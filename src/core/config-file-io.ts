/**
 * How Walnut reads config.yaml as a file it shares with the user's editor.
 *
 * An editor that saves in place truncates the file and writes it again, one that
 * saves by rename removes it for a moment, and a slow one pauses between writes.
 * Each of those leaves a window where the file reads empty, missing or as a
 * prefix. Before this module, a reader that landed in the window wrote the
 * sidecar backup (Walnut's own last write, older than the edit) over the file,
 * and a read-modify-write merged into the backup, or into nothing, and renamed
 * that over the user's save.
 *
 * The rules here: a snapshot carries the file's identity (inode, size, mtime,
 * ctime) read on the same descriptor as the bytes; a bad state counts only after
 * the file has kept still for a quiet period; and every commit compares the
 * identity it read against the file right before it replaces it, so an edit that
 * landed in between is re-read, never overwritten. Everything is async: a wait is
 * a timer, never a block of the event loop.
 */
import fs from 'node:fs/promises'
import yaml from 'js-yaml'

export type ConfigFileState = 'ok' | 'missing' | 'empty' | 'unparseable' | 'unreadable'

/** Who the file is right now: a commit replaces only the file it read. */
export interface ConfigFileId { dev: number; ino: number; size: number; mtimeMs: number; ctimeMs: number }

export interface ConfigSnapshot {
  state: ConfigFileState
  content: string | null
  doc: Record<string, unknown> | null
  /** null when missing or unreadable. */
  id: ConfigFileId | null
  /** The file changed while it was being read (the bytes may mix two versions). */
  changing: boolean
  error?: string
}

function idOf(st: { dev: number; ino: number; size: number; mtimeMs: number; ctimeMs: number }): ConfigFileId {
  return { dev: st.dev, ino: st.ino, size: st.size, mtimeMs: st.mtimeMs, ctimeMs: st.ctimeMs }
}

/**
 * Same file, unchanged. `ctime: false` for the commit check: a backup tool or a
 * sync client that only touches metadata (xattrs) moves ctime alone, and a
 * filesystem with an attribute cache can report it differently on the path than
 * on the descriptor, which would make every commit conflict.
 */
export function sameFileId(a: ConfigFileId | null, b: ConfigFileId | null, opts: { ctime?: boolean } = {}): boolean {
  if (a === null || b === null) return a === b
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs
    && (opts.ctime === false || a.ctimeMs === b.ctimeMs)
}

/** The file's identity now; null when it does not exist. */
export async function statFileId(file: string): Promise<ConfigFileId | null> {
  try { return idOf(await fs.stat(file)) } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw err
  }
}

/** A YAML mapping, or null for anything else (empty, a scalar, a list, a syntax error). */
/**
 * The last text parsed and its mapping. Every getConfig reads config.yaml, and on the live
 * server that was many YAML parses a second (2026-11-23: 1.9 s of a 30 s CPU profile during
 * the 22 GB climb); the file changes a few times a day. A copy of the kept mapping is handed
 * out, so a caller that edits what it got never changes the next caller's.
 *
 * The copy is cloneYamlData, not structuredClone: on a 24 KB config Bun's structuredClone
 * costs about 250 us, nine times a plain walk, and getConfig runs some 20 times a second on
 * the live server (2026-11-25 stall profiles: 8.9 s of 395 s of loop CPU was this one clone).
 */
let lastParsed: { content: string; doc: Record<string, unknown> } | null = null

/**
 * A deep copy of what js-yaml loads: plain mappings, lists, scalars and Dates (a YAML
 * timestamp). Anything else (a `!!binary` buffer) goes through structuredClone, as before.
 * A `__proto__` key stays an own key, as in the loaded mapping, never the copy's prototype.
 * Like structuredClone, a value reached twice is copied once: an alias (`*x`) stays one shared
 * object in the copy, and an anchor that names itself (`a: &x {b: *x}`) stays a cycle, never a
 * stack overflow (which read a valid file as unparseable) nor an alias bomb expanded.
 */
export function cloneYamlData<T>(value: T, seen: Map<object, unknown> = new Map()): T {
  if (value === null || typeof value !== 'object') return value
  const held = seen.get(value)
  if (held !== undefined) return held as T
  if (value instanceof Date) {
    const copy = new Date(value.getTime())
    seen.set(value, copy)
    return copy as T
  }
  if (Array.isArray(value)) {
    const out: unknown[] = new Array(value.length)
    seen.set(value, out)
    for (let i = 0; i < value.length; i++) out[i] = cloneYamlData(value[i], seen)
    return out as T
  }
  const proto = Object.getPrototypeOf(value)
  if (proto !== Object.prototype && proto !== null) {
    const copy = structuredClone(value)
    seen.set(value, copy)
    return copy
  }
  const out: Record<string, unknown> = {}
  seen.set(value, out)
  for (const key of Object.keys(value)) {
    const v = cloneYamlData((value as Record<string, unknown>)[key], seen)
    if (key === '__proto__') Object.defineProperty(out, key, { value: v, enumerable: true, writable: true, configurable: true })
    else out[key] = v
  }
  return out as T
}

export function parseConfigMapping(content: string): { doc: Record<string, unknown> | null; error?: string } {
  if (lastParsed && lastParsed.content === content) return { doc: cloneYamlData(lastParsed.doc) }
  try {
    const parsed = yaml.load(content)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      lastParsed = { content, doc: cloneYamlData(parsed as Record<string, unknown>) }
      return { doc: parsed as Record<string, unknown> }
    }
    return { doc: null, error: 'not a YAML mapping' }
  } catch (err) {
    return { doc: null, error: err instanceof Error ? err.message.split('\n')[0] : String(err) }
  }
}

/**
 * The text of the last read that the file's identity alone can vouch for: read whole, unchanged
 * while it was read, and last changed at least KEPT_TEXT_SETTLED_MS before the read. A later read
 * whose descriptor shows the same identity takes this text instead of reading the bytes again:
 * getConfig runs some 20 times a second on the live server, and each read made a 25 KB buffer and
 * a 50 KB string (the file holds non-ASCII text) for the same bytes (2026-11-25, the memory bursts
 * after a start). Any write after that read moves the identity: its mtime and ctime are at least
 * the read's clock second, which a stamp that old cannot be even on a filesystem that keeps whole
 * seconds; a replace by rename is a new inode.
 */
let keptText: { file: string; id: ConfigFileId; content: string } | null = null
const KEPT_TEXT_SETTLED_MS = 2_000
let keptTextSettledMs = KEPT_TEXT_SETTLED_MS

/** Read the file and its identity on one descriptor, so the two describe the same bytes. */
export async function readConfigSnapshot(file: string): Promise<ConfigSnapshot> {
  let fh: fs.FileHandle
  try { fh = await fs.open(file, 'r') } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return { state: 'missing', content: null, doc: null, id: null, changing: false }
    return { state: 'unreadable', content: null, doc: null, id: null, changing: false, error: err instanceof Error ? err.message : String(err) }
  }
  let content: string
  let before: ConfigFileId
  let after: ConfigFileId
  try {
    // Taken before the first stat: a write after it moves the file's stamp past this time, so a
    // stamp at least keptTextSettledMs older than it holds even on a 2 s timestamp filesystem.
    const readAt = Date.now()
    before = idOf(await fh.stat())
    const kept = keptText
    if (kept && kept.file === file && sameFileId(kept.id, before)) {
      content = kept.content
      after = before
    } else {
      content = await fh.readFile('utf-8')
      after = idOf(await fh.stat())
      keptText = sameFileId(before, after) && readAt - Math.max(after.mtimeMs, after.ctimeMs) >= keptTextSettledMs
        ? { file, id: after, content } : null
    }
  } catch (err) {
    return { state: 'unreadable', content: null, doc: null, id: null, changing: false, error: err instanceof Error ? err.message : String(err) }
  } finally {
    await fh.close().catch(() => {})
  }
  const changing = !sameFileId(before, after)
  if (!content.trim()) return { state: 'empty', content, doc: null, id: after, changing }
  const { doc, error } = parseConfigMapping(content)
  if (!doc) return { state: 'unparseable', content, doc: null, id: after, changing, error }
  return { state: 'ok', content, doc, id: after, changing }
}

/** For tests: forget the kept text, as a new process starts; `settledMs` shortens the window (null: the real one). */
export function _forgetKeptConfigTextForTesting(settledMs: number | null = null): void {
  keptText = null
  keptTextSettledMs = settledMs ?? KEPT_TEXT_SETTLED_MS
}

// Not unref'd: a short-lived process (the CLI) waiting here must not exit mid-await.
const sleep = (ms: number) => new Promise<void>((r) => { setTimeout(r, ms) })

/**
 * Wait until the file has kept the same identity (or stayed missing) for
 * `quietMs`, and return that identity. Returns `{ changed: true }` as soon as it
 * changes (someone is writing it: read it again rather than wait out a fresh
 * quiet period), and undefined at the deadline.
 */
export async function waitForQuietFile(
  file: string,
  opts: { quietMs: number; deadline: number; from: ConfigFileId | null },
): Promise<{ id: ConfigFileId | null } | { changed: true } | undefined> {
  const step = Math.max(10, Math.min(50, Math.floor(opts.quietMs / 8)))
  const since = Date.now()
  for (;;) {
    // Measured against the state the caller read, so a change that landed just
    // after that read counts as a change, not as the start of the quiet period.
    if (!sameFileId(await statFileId(file), opts.from, { ctime: false })) return { changed: true }
    if (Date.now() - since >= opts.quietMs) return { id: opts.from }
    if (Date.now() >= opts.deadline) return undefined
    await sleep(step)
  }
}

/**
 * Whether a file read as `id` has finished being written: its last change is
 * `settleMs` old, or it has not changed across `settleMs` of waiting. A writer
 * that pauses longer than that between two writes can still be read in the
 * middle; the commit's identity check is what keeps such a read from replacing
 * what the writer does next.
 */
export async function isSettled(file: string, id: ConfigFileId, settleMs: number): Promise<boolean> {
  const age = Date.now() - Math.max(id.mtimeMs, id.ctimeMs)
  if (age >= settleMs) return true
  await sleep(Math.min(settleMs, Math.max(10, settleMs - age)))
  return sameFileId(await statFileId(file), id)
}

export type CommitOutcome = 'written' | 'conflict'

/**
 * Replace the file with `content` only if it is still the file that was read:
 * `expected` null means "it must still be missing" (an exclusive create), an id
 * means "it must still be that file". A temp in the same directory is renamed
 * (or hard-linked, for the create) into place, so a reader sees the old file or
 * the new one, never a prefix.
 *
 * With `holdReplaced`, a rename also hands back a descriptor of the file it
 * replaced (see watchReplacedFile): an editor that was still writing the old file
 * in place keeps writing into it after the rename, and only that descriptor can
 * still read what it wrote. The caller closes it.
 */
export async function commitConfigFile(
  file: string,
  content: string,
  expected: ConfigFileId | null,
  opts: { holdReplaced?: boolean } = {},
): Promise<{ outcome: CommitOutcome; replaced?: fs.FileHandle }> {
  const tmp = atomicTempName(file)
  let held: fs.FileHandle | undefined
  try {
    // Owner only: config.yaml holds keys (a bucket's secret, provider keys).
    await fs.writeFile(tmp, content, { encoding: 'utf-8', mode: 0o600 })
    if (expected === null) {
      try {
        await fs.link(tmp, file)
        return { outcome: 'written' }
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code
        if (code === 'EEXIST') return { outcome: 'conflict' }
        // A filesystem without hard links: an exclusive create still never
        // replaces a file someone else made.
        if (code !== 'EPERM' && code !== 'ENOTSUP' && code !== 'EOPNOTSUPP' && code !== 'ENOSYS') throw err
        try { await fs.writeFile(file, content, { encoding: 'utf-8', flag: 'wx', mode: 0o600 }) } catch (e) {
          if ((e as NodeJS.ErrnoException).code === 'EEXIST') return { outcome: 'conflict' }
          throw e
        }
        return { outcome: 'written' }
      }
    }
    // Not on Windows: there a rename over a file someone holds open is refused.
    if (opts.holdReplaced && process.platform !== 'win32') {
      held = await fs.open(file, 'r').catch(() => undefined)
      if (held && !sameFileId(idOf(await held.stat()), expected, { ctime: false })) return { outcome: 'conflict' }
    }
    if (!sameFileId(await statFileId(file), expected, { ctime: false })) return { outcome: 'conflict' }
    await fs.rename(tmp, file)
    const replaced = held
    held = undefined
    return { outcome: 'written', replaced }
  } finally {
    await held?.close().catch(() => {})
    await fs.rm(tmp, { force: true }).catch(() => {})
  }
}

/**
 * Watch a file a commit replaced (its descriptor, `id` as it was read) for
 * `watchMs`. When something keeps writing into it (an in-place save that paused
 * past the settle window and went on after the rename), wait until those writes
 * settle and return what the file holds then; null when nothing wrote to it.
 */
export async function watchReplacedFile(
  fh: fs.FileHandle,
  id: ConfigFileId,
  opts: { watchMs: number; settleMs: number; isCancelled?: () => boolean },
): Promise<string | null> {
  const end = Date.now() + opts.watchMs
  let last = id
  let changedAt = 0
  for (;;) {
    if (opts.isCancelled?.()) return null
    if (changedAt && Date.now() - changedAt >= opts.settleMs) {
      const content = await readWhole(fh, last.size)
      // Written to again while it was read: watch on.
      const after = idOf(await fh.stat())
      if (sameFileId(after, last, { ctime: false })) return content
      last = after
      changedAt = Date.now()
    }
    // A writer that keeps going past the window still gets settleMs to finish.
    if (!changedAt && Date.now() >= end) return null
    if (Date.now() >= end + opts.watchMs * 4) return readWhole(fh, last.size) // a writer that never stops
    await sleep(25)
    const cur = idOf(await fh.stat())
    if (!sameFileId(cur, last, { ctime: false })) { last = cur; changedAt = Date.now() }
  }
}

async function readWhole(fh: fs.FileHandle, size: number): Promise<string> {
  const buf = Buffer.alloc(size)
  let off = 0
  while (off < buf.length) {
    const { bytesRead } = await fh.read(buf, off, buf.length - off, off)
    if (bytesRead === 0) break
    off += bytesRead
  }
  return buf.subarray(0, off).toString('utf-8')
}

/** config.yaml and its copies hold keys (a bucket's secret, provider keys): owner only. */
export const CONFIG_FILE_MODE = 0o600

let atomicWriteSeq = 0

/**
 * The temp a write of `filePath` goes through (writeFileAtomic, commitConfigFile):
 * `<file>.tmp-<pid>-<base36 ms>-<base36 seq>`, unique even for two writes in one millisecond.
 * ATOMIC_TEMP_RE recognizes it (and the older `<file>.tmp-<pid>-<base36 ms>`), so a sweep that
 * removes the temps a crash left behind finds every one.
 */
export function atomicTempName(filePath: string): string {
  return `${filePath}.tmp-${process.pid}-${Date.now().toString(36)}-${(atomicWriteSeq++).toString(36)}`
}

/** A name atomicTempName made (older builds' too); group 1 is the file it was for. */
export const ATOMIC_TEMP_RE = /^(.+)\.tmp-\d+-[0-9a-z]+(?:-[0-9a-z]+)?$/

/**
 * Replace a file's whole content atomically: write a sibling temp, then rename.
 *
 * `fs.writeFile` truncates first and writes after, so a concurrent reader can
 * observe a HALF file, and half a config.yaml is worse than none, because it
 * still parses. The `agent:` section sits near the top of a ~280-line file, so a
 * reader landing in that window got valid YAML with the whole section missing and
 * silently ran on defaults, with no unreadable-config error logged because nothing
 * ever threw (observed 2026-08-28 06:03, where the missing section sent one turn
 * to a provider whose credentials this box does not keep).
 *
 * Temp lives in the SAME directory so the rename is a same-filesystem atomic
 * swap (an EXDEV across /tmp would fall back to copy, reopening the window).
 */
export async function writeFileAtomic(filePath: string, content: string | Uint8Array, mode?: number): Promise<void> {
  const tmp = atomicTempName(filePath)
  try {
    await fs.writeFile(tmp, content, { ...(typeof content === 'string' ? { encoding: 'utf-8' as const } : {}), ...(mode !== undefined ? { mode } : {}) })
    await fs.rename(tmp, filePath)
  } catch (err) {
    await fs.rm(tmp, { force: true }).catch(() => {})
    throw err
  }
}
