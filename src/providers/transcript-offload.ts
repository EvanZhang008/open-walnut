/**
 * Session history in remote storage, the tier after the archive (2026-11-10, the user:
 * "do it s3, or other"). A session the archive compressed (transcript-archive.ts) whose
 * files are all older than the remote cutoff (default 180 days) has its `.gz` files
 * uploaded to an S3-compatible bucket and, once checked again, removed here. Opening it
 * brings them back (transcript-archive.ts restoreLocked, through its fetcher) and then
 * decompresses as for any archive.
 *
 * Nothing is lost, in two steps, as with the archive itself. First each archive file is
 * hashed (sha256 and md5), uploaded under a name holding its hash (so an object is never
 * replaced by other bytes), and the upload is checked: the store verifies the md5 it was
 * sent, and a HEAD must answer its size and that md5 as the ETag (an ETag that is no plain
 * md5 has the object read back and its sha256 compared). Only then does the manifest record the objects (`remote`). Second, a pass at least
 * OFFLOAD_KEEP_MS later checks every local file still hashes as recorded and every object is
 * still holds those bytes (the same check), records `offloadedAt`, and removes the local files. A crash at
 * any point leaves files the manifest names: a restore fetches only what is missing, and
 * checks each download's sha256 before it is put in place (never over a file there).
 *
 * The remote objects are never removed by Walnut: they stay as a copy after a restore.
 * Every step holds the archive's own per-session lock, so an offload, a compression pass and
 * a restore never interleave. The fetcher runs under a restore's lock and takes none.
 *
 * Only the server holds the storage's credentials; it runs this for its own host, next to the
 * files. A daemon asks its server to fetch (capability `history.fetch`).
 */
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { pipeline } from 'node:stream/promises'
import { Writable } from 'node:stream'
import { ARCHIVE_SUFFIX, MANIFEST_SUFFIX, RemoteHistoryError, archiveInternals as A, type Manifest, type RemoteFile } from './transcript-archive.js'

/** How long uploaded files stay here too before a later pass removes them. */
export const OFFLOAD_KEEP_MS = 60 * 60_000

export interface OffloadStore {
  bucket: string
  endpoint?: string
  region?: string
  /** Upload `file` as `key`; the store must refuse it when the bytes do not match `md5` (hex). */
  put(key: string, file: string, info: { size: number; md5: string; sha256: string }): Promise<void>
  /** The object's size and ETag, or null when there is none. */
  head(key: string): Promise<{ size: number; etag?: string } | null>
  /** Read the whole object back and hash it (for an ETag that is no plain md5), or null when there is none. */
  readHash(key: string): Promise<{ size: number; sha256: string } | null>
}

export interface FetchStore {
  /** Download `key` of `bucket` (at `endpoint`, in `region`) into `dst`. */
  get(remote: { bucket: string; endpoint?: string; region?: string }, key: string, dst: string): Promise<void>
}

export interface OffloadOptions {
  store: OffloadStore
  /** Sessions whose every file is older than this many ms go to remote storage. */
  olderThanMs: number
  /** Object names start with this (no trailing slash). */
  keyPrefix: string
  now?: number
  budgetMs?: number
  dryRun?: boolean
}

export interface OffloadReport {
  /** Sessions whose archive files were uploaded and checked in this pass. */
  uploaded: number
  uploadedBytes: number
  /** Sessions whose local archive files went in this pass, and the bytes that freed. */
  offloaded: number
  freedBytes: number
  /** Sessions uploaded and waiting OFFLOAD_KEEP_MS before their local files go. */
  waiting: number
  failed: number
  errors: string[]
  partial: boolean
}

async function hashFile(p: string): Promise<{ size: number; sha256: string; md5: string }> {
  const sha = createHash('sha256')
  const md5 = createHash('md5')
  let size = 0
  await pipeline(fs.createReadStream(p), new Writable({
    write(chunk: Buffer, _e, cb) { size += chunk.length; sha.update(chunk); md5.update(chunk); cb() },
  }))
  return { size, sha256: sha.digest('hex'), md5: md5.digest('hex') }
}

/** The md5 an ETag carries: only a single-part upload's ETag without KMS is one. */
function plainMd5(etag: string | undefined): string | null {
  const e = (etag ?? '').replace(/"/g, '').toLowerCase()
  return /^[0-9a-f]{32}$/.test(e) ? e : null
}

/**
 * Does the object hold exactly these bytes? Its size first; then an ETag that is a plain md5
 * answers it, and any other ETag (KMS, multipart, a store's own) means reading it back, since
 * only its content proves it (metadata can be written by anyone who can write the object).
 */
async function holds(store: OffloadStore, key: string, h: { size: number; md5: string; sha256: string }): Promise<boolean> {
  const there = await store.head(key)
  if (!there || there.size !== h.size) return false
  const md5 = plainMd5(there.etag)
  if (md5) return md5 === h.md5
  const back = await store.readHash(key)
  return !!back && back.size === h.size && back.sha256 === h.sha256
}

const posix = (rel: string) => rel.split(path.sep).join('/')
export const objectKey = (prefix: string, dir: string, rel: string, sha256: string): string =>
  `${prefix.replace(/\/+$/, '')}/${path.basename(dir)}/${posix(rel)}.${sha256.slice(0, 16)}${ARCHIVE_SUFFIX}`

/** Every file of the manifest older than the cutoff (their original mtimes). */
const oldEnough = (m: Manifest, cutoff: number) => m.files.length > 0 && m.files.every((f) => f.mtimeMs < cutoff)

/** Is any file of the session at its plain name, or set aside? Then it is not ours to move. */
async function anyPlain(dir: string, m: Manifest): Promise<boolean> {
  for (const f of m.files) {
    const p = path.join(dir, f.rel)
    if ((await A.exists(p)) || (await A.exists(p + A.ORIG_SUFFIX))) return true
  }
  return false
}

async function upload(dir: string, m: Manifest, o: OffloadOptions, now: number): Promise<number> {
  const files: RemoteFile[] = []
  let bytes = 0
  for (const f of m.files) {
    const gz = path.join(dir, f.rel + ARCHIVE_SUFFIX)
    const h = await hashFile(gz)
    const key = objectKey(o.keyPrefix, dir, f.rel, h.sha256)
    // An object already under the name (an earlier pass) is used only when it holds these bytes.
    if (!(await holds(o.store, key, h))) {
      await o.store.put(key, gz, h)
      if (!(await holds(o.store, key, h))) throw new Error(`${key} did not check out after its upload`)
    }
    files.push({ rel: f.rel, key, gzSize: h.size, gzSha256: h.sha256, md5: h.md5 })
    bytes += h.size
  }
  const remote = { bucket: o.store.bucket, ...(o.store.endpoint ? { endpoint: o.store.endpoint } : {}), ...(o.store.region ? { region: o.store.region } : {}), uploadedAt: now, files }
  await A.writeManifest(dir, { ...m, remote })
  return bytes
}

/** The second step: every local file still as uploaded, every object still there; then the local files go. */
async function removeLocal(dir: string, m: Manifest, o: OffloadOptions, now: number): Promise<number> {
  const r = m.remote!
  if (r.bucket !== o.store.bucket || (r.endpoint ?? '') !== (o.store.endpoint ?? '')) throw new Error('uploaded to another bucket than the one set now')
  let freed = 0
  for (const f of m.files) {
    const rf = r.files.find((x) => x.rel === f.rel)
    if (!rf) throw new Error(`${f.rel} has no remote copy recorded`)
    const local = await hashFile(path.join(dir, f.rel + ARCHIVE_SUFFIX))
    if (local.sha256 !== rf.gzSha256 || local.size !== rf.gzSize) throw new Error(`${f.rel}${ARCHIVE_SUFFIX} changed since its upload`)
    if (!(await holds(o.store, rf.key, { size: rf.gzSize, md5: rf.md5, sha256: rf.gzSha256 }))) throw new Error(`${rf.key} is not in remote storage as uploaded`)
    freed += local.size
  }
  await A.writeManifest(dir, { ...m, remote: { ...r, offloadedAt: now } })
  for (const f of m.files) await fsp.rm(path.join(dir, f.rel + ARCHIVE_SUFFIX), { force: true })
  return freed
}

/**
 * One pass over every projects dir: each archived session old enough is uploaded; each one
 * uploaded OFFLOAD_KEEP_MS ago has its local archive files removed. Budgeted and resumable.
 */
export async function offloadArchived(projectsDirs: string[], o: OffloadOptions): Promise<OffloadReport> {
  const now = o.now ?? Date.now()
  const cutoff = now - o.olderThanMs
  const until = Date.now() + (o.budgetMs ?? 10 * 60_000)
  const r: OffloadReport = { uploaded: 0, uploadedBytes: 0, offloaded: 0, freedBytes: 0, waiting: 0, failed: 0, errors: [], partial: false }
  if (!(o.olderThanMs > 0)) return r
  const fail = (where: string, e: unknown) => {
    r.failed++
    if (r.errors.length < 10) r.errors.push(`${where}: ${(e as Error).message}`)
  }
  for (const root of [...new Set(projectsDirs)]) {
    let projects: fs.Dirent[]
    try { projects = await fsp.readdir(root, { withFileTypes: true }) } catch { continue }
    for (const p of projects) {
      if (!p.isDirectory()) continue
      const dir = path.join(root, p.name)
      let names: string[]
      try { names = await fsp.readdir(dir) } catch { continue }
      for (const name of names) {
        if (!name.endsWith(MANIFEST_SUFFIX)) continue
        const sid = name.slice(0, -MANIFEST_SUFFIX.length)
        if (!A.SID_RE.test(sid)) continue
        const m = await A.readManifest(dir, sid)
        // Still being archived (originals aside), already here only remotely, or not old enough.
        if (!m || m.asideAt !== undefined || m.remote?.offloadedAt !== undefined || !oldEnough(m, cutoff)) continue
        const step2 = !!m.remote && now - m.remote.uploadedAt >= OFFLOAD_KEEP_MS
        if (m.remote && !step2) { r.waiting++; continue }
        if (Date.now() > until) { r.partial = true; return r }
        if (o.dryRun) { if (!m.remote) r.uploaded++; continue }
        const h = A.tryLock(dir, sid)
        if (!h) continue
        try {
          await A.withBeat(h, async () => {
            const cur = await A.readManifest(dir, sid)
            if (!cur || cur.asideAt !== undefined || cur.remote?.offloadedAt !== undefined || (await anyPlain(dir, cur))) return
            if (!cur.remote) { r.uploadedBytes += await upload(dir, cur, o, now); r.uploaded++; r.waiting++ }
            else if (now - cur.remote.uploadedAt >= OFFLOAD_KEEP_MS) { r.freedBytes += await removeLocal(dir, cur, o, now); r.offloaded++ }
            A.beat(h)
          })
        } catch (e) { fail(path.join(dir, name), e) }
      }
    }
  }
  return r
}

/**
 * Bring back the archive files of `sid` in `dir` that only remote storage holds (the
 * restore's fetcher; its caller holds the session's lock). Each download is checked against
 * the manifest's sha256 and size before it is put in place, never over a file there.
 */
export async function fetchRemoteArchive(dir: string, sid: string, store: FetchStore): Promise<number> {
  if (!A.SID_RE.test(sid)) throw new RemoteHistoryError(`not a session id: ${sid}`)
  const m = await A.readManifest(dir, sid)
  if (!m?.remote) return 0
  let got = 0
  for (const rf of m.remote.files) {
    const gz = path.join(dir, rf.rel) + ARCHIVE_SUFFIX
    // A plain or set-aside copy stands in only when it holds the recorded bytes (restoreLocked keeps both otherwise).
    const f = m.files.find((x) => x.rel === rf.rel)
    if (await A.exists(gz) || (f && (await A.heldHere(dir, f)))) continue
    await fsp.mkdir(path.dirname(gz), { recursive: true })
    const tmp = A.tmpName(gz)
    try {
      await store.get(m.remote, rf.key, tmp)
      const h = await hashFile(tmp)
      if (h.sha256 !== rf.gzSha256 || h.size !== rf.gzSize) throw new RemoteHistoryError(`${rf.key} in remote storage does not match what was uploaded`)
      await A.fsyncPath(tmp)
      await A.install(tmp, gz)
      got++
    } catch (e) {
      await fsp.rm(tmp, { force: true })
      throw e instanceof RemoteHistoryError ? e : new RemoteHistoryError(`could not fetch ${rf.key} from remote storage: ${(e as Error).message}`)
    }
  }
  return got
}

/** Sessions here and their bytes, by where their history is: plain-but-archived here, uploaded, only remote. */
export async function remoteTierStatus(projectsDirs: string[]): Promise<{ uploaded: number; remoteOnly: number; remoteBytes: number }> {
  const out = { uploaded: 0, remoteOnly: 0, remoteBytes: 0 }
  for (const root of [...new Set(projectsDirs)]) {
    let projects: fs.Dirent[]
    try { projects = await fsp.readdir(root, { withFileTypes: true }) } catch { continue }
    for (const p of projects) {
      if (!p.isDirectory()) continue
      const dir = path.join(root, p.name)
      let names: string[]
      try { names = await fsp.readdir(dir) } catch { continue }
      for (const name of names) {
        if (!name.endsWith(MANIFEST_SUFFIX)) continue
        const m = await A.readManifest(dir, name.slice(0, -MANIFEST_SUFFIX.length))
        if (!m?.remote) continue
        out.uploaded++
        if (m.remote.offloadedAt !== undefined) out.remoteOnly++
        out.remoteBytes += m.remote.files.reduce((n, f) => n + f.gzSize, 0)
      }
    }
  }
  return out
}
