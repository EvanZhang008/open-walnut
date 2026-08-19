import path from 'node:path'
import os from 'node:os'
import { log } from '../logging/index.js'
import { DaemonFileReader } from '../core/daemon-file-reader.js'
import type { SessionHistoryMessage } from '../core/session-history.js'
import type { SessionRecord } from '../core/types.js'
import { AcpHistoryFold, projectAcpJournalHistory } from './acp-journal-projector.js'
import type { JournalRecord } from './acp-worker/protocol.js'

interface JournalReader {
  readFile(filePath: string): Promise<string | null>
  /** Optional range APIs (DaemonFileReader has all three) — enable the
   *  streaming fold below. Seam readers exposing only readFile get the legacy
   *  whole-file path. `epoch` (dev:ino:birthtimeMs on real daemons) identifies
   *  the file INCARNATION — see FoldCacheEntry.epoch. */
  stat?(filePath: string): Promise<{ mtimeMs: number; size: number; epoch?: string } | null>
  readFileRange?(filePath: string, start: number): Promise<{ content: string; fileSize: number } | null>
  readRangeBytes?(filePath: string, start: number, length: number):
    Promise<{ buf: Buffer; fileSize: number; eof: boolean } | null>
}

/** Tail window used when a tail-bounded caller (route polls with ?tail=) hits a
 *  COLD cache on a journal bigger than this: fold only the last window for an
 *  instant first paint (marked windowed), and let the on-demand full fold
 *  ("Load earlier messages" sends no tail) replace it. Mirrors the native
 *  HISTORY_COLD_TAIL_READ_BYTES semantics. */
const ACP_TAIL_WINDOW_BYTES = 4 * 1024 * 1024

/** Per-RPC range size for the streaming fold — matches DaemonFileReader's
 *  internal chunking so no single WS frame can trip the corp-proxy kill. */
const STREAM_CHUNK_BYTES = 1024 * 1024

/** Legacy journals (command-accepted {op:'prompt'} era) need the positional
 *  recoverLegacyUserPrompts pre-pass, which requires the whole record list in
 *  memory. Bound that materialization; every observed legacy journal is <10MB
 *  (they predate the replay-bloat era). Over the bound we keep the streamed
 *  fold — losing legacy-era user prompts, which the old 4MB tail window lost
 *  anyway along with everything else. Note: this bounds parsed OBJECTS, not
 *  just a string, so keep it well under the 32MB reader ceiling. */
const LEGACY_MATERIALIZE_MAX_BYTES = 16 * 1024 * 1024

export interface ReadAcpSessionHistoryOptions {
  /** Test seam and specialized callers; production uses DaemonFileReader. */
  reader?: JournalReader
  /** Tail-bounded caller: on a COLD cache, bound the fold to the journal's last
   *  N bytes (marked windowed) instead of folding the whole file. A warm cache
   *  (full or windowed) is always served incrementally regardless. */
  maxColdReadBytes?: number
}

export interface AcpSessionHistoryState {
  messages: SessionHistoryMessage[]
  /** False only when the journal read API reported a missing file. */
  journalExists: boolean
  /** True when only a tail window of the journal was folded — older messages
   *  are missing from `messages`. Cleared by a full (no maxColdReadBytes) read. */
  windowed?: boolean
}

type AcpHistoryRecord = Pick<SessionRecord, 'claudeSessionId'>
  & Partial<Pick<SessionRecord, 'acpRuntimeId' | 'acpJournalPath' | 'host'>>

export function getAcpJournalPath(record: AcpHistoryRecord): string | null {
  return getAcpJournalPathCandidates(record)[0] ?? null
}

/**
 * Candidate journal paths, most likely first. The daemon moved its streams dir
 * (2026-08: /tmp/open-walnut-streams → ~/.open-walnut/tmp/streams) and migrates
 * files on startup, but records persisted BEFORE the move still hold the dead
 * absolute path — 11 of 16 codex records on the incident machine pointed at
 * files that had been migrated away, silently reading as empty history. So:
 * try the recorded path, then re-derive from the runtimeId against the current
 * prod dir, then the legacy dir.
 */
export function getAcpJournalPathCandidates(record: AcpHistoryRecord): string[] {
  const candidates: string[] = []
  const push = (p: string | null | undefined): void => {
    if (p && !candidates.includes(p)) candidates.push(p)
  }
  push(record.acpJournalPath)
  if (record.acpRuntimeId) {
    const file = `${record.acpRuntimeId}.acp.jsonl`
    const daemonDir = process.env.WALNUT_DAEMON_DIR || '/tmp/open-walnut'
    if (process.env.WALNUT_STREAMS_DIR) {
      push(path.join(process.env.WALNUT_STREAMS_DIR, file))
    } else if (process.env.WALNUT_DAEMON_DIR) {
      // Isolated daemon (tests/sandbox): streams live in the sibling dir.
      push(path.join(`${daemonDir}-streams`, file))
    }
    // Prod locations — current first, legacy second (mirror daemon-standalone).
    push(path.join(os.homedir(), '.open-walnut', 'tmp', 'streams', file))
    push(path.join('/tmp/open-walnut-streams', file))
  }
  return candidates
}

// ── Incremental fold cache ──
//
// The journal is append-only (one writer, O_APPEND — see acp-worker/journal.ts),
// so a fold that consumed bytes [start, offset) stays valid forever; a later
// read only needs to fold [offset, EOF). This is what makes whale journals
// cheap: the 100MB journal that used to be re-read and re-projected on EVERY
// history request (inc-1787163257396: 70 windowed reads in an hour) folds new
// bytes only after the first pass. Mirrors the native parsedHistoryCache
// (session-history.ts) in spirit; simpler because append-only means mtime
// equality is not needed — offset ≤ size is the validity test.

interface FoldCacheEntry {
  /** Byte offset after the last COMPLETE line folded (next incremental start). */
  offset: number
  fold: AcpHistoryFold
  /** Fold started mid-file (tail window) — must not satisfy a full caller. */
  windowed: boolean
  /** File incarnation (dev:ino:birthtimeMs) from the daemon's stat. Guards the
   *  one case `offset <= size` cannot: the same path deleted and REGROWN past
   *  the old offset would splice a stale fold onto unrelated bytes. Absent on
   *  old daemons — then we fall back to the size test alone. */
  epoch?: string
  /** In-flight extend for THIS entry. Scoped to the entry (not a global key)
   *  so a full caller can never be handed a windowed entry's pending extend. */
  extending?: Promise<AcpSessionHistoryState | null>
  /** Legacy journal: messages came from the materialized recovery path and the
   *  fold cannot be extended incrementally (the pre-pass is positional). Served
   *  while the file size matches `size`; any growth forces a full re-read. A
   *  journal cannot BECOME legacy by appending (the legacy schema predates the
   *  current writer), so incremental extends never re-evaluate this. */
  legacy?: { messages: SessionHistoryMessage[]; size: number }
  /** Streamed-fold legacy markers — only meaningful during the COLD fold
   *  (see the legacy note above); extends skip tracking them. */
  legacyPromptIds: Set<string>
  acceptedPromptIds: Set<string>
}

const MAX_FOLD_CACHE_ENTRIES = 16
/** Total chars across cached folds (fold.charCount) — a 100MB journal folds to
 *  ~4M chars with tool-result truncation, so this holds several whales. */
const MAX_FOLD_CACHE_CHARS = 48 * 1024 * 1024

const foldCache = new Map<string, FoldCacheEntry>()
const inflight = new Map<string, Promise<AcpSessionHistoryState | null>>()

export function _resetAcpHistoryCacheForTesting(): void {
  foldCache.clear()
  inflight.clear()
}

function cacheKey(runtimeId: string, host: string | undefined, journalPath: string): string {
  return `${runtimeId}@${host ?? '__local__'}|${journalPath}`
}

function cacheSet(key: string, entry: FoldCacheEntry): void {
  foldCache.delete(key)
  foldCache.set(key, entry)
  while (foldCache.size > MAX_FOLD_CACHE_ENTRIES) {
    const oldest = foldCache.keys().next().value as string
    foldCache.delete(oldest)
  }
  let chars = 0
  for (const e of foldCache.values()) chars += e.fold.charCount
  for (const [k, e] of foldCache) {
    if (chars <= MAX_FOLD_CACHE_CHARS || k === key) break
    foldCache.delete(k)
    chars -= e.fold.charCount
  }
}

/**
 * Read one ACP journal through the daemon-uniform file API and return the same
 * history DTO as native sessions. Both route phases (`source=streams` and full)
 * call this helper for engine=codex.
 */
export async function readAcpSessionHistory(
  record: AcpHistoryRecord,
  options: ReadAcpSessionHistoryOptions = {},
): Promise<SessionHistoryMessage[]> {
  return (await readAcpSessionHistoryState(record, options)).messages
}

export async function readAcpSessionHistoryState(
  record: AcpHistoryRecord,
  options: ReadAcpSessionHistoryOptions = {},
): Promise<AcpSessionHistoryState> {
  const runtimeId = record.acpRuntimeId
  const candidates = getAcpJournalPathCandidates(record)
  if (!runtimeId || candidates.length === 0) return { messages: [], journalExists: false }
  const reader = options.reader ?? new DaemonFileReader(record.host ?? '__local__')
  for (const journalPath of candidates) {
    let state: AcpSessionHistoryState | null
    if (reader.stat && reader.readRangeBytes) {
      try {
        state = await readJournalStreaming(reader, runtimeId, record, journalPath, options)
      } catch (err) {
        // Degrade ONLY on a missing daemon capability or transport failure —
        // the whole-file path (with its over-ceiling 4MB tail fallback) still
        // works there. A programmer error in the fold must stay loud: silently
        // degrading it would reproduce the original only-2-messages incident
        // while reading like routine capability degradation in the logs.
        const msg = err instanceof Error ? err.message : String(err)
        if (!/unknown command|transport failure|fs\.stat failed/i.test(msg)) throw err
        log.session.warn('acp history: streaming fold unavailable — degrading to whole-file read', {
          runtimeId, journalPath, error: msg,
        })
        state = await readJournalWholeFile(reader, runtimeId, record, journalPath)
      }
    } else {
      state = await readJournalWholeFile(reader, runtimeId, record, journalPath)
    }
    if (state !== null) return state
  }
  // Not "empty history" — the journal is genuinely gone. Silent [] here made a
  // stale acpJournalPath indistinguishable from a fresh session (2026-08-10).
  log.session.warn('acp history: journal not found at any candidate path', {
    sessionId: record.claudeSessionId, runtimeId, candidates,
  })
  return { messages: [], journalExists: false }
}

// ── Streaming fold path (production: DaemonFileReader) ──

async function readJournalStreaming(
  reader: JournalReader,
  runtimeId: string,
  record: AcpHistoryRecord,
  journalPath: string,
  options: ReadAcpSessionHistoryOptions,
): Promise<AcpSessionHistoryState | null> {
  let st: { mtimeMs: number; size: number; epoch?: string } | null
  try {
    st = await reader.stat!(journalPath)
  } catch {
    // Old daemon without fs.stat (or transient) — legacy whole-file path still
    // works there (its own internal fallbacks handle the rest).
    return readJournalWholeFile(reader, runtimeId, record, journalPath)
  }
  if (st === null) return null
  const size = st.size
  const key = cacheKey(runtimeId, record.host, journalPath)
  const wantFull = !options.maxColdReadBytes

  const cached = foldCache.get(key)
  const epochValid = !cached?.epoch || !st.epoch || cached.epoch === st.epoch
  if (cached && cached.offset <= size && epochValid && !(cached.windowed && wantFull)) {
    // Valid prefix. Legacy entries can't extend — serve while the file size the
    // legacy fold was computed AT is unchanged (`offset` stops before a torn
    // trailing line, so comparing offset === size would re-fold the whole
    // journal on every poll after a mid-write crash).
    if (cached.legacy) {
      if (cached.legacy.size === size) return serveEntry(cached)
      // grew: fall through to a fresh read below
    } else {
      // The in-flight extend is scoped to the ENTRY, not a global key: a full
      // caller must never be handed a pending extend of a windowed entry (it
      // would receive the tail with windowed:true — the exact symptom this
      // change fixes). Two callers that observed different sizes still collapse
      // into one extend; the later one's next poll picks up the remainder.
      if (!cached.extending) {
        cached.extending = (async () => {
          try {
            await extendFold(reader, journalPath, cached, size)
            // Never let an extended WINDOWED entry clobber a FULL entry that a
            // concurrent full fold installed while we were reading.
            const current = foldCache.get(key)
            if (!current || current === cached || !(cached.windowed && !current.windowed)) {
              cacheSet(key, cached)
            }
            return serveEntry(cached)
          } finally {
            cached.extending = undefined
          }
        })()
      }
      return cached.extending
    }
  }

  // Cold (or invalidated: file shrank/replaced, or a full caller hit a
  // windowed entry). Decide the fold's start. windowBytes only matters for
  // tail-bounded callers — a full caller always folds from 0.
  const windowBytes = options.maxColdReadBytes ?? 0
  const windowed = !wantFull && size > windowBytes
  const start = windowed ? size - windowBytes : 0
  const flightKey = `${key}|${windowed ? `w${start}` : 'full'}`
  const state = await dedupe(flightKey, async () => {
    const entry: FoldCacheEntry = {
      offset: start,
      fold: new AcpHistoryFold(runtimeId),
      windowed,
      ...(st.epoch ? { epoch: st.epoch } : {}),
      legacyPromptIds: new Set(),
      acceptedPromptIds: new Set(),
    }
    const work = (async (): Promise<AcpSessionHistoryState | null> => {
      // Full cold folds of whales chain ~size/1MB sequential range RPCs; gate
      // their concurrency like DaemonFileReader gates whole-file reads (several
      // codex whales re-opening after a server restart must not fan out N
      // unbounded read chains at once — the 2026-07-24 OOM class). Windowed
      // folds are bounded by their window and skip the gate.
      if (!windowed) await acquireFullFoldSlot()
      try {
        await extendFold(reader, journalPath, entry, size, /* dropTornFirstLine */ windowed)
      } finally {
        if (!windowed) releaseFullFoldSlot()
      }
      if (windowed) {
        log.session.info('acp history: cold tail-bounded read — folded a tail window', {
          runtimeId, journalPath, windowBytes, size,
        })
      }

      // Legacy journal (command-accepted {op:'prompt'} without prompt-accepted):
      // the streamed fold dropped those user prompts; re-read materialized so
      // recoverLegacyUserPrompts can synthesize them. Bounded — see constant.
      const isLegacy = [...entry.legacyPromptIds].some((id) => !entry.acceptedPromptIds.has(id))
      if (isLegacy && !windowed) {
        if (size <= LEGACY_MATERIALIZE_MAX_BYTES) {
          const records: JournalRecord[] = []
          await streamJournalLines(reader, journalPath, 0, size, (line) => {
            const rec = parseJournalLine(line)
            if (rec) records.push(rec)
          })
          entry.legacy = { messages: projectAcpJournalHistory(runtimeId, records), size }
        } else {
          log.session.warn('acp history: legacy journal exceeds the materialization bound — legacy-era user prompts omitted', {
            runtimeId, journalPath, size, bound: LEGACY_MATERIALIZE_MAX_BYTES,
          })
        }
      }
      return serveEntry(entry)
    })().finally(() => { entry.extending = undefined })
    // Occupy the entry's extend slot for the whole cold fold, THEN install it.
    // Install-before-fold is what preserves progress across a mid-stream daemon
    // flap (`offset <= size` keeps a partial fold servable and resumable — a
    // 100MB fold that dies at 90MB resumes at 90MB instead of degrading to the
    // 4MB whole-file tail forever); the occupied slot is what stops a
    // concurrent caller from extending the SAME entry while this fold is still
    // pushing into it (two folds from one offset = every line duplicated).
    entry.extending = work
    const preExisting = foldCache.get(key)
    if (!(windowed && preExisting && !preExisting.windowed && preExisting.offset <= size)) {
      cacheSet(key, entry)
    }
    return work
  })

  // Background full-fold warm-up after a windowed cold read (native parity:
  // session-history.ts does the same). The window painted instantly; the next
  // poll then serves the COMPLETE history from cache and the windowed flag
  // clears without the user ever clicking "Load earlier messages". Incremental
  // reads keep it warm from then on. Fire-and-forget; the recursive call is a
  // full read (no maxColdReadBytes), so it reuses the legacy handling, the
  // `${key}|full` dedupe (a real full request racing this collapses into it),
  // and the full-fold concurrency gate. Termination invariant: `windowed` can
  // be true ONLY when maxColdReadBytes was passed, and the recursive call
  // omits it — if a second reason to mark a fold windowed is ever added, this
  // must be revisited or it becomes unbounded recursion.
  if (state?.windowed) {
    void readJournalStreaming(reader, runtimeId, record, journalPath, { reader })
      .catch((err) => {
        log.session.warn('acp history: background full-fold warm-up failed', {
          runtimeId, journalPath, error: err instanceof Error ? err.message : String(err),
        })
      })
  }
  return state
}

// Concurrency gate for FULL cold folds (mirrors DaemonFileReader's
// MAX_CONCURRENT_FULL_READS rationale — see comment at the call site).
const MAX_CONCURRENT_FULL_FOLDS = 2
let fullFoldsInFlight = 0
const fullFoldWaiters: Array<() => void> = []

async function acquireFullFoldSlot(): Promise<void> {
  if (fullFoldsInFlight < MAX_CONCURRENT_FULL_FOLDS) {
    fullFoldsInFlight++
    return
  }
  await new Promise<void>((resolve) => fullFoldWaiters.push(resolve))
  fullFoldsInFlight++
}

function releaseFullFoldSlot(): void {
  fullFoldsInFlight--
  const next = fullFoldWaiters.shift()
  if (next) next()
}

function serveEntry(entry: FoldCacheEntry): AcpSessionHistoryState {
  const messages = entry.legacy ? entry.legacy.messages : entry.fold.messages
  return {
    // DEEP copy, not a slice: the fold keeps mutating its message OBJECTS on
    // later incremental reads (continuation chunks do `text +=` in place), and
    // route transforms mutate served objects too — rewriteHistoryRemoteImages
    // rewrites msg.text/tool.result in place for remote sessions. A shared
    // object would let each side corrupt the other (mirror paths written into
    // the cache; cache appends landing on an already-served payload).
    messages: messages.map((m) => ({
      ...m,
      ...(m.tools ? { tools: m.tools.map((t) => ({ ...t })) } : {}),
    })),
    journalExists: true,
    ...(entry.windowed ? { windowed: true } : {}),
  }
}

function dedupe(
  flightKey: string,
  work: () => Promise<AcpSessionHistoryState | null>,
): Promise<AcpSessionHistoryState | null> {
  const existing = inflight.get(flightKey)
  if (existing) return existing
  const p = work().finally(() => inflight.delete(flightKey))
  inflight.set(flightKey, p)
  return p
}

/** Fold journal bytes [entry.offset, size) into entry.fold. `entry.offset`
 *  advances line-by-line INSIDE the callback, so a mid-stream error (daemon
 *  flap) leaves the entry consistent at the last fully folded line — the next
 *  read simply resumes from there instead of double-folding. */
async function extendFold(
  reader: JournalReader,
  journalPath: string,
  entry: FoldCacheEntry,
  size: number,
  dropTornFirstLine = false,
): Promise<void> {
  if (entry.offset >= size) return
  let drop = dropTornFirstLine
  await streamJournalLines(reader, journalPath, entry.offset, size, (line, endOffset) => {
    if (drop) { drop = false; entry.offset = endOffset; return } // window starts mid-record
    const rec = parseJournalLine(line)
    if (rec) {
      trackLegacyMarkers(rec, entry)
      entry.fold.push(rec)
    }
    entry.offset = endOffset
  })
}

function trackLegacyMarkers(rec: JournalRecord, entry: FoldCacheEntry): void {
  if (rec.kind !== 'meta') return
  if (rec.event.type === 'command-accepted' && rec.event.op === 'prompt') {
    entry.legacyPromptIds.add(rec.event.commandId)
  } else if (rec.event.type === 'prompt-accepted') {
    entry.acceptedPromptIds.add(rec.event.commandId)
  }
}

function parseJournalLine(line: string): JournalRecord | null {
  if (!line.trim()) return null
  try {
    const rec = JSON.parse(line) as JournalRecord
    return rec?.kind === 'acp' || rec?.kind === 'meta' ? rec : null
  } catch {
    // One damaged complete record is skipped; later records remain readable.
    return null
  }
}

/**
 * Stream complete journal lines in [start, end) through `onLine`, reading
 * STREAM_CHUNK_BYTES per RPC so memory stays bounded regardless of journal
 * size (this is what removes the whole-file byte ceiling from this path).
 * Lines are split on the newline BYTE before utf-8 decoding, so a multi-byte
 * char spanning a chunk boundary can never be torn. `onLine` receives the byte
 * offset just past each line's newline. A trailing partial line (mid-write) is
 * never emitted; the next incremental read re-reads it.
 */
async function streamJournalLines(
  reader: JournalReader,
  journalPath: string,
  start: number,
  end: number,
  onLine: (line: string, endOffset: number) => void,
): Promise<void> {
  let offset = start
  let leftover: Buffer = Buffer.alloc(0)
  while (offset < end) {
    const want = Math.min(STREAM_CHUNK_BYTES, end - offset)
    const res = await reader.readRangeBytes!(journalPath, offset, want)
    if (res === null) break // vanished between stat and read
    const { buf, eof } = res
    if (buf.length === 0) break
    offset += buf.length
    const chunk = leftover.length > 0 ? Buffer.concat([leftover, buf]) : buf
    // End-of-chunk byte offset in file space; a line ending at chunk index i
    // ends in the file at chunkEnd - (chunk.length - (i + 1)).
    const chunkEnd = offset
    let lineStart = 0
    for (let i = 0; i < chunk.length; i++) {
      if (chunk[i] !== 0x0a) continue
      onLine(chunk.subarray(lineStart, i).toString('utf8'), chunkEnd - (chunk.length - (i + 1)))
      lineStart = i + 1
    }
    leftover = lineStart < chunk.length ? Buffer.from(chunk.subarray(lineStart)) : Buffer.alloc(0)
    if (eof) break
  }
}

// ── Legacy whole-file path (seam readers without the range APIs) ──

async function readJournalWholeFile(
  reader: JournalReader,
  runtimeId: string,
  record: AcpHistoryRecord,
  journalPath: string,
): Promise<AcpSessionHistoryState | null> {
  let content: string | null
  try {
    content = await reader.readFile(journalPath)
  } catch (err) {
    // Whole-file read refused for size (byte ceiling) — degrade to a bounded
    // tail window instead of failing the request.
    const msg = err instanceof Error ? err.message : String(err)
    if (!msg.includes('byte ceiling')) throw err
    const tail = await readAcpJournalTail(reader, journalPath)
    if (tail === null) return null
    log.session.info('acp history: journal over byte ceiling — projected tail window', {
      sessionId: record.claudeSessionId, runtimeId, journalPath,
      windowBytes: ACP_TAIL_WINDOW_BYTES,
    })
    return {
      messages: projectAcpJournalHistory(runtimeId, parseAcpJournal(tail)),
      journalExists: true,
      windowed: true,
    }
  }
  if (content === null) return null
  return {
    messages: projectAcpJournalHistory(runtimeId, parseAcpJournal(content)),
    journalExists: true,
  }
}

/** Read the last ACP_TAIL_WINDOW_BYTES of an over-ceiling journal, dropping the
 *  torn first line (a byte window starts mid-record). Returns null when the
 *  reader lacks the range API or the file vanished between stat and read. */
async function readAcpJournalTail(reader: JournalReader, journalPath: string): Promise<string | null> {
  if (!reader.stat || !reader.readFileRange) return null
  try {
    const st = await reader.stat(journalPath)
    if (st === null) return null
    const start = Math.max(0, st.size - ACP_TAIL_WINDOW_BYTES)
    const range = await reader.readFileRange(journalPath, start)
    if (range === null) return null
    if (start === 0) return range.content
    const nl = range.content.indexOf('\n')
    return nl >= 0 ? range.content.slice(nl + 1) : ''
  } catch {
    return null
  }
}

/** Parse complete journal lines only; corrupt/torn lines never poison history. */
export function parseAcpJournal(content: string): JournalRecord[] {
  const records: JournalRecord[] = []
  const lastNewline = content.lastIndexOf('\n')
  if (lastNewline < 0) return records
  for (const line of content.slice(0, lastNewline).split('\n')) {
    const record = parseJournalLine(line)
    if (record) records.push(record)
  }
  return records
}
