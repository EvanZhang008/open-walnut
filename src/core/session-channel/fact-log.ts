/**
 * A host's log of session facts for one Walnut (docs/plan/one-service-every-host.md, phase 2):
 * every fact of every session this host's service judges, in order, kept until that Walnut's
 * leader confirmed it. While the leader is connected the log is the channel's send buffer; while
 * it is away the same records pile up here and go when it comes back (channel.ts): one set of
 * records for both.
 *
 * Records keep the offline journal's shape (`{v:2, seq, opId, rev, at, kind, ...}`,
 * providers/offline-journal-core.ts) so the leader dedups them the same way, plus `sid`, a
 * per-session `sseq`, the fact's event `name` and `data`. It is a file of its own, not the
 * journal: a fact is written by the service's main thread at the rate of a session's tools, so
 * appends are batched (one write and one fdatasync per batch, every `flushMs`), async, and never
 * take the journal's per-append lock.
 *
 * Files in `dir`:
 *   facts-<walnutId>.ndjson      one record per line, append-only; rewritten only by compaction
 *                                (tmp + rename)
 *   facts-<walnutId>.state.json  {v:1, logId, acked, permit, sseq: {sid: last}, told: {sid: line}}
 *
 * Rules this file owns:
 *   - a record is durable (fsynced) before anyone hears of it (`onDurable`), so a leader never
 *     confirms what a crash could lose;
 *   - the CLI's output file already holds every line in full: a string field of a fact longer
 *     than `inlineCap` is cut on disk and named in `refs` with the line it came from; the record
 *     the live channel sends (`onDurable`) is the whole one, from memory. A `row` record is never
 *     cut: its fields are the row itself, which no output file holds (2026-11-24: a spawn prompt
 *     replayed from disk reached the leader cut at 16 KB, and its sessions were told the rest of
 *     their instructions again and again, a rule cut mid-word as "Taken out");
 *   - compaction (when the file passes `compactBytes`) drops what the leader confirmed, and in
 *     what it has not, stands one `turn-summary` record for the tool facts of each finished turn
 *     and one merged `row` record for its row patches; facts of a turn still running are kept;
 *     a session's `drop` record (the leader deleted it) stands for all of that session before it;
 *     a session's newest `live` record and its newest snapshot fact (SNAPSHOT_FACTS) stand for
 *     the earlier ones; a compaction that left the file large waits until it doubles;
 *   - a torn last line (a crash in a write) is cut at open;
 *   - `toldLine(sid)`: the furthest CLI output line a durable fact of the session came from, so the
 *     host's runner, attaching again after a restart, reads on from exactly where the leader was told
 *     (host-judged-lines.ts), and whether a turn end (a `session:result`) came from that very line.
 *     It is derived from the durable records, not written with them: folded in after each batch's
 *     fsync, rebuilt from the records at open, and saved in the state before every compaction (which
 *     drops records, never it), so it is never ahead of what a crash could lose, nor behind it.
 *   - `saidLine(sid)`: the furthest CLI output line any fact of the session came from, as read,
 *     where the told line stops at the start of a result its runner withholds while background work
 *     runs (claude-code-session.ts readOffset). An attach reads on from the told line, so it reads
 *     again lines whose facts the leader already heard; the host emitter keeps their transcript
 *     detail from being said twice (host-emitter.ts). Kept like the told line: folded in after each
 *     batch's fsync (a record whose line stopped short names the line in `src`), rebuilt at open,
 *     saved with the state.
 */
import fsp from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import { SNAPSHOT_FACTS, TURN_DETAIL_FACTS, TURN_END_FACT } from './event-classes.js'
import { comparePermit, isPermitPair, type PermitPair } from './channel.js'

export interface FactRef { epoch?: string; v?: number; bytes: number }

export interface FactRecord {
  v: 2
  seq: number
  opId: string
  rev: 1
  at: number
  kind: 'session-fact'
  sid: string
  sseq: number
  /** A session event name (event-classes.ts) or a channel record kind ('row', 'rename', 'drop', 'turn-summary'). */
  name: string
  data: unknown
  /** The CLI output line the fact came from (its stream epoch and end offset). */
  line?: { epoch?: string; v: number }
  /** On disk only: the line the fact was read from, when `line` stopped short of it (`saidLine`). */
  src?: number
  /** Fields cut to the inline cap on disk, by their path in `data` ('a.b.0'). */
  refs?: Record<string, FactRef>
  /** The destinations the host's own emit named, so the leader says it to the same subscribers. */
  to?: string[]
  /**
   * 'leader': a fact this host kept while it stood down for an older leader (old-leader-watch.ts).
   * That leader judged the turn itself, from the session's transcript, so the leader that applies
   * the record later has nothing left to act on (leader-apply.ts actedOnAlready). An older leader
   * does not read the field.
   */
  judgedBy?: 'leader'
}

export interface FactLogOptions {
  dir: string
  walnutId: string
  now?: () => number
  flushMs?: number
  durable?: boolean
  inlineCap?: number
  compactBytes?: number
  log?: (level: 'info' | 'warn', msg: string, data?: Record<string, unknown>) => void
}

/**
 * `permit` and `permitNumber`: the highest leader standing seen (channel.ts PermitPair), kept as its
 * epoch in `permit` (the field an older build wrote and reads: its one number was the epoch) and
 * its permit number beside it (absent in an older file: 0).
 */
interface LogState { v: 1; logId: string; acked: number; permit: number; permitNumber?: number; sseq: Record<string, number>; told?: Record<string, ToldLine>; said?: Record<string, ToldLine> }

/** A CLI output line a fact came from: its stream file's epoch (when known) and its end offset; `end`: a turn end came from it. */
export interface ToldLine { epoch?: string; v: number; end?: true }

/** The fact that says a turn ended. */
const TURN_END = 'session:result'

/** `seen` with a durable fact's line folded in: a later line of the same file, or the first line of a new file. `name`: the fact's. */
export function foldTold(seen: ToldLine | undefined, line: ToldLine | undefined, name?: string): ToldLine | undefined {
  if (!line || !Number.isSafeInteger(line.v) || line.v < 0) return seen
  const end = name === TURN_END
  const make = (e: boolean): ToldLine => ({ ...(line.epoch ? { epoch: line.epoch } : {}), v: line.v, ...(e ? { end: true as const } : {}) })
  if (!seen || (line.epoch && seen.epoch && line.epoch !== seen.epoch) || line.v > seen.v) return make(end)
  // Another fact of the same line: a turn end from it stays one.
  if (line.v === seen.v && end && !seen.end) return { ...seen, end: true }
  return seen
}

/** `seen` with a durable fact's source line folded in (`saidLine`): its `src`, else its `line`. */
export function foldSaid(seen: ToldLine | undefined, r: { line?: { epoch?: string; v: number }; src?: number }): ToldLine | undefined {
  if (!r.line) return seen
  const v = typeof r.src === 'number' && Number.isSafeInteger(r.src) && r.src > r.line.v ? r.src : r.line.v
  if (!Number.isSafeInteger(v) || v < 0) return seen
  if (!seen || (r.line.epoch && seen.epoch && r.line.epoch !== seen.epoch) || v > seen.v) return { ...(r.line.epoch ? { epoch: r.line.epoch } : {}), v }
  return seen
}

function toldOf(raw: unknown): Record<string, ToldLine> {
  const out: Record<string, ToldLine> = {}
  if (!raw || typeof raw !== 'object') return out
  for (const [sid, t] of Object.entries(raw as Record<string, unknown>)) {
    const l = t as Partial<ToldLine> | null
    if (l && Number.isSafeInteger(l.v) && (l.v as number) >= 0) out[sid] = { ...(typeof l.epoch === 'string' ? { epoch: l.epoch } : {}), v: l.v as number, ...(l.end === true ? { end: true as const } : {}) }
  }
  return out
}

const SAFE_ID = /^[A-Za-z0-9_.-]{1,128}$/
/**
 * How long appends gather before one write, one fdatasync and one facts frame. Each frame is one
 * SQLite transaction on the leader (session-tracker.ts applyHostChannelBatch), so the window sets
 * the leader's commit rate for a busy host; 50 ms keeps a fact's way to the leader well inside 1 s.
 */
export const FACT_FLUSH_MS = 50

export class FactLog {
  private state: LogState
  private nextSeq: number
  private buffered: { full: FactRecord; line: string; src?: number }[] = []
  private timer: ReturnType<typeof setTimeout> | null = null
  private chain: Promise<void> = Promise.resolve()
  private listeners = new Set<(recs: FactRecord[]) => void>()
  private bytes: number
  /** The size past which the file is compacted again (twice what the last compaction left). */
  private compactAgainAt = 0
  private firstSeq: number
  private closed = false
  private durableHead: number

  private constructor(private readonly o: Required<Omit<FactLogOptions, 'log'>> & Pick<FactLogOptions, 'log'>, state: LogState, head: number, first: number, bytes: number) {
    this.state = state
    this.nextSeq = head + 1
    this.durableHead = head
    this.firstSeq = first
    this.bytes = bytes
  }

  static async open(opts: FactLogOptions): Promise<FactLog> {
    if (!SAFE_ID.test(opts.walnutId)) throw new Error(`fact log: bad walnut id ${JSON.stringify(opts.walnutId)}`)
    const o = {
      now: Date.now, flushMs: FACT_FLUSH_MS, durable: true, inlineCap: FACT_INLINE_CAP, compactBytes: 8 * 1024 * 1024, ...opts,
    }
    await fsp.mkdir(o.dir, { recursive: true, mode: 0o700 })
    const file = path.join(o.dir, `facts-${o.walnutId}.ndjson`)
    const stateFile = path.join(o.dir, `facts-${o.walnutId}.state.json`)
    let state: LogState | null = null
    try {
      const raw = JSON.parse(await fsp.readFile(stateFile, 'utf8')) as Partial<LogState>
      if (raw?.v === 1 && typeof raw.logId === 'string') {
        const permitNumber = Number(raw.permitNumber) || 0
        state = { v: 1, logId: raw.logId, acked: Number(raw.acked) || 0, permit: Number(raw.permit) || 0, ...(permitNumber > 0 ? { permitNumber } : {}), sseq: raw.sseq && typeof raw.sseq === 'object' ? raw.sseq : {}, told: toldOf(raw.told), said: toldOf(raw.said) }
      }
    } catch { /* a new log */ }
    const { records, validBytes, totalBytes } = await readRecords(file)
    if (validBytes < totalBytes) {
      // A crash in a write left a torn line: cut it, so the next append starts on a line of its own.
      await fsp.truncate(file, validBytes)
      o.log?.('warn', 'fact log: cut a torn last line', { walnutId: o.walnutId, cut: totalBytes - validBytes })
    }
    if (!state) state = { v: 1, logId: crypto.randomBytes(8).toString('hex'), acked: 0, permit: 0, sseq: {}, told: {}, said: {} }
    const told = state.told ??= {}
    const said = state.said ??= {}
    let head = state.acked
    for (const r of records) {
      head = Math.max(head, r.seq)
      state.sseq[r.sid] = Math.max(state.sseq[r.sid] ?? 0, r.sseq)
      const t = foldTold(told[r.sid], r.line, r.name)
      if (t) told[r.sid] = t
      const d = foldSaid(said[r.sid], r)
      if (d) said[r.sid] = d
    }
    const log = new FactLog(o, state, head, records[0]?.seq ?? head + 1, validBytes)
    await log.saveState()
    return log
  }

  get logId(): string { return this.state.logId }
  /** The last durable seq (0: none yet). */
  get head(): number { return this.durableHead }
  /** The lowest seq still in the file (head + 1 when it holds none). */
  get floor(): number { return this.firstSeq }
  get acked(): number { return this.state.acked }
  /** The epoch of the highest leader standing seen (the one number an older build kept). */
  get permit(): number { return this.state.permit }
  /** The highest leader standing seen: (0, n) for a log an older build wrote. */
  get permitPair(): PermitPair { return { permitNumber: this.state.permitNumber ?? 0, epoch: this.state.permit } }
  get sizeBytes(): number { return this.bytes }
  private get file(): string { return path.join(this.o.dir, `facts-${this.o.walnutId}.ndjson`) }
  private get stateFile(): string { return path.join(this.o.dir, `facts-${this.o.walnutId}.state.json`) }

  /** Hear each batch once it is durable, the whole records, in seq order. */
  onDurable(cb: (recs: FactRecord[]) => void): () => void {
    this.listeners.add(cb)
    return () => { this.listeners.delete(cb) }
  }

  /** The furthest CLI output line a durable fact of `sid` came from (see the header), or undefined. */
  toldLine(sid: string): ToldLine | undefined {
    const t = this.state.told?.[sid]
    return t ? { ...t } : undefined
  }

  /** The furthest CLI output line a durable fact of `sid` was read from (see the header), or undefined. */
  saidLine(sid: string): ToldLine | undefined {
    const t = this.state.said?.[sid]
    return t ? { ...t } : undefined
  }

  /** The next sseq this session's next fact takes, without taking it. */
  nextSseq(sid: string): number { return (this.state.sseq[sid] ?? 0) + 1 }

  /**
   * Append one fact. Seq and sseq are taken now (so order is the caller's); it is durable after
   * the next flush. `continueFrom`: a session id that replaced another (a rename) continues the
   * old id's sseq instead of starting from 1.
   */
  append(sid: string, name: string, data: unknown, opts: { line?: { epoch?: string; v: number }; src?: number; at?: number; continueFrom?: string; to?: string[]; judgedBy?: 'leader' } = {}): FactRecord {
    if (this.closed) throw new Error('fact log closed')
    if (!SAFE_ID.test(sid)) throw new Error(`fact log: bad session id ${JSON.stringify(sid)}`)
    if (opts.continueFrom && this.state.sseq[opts.continueFrom] && !this.state.sseq[sid]) this.state.sseq[sid] = this.state.sseq[opts.continueFrom]
    const seq = this.nextSeq++
    const sseq = (this.state.sseq[sid] ?? 0) + 1
    this.state.sseq[sid] = sseq
    const full: FactRecord = {
      v: 2, seq, opId: `sf-${this.state.logId}-${seq}`, rev: 1, at: opts.at ?? this.o.now(), kind: 'session-fact', sid, sseq, name, data,
      ...(opts.line ? { line: opts.line } : {}),
      ...(opts.to ? { to: [...opts.to] } : {}),
      ...(opts.judgedBy ? { judgedBy: opts.judgedBy } : {}),
    }
    const disk: FactRecord = opts.line && typeof opts.src === 'number' && Number.isSafeInteger(opts.src) && opts.src > opts.line.v
      ? { ...capRecord(full, this.o.inlineCap), src: opts.src } : capRecord(full, this.o.inlineCap)
    this.buffered.push({ full, line: JSON.stringify(disk) + '\n', ...(disk.src !== undefined ? { src: disk.src } : {}) })
    this.schedule()
    return full
  }

  /** Write what is buffered now (and wait for any write in progress). */
  flush(): Promise<void> {
    if (this.timer) { clearTimeout(this.timer); this.timer = null }
    return this.serial(() => this.writeBuffered())
  }

  /** The leader confirmed everything up to `upTo`. Trims the file when enough of it is confirmed. */
  async ack(upTo: number): Promise<void> {
    if (!Number.isSafeInteger(upTo) || upTo <= this.state.acked) return
    this.state.acked = Math.min(upTo, this.durableHead)
    await this.serial(async () => {
      await this.saveState()
      // Only when at least half the records left are confirmed: a leader catching up acks every
      // 100 ms, and each would otherwise rewrite the whole unread rest of the file.
      const confirmed = this.state.acked - this.firstSeq + 1
      if (confirmed > 0 && confirmed * 2 >= this.durableHead - this.firstSeq + 1 && this.bytes > this.o.compactBytes / 2) await this.compactNow()
    })
  }

  /** A leader with this standing spoke: remember the highest (channel.ts comparePermit). */
  async notePermit(p: PermitPair): Promise<void> {
    if (!isPermitPair(p) || comparePermit(p, this.permitPair) <= 0) return
    this.state.permit = p.epoch
    if (p.permitNumber > 0) this.state.permitNumber = p.permitNumber
    else delete this.state.permitNumber
    await this.serial(() => this.saveState())
  }

  /** The durable records after `after`, as kept on disk (cut fields, summaries), in seq order. */
  async read(after: number, limit = Number.MAX_SAFE_INTEGER): Promise<FactRecord[]> {
    // Read between writes, so a compaction's rename never races the read.
    let out: FactRecord[] = []
    await this.serial(async () => {
      const { records } = await readRecords(this.file)
      out = records.filter((r) => r.seq > after && r.seq <= this.durableHead)
    })
    return out.length > limit ? out.slice(0, limit) : out
  }

  /** Rewrite the file now (tests; the size and ack triggers call it themselves). */
  compact(): Promise<void> { return this.serial(() => this.compactNow()) }

  async close(): Promise<void> {
    await this.flush()
    this.closed = true
    this.listeners.clear()
  }

  private schedule(): void {
    if (this.timer) return
    this.timer = setTimeout(() => { this.timer = null; void this.serial(() => this.writeBuffered()) }, this.o.flushMs)
  }

  private serial(fn: () => Promise<void>): Promise<void> {
    const run = this.chain.then(fn)
    this.chain = run.catch((err: unknown) => {
      this.o.log?.('warn', 'fact log: a write failed', { walnutId: this.o.walnutId, error: err instanceof Error ? err.message : String(err) })
    })
    return run
  }

  private async writeBuffered(): Promise<void> {
    if (this.buffered.length === 0) return
    const batch = this.buffered
    this.buffered = []
    const text = batch.map((b) => b.line).join('')
    const fh = await fsp.open(this.file, 'a', 0o600)
    let before = -1
    try {
      before = (await fh.stat()).size
      const { bytesWritten } = await fh.write(text)
      if (bytesWritten !== Buffer.byteLength(text)) throw new Error(`a short write (${bytesWritten} of ${Buffer.byteLength(text)} bytes)`)
      if (this.o.durable) await fh.datasync()
    } catch (err) {
      // Not written whole: what part of it landed goes again (no torn line hides the records after
      // it, no record is kept twice), and the batch goes back in front, so order holds.
      if (before >= 0) await fh.truncate(before).catch(() => {})
      this.buffered = [...batch, ...this.buffered]
      throw err
    } finally {
      await fh.close()
    }
    this.bytes += Buffer.byteLength(text)
    if (this.firstSeq > this.durableHead) this.firstSeq = batch[0].full.seq
    this.durableHead = batch[batch.length - 1].full.seq
    const recs = batch.map((b) => b.full)
    const told = this.state.told ??= {}
    const said = this.state.said ??= {}
    for (const b of batch) {
      const r = b.full
      const t = foldTold(told[r.sid], r.line, r.name)
      if (t) told[r.sid] = t
      const d = foldSaid(said[r.sid], { ...(r.line ? { line: r.line } : {}), ...(b.src !== undefined ? { src: b.src } : {}) })
      if (d) said[r.sid] = d
    }
    for (const cb of this.listeners) {
      try { cb(recs) } catch (err) {
        this.o.log?.('warn', 'fact log: a listener threw', { error: err instanceof Error ? err.message : String(err) })
      }
    }
    if (this.bytes > Math.max(this.o.compactBytes, this.compactAgainAt)) await this.compactNow()
  }

  private async compactNow(): Promise<void> {
    const { records } = await readRecords(this.file)
    const kept = compactRecords(records.filter((r) => r.seq > this.state.acked))
    const tmp = `${this.file}.tmp`
    const text = kept.map((r) => JSON.stringify(r) + '\n').join('')
    const fh = await fsp.open(tmp, 'w', 0o600)
    try {
      await fh.write(text)
      if (this.o.durable) await fh.datasync()
    } finally {
      await fh.close()
    }
    await this.saveState()
    await fsp.rename(tmp, this.file)
    const before = this.bytes
    this.bytes = Buffer.byteLength(text)
    this.firstSeq = kept[0]?.seq ?? this.durableHead + 1
    // Not again on size until the file doubles: what compaction could not drop (facts the leader has
    // not read) would be read, parsed and rewritten whole at every flush (2026-11-25: 100 MB a flush).
    this.compactAgainAt = this.bytes * 2
    this.o.log?.('info', 'fact log: compacted', { walnutId: this.o.walnutId, records: records.length, kept: kept.length, before, after: this.bytes })
  }

  private async saveState(): Promise<void> {
    const tmp = `${this.stateFile}.tmp`
    const fh = await fsp.open(tmp, 'w', 0o600)
    try {
      await fh.writeFile(JSON.stringify(this.state))
      // Durable before the rename: a power loss never leaves an empty state (a new log id, every fact said again).
      if (this.o.durable) await fh.sync()
    } finally {
      await fh.close()
    }
    await fsp.rename(tmp, this.stateFile)
  }
}

async function readRecords(file: string): Promise<{ records: FactRecord[]; validBytes: number; totalBytes: number }> {
  let buf: Buffer
  try { buf = await fsp.readFile(file) } catch { return { records: [], validBytes: 0, totalBytes: 0 } }
  const records: FactRecord[] = []
  let start = 0
  let valid = 0
  while (start < buf.length) {
    const nl = buf.indexOf(10, start)
    if (nl < 0) break // a torn last line
    try {
      const r = JSON.parse(buf.subarray(start, nl).toString('utf8')) as FactRecord
      // In seq order, once each: a record kept twice (a write retried after its sync failed) is read once.
      if (r && r.kind === 'session-fact' && Number.isSafeInteger(r.seq) && r.seq > (records[records.length - 1]?.seq ?? 0)) records.push(r)
    } catch { break }
    start = nl + 1
    valid = start
  }
  return { records, validBytes: valid, totalBytes: buf.length }
}

/** The inline cap of a fact log's records on disk, unless its options name another. */
export const FACT_INLINE_CAP = 16 * 1024

/** The record as kept on disk: every string over `cap` bytes cut, and named in `refs`; a `row` record whole. */
export function capRecord(rec: FactRecord, cap: number): FactRecord {
  if (rec.name === 'row') return rec
  const refs: Record<string, FactRef> = {}
  const walk = (v: unknown, at: string, depth: number): unknown => {
    if (typeof v === 'string') {
      if (v.length <= cap) return v
      refs[at || '.'] = { ...(rec.line?.epoch ? { epoch: rec.line.epoch } : {}), ...(rec.line ? { v: rec.line.v } : {}), bytes: Buffer.byteLength(v) }
      return v.slice(0, cap)
    }
    if (depth > 8 || v === null || typeof v !== 'object') return v
    if (Array.isArray(v)) return v.map((x, i) => walk(x, at ? `${at}.${i}` : String(i), depth + 1))
    const out: Record<string, unknown> = {}
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) out[k] = walk(x, at ? `${at}.${k}` : k, depth + 1)
    return out
  }
  const data = walk(rec.data, '', 0)
  return Object.keys(refs).length ? { ...rec, data, refs } : rec
}

/** The row field a ref path names ('patch.title.0' names title), or null. */
const rowFieldOf = (path: string): string | null => (path.startsWith('patch.') ? path.slice(6).split('.')[0] || null : null)

/**
 * The fields of a `row` record's patch an older log cut on disk (its `refs`; a row that log's
 * compaction merged lost them, and a field cut there is exactly `cap` characters long): the
 * leader keeps its own value of each, never the cut one.
 */
export function cutRowFields(rec: Pick<FactRecord, 'name' | 'data' | 'refs'>, cap = FACT_INLINE_CAP): string[] {
  if (rec.name !== 'row') return []
  const out = new Set<string>()
  for (const path of Object.keys(rec.refs ?? {})) { const f = rowFieldOf(path); if (f) out.add(f) }
  const patch = (rec.data as { patch?: Record<string, unknown> } | null)?.patch ?? {}
  for (const [k, v] of Object.entries(patch)) if (typeof v === 'string' && v.length === cap) out.add(k)
  return [...out]
}

/**
 * Stand one summary for the detail facts of each finished turn of each session, and one merged
 * row patch for its row patches. A turn is a session's records after its last `session:result`
 * up to and including the next one; the records of a turn still running stay as they are.
 */
export function compactRecords(records: readonly FactRecord[]): FactRecord[] {
  const bySid = new Map<string, FactRecord[]>()
  for (const r of records) { const list = bySid.get(r.sid) ?? []; list.push(r); bySid.set(r.sid, list) }
  const replace = new Map<number, FactRecord | null>() // seq -> its stand-in (null: dropped)
  for (const list of bySid.values()) {
    let turn: FactRecord[] = []
    for (const r of list) {
      turn.push(r)
      if (r.name !== TURN_END_FACT) continue
      const detail = turn.filter((x) => TURN_DETAIL_FACTS.has(x.name) || x.name === 'turn-summary')
      if (detail.length > 1) {
        const tools: Record<string, number> = {}
        let toolUses = 0
        let lastUsage: unknown
        for (const d of detail) {
          if (d.name === 'turn-summary') {
            const s = d.data as { toolUses?: number; tools?: Record<string, number>; usage?: unknown }
            toolUses += s.toolUses ?? 0
            for (const [k, n] of Object.entries(s.tools ?? {})) tools[k] = (tools[k] ?? 0) + n
            if (s.usage !== undefined) lastUsage = s.usage
          } else if (d.name === 'session:tool-use') {
            toolUses++
            const name = String((d.data as { name?: unknown })?.name ?? (d.data as { toolName?: unknown })?.toolName ?? 'tool')
            tools[name] = (tools[name] ?? 0) + 1
          } else if (d.name === 'session:usage-update') lastUsage = d.data
        }
        const lines = detail.map((d) => d.line?.v).filter((v): v is number => typeof v === 'number')
        const first = detail[0]
        replace.set(first.seq, {
          ...first, name: 'turn-summary', refs: undefined, line: undefined,
          data: { facts: detail.length, toolUses, tools, ...(lastUsage !== undefined ? { usage: lastUsage } : {}), ...(lines.length ? { vFrom: Math.min(...lines), vTo: Math.max(...lines) } : {}) },
        })
        for (const d of detail.slice(1)) replace.set(d.seq, null)
      }
      const rows = turn.filter((x) => x.name === 'row')
      if (rows.length > 1) {
        const merged: Record<string, unknown> = {}
        // A field an older log cut stays named as cut, until a later patch of the turn sets it again.
        const refs: Record<string, FactRef> = {}
        for (const x of rows) {
          const patch = (x.data as { patch?: Record<string, unknown> })?.patch ?? {}
          Object.assign(merged, patch)
          for (const path of Object.keys(refs)) if (rowFieldOf(path)! in patch) delete refs[path]
          for (const [path, ref] of Object.entries(x.refs ?? {})) if (rowFieldOf(path)) refs[path] = ref
        }
        const last = rows[rows.length - 1]
        const born = rows.some((x) => (x.data as { born?: boolean })?.born)
        // A born row's echo of its start's hand (host-emitter.ts) stays with the merged row.
        const hand = rows.map((x) => (x.data as { hand?: unknown })?.hand).find((h): h is string => typeof h === 'string')
        replace.set(last.seq, { ...last, refs: Object.keys(refs).length ? refs : undefined, data: { ...(born ? { born: true } : {}), ...(hand ? { hand } : {}), patch: merged } })
        for (const x of rows.slice(0, -1)) replace.set(x.seq, null)
      }
      turn = []
    }
  }
  // A session's newest `live` record, and its newest snapshot of each kind (SNAPSHOT_FACTS), stands
  // for every earlier one. A snapshot a finished turn's summary already stands for keeps its place.
  const newest = new Map<string, number>()
  const snapshotOf = (r: FactRecord): string | null => (r.name === 'live' || SNAPSHOT_FACTS.has(r.name) ? `${r.sid}\u0000${r.name}` : null)
  for (const r of records) { const k = snapshotOf(r); if (k) newest.set(k, r.seq) }
  for (const r of records) {
    const k = snapshotOf(r)
    if (k && newest.get(k) !== r.seq && !replace.has(r.seq)) replace.set(r.seq, null)
  }
  // A session the leader deleted (its `drop` record): nothing of it before the drop is sent any more.
  const droppedAt = new Map<string, number>()
  for (const r of records) if (r.name === 'drop') droppedAt.set(r.sid, r.seq)
  for (const r of records) { const at = droppedAt.get(r.sid); if (at !== undefined && r.seq < at) replace.set(r.seq, null) }
  const out: FactRecord[] = []
  for (const r of records) {
    if (!replace.has(r.seq)) { out.push(r); continue }
    const s = replace.get(r.seq)
    if (s) out.push(stripUndefined(s))
  }
  return out
}

function stripUndefined(r: FactRecord): FactRecord {
  const out = { ...r } as Record<string, unknown>
  for (const k of Object.keys(out)) if (out[k] === undefined) delete out[k]
  return out as unknown as FactRecord
}
