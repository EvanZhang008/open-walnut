/**
 * Remote sessions' tail windows (history-tail-window.ts) kept across restarts, so the first
 * history read of a host's big transcript after a deploy moves only what the CLI appended
 * since, not the whole window (4 MB) over the host's link again. About 70 restarts a day.
 *
 * Files, per window, in WALNUT_HOME/cache/history-tail-windows/ (not synced):
 *  - `<hash of key>.win`: a header line `{v, id, base}`, then the transcript's raw bytes from
 *    file offset `base` (a line start) on. Never a parse: the code that runs parses it again, so
 *    a parser change needs no version bump.
 *  - `<hash of key>.json`: the small description (key, path, epoch, mtime, where the window
 *    ends and where its last line starts, and the data file's `id` and `base`).
 *
 * Writes grow with what the transcript gained, never with the window (2026-11-25, the Walnut
 * VP: rewriting 4 MB per busy session every 30 s is about 80 MB a minute for ten sessions).
 * A window is written whole once; after that a save writes at its old end only the bytes
 * appended since, plus the description. When the data has grown to COMPACT_FACTOR times the
 * window, it is written whole once more from the window's start: about 1.5 bytes written per
 * byte appended. Saves of one window are at most one per SAVE_EVERY_MS; stop writes what is due.
 * A crash between the data and the description is harmless: the description says how many
 * bytes count, and the next append writes at that offset; a whole rewrite takes a new `id`, so
 * a description of the old data never reads the new one.
 *
 * What is kept: only windows of a host's transcript, at most MAX_DISK_WINDOWS and
 * MAX_DISK_WINDOW_BYTES together, the least recently written going first.
 *
 * Trust: the boot reads only the descriptions and the data headers (anything that is not a
 * whole window of this version is removed). A window's data is read when its session is first
 * read, and history-tail-window.ts serves it only after checking it against the file as it is
 * now: same path and epoch, a size that did not shrink, and its last line read again from the
 * file, byte for byte (the check a window grown in memory gets). Anything else is a fresh read,
 * and the copy is removed. An older Walnut never reads these files.
 */
import crypto from 'node:crypto'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { log } from '../logging/index.js'
import { writeFileAtomic } from './config-file-io.js'

const VERSION = 1
/**
 * At most this many windows on disk: never fewer than the windows held in memory
 * (history-tail-window.ts MAX_TAIL_WINDOWS, a test holds it), or the disk would push out, at
 * every save, a window still in use, and write it whole again at its next save.
 */
export const MAX_DISK_WINDOWS = 24
/** Data past this many times the window (or COMPACT_MIN_BYTES) is written whole again from the window's start. */
export const COMPACT_FACTOR = 3
const COMPACT_MIN_BYTES = 256 * 1024
/** The widest window kept (the history route's cold read and the over-ceiling tail). */
const WIDEST_WINDOW = 4 * 1024 * 1024
/** And at most this many bytes of their data together: every window at its largest. */
export const MAX_DISK_WINDOW_BYTES = MAX_DISK_WINDOWS * COMPACT_FACTOR * WIDEST_WINDOW
/** Saves of one window inside this make one write. */
export const TAIL_WINDOW_SAVE_EVERY_MS = 30_000
/**
 * A window new on disk that would push out one saved within this is not written now (more host
 * sessions active than the caps hold): it waits for a later save, or for the stop's flush.
 * Without this, each such save pushed out the next window due and that one came back whole.
 */
export const ADMIT_RECENT_MS = 10 * 60_000
const HEADER_MAX = 16 * 1024

/** A window as it is written and read back (history-tail-window.ts TailWindow, minus its parse). */
export interface DiskTailWindow {
  path: string
  epoch?: string
  mtimeMs: number | null
  end: number
  lastLineStart: number
  lastLine: Buffer
  lines: Buffer
  /** Which line of reads it belongs to (newTailLineage): only the same lineage appends to its data. */
  lineage?: number
}

/** The description file. */
interface Meta {
  v: number
  key: string
  path: string
  epoch?: string
  mtimeMs: number | null
  end: number
  lastLineStart: number
  /** The data file's id and the transcript offset its bytes start at. */
  id: string
  base: number
  savedAt: number
}

interface Kept {
  meta: Meta
  /** Bytes of the data file's header line. */
  headerBytes: number
  /** Bytes of the data file, as last written (counted against MAX_DISK_WINDOW_BYTES). */
  bytes: number
  /** The lineage whose window this data holds; undefined until read back or written here. */
  lineage?: number
}

let dir: string | null = null
let loading: Promise<void> | null = null
const index = new Map<string, Kept>()
/**
 * Per key: the save asked (`get` read when its write runs; `retry` false: a save of a window
 * leaving memory, dropped rather than held when it is not admitted), its timer, its write chain,
 * and the saves not admitted, kept for the stop's flush.
 */
interface Asked { get: () => DiskTailWindow | undefined; retry: boolean }
const asked = new Map<string, Asked>()
const deferred = new Map<string, Asked>()
/** Per key: bumped by every removal, so a write that ran across one never puts its entry back. */
const gens = new Map<string, number>()
const timers = new Map<string, ReturnType<typeof setTimeout>>()
const chains = new Map<string, Promise<void>>()
const reading = new Map<string, Promise<DiskTailWindow | null>>()
let lineages = 0
let bytesWritten = 0

/** A new line of reads (a fresh window read): its data is never appended to another's. */
export function newTailLineage(): number {
  return ++lineages
}

const hashOf = (key: string): string => crypto.createHash('sha256').update(key).digest('hex').slice(0, 40)
const dataFile = (key: string): string => path.join(dir as string, `${hashOf(key)}.win`)
const metaFile = (key: string): string => path.join(dir as string, `${hashOf(key)}.json`)
const errText = (err: unknown): string => err instanceof Error ? err.message : String(err)

function isMeta(m: unknown): m is Meta {
  if (!m || typeof m !== 'object') return false
  const x = m as Meta
  const n = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0
  return x.v === VERSION && typeof x.key === 'string' && typeof x.path === 'string' && typeof x.id === 'string'
    && (x.epoch === undefined || typeof x.epoch === 'string') && (x.mtimeMs === null || n(x.mtimeMs))
    && n(x.end) && n(x.lastLineStart) && n(x.base) && n(x.savedAt)
    && x.base <= x.lastLineStart && x.lastLineStart < x.end
}

/** The data header in a data file's first bytes, and its length; null when it is not ours. */
function dataHeaderOf(buf: Buffer): { id: string; base: number; bytes: number } | null {
  const nl = buf.indexOf(0x0a)
  if (nl < 0 || nl > HEADER_MAX) return null
  try {
    const h = JSON.parse(buf.subarray(0, nl).toString('utf-8')) as { v?: unknown; id?: unknown; base?: unknown }
    return h.v === VERSION && typeof h.id === 'string' && typeof h.base === 'number' ? { id: h.id, base: h.base, bytes: nl + 1 } : null
  } catch {
    return null
  }
}

/** Run `work` after the key's earlier writes and removals, one at a time per key. */
function onChain(key: string, work: () => Promise<void>): Promise<void> {
  const next = (chains.get(key) ?? Promise.resolve()).then(work).catch((err) => {
    log.session.debug('tail windows: window not kept', { error: errText(err) })
  })
  chains.set(key, next)
  void next.finally(() => { if (chains.get(key) === next) chains.delete(key) })
  return next
}

/** Remove one kept window: what is asked is forgotten, and its files go after its running write. */
function forget(key: string): void {
  gens.set(key, (gens.get(key) ?? 0) + 1)
  index.delete(key)
  reading.delete(key)
  asked.delete(key)
  deferred.delete(key)
  const t = timers.get(key)
  if (t) clearTimeout(t)
  timers.delete(key)
  if (!dir) return
  const files = [dataFile(key), metaFile(key)]
  void onChain(key, async () => { await Promise.all(files.map((f) => fsp.rm(f, { force: true }))) })
}

/** The least recently written go until the count and the bytes are within the caps; the newest stays. */
function prune(): void {
  const byAge = [...index].sort((a, b) => a[1].meta.savedAt - b[1].meta.savedAt)
  let bytes = byAge.reduce((sum, [, k]) => sum + k.bytes, 0)
  let count = byAge.length
  for (const [key, k] of byAge) {
    if (count <= MAX_DISK_WINDOWS && bytes <= MAX_DISK_WINDOW_BYTES) break
    if (count === 1) break
    forget(key)
    bytes -= k.bytes
    count--
  }
}

/**
 * Whether writing `bytes` for `key` (new on disk, or written whole again) would push out a
 * window saved within ADMIT_RECENT_MS: the same order prune() goes in.
 */
function pushesOutRecent(key: string, bytes: number): boolean {
  const others = [...index].filter(([k]) => k !== key).sort((a, b) => a[1].meta.savedAt - b[1].meta.savedAt)
  let count = others.length + 1
  let total = others.reduce((sum, [, k]) => sum + k.bytes, bytes)
  const recent = Date.now() - ADMIT_RECENT_MS
  for (const [, k] of others) {
    if (count <= MAX_DISK_WINDOWS && total <= MAX_DISK_WINDOW_BYTES) return false
    if (k.meta.savedAt > recent) return true
    count--
    total -= k.bytes
  }
  return false
}

/** One window's description and its data header, checked against each other; null when not whole. */
async function readKept(where: string, metaName: string): Promise<Kept | null> {
  const meta = JSON.parse(await fsp.readFile(path.join(where, metaName), 'utf8')) as unknown
  if (!isMeta(meta) || `${hashOf(meta.key)}.json` !== metaName) return null
  const fh = await fsp.open(path.join(where, `${hashOf(meta.key)}.win`), 'r')
  try {
    const { size } = await fh.stat()
    const head = Buffer.alloc(Math.min(size, HEADER_MAX + 1))
    await fh.read(head, 0, head.length, 0)
    const h = dataHeaderOf(head)
    if (!h || h.id !== meta.id || h.base !== meta.base || size < h.bytes + (meta.end - meta.base)) return null
    return { meta, headerBytes: h.bytes, bytes: size }
  } finally {
    await fh.close()
  }
}

/**
 * Boot, after the listen: read the kept windows' descriptions and data headers (never the data),
 * remove what is not a whole window of this version, and keep windows from now on. Once per process.
 */
export function startTailWindowDisk(at?: string): Promise<void> {
  if (loading || dir) return loading ?? Promise.resolve()
  const load = (async () => {
    const where = at ?? path.join((await import('../constants.js')).WALNUT_HOME, 'cache', 'history-tail-windows')
    await fsp.mkdir(where, { recursive: true })
    dir = where
    const names = await fsp.readdir(where).catch(() => [] as string[])
    const keep = new Set<string>()
    for (const name of names.filter((n) => n.endsWith('.json'))) {
      const kept = await readKept(where, name).catch(() => null)
      if (!kept) continue
      index.set(kept.meta.key, kept)
      keep.add(name)
      keep.add(name.replace(/\.json$/, '.win'))
    }
    // A temp a stop cut short, a data file with no description, anything not a whole window.
    for (const name of names) {
      if (!keep.has(name)) await fsp.rm(path.join(where, name), { force: true, recursive: true }).catch(() => {})
    }
    prune()
    if (index.size > 0) log.session.info('tail windows: kept windows found', { windows: index.size })
  })().catch((err) => {
    log.session.debug('tail windows: kept windows not read', { error: errText(err) })
  }).finally(() => { loading = null })
  loading = load
  return load
}

/**
 * The window kept for `key` when it is of this file incarnation (`path`, `epoch`), or null: only
 * its newest `window` bytes from a line start (as a fresh window read keeps them) and its last
 * line are read, checked against its description; the caller still checks it against the file
 * (history-tail-window.ts) before it answers. A copy of another file is removed.
 */
export async function readDiskTailWindow(key: string, filePath: string, epoch: string | undefined, window: number): Promise<DiskTailWindow | null> {
  if (loading) await loading
  if (!dir) return null
  const kept = index.get(key)
  if (!kept) return null
  if (kept.meta.path !== filePath || kept.meta.epoch !== epoch) { forget(key); return null }
  const running = reading.get(key)
  if (running) return running
  const work = (async (): Promise<DiskTailWindow | null> => {
    try {
      // After a write of this key already running, so the data matches the description read.
      await chains.get(key)
      const now = index.get(key)
      if (!now) return null
      const m = now.meta
      const from = Math.max(m.base, m.end - window)
      const readFrom = Math.min(from, m.lastLineStart)
      const fh = await fsp.open(dataFile(key), 'r')
      let buf: Buffer
      try {
        const head = Buffer.alloc(Math.min(now.headerBytes, HEADER_MAX + 1))
        await fh.read(head, 0, head.length, 0)
        const h = dataHeaderOf(head)
        if (!h || h.id !== m.id || h.base !== m.base || h.bytes !== now.headerBytes) { forget(key); return null }
        buf = Buffer.alloc(m.end - readFrom)
        const { bytesRead } = await fh.read(buf, 0, buf.length, h.bytes + (readFrom - m.base))
        if (bytesRead !== buf.length) { forget(key); return null }
      } finally {
        await fh.close()
      }
      // From `base` the bytes start a line; from inside, the window's lines start after the first
      // newline at or past its start, as a fresh window read keeps them.
      let lines = buf
      if (from > m.base) {
        const nl = buf.indexOf(0x0a, from - readFrom)
        lines = nl < 0 ? buf.subarray(buf.length) : buf.subarray(nl + 1)
      }
      // A copy: a window that does not grow keeps its last line, and a slice would hold the read.
      const lastLine = Buffer.from(buf.subarray(m.lastLineStart - readFrom))
      if (lastLine.length === 0 || lastLine[lastLine.length - 1] !== 0x0a) { forget(key); return null }
      now.lineage = newTailLineage()
      return {
        path: m.path, ...(m.epoch !== undefined ? { epoch: m.epoch } : {}), mtimeMs: m.mtimeMs,
        end: m.end, lastLineStart: m.lastLineStart, lastLine, lines, lineage: now.lineage,
      }
    } catch (err) {
      log.session.debug('tail windows: kept window unreadable', { error: errText(err) })
      forget(key)
      return null
    }
  })().finally(() => { if (reading.get(key) === work) reading.delete(key) })
  reading.set(key, work)
  return work
}

/** Append to `kept`'s data the bytes of `w` past its end; false when its data file is gone. */
async function append(key: string, kept: Kept, w: DiskTailWindow): Promise<Kept | false> {
  const add = w.lines.subarray(w.lines.length - (w.end - kept.meta.end))
  const at = kept.headerBytes + (kept.meta.end - kept.meta.base)
  let fh: fsp.FileHandle
  try {
    fh = await fsp.open(dataFile(key), 'r+')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw err
  }
  try {
    // Written where the counted data ends: bytes a crash left past it are cut.
    if (add.length > 0) await fh.write(add, 0, add.length, at)
    await fh.truncate(at + add.length)
  } finally {
    await fh.close()
  }
  bytesWritten += add.length
  return { ...kept, bytes: at + add.length, meta: { ...kept.meta, mtimeMs: w.mtimeMs, end: w.end, lastLineStart: w.lastLineStart, savedAt: Date.now() } }
}

/**
 * Write the window: only the bytes past what its data holds when that is the same lineage, else
 * whole. A whole write that would push out a window saved recently is not done unless `admitAll`
 * (the stop's flush): 'deferred'.
 */
async function write(key: string, w: DiskTailWindow, admitAll: boolean, gen: number): Promise<'written' | 'deferred'> {
  const kept = index.get(key)
  const linesStart = w.end - w.lines.length
  const compactAt = COMPACT_FACTOR * Math.max(w.lines.length, COMPACT_MIN_BYTES)
  const appendable = kept !== undefined && w.lineage !== undefined && kept.lineage === w.lineage
    && kept.meta.path === w.path && kept.meta.epoch === w.epoch
    && w.end >= kept.meta.end && kept.meta.end >= linesStart && w.end - kept.meta.base <= compactAt
  let next = appendable ? await append(key, kept, w) : false
  if (!next) {
    // Whole, from the window's start, or from its last line when that one line is longer than the window.
    const base = Math.min(linesStart, w.lastLineStart)
    const body = base < linesStart ? w.lastLine : w.lines
    if (!admitAll && pushesOutRecent(key, body.length)) return 'deferred'
    const id = crypto.randomBytes(8).toString('hex')
    const head = Buffer.from(`${JSON.stringify({ v: VERSION, id, base })}\n`, 'utf-8')
    const data = Buffer.concat([head, body])
    await writeFileAtomic(dataFile(key), data)
    bytesWritten += data.length
    next = {
      headerBytes: head.length, bytes: data.length, ...(w.lineage !== undefined ? { lineage: w.lineage } : {}),
      meta: {
        v: VERSION, key, path: w.path, ...(w.epoch !== undefined ? { epoch: w.epoch } : {}), mtimeMs: w.mtimeMs,
        end: w.end, lastLineStart: w.lastLineStart, id, base, savedAt: Date.now(),
      },
    }
  }
  const meta = JSON.stringify(next.meta)
  await writeFileAtomic(metaFile(key), meta)
  bytesWritten += Buffer.byteLength(meta)
  // Removed while it wrote (pushed out, dropped): the removal queued after it takes the files.
  if ((gens.get(key) ?? 0) !== gen) return 'written'
  index.set(key, next)
  prune()
  return 'written'
}

/** Run the save asked for `key` now (its timer fired, or a flush); `admitAll`: the stop's flush. */
function runAsked(key: string, admitAll = false): Promise<void> {
  const t = timers.get(key)
  if (t) clearTimeout(t)
  timers.delete(key)
  const current = asked.get(key) ?? (admitAll ? deferred.get(key) : undefined)
  asked.delete(key)
  deferred.delete(key)
  if (!current) return chains.get(key) ?? Promise.resolve()
  // A removal from here on (queued after this write) wins: the write then never puts its entry back.
  const gen = gens.get(key) ?? 0
  return onChain(key, async () => {
    if (!dir || (gens.get(key) ?? 0) !== gen) return
    const w = current.get()
    if (!w) return
    // Not admitted: a later save tries again, and the stop's flush writes it (unless asked anew since).
    if (await write(key, w, admitAll, gen) === 'deferred' && current.retry && !asked.has(key)) deferred.set(key, current)
  })
}

/**
 * Ask for a write of the window `current` returns when the write runs (undefined: nothing to
 * write then). Asks for one key inside TAIL_WINDOW_SAVE_EVERY_MS make one write.
 */
export function saveDiskTailWindow(key: string, current: () => DiskTailWindow | undefined): void {
  if (!dir) return
  deferred.delete(key)
  asked.set(key, { get: current, retry: true })
  if (timers.has(key)) return
  const t = setTimeout(() => { void runAsked(key) }, TAIL_WINDOW_SAVE_EVERY_MS)
  t.unref?.()
  timers.set(key, t)
}

/**
 * A window leaving memory (history-tail-window.ts evict): a save still asked for it is written
 * now, so nothing holds its bytes outside the memory budget. Not admitted, it is dropped: the
 * copy on disk, older, still answers.
 */
export function saveDiskTailWindowNow(key: string, w: DiskTailWindow): void {
  if (!dir || (!asked.has(key) && !deferred.has(key))) return
  deferred.delete(key)
  asked.set(key, { get: () => w, retry: false })
  void runAsked(key)
}

/** The window kept for `key` no longer answers its file (a rewrite, a rewind): removed. */
export function dropDiskTailWindow(key: string): void {
  if (index.has(key) || asked.has(key) || deferred.has(key)) forget(key)
}

/** Every window kept for keys under `prefix` (a session's), removed. */
export function dropDiskTailWindows(prefix: string): void {
  for (const key of new Set([...index.keys(), ...asked.keys(), ...deferred.keys()])) if (key.startsWith(prefix)) forget(key)
}

/**
 * Write now every save asked, then every save not admitted before (server stop; the caller bounds
 * the wait). Most are appends of at most SAVE_EVERY_MS of growth; a window not yet on disk is whole.
 */
export async function flushTailWindowDisk(): Promise<void> {
  await Promise.all([...asked.keys()].map((key) => runAsked(key, true)))
  await Promise.all([...deferred.keys()].map((key) => runAsked(key, true)))
  // A write past the caps removes the oldest copy on its key's chain: wait for those too.
  await Promise.all([...chains.values()])
}

/** Test seam: the writes the timers started, settled (no flush). */
export async function _settleTailWindowDiskForTesting(): Promise<void> {
  await Promise.all([...chains.values()])
}

/** Test seam: bytes written to window files so far (data and descriptions). */
export function _tailWindowDiskBytesWrittenForTesting(): number {
  return bytesWritten
}

/** Test seam: forget the disk side (as a new process that has not started it). Files stay. */
export function _stopTailWindowDiskForTesting(): void {
  for (const t of timers.values()) clearTimeout(t)
  dir = null
  loading = null
  index.clear()
  asked.clear()
  deferred.clear()
  gens.clear()
  timers.clear()
  chains.clear()
  reading.clear()
}
