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
 * Nothing is ever lost: each file is gzipped to a temp file while its bytes
 * are hashed, the temp file is read back through gunzip and must hash the
 * same, and only then is it renamed into place; the originals are removed
 * last, and only while every one of them still has the inode, size, mtime and
 * ctime it had when the pass began (a write of any kind moves ctime).
 * Anything else, an error included, undoes the pass and keeps the originals.
 * A restore checks every file against its manifest hash before the rename.
 * Both hold one lock file per session, so an archive and a restore never
 * interleave, and a crash at any point leaves the plain file in place or the
 * archive whole (a plain file always wins over a stale `.gz`). The lock names
 * its holder with a token and a pid; its holder touches it while it works, so
 * only a lock whose process is gone, or one nobody touched for LOCK_STALE_MS,
 * is ever broken, and a holder removes only its own lock.
 *
 * A session someone opens while it is archived wins: a restore waits for the
 * pass's lock, a resume (or a fork of it) marks the session opened first
 * (noteSessionOpened), and right before an original is removed the pass asks
 * again whether the session is live or opened (`isLiveNow`, a fresh look at
 * the processes) and gives up if so. What is left is a CLI started from a
 * terminal in the few milliseconds between that look and the removal.
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
/** How long removed originals sit aside before they go, so a write already on its way lands where it is seen. */
const SETTLE_MS = 200
/** A session opened this recently is never archived (its CLI may still be starting). */
const OPENED_GRACE_MS = 30 * 60_000
/** How long a restore waits for an archive pass of the same session. */
const RESTORE_WAIT_MS = 60_000
const MANIFEST_VERSION = 1
const SID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

export interface ManifestFile { rel: string; size: number; mtimeMs: number; sha256: string }
export interface Manifest { version: number; sessionId: string; archivedAt: string; files: ManifestFile[] }

export interface ArchiveOptions {
  /** Sessions whose newest touch is older than this many ms are archived. */
  olderThanMs: number
  now?: number
  /** A session the daemon still runs (or any other reason to keep it plain). */
  isLive?: (sessionId: string) => boolean
  /** Asked again right before a session's originals are removed: a fresh look (the process table). */
  isLiveNow?: (sessionId: string) => boolean | Promise<boolean>
  /** Stop starting new sessions after this long; the next pass goes on. */
  budgetMs?: number
  /** Stop after this many sessions in one pass. */
  maxSessions?: number
  /** Count what would be archived without writing anything. */
  dryRun?: boolean
}

export interface ArchiveReport {
  sessions: number
  files: number
  bytesBefore: number
  bytesAfter: number
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

/** Decompress `gz` to its plain name after checking it against `want`; removes `gz`. */
async function decompressOne(gz: string, want: ManifestFile | undefined): Promise<void> {
  const dst = gz.slice(0, -ARCHIVE_SUFFIX.length)
  const tmp = tmpName(dst)
  const h = createHash('sha256')
  let size = 0
  try {
    await pipeline(fs.createReadStream(gz), createGunzip(), new Transform({
      transform(chunk, _e, cb) { size += chunk.length; h.update(chunk); cb(null, chunk) },
    }), fs.createWriteStream(tmp, { mode: 0o600 }))
    if (want && (h.digest('hex') !== want.sha256 || size !== want.size)) throw new Error(`archived copy of ${want.rel} does not match its manifest`)
    await fsyncPath(tmp)
    const mtime = want?.mtimeMs ?? (await fsp.stat(gz)).mtimeMs
    await fsp.utimes(tmp, mtime / 1000, mtime / 1000)
    await fsp.rename(tmp, dst)
    await fsp.rm(gz, { force: true })
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
    else if (e.isFile() && !e.name.includes(TMP_TAG)) out.push(path.relative(base, p))
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

/** Archive one session; returns bytes before and after, or throws with the originals kept. */
async function archiveSession(c: Candidate, h: Held, isLiveNow?: ArchiveOptions['isLiveNow']): Promise<{ files: number; before: number; after: number }> {
  const items = [...c.side, { rel: c.sid + '.jsonl', stamp: c.stamp }]
  const done: Array<ManifestFile & { gzBytes: number }> = []
  try {
    for (const it of items) {
      done.push(await compressOne(path.join(c.dir, it.rel), it.rel, it.stamp))
      beat(h)
    }
    await writeManifest(c.dir, { version: MANIFEST_VERSION, sessionId: c.sid, archivedAt: new Date().toISOString(), files: done.map(({ gzBytes: _g, ...f }) => f) })
    // Someone opened the session meanwhile: it stays plain.
    if (openedRecently(c.sid) || (await isLiveNow?.(c.sid))) throw new Error(`${c.sid} was opened while it was archived`)
    // Every original must be exactly as it was before any is removed, and the lock still ours.
    for (const it of items) {
      const now = stampOf(await fsp.lstat(path.join(c.dir, it.rel)))
      if (!sameStamp(now, it.stamp)) throw new Error(`${it.rel} changed while it was archived`)
    }
    if (!stillHeld(h) || openedRecently(c.sid)) throw new Error(`${c.sid} lost its archive lock`)
    beat(h)
  } catch (e) {
    await fsp.rm(manifestPath(c.dir, c.sid), { force: true })
    for (const f of done) await fsp.rm(path.join(c.dir, f.rel + ARCHIVE_SUFFIX), { force: true })
    throw e
  }
  try { await removeOriginals(c, items) } catch (e) {
    // The originals are back (merged with anything written meanwhile): the archive goes.
    await fsp.rm(manifestPath(c.dir, c.sid), { force: true })
    for (const f of done) await fsp.rm(path.join(c.dir, f.rel + ARCHIVE_SUFFIX), { force: true })
    throw e
  }
  return { files: done.length, before: done.reduce((n, f) => n + f.size, 0), after: done.reduce((n, f) => n + f.gzBytes, 0) }
}

const unchanged = (s: fs.Stats, st: FileStamp): boolean => s.ino === st.ino && s.size === st.size && s.mtimeMs === st.mtimeMs

/** Put an original set aside back; anything written at `p` meanwhile is appended after it, never lost. */
async function putBack(p: string, aside: string): Promise<void> {
  try {
    await fsp.link(aside, p)
    await fsp.rm(aside, { force: true })
    return
  } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e }
  // A writer made a new file at `p` (an append by path): old bytes first, then the new ones.
  const merged = tmpName(p)
  await pipeline(fs.createReadStream(aside), fs.createWriteStream(merged, { mode: 0o600 }))
  await pipeline(fs.createReadStream(p), fs.createWriteStream(merged, { flags: 'a' }))
  await fsyncPath(merged)
  await fsp.rename(merged, p)
  await fsp.rm(aside, { force: true })
}

/**
 * Remove a session's originals (archived and verified): each is renamed aside
 * (the transcript last), and after SETTLE_MS each must still be the file it
 * was and no new file may stand at its name. Anything else puts every one back
 * (merging a new file a writer made) and throws, so the caller drops the archive.
 */
async function removeOriginals(c: Candidate, items: Array<{ rel: string; stamp: FileStamp }>): Promise<void> {
  const aside: Array<{ p: string; tmp: string; stamp: FileStamp }> = []
  let moved = false
  try {
    for (const it of items) {
      const p = path.join(c.dir, it.rel)
      const tmp = tmpName(p)
      await fsp.rename(p, tmp)
      aside.push({ p, tmp, stamp: it.stamp })
      if (!unchanged(await fsp.lstat(tmp), it.stamp)) { moved = true; break }
    }
    if (!moved) {
      await new Promise(r => setTimeout(r, SETTLE_MS))
      for (const a of aside) {
        if (!unchanged(await fsp.lstat(a.tmp), a.stamp)) { moved = true; break }
        if (await fsp.lstat(a.p).then(() => true, () => false)) { moved = true; break }
      }
    }
  } catch (e) {
    for (const a of aside.reverse()) await putBack(a.p, a.tmp)
    throw e
  }
  if (moved) {
    for (const a of aside.reverse()) await putBack(a.p, a.tmp)
    throw new Error(`${c.sid} was written while it was archived`)
  }
  for (const a of aside) await fsp.rm(a.tmp, { force: true })
}

/** Remove temp files a crashed pass left in a project dir (and its session folders). */
async function sweepTemps(dir: string, names: string[], now: number): Promise<void> {
  for (const n of names) {
    if (!n.includes(TMP_TAG)) continue
    const p = path.join(dir, n)
    // By ctime: an original set aside keeps its old mtime, and the rename that set it aside moved its ctime.
    try { if (now - (await fsp.lstat(p)).ctimeMs > 3_600_000) await fsp.rm(p, { force: true }) } catch { /* gone */ }
  }
}

/**
 * One archive pass over every projects dir: each plain session older than the
 * cutoff, not live, is compressed. Budgeted and resumable (a session either
 * moves whole or stays as it was), so a pass that stops early loses nothing.
 */
export async function archiveTranscripts(projectsDirs: string[], opts: ArchiveOptions): Promise<ArchiveReport> {
  const now = opts.now ?? Date.now()
  const cutoff = now - opts.olderThanMs
  const until = Date.now() + (opts.budgetMs ?? 10 * 60_000)
  const max = opts.maxSessions ?? Infinity
  const r: ArchiveReport = { sessions: 0, files: 0, bytesBefore: 0, bytesAfter: 0, skippedLive: 0, failed: 0, errors: [], partial: false, dryRun: !!opts.dryRun }
  if (!(opts.olderThanMs > 0)) return r
  for (const root of [...new Set(projectsDirs)]) {
    let projects: fs.Dirent[]
    try { projects = await fsp.readdir(root, { withFileTypes: true }) } catch { continue }
    for (const p of projects) {
      if (!p.isDirectory()) continue
      const dir = path.join(root, p.name)
      let names: string[]
      try { names = await fsp.readdir(dir) } catch { continue }
      await sweepTemps(dir, names, now)
      for (const name of names) {
        if (!name.endsWith('.jsonl')) continue
        const sid = name.slice(0, -6)
        if (!SID_RE.test(sid)) continue
        if (Date.now() > until || r.sessions >= max) { r.partial = true; return r }
        const c = await candidate(dir, sid, cutoff)
        if (!c) continue
        if (opts.isLive?.(sid)) { r.skippedLive++; continue }
        if (opts.dryRun) {
          r.sessions++; r.files += c.side.length + 1
          r.bytesBefore += c.stamp.size + c.side.reduce((n, s) => n + s.stamp.size, 0)
          continue
        }
        if (openedRecently(sid)) { r.skippedLive++; continue }
        const h = tryLock(dir, sid)
        if (!h) continue
        try {
          await withBeat(h, async () => {
            // A pass that stopped halfway left a manifest: finish the way back first, so
            // the new manifest names every file of the session, then archive it whole.
            let cur: Candidate | null = c
            if (fs.existsSync(manifestPath(dir, sid))) { await restoreLocked(dir, sid); cur = await candidate(dir, sid, cutoff) }
            if (!cur) return
            const got = await archiveSession(cur, h, opts.isLiveNow)
            r.sessions++; r.files += got.files; r.bytesBefore += got.before; r.bytesAfter += got.after
          })
        } catch (e) {
          r.failed++
          if (r.errors.length < 10) r.errors.push(`${path.join(dir, name)}: ${(e as Error).message}`)
        }
      }
    }
  }
  return r
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
  const exists = (p: string) => fsp.lstat(p).then(() => true, () => false)
  // No manifest and no pass at work on it: nothing to do. A pass at work (its lock) is
  // waited for, since it may write a manifest and remove the plain file next.
  if (!(await exists(manifestPath(dir, sid))) && !(await exists(lockPath(dir, sid)))) return exists(plain)
  const h = await lockWait(dir, sid, RESTORE_WAIT_MS)
  if (!h) throw new Error(`session ${sid} is being archived; try again`)
  return withBeat(h, async () => (await exists(manifestPath(dir, sid))) ? restoreLocked(dir, sid) : exists(plain))
}

/** The restore itself; the caller holds the session's lock. */
async function restoreLocked(dir: string, sid: string): Promise<boolean> {
  const exists = (p: string) => fsp.lstat(p).then(() => true, () => false)
  {
    const m = await readManifest(dir, sid)
    if (!m) throw new Error(`archive manifest of ${sid} cannot be read`)
    const want = new Map(m.files.map(f => [f.rel, f]))
    const rels = m.files.map(f => f.rel)
    // Sidecar files first, the transcript last: a plain transcript means a whole session.
    rels.sort((a, b) => (a === sid + '.jsonl' ? 1 : 0) - (b === sid + '.jsonl' ? 1 : 0))
    for (const rel of rels) {
      const p = path.join(dir, rel)
      const g = p + ARCHIVE_SUFFIX
      if (await exists(p)) { await fsp.rm(g, { force: true }); continue }
      if (!(await exists(g))) {
        if (rel === sid + '.jsonl') throw new Error(`archive of ${sid} has no transcript`)
        continue
      }
      await decompressOne(g, want.get(rel))
    }
    await fsp.rm(manifestPath(dir, sid), { force: true })
    return true
  }
}

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
    if (base.includes(TMP_TAG) || base.endsWith(MANIFEST_SUFFIX) || base.endsWith(LOCK_SUFFIX)) continue
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
