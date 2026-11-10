/**
 * Session history archive: Claude Code transcripts nobody has touched for a
 * while are compressed in place on their own host, and come back the moment
 * anything opens them (2026-11-10, the user: keep 60 days plain, compress the
 * rest, decompress on open).
 *
 * A session is `<projects>/<dir>/<sid>.jsonl` plus its sidecar folder
 * `<sid>/` (subagent transcripts, tool results). Archived, it is
 * `<sid>.jsonl.gz`, each sidecar file larger than MIN_FILE_BYTES as
 * `<file>.gz`, and a manifest `<sid>.walnut-archive.json` beside the
 * transcript naming every file it compressed with its size, mtime and sha256.
 * Claude Code lists only `*.jsonl`, so it ignores both.
 *
 * Nothing is ever lost, in two steps. First, each file is gzipped to a temp
 * file while its bytes are hashed, the temp file is read back through gunzip
 * and must hash the same, and only then is it renamed into place; the manifest
 * is written, and every original is renamed aside to `<file>.walnut-orig`
 * (the transcript last), only while each still has the inode, size, mtime and
 * ctime it had when the pass began. Second, a pass at least ASIDE_KEEP_MS later
 * removes the asides, only when each is still that same file (inode, size,
 * mtime, and the ctime it had right after the move), still hashes as recorded,
 * its archive still decompresses to those bytes, no file stands at its plain
 * name and no process has the session. Anything a writer did in
 * between (a write into an aside through a handle it held, a new file at the
 * plain name) puts the session back plain with every copy kept: the writer's
 * file stays, the other copy is kept beside it as `<file>.walnut-conflict-<time>`,
 * never merged and never removed. A restore puts every file in place with a
 * link that never replaces one a writer made, keeps the archive's copy too
 * unless a kept file holds its recorded bytes (by hash), and removes the
 * archive and manifest only once the session is whole.
 *
 * What is left: a process that held a file open for over an hour without
 * writing, is not a `claude` the checks below see, and writes in the moment
 * between the last check of an aside and its removal.
 *
 * Both steps and a restore hold one lock file per session, so they never
 * interleave, and every state a crash can leave is one the manifest names. The
 * lock names its holder with a token and a pid; its holder touches it while it
 * works, so only a lock whose process is gone, or one nobody touched for
 * LOCK_STALE_MS, is ever broken, and a holder removes only its own lock.
 *
 * A session in use is never archived: not one this daemon runs, a `claude`
 * process names on its command line, or Claude Code's own registry
 * (`~/.claude/sessions/<pid>.json`) names for a live process, nor one a resume
 * or fork opened (noteSessionOpened); each is asked again right before the
 * originals are set aside and before they are removed.
 *
 * A session is old when its transcript's mtime AND ctime, and every sidecar
 * file's mtime, are older than the cutoff. A restore renames a fresh file into
 * place, which moves its ctime to now, so a session someone opened stays plain
 * for another full retention period with no marker of our own.
 *
 * Host-local by design: the daemon runs the sweep and the restores next to the
 * data (bundled into the binary daemon, and into the task-dir-core.cjs sidecar
 * for the source twin); the server only asks.
 */
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { createHash, randomBytes } from 'node:crypto'
import { pipeline } from 'node:stream/promises'
import { Transform, Writable } from 'node:stream'
import { createGunzip, createGzip } from 'node:zlib'

export const ARCHIVE_SUFFIX = '.gz'
export const MANIFEST_SUFFIX = '.walnut-archive.json'
const LOCK_SUFFIX = '.walnut-archive.lock'
const TMP_TAG = '.walnut-tmp-'
/** Files this small save nothing on a 4 KB-block disk; they stay plain. */
export const MIN_FILE_BYTES = 8 * 1024
/** A lock nobody touched for this long, or whose process is gone, is broken. */
const LOCK_STALE_MS = 10 * 60_000
/** Its holder touches the lock this often. */
const LOCK_BEAT_MS = 30_000
/**
 * How long originals sit aside before a later pass removes them: a write through
 * a handle a process held, or a new file at the plain name, shows by then, and
 * the session goes back plain with every copy kept.
 */
const ASIDE_KEEP_MS = 60 * 60_000
/** A session opened this recently is never archived (its CLI may still be starting). */
const OPENED_GRACE_MS = 30 * 60_000
/** How long a restore waits for an archive pass of the same session. */
const RESTORE_WAIT_MS = 60_000
const MANIFEST_VERSION = 1
const SID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

export interface ManifestFile { rel: string; size: number; mtimeMs: number; sha256: string; ino?: number; asideCtimeMs?: number }
/** `asideAt` is set while the originals still sit aside (`<file>.walnut-orig`); a finalize clears it. */
export interface Manifest { version: number; sessionId: string; archivedAt: string; asideAt?: number; files: ManifestFile[] }

export interface ArchiveOptions {
  /** Sessions whose newest touch is older than this many ms are archived. */
  olderThanMs: number
  now?: number
  /** A session the daemon still runs (or any other reason to keep it plain). */
  isLive?: (sessionId: string) => boolean
  /** Asked again right before originals are set aside or removed: a fresh look (the process table). */
  isLiveNow?: (sessionId: string) => boolean | Promise<boolean>
  /** Stop starting new sessions after this long; the next pass goes on. */
  budgetMs?: number
  /** Stop after this many sessions in one pass. */
  maxSessions?: number
  /** Count what would be archived without writing anything. */
  dryRun?: boolean
}

export interface ArchiveReport {
  /** Sessions compressed in this pass (their originals now sit aside). */
  sessions: number
  files: number
  bytesBefore: number
  bytesAfter: number
  /** Sessions whose originals went in this pass, and the bytes that freed. */
  finalized: number
  freedBytes: number
  /** Sessions whose originals still sit aside after this pass. */
  aside: number
  /** Sessions a write reached while archived: back plain, every copy kept. */
  conflicts: number
  skippedLive: number
  failed: number
  errors: string[]
  partial: boolean
  dryRun: boolean
}

type FileStamp = { ino: number; size: number; mtimeMs: number; ctimeMs: number; atimeMs: number }
const stampOf = (s: fs.Stats): FileStamp => ({ ino: s.ino, size: s.size, mtimeMs: s.mtimeMs, ctimeMs: s.ctimeMs, atimeMs: s.atimeMs })
const sameStamp = (a: FileStamp, b: FileStamp): boolean =>
  a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs

export const isArchivedTranscriptName = (name: string): boolean => name.endsWith('.jsonl' + ARCHIVE_SUFFIX)
/** `<sid>.jsonl` and `<sid>.jsonl.gz` both name session `<sid>`; anything else is null. */
export function transcriptSessionId(name: string): string | null {
  if (name.endsWith('.jsonl')) return name.slice(0, -6) || null
  if (isArchivedTranscriptName(name)) return name.slice(0, -9) || null
  return null
}

const manifestPath = (dir: string, sid: string) => path.join(dir, sid + MANIFEST_SUFFIX)
const lockPath = (dir: string, sid: string) => path.join(dir, '.' + sid + LOCK_SUFFIX)
const tmpName = (p: string) => p + TMP_TAG + randomBytes(4).toString('hex')

function pidAlive(pid: unknown): boolean {
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 1) return false
  try { process.kill(pid, 0); return true } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM' }
}

const opened = new Map<string, number>()
/** A resume or a fork of `sid` is starting: no pass archives it for a while, and a pass at work on it gives up. */
export function noteSessionOpened(sid: string): void {
  opened.set(sid, Date.now())
  if (opened.size > 2000) for (const [k, at] of opened) if (Date.now() - at > OPENED_GRACE_MS) opened.delete(k)
}
const openedRecently = (sid: string): boolean => Date.now() - (opened.get(sid) ?? -Infinity) < OPENED_GRACE_MS

interface Held { token: string; path: string }

/** Take the session's lock, breaking a stale one; null when someone live holds it. */
function tryLock(dir: string, sid: string): Held | null {
  const p = lockPath(dir, sid)
  for (let i = 0; i < 2; i++) {
    const token = randomBytes(8).toString('hex')
    try {
      const fd = fs.openSync(p, 'wx', 0o600)
      try { fs.writeSync(fd, JSON.stringify({ pid: process.pid, at: Date.now(), token })) } finally { fs.closeSync(fd) }
      return { token, path: p }
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e
      let held: { pid?: number; at?: number } = {}
      try { held = JSON.parse(fs.readFileSync(p, 'utf8')) } catch { /* torn or gone: judge by age */ }
      let age = 0
      try { age = Date.now() - fs.statSync(p).mtimeMs } catch { continue }
      // A live holder touches its lock every LOCK_BEAT_MS; one whose pid is gone, or that stopped
      // touching it, is broken. A lock still being written (no pid yet) gets a few seconds.
      if (age < LOCK_STALE_MS && (pidAlive(held.pid) || (held.pid === undefined && age < 5_000))) return null
      try { fs.unlinkSync(p) } catch { /* someone else broke it */ }
    }
  }
  return null
}
function lockToken(p: string): string | undefined {
  try { return (JSON.parse(fs.readFileSync(p, 'utf8')) as { token?: string }).token } catch { return undefined }
}
/** Is the lock still ours? */
const stillHeld = (h: Held): boolean => lockToken(h.path) === h.token
/** Touch our lock so nobody takes it for stale. */
function beat(h: Held): void {
  if (!stillHeld(h)) return
  const t = new Date()
  try { fs.utimesSync(h.path, t, t) } catch { /* gone */ }
}
/** Remove the lock, only while it is ours. */
function unlock(h: Held): void {
  if (stillHeld(h)) { try { fs.unlinkSync(h.path) } catch { /* gone */ } }
}
/** Run `fn` holding `h`, touching the lock while it runs. */
async function withBeat<T>(h: Held, fn: () => Promise<T>): Promise<T> {
  const timer = setInterval(() => beat(h), LOCK_BEAT_MS)
  timer.unref?.()
  try { return await fn() } finally { clearInterval(timer); unlock(h) }
}

async function lockWait(dir: string, sid: string, waitMs: number): Promise<Held | null> {
  const until = Date.now() + waitMs
  for (;;) {
    const h = tryLock(dir, sid)
    if (h) return h
    if (Date.now() > until) return null
    await new Promise(r => setTimeout(r, 100))
  }
}

function hasher(h: ReturnType<typeof createHash>) {
  return new Transform({ transform(chunk, _enc, cb) { h.update(chunk); cb(null, chunk) } })
}
const sink = () => new Writable({ write(_c, _e, cb) { cb() } })

async function fsyncPath(p: string): Promise<void> {
  const fh = await fsp.open(p, 'r+')
  try { await fh.sync() } finally { await fh.close() }
}

/** sha256 of what a gzip file decompresses to (gunzip also checks its CRC and length). */
async function gunzipHash(p: string): Promise<{ sha256: string; size: number }> {
  const h = createHash('sha256')
  let size = 0
  await pipeline(fs.createReadStream(p), createGunzip(), new Transform({
    transform(chunk, _e, cb) { size += chunk.length; h.update(chunk); cb() },
  }), sink())
  return { sha256: h.digest('hex'), size }
}

/** Compress `src` to `src.gz` (verified round trip); returns its manifest entry. Keeps `src`. */
async function compressOne(src: string, rel: string, stamp: FileStamp): Promise<ManifestFile & { gzBytes: number }> {
  const dst = src + ARCHIVE_SUFFIX
  const tmp = tmpName(dst)
  const h = createHash('sha256')
  try {
    await pipeline(fs.createReadStream(src), hasher(h), createGzip({ level: 6 }), fs.createWriteStream(tmp, { mode: 0o600 }))
    await fsyncPath(tmp)
    const sha256 = h.digest('hex')
    const back = await gunzipHash(tmp)
    if (back.sha256 !== sha256 || back.size !== stamp.size) throw new Error(`round trip differs for ${rel}`)
    await fsp.utimes(tmp, stamp.atimeMs / 1000, stamp.mtimeMs / 1000)
    await fsp.rename(tmp, dst)
    const gzBytes = (await fsp.stat(dst)).size
    return { rel, size: stamp.size, mtimeMs: stamp.mtimeMs, sha256, gzBytes }
  } catch (e) {
    await fsp.rm(tmp, { force: true })
    throw e
  }
}

/**
 * Put `src` at `dst` without ever replacing a file there: a link (or an
 * exclusive copy where links are refused), then `src` goes. A file a writer
 * made at `dst` meanwhile stays, and `src` is kept beside it as a conflict
 * file. Returns where `src`'s bytes are now.
 */
async function install(src: string, dst: string): Promise<string> {
  try {
    await fsp.link(src, dst)
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code
    if (code === 'EEXIST') { const c = conflictName(dst); await fsp.rename(src, c); return c }
    if (code !== 'EPERM' && code !== 'ENOTSUP' && code !== 'EXDEV' && code !== 'EMLINK') throw e
    try { await fsp.copyFile(src, dst, fs.constants.COPYFILE_EXCL) } catch (e2) {
      if ((e2 as NodeJS.ErrnoException).code !== 'EEXIST') throw e2
      const c = conflictName(dst); await fsp.rename(src, c); return c
    }
  }
  await fsp.rm(src, { force: true })
  return dst
}

/** Do the first `f.size` bytes of `p` hash to `f.sha256`? (The file holds the recorded bytes, an append after them allowed.) */
async function holdsRecorded(p: string, f: ManifestFile): Promise<boolean> {
  try {
    if ((await fsp.lstat(p)).size < f.size) return false
    const h = createHash('sha256')
    if (f.size > 0) await pipeline(fs.createReadStream(p, { start: 0, end: f.size - 1 }), hasher(h), sink())
    return h.digest('hex') === f.sha256
  } catch { return false }
}

/** Decompress `gz` to `dst` after checking it against `want`, never over a file there; keeps `gz` (the caller drops it once the session is whole). */
async function decompressOne(gz: string, want: ManifestFile | undefined, dst: string): Promise<void> {
  const tmp = tmpName(dst)
  const h = createHash('sha256')
  let size = 0
  try {
    const count = new Transform({
      transform(chunk, _e, cb) { size += chunk.length; h.update(chunk); cb(null, chunk) },
    })
    const sink = fs.createWriteStream(tmp, { mode: 0o600 })
    await pipeline(fs.createReadStream(gz), createGunzip(), count, sink)
    if (want && (h.digest('hex') !== want.sha256 || size !== want.size)) throw new Error(`archived copy of ${want.rel} does not match its manifest`)
    await fsyncPath(tmp)
    const mtime = want?.mtimeMs ?? (await fsp.stat(gz)).mtimeMs
    await fsp.utimes(tmp, mtime / 1000, mtime / 1000)
    await install(tmp, dst)
  } catch (e) {
    await fsp.rm(tmp, { force: true })
    throw e
  }
}

/** Regular files under `dir`, relative, skipping our own temp files and archives. */
async function walkFiles(dir: string, base = dir, out: string[] = []): Promise<string[]> {
  let entries: fs.Dirent[]
  try { entries = await fsp.readdir(dir, { withFileTypes: true }) } catch { return out }
  for (const e of entries) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) await walkFiles(p, base, out)
    else if (e.isFile() && !e.name.includes(TMP_TAG) && !e.name.endsWith(ORIG_SUFFIX)) out.push(path.relative(base, p))
  }
  return out
}

async function readManifest(dir: string, sid: string): Promise<Manifest | null> {
  try {
    const m = JSON.parse(await fsp.readFile(manifestPath(dir, sid), 'utf8')) as Manifest
    return m && Array.isArray(m.files) ? m : null
  } catch { return null }
}

async function writeManifest(dir: string, m: Manifest): Promise<void> {
  const p = manifestPath(dir, m.sessionId)
  const tmp = tmpName(p)
  await fsp.writeFile(tmp, JSON.stringify(m), { mode: 0o600 })
  await fsyncPath(tmp)
  await fsp.rename(tmp, p)
}

type Candidate = { dir: string; sid: string; stamp: FileStamp; side: Array<{ rel: string; stamp: FileStamp }> }

/** Is session `sid` in `dir` old enough, with all its files? Null when not (or when it is not plain). */
async function candidate(dir: string, sid: string, cutoff: number): Promise<Candidate | null> {
  let st: fs.Stats
  try { st = await fsp.lstat(path.join(dir, sid + '.jsonl')) } catch { return null }
  if (!st.isFile() || st.mtimeMs >= cutoff || st.ctimeMs >= cutoff) return null
  const side: Candidate['side'] = []
  const sideDir = path.join(dir, sid)
  for (const rel of await walkFiles(sideDir)) {
    if (rel.endsWith(ARCHIVE_SUFFIX)) continue
    let s: fs.Stats
    try { s = await fsp.lstat(path.join(sideDir, rel)) } catch { continue }
    if (s.mtimeMs >= cutoff) return null
    if (s.size >= MIN_FILE_BYTES) side.push({ rel: path.join(sid, rel), stamp: stampOf(s) })
  }
  return { dir, sid, stamp: stampOf(st), side }
}

/** An original set aside under this name, recorded in the manifest before the move. */
const ORIG_SUFFIX = '.walnut-orig'
/** What a restore keeps when two copies of a file disagree; never removed by Walnut. */
const CONFLICT_TAG = '.walnut-conflict-'
const conflictName = (p: string) => p + CONFLICT_TAG + new Date().toISOString().replace(/[-:.]/g, '').slice(0, 15) + '-' + randomBytes(2).toString('hex')
const exists = (p: string) => fsp.lstat(p).then(() => true, () => false)

/**
 * Archive one session: compress and verify every file, record the manifest
 * with the name each original is about to be set aside under, then rename the
 * originals aside (the transcript last). Nothing is removed here: the
 * originals stay aside until a later pass finalizes them (finalizeAside).
 * Throws with the originals in place when anything is off before the move.
 */
async function archiveSession(c: Candidate, h: Held, isLiveNow?: ArchiveOptions['isLiveNow']): Promise<{ files: number; before: number; after: number }> {
  const items = [...c.side, { rel: c.sid + '.jsonl', stamp: c.stamp }]
  const done: Array<ManifestFile & { gzBytes: number }> = []
  try {
    for (const it of items) {
      done.push(await compressOne(path.join(c.dir, it.rel), it.rel, it.stamp))
      beat(h)
    }
    // Someone opened the session meanwhile: it stays plain.
    if (openedRecently(c.sid) || (await isLiveNow?.(c.sid))) throw new Error(`${c.sid} was opened while it was archived`)
    for (const it of items) {
      const now = stampOf(await fsp.lstat(path.join(c.dir, it.rel)))
      if (!sameStamp(now, it.stamp)) throw new Error(`${it.rel} changed while it was archived`)
    }
    if (!stillHeld(h) || openedRecently(c.sid)) throw new Error(`${c.sid} lost its archive lock`)
    await writeManifest(c.dir, {
      version: MANIFEST_VERSION, sessionId: c.sid, archivedAt: new Date().toISOString(),
      asideAt: Date.now(), files: done.map(({ gzBytes: _g, ...f }) => ({ ...f, ino: items.find(i => i.rel === f.rel)!.stamp.ino })),
    })
    beat(h)
  } catch (e) {
    await fsp.rm(manifestPath(c.dir, c.sid), { force: true })
    for (const f of done) await fsp.rm(path.join(c.dir, f.rel + ARCHIVE_SUFFIX), { force: true })
    throw e
  }
  // From here the manifest names every aside: a crash at any point is undone by a restore.
  for (const it of items) {
    const p = path.join(c.dir, it.rel)
    await fsp.rename(p, p + ORIG_SUFFIX)
  }
  // Each aside's ctime right after the move: a finalize removes it only if nothing changed it since.
  const m = await readManifest(c.dir, c.sid)
  if (m) {
    for (const f of m.files) {
      const st = await fsp.lstat(path.join(c.dir, f.rel + ORIG_SUFFIX)).catch(() => null)
      if (st && st.ino === f.ino) f.asideCtimeMs = st.ctimeMs
    }
    await writeManifest(c.dir, m)
  }
  return { files: done.length, before: done.reduce((n, f) => n + f.size, 0), after: done.reduce((n, f) => n + f.gzBytes, 0) }
}

/**
 * The second step of an archive, at least ASIDE_KEEP_MS after the first: the
 * originals set aside go when every one is still the file that was compressed,
 * no file stands at its plain name, and no process has the session. Any write
 * since (through a handle into an aside, or a new file at the plain name) puts
 * the session back plain with every copy kept (restoreLocked). Returns the
 * bytes freed; null when the session is in use; 'undo' when a pass stopped
 * before it set every original aside (they are put back); 'written' when a
 * writer reached the session.
 */
async function finalizeAside(dir: string, m: Manifest, isLiveNow: ArchiveOptions['isLiveNow'], h: Held): Promise<number | null | 'undo' | 'written'> {
  let freed = 0
  let undo = false
  const asides: Array<{ path: string; f: ManifestFile }> = []
  for (const f of m.files) {
    const p = path.join(dir, f.rel)
    const a = await fsp.lstat(p + ORIG_SUFFIX).catch(() => null)
    const plain = await fsp.lstat(p).catch(() => null)
    // The original itself still at its name: the pass stopped before it set this one aside.
    if (plain && !a && plain.ino === f.ino && plain.size === f.size && plain.mtimeMs === f.mtimeMs) { undo = true; continue }
    if (plain) return 'written'
    if (!a) continue
    // Untouched since it was set aside: same file, same size and mtime, and no change of any kind
    // since the move (every write moves ctime, which no writer can set back).
    if (a.ino !== f.ino || a.size !== f.size || a.mtimeMs !== f.mtimeMs) return 'written'
    if (f.asideCtimeMs !== undefined && a.ctimeMs !== f.asideCtimeMs) return 'written'
    asides.push({ path: p + ORIG_SUFFIX, f })
    freed += a.size
  }
  if (undo) return 'undo'
  if (openedRecently(m.sessionId) || (await isLiveNow?.(m.sessionId)) || !stillHeld(h)) return null
  for (const { path: a, f } of asides) {
    // The bytes themselves: the aside still hashes as recorded, and the archive still decompresses to them.
    if (!(await holdsRecorded(a, f)) || (await fsp.lstat(a)).size !== f.size) return 'written'
    const back = await gunzipHash(path.join(dir, f.rel + ARCHIVE_SUFFIX)).catch(() => null)
    if (!back || back.sha256 !== f.sha256 || back.size !== f.size) return 'undo'
    beat(h)
  }
  if (openedRecently(m.sessionId) || (await isLiveNow?.(m.sessionId)) || !stillHeld(h)) return null
  for (const { path: a, f } of asides) {
    const now = await fsp.lstat(a)
    if (now.size !== f.size || now.mtimeMs !== f.mtimeMs || (f.asideCtimeMs !== undefined && now.ctimeMs !== f.asideCtimeMs)) return 'written'
    await fsp.rm(a, { force: true })
  }
  await writeManifest(dir, { ...m, asideAt: undefined })
  return freed
}

/** Remove temp files a crashed pass left in a project dir (its compression temps; never an aside). */
async function sweepTemps(dir: string, names: string[], now: number): Promise<void> {
  for (const n of names) {
    if (!n.includes(TMP_TAG)) continue
    const p = path.join(dir, n)
    try { if (now - (await fsp.lstat(p)).mtimeMs > 3_600_000) await fsp.rm(p, { force: true }) } catch { /* gone */ }
  }
}

/**
 * One archive pass over every projects dir: each plain session older than the
 * cutoff, not live, is compressed and its originals set aside; each session
 * set aside ASIDE_KEEP_MS ago is finalized. Budgeted and resumable (a session
 * either moves whole or stays as it was), so a pass that stops early loses nothing.
 */
export async function archiveTranscripts(projectsDirs: string[], opts: ArchiveOptions): Promise<ArchiveReport> {
  const now = opts.now ?? Date.now()
  const cutoff = now - opts.olderThanMs
  const until = Date.now() + (opts.budgetMs ?? 10 * 60_000)
  const max = opts.maxSessions ?? Infinity
  const r: ArchiveReport = { sessions: 0, files: 0, bytesBefore: 0, bytesAfter: 0, finalized: 0, freedBytes: 0, aside: 0, conflicts: 0, skippedLive: 0, failed: 0, errors: [], partial: false, dryRun: !!opts.dryRun }
  if (!(opts.olderThanMs > 0)) return r
  const roots = [...new Set(projectsDirs)]
  const registry = claudeRegistryLive(roots)
  const isLive = (sid: string) => registry.has(sid) || !!opts.isLive?.(sid)
  const isLiveNow = async (sid: string) => claudeRegistryLive(roots).has(sid) || !!(await opts.isLiveNow?.(sid))
  const fail = (where: string, e: unknown) => {
    r.failed++
    if (r.errors.length < 10) r.errors.push(`${where}: ${(e as Error).message}`)
  }
  for (const root of roots) {
    let projects: fs.Dirent[]
    try { projects = await fsp.readdir(root, { withFileTypes: true }) } catch { continue }
    for (const p of projects) {
      if (!p.isDirectory()) continue
      const dir = path.join(root, p.name)
      let names: string[]
      try { names = await fsp.readdir(dir) } catch { continue }
      await sweepTemps(dir, names, now)
      // Sessions set aside by an earlier pass: finalize the ones old enough. A session
      // one of them put back plain waits for the next pass.
      const handled = new Set<string>()
      for (const name of names) {
        if (!name.endsWith(MANIFEST_SUFFIX) || opts.dryRun) continue
        const sid = name.slice(0, -MANIFEST_SUFFIX.length)
        if (!SID_RE.test(sid)) continue
        const m = await readManifest(dir, sid)
        if (m) handled.add(sid)
        if (!m || m.asideAt === undefined) continue
        if (now - m.asideAt < ASIDE_KEEP_MS) { r.aside++; continue }
        if (Date.now() > until) { r.partial = true; return r }
        const h = tryLock(dir, sid)
        if (!h) { r.aside++; continue }
        try {
          await withBeat(h, async () => {
            const cur = await readManifest(dir, sid)
            if (!cur || cur.asideAt === undefined) return
            const freed = await finalizeAside(dir, cur, isLiveNow, h)
            if (freed === null) { r.aside++; r.skippedLive++ }
            else if (freed === 'undo') await restoreLocked(dir, sid)
            else if (freed === 'written') { await restoreLocked(dir, sid); r.conflicts++ }
            else { r.finalized++; r.freedBytes += freed }
          })
        } catch (e) { fail(path.join(dir, name), e) }
      }
      for (const name of names) {
        if (!name.endsWith('.jsonl')) continue
        const sid = name.slice(0, -6)
        if (!SID_RE.test(sid) || handled.has(sid)) continue
        if (Date.now() > until || r.sessions >= max) { r.partial = true; return r }
        const c = await candidate(dir, sid, cutoff)
        if (!c) continue
        if (isLive(sid) || openedRecently(sid)) { r.skippedLive++; continue }
        if (opts.dryRun) {
          r.sessions++; r.files += c.side.length + 1
          r.bytesBefore += c.stamp.size + c.side.reduce((n, s) => n + s.stamp.size, 0)
          continue
        }
        const h = tryLock(dir, sid)
        if (!h) continue
        try {
          await withBeat(h, async () => {
            // A pass that stopped halfway left a manifest: finish the way back first, so
            // the new manifest names every file of the session, then archive it whole.
            let cur: Candidate | null = c
            if (fs.existsSync(manifestPath(dir, sid))) { await restoreLocked(dir, sid); cur = await candidate(dir, sid, cutoff) }
            if (!cur) return
            const got = await archiveSession(cur, h, isLiveNow)
            r.sessions++; r.aside++; r.files += got.files; r.bytesBefore += got.before; r.bytesAfter += got.after
          })
        } catch (e) { fail(path.join(dir, name), e) }
      }
    }
  }
  return r
}

/**
 * Session ids Claude Code's own process registry (`<config dir>/sessions/<pid>.json`,
 * beside `projects/`) names for a process still alive: every CLI on the host,
 * a terminal's included, and the session an interactive one switched to.
 */
export function claudeRegistryLive(projectsDirs: readonly string[]): Set<string> {
  const ids = new Set<string>()
  for (const root of projectsDirs) {
    const reg = path.join(path.dirname(path.resolve(root)), 'sessions')
    let names: string[]
    try { names = fs.readdirSync(reg) } catch { continue }
    for (const n of names) {
      if (!n.endsWith('.json')) continue
      try {
        const e = JSON.parse(fs.readFileSync(path.join(reg, n), 'utf8')) as { pid?: number; sessionId?: string }
        if (typeof e.sessionId === 'string' && pidAlive(e.pid)) ids.add(e.sessionId)
      } catch { /* torn or gone */ }
    }
  }
  return ids
}

const inflight = new Map<string, Promise<boolean>>()

/**
 * Bring session `sid` in project dir `dir` back to plain files. True when its
 * transcript is plain afterwards (it was, or it came back); false when there
 * is no such session here. Throws only when an archive is there and could not
 * be restored (its files are then left as they were).
 */
export function restoreSession(dir: string, sid: string): Promise<boolean> {
  const key = path.join(dir, sid)
  const running = inflight.get(key)
  if (running) return running
  const job = restoreSessionNow(dir, sid).finally(() => inflight.delete(key))
  inflight.set(key, job)
  return job
}

async function restoreSessionNow(dir: string, sid: string): Promise<boolean> {
  const plain = path.join(dir, sid + '.jsonl')
  // No manifest and no pass at work on it: nothing to do. A pass at work (its lock) is
  // waited for, since it may write a manifest and set the plain file aside next.
  if (!(await exists(manifestPath(dir, sid))) && !(await exists(lockPath(dir, sid)))) return exists(plain)
  const h = await lockWait(dir, sid, RESTORE_WAIT_MS)
  if (!h) throw new Error(`session ${sid} is being archived; try again`)
  return withBeat(h, async () => (await exists(manifestPath(dir, sid))) ? restoreLocked(dir, sid) : exists(plain))
}

/**
 * The restore itself; the caller holds the session's lock. Per file, never
 * merging two copies, never placing a file over another, and never removing
 * the archive while it holds bytes no kept file has:
 * - a file at the plain name stays (a writer's or the original);
 * - an original set aside comes back by a link that never replaces a file
 *   there (else it is kept beside it as a conflict file);
 * - with neither, the archive is decompressed the same way;
 * - the archive's copy is also kept as a conflict file unless a kept file
 *   holds the recorded bytes (their hash, an append after them allowed).
 * The archive files and the manifest go only once every file is settled; an
 * error keeps them (a later restore picks up where this one stopped).
 */
async function restoreLocked(dir: string, sid: string): Promise<boolean> {
  const m = await readManifest(dir, sid)
  if (!m) throw new Error(`archive manifest of ${sid} cannot be read`)
  const files = [...m.files]
  // Sidecar files first, the transcript last: a plain transcript means a whole session.
  files.sort((a, b) => (a.rel === sid + '.jsonl' ? 1 : 0) - (b.rel === sid + '.jsonl' ? 1 : 0))
  const spent: string[] = []
  for (const f of files) {
    const p = path.join(dir, f.rel)
    const g = p + ARCHIVE_SUFFIX
    const o = p + ORIG_SUFFIX
    const hasGz = await exists(g)
    const kept: string[] = []
    if (await exists(o)) kept.push(await install(o, p))
    if (await exists(p)) kept.push(p)
    if (!kept.length) {
      if (!hasGz) {
        if (f.rel === sid + '.jsonl') throw new Error(`archive of ${sid} has no transcript`)
        continue
      }
      await decompressOne(g, f, p)
      spent.push(g)
      continue
    }
    if (hasGz) {
      let held = false
      for (const k of kept) if (await holdsRecorded(k, f)) { held = true; break }
      if (!held) {
        await decompressOne(g, f, conflictName(p))
        log(`archive of ${sid}: ${f.rel} was written while archived; every copy kept`)
      }
      spent.push(g)
    }
    if (kept.some((k) => k.includes(CONFLICT_TAG))) log(`archive of ${sid}: ${f.rel} was written while archived; every copy kept`)
  }
  for (const g of spent) await fsp.rm(g, { force: true })
  await fsp.rm(manifestPath(dir, sid), { force: true })
  return true
}

let log: (msg: string) => void = (msg) => { try { process.stderr.write(`[transcript-archive] ${msg}\n`) } catch { /* closed */ } }
/** Where the archive reports a file kept twice (the daemons pass their logger). */
export function setArchiveLog(fn: (msg: string) => void): void { log = fn }

/**
 * Make sure a transcript or sidecar path is plain before it is opened: when
 * `p` is missing and belongs to an archived session, restore that session.
 * True when `p` exists afterwards. Never throws; a failed restore reads as
 * missing, which every caller already handles.
 */
export async function ensurePlain(p: string): Promise<boolean> {
  let there = true
  try { await fsp.lstat(p) } catch { there = false }
  // Present or not, a path of a session with a manifest (its sidecar folder, a
  // transcript a stopped pass left plain) is restored, so what it lists is whole.
  const at = archivedSessionOf(p)
  if (!at) return there
  try { await restoreSession(at.dir, at.sid) } catch { return there }
  return fsp.lstat(p).then(() => true, () => false)
}


/**
 * The archived session a path belongs to: `<dir>/<sid>.jsonl` itself, or a
 * file under `<dir>/<sid>/`. Checked against the disk (an archive or a
 * manifest must be there), so an ordinary missing file is not taken for one.
 */
export function archivedSessionOf(p: string): { dir: string; sid: string } | null {
  const abs = path.resolve(p)
  const base = path.basename(abs)
  // Every archive this module makes has a manifest; a `.gz` with none is not ours.
  const has = (dir: string, sid: string) => SID_RE.test(sid) && fs.existsSync(manifestPath(dir, sid))
  if (base.endsWith('.jsonl') || isArchivedTranscriptName(base)) {
    const sid = transcriptSessionId(base)!
    if (has(path.dirname(abs), sid)) return { dir: path.dirname(abs), sid }
  }
  let cur = abs
  for (let i = 0; i < 5 && cur !== path.dirname(cur); i++) {
    if (has(path.dirname(cur), path.basename(cur))) return { dir: path.dirname(cur), sid: path.basename(cur) }
    cur = path.dirname(cur)
  }
  return null
}

/**
 * Find session `sid` archived (or being archived) in any project dir under the
 * roots; restore it and return its plain path. A resume calls this: it marks
 * the session opened first, so a pass at work on it gives up.
 */
export async function restoreSessionAnywhere(projectsDirs: string[], sid: string): Promise<string | null> {
  if (!SID_RE.test(sid)) return null
  noteSessionOpened(sid)
  for (const root of [...new Set(projectsDirs)]) {
    let projects: fs.Dirent[]
    try { projects = await fsp.readdir(root, { withFileTypes: true }) } catch { continue }
    for (const p of projects) {
      if (!p.isDirectory()) continue
      const dir = path.join(root, p.name)
      if (!fs.existsSync(manifestPath(dir, sid)) && !fs.existsSync(lockPath(dir, sid))) continue
      try { if (await restoreSession(dir, sid)) return path.join(dir, sid + '.jsonl') } catch { return null }
    }
  }
  return null
}

const underAny = (p: string, roots: readonly string[]): boolean => {
  const abs = path.resolve(p)
  return roots.some((r) => abs === r || abs.startsWith(path.resolve(r) + path.sep))
}

/**
 * The daemon's file commands call this first with the path they were asked for:
 * a transcript or sidecar path of an archived session under one of the
 * projects dirs comes back plain before the command reads, stats or lists it.
 * Any other path costs one prefix check. Never throws.
 */
export async function restoreForRead(p: unknown, projectsDirs: readonly string[]): Promise<void> {
  if (typeof p !== 'string' || !p || !underAny(p, projectsDirs)) return
  await ensurePlain(p).catch(() => false)
}

/**
 * An `fs.find` for `<sid>.jsonl` matches names by substring, so it also finds
 * `<sid>.jsonl.gz`: such a hit is restored and answered as its plain path (or
 * left out when it cannot be), our own manifest, lock and temp files are left
 * out, and each path is named once.
 */
export async function plainFindResults(found: readonly string[], name: string): Promise<string[]> {
  const out: string[] = []
  for (const f of found) {
    const base = path.basename(f)
    if (base.includes(TMP_TAG) || base.includes(CONFLICT_TAG) || base.endsWith(ORIG_SUFFIX) || base.endsWith(MANIFEST_SUFFIX) || base.endsWith(LOCK_SUFFIX)) continue
    if (isArchivedTranscriptName(base) && !name.endsWith(ARCHIVE_SUFFIX)) {
      const plain = f.slice(0, -ARCHIVE_SUFFIX.length)
      if (!(await ensurePlain(plain).catch(() => false))) continue
      if (!out.includes(plain)) out.push(plain)
      continue
    }
    if (!out.includes(f)) out.push(f)
  }
  return out
}

/** The transcript a CLI's argv resumes (`--resume <id>`, `-r <id>`, `=` forms), a fork's source included. */
export function resumeSourceId(args: readonly string[]): string | null {
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    let v: string | undefined
    if (a === '--resume' || a === '-r') v = args[i + 1]
    else if (a.startsWith('--resume=')) v = a.slice(9)
    if (v && SID_RE.test(v)) return v
  }
  return null
}

/**
 * The transcript ids live `claude` processes name on their command line
 * (`--resume <id>`, `-r <id>`, `--session-id <id>`, `=` forms too), from
 * `ps -A -o args=`: a CLI this daemon did not start (a terminal's) counts as
 * live as well.
 */
export function liveTranscriptIdsFromPs(psOutput: string): Set<string> {
  const ids = new Set<string>()
  for (const line of psOutput.split('\n')) {
    if (!/claude/.test(line)) continue
    const re = /(?:^|\s)(?:--resume|-r|--session-id)(?:=|\s+)([A-Za-z0-9][A-Za-z0-9._-]{0,127})/g
    for (let m = re.exec(line); m; m = re.exec(line)) ids.add(m[1])
  }
  return ids
}

/**
 * Restore session `sid` in project dir `dir` when it is archived there (its
 * manifest is present): async, for callers on a busy event loop that already
 * know the dir. True when its transcript is plain afterwards. Never throws.
 */
export async function restoreArchivedAt(dir: string, sid: string): Promise<boolean> {
  if (!SID_RE.test(sid)) return false
  try { await fsp.access(manifestPath(dir, sid)) } catch { return false }
  return restoreSession(dir, sid).catch(() => false)
}

/** Is session `sid` archived in `dir`? Sync, one stat. */
export function isArchivedAt(dir: string, sid: string): boolean {
  return SID_RE.test(sid) && fs.existsSync(manifestPath(dir, sid))
}
