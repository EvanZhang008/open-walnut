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
export function parseConfigMapping(content: string): { doc: Record<string, unknown> | null; error?: string } {
  try {
    const parsed = yaml.load(content)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return { doc: parsed as Record<string, unknown> }
    return { doc: null, error: 'not a YAML mapping' }
  } catch (err) {
    return { doc: null, error: err instanceof Error ? err.message.split('\n')[0] : String(err) }
  }
}

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
    before = idOf(await fh.stat())
    content = await fh.readFile('utf-8')
    after = idOf(await fh.stat())
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
  const tmp = `${file}.tmp-${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
  let held: fs.FileHandle | undefined
  try {
    await fs.writeFile(tmp, content, 'utf-8')
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
        try { await fs.writeFile(file, content, { encoding: 'utf-8', flag: 'wx' }) } catch (e) {
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
