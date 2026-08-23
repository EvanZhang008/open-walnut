/**
 * Chunked bundle push — the big-push channel that survives hostile networks.
 *
 * Why this exists (2026-08-22, T60/T65): endpoint-security network filters on
 * some client machines corrupt long sustained TLS uploads. A `git push` of a
 * pack past a few dozen MB dies mid-stream with "SSL bad record mac" while
 * a 25MB push sails through — and the killed receive-pack strands a quarantine
 * dir on the hub every time (the disk-fill debris chain). Controlled
 * experiment: the same 250MB pack pushed locally on the hub box succeeds, so
 * the server is healthy; the wire from the client is the problem, and it is
 * not something we can configure away on machines we don't administer.
 *
 * The daemon deployer solved the identical problem long ago: split the payload
 * into small pieces, one HTTP request per piece — filters that murder a long
 * stream leave short requests alone. This route brings that to git sync:
 *
 *   client: git bundle create <tmp> ^<remote-tip>.. main   (self-contained delta)
 *           split into CHUNK_BYTES pieces
 *   POST /git/data/bundle/start?sha256=..&bytes=..&chunk=..
 *           → { uploadId, resumable, nextSeq, resumed }
 *   GET  /git/data/bundle/status?upload=..&sha256=..&chunk=..&bytes=..
 *           → { ok, nextSeq, bytes, ... } | 409 mismatch | 404 expired
 *   POST /git/data/bundle/chunk?upload=..&seq=N (raw bytes, one connection each)
 *   POST /git/data/bundle/finish { sha256, ref, oldValue, newValue }
 *           → hub verifies hash, `git bundle verify`, fetches the bundle,
 *             then updates the ref with a compare-and-swap (same safety as
 *             force-with-lease: oldValue must match or 409).
 *
 * Auth: rides the same gitAuthMiddleware as the smart-HTTP routes (device
 * token via Bearer or Basic). Mounted under /git/data in server.ts, cloud
 * mode only, BEFORE body parsers (chunk bodies are raw binary).
 *
 * RESUME (2026-08-22, round 2). The data repo's pack passed 2.5GB, so a
 * full-history rescue bundle is ~210 chunks — and a filter that kills one
 * chunk three times in a row used to abort the WHOLE run, which then restarted
 * at chunk 1 on the next attempt and never converged. So an upload is a LEASE,
 * not a single request's worth of state:
 *   - the lease's progress lives on DISK (meta.json beside the chunk file), so
 *     it survives a hub restart, not just a client reconnect
 *   - the client declares the bundle's identity (sha256 + size + chunk size) at
 *     start, so a resume can be PROVEN to be the same bundle; a different
 *     bundle gets a fresh lease instead of silently appending to the old one
 *   - `status` answers "how far did you get" in one small request
 *   - the TTL is 24h (was 30min): a lease must comfortably outlive the gap
 *     between two compaction attempts, or cross-run resume is theatre
 *
 * Server-side safety:
 *   - uploads are staged under the hub dir (same filesystem, easy cleanup),
 *     never executed, and only ever handed to `git bundle verify` + `git fetch`
 *   - per-upload byte cap, total-staging cap, concurrent-lease cap
 *   - stale leases swept lazily from start/status/finish (no timer to leak) —
 *     including orphan lease DIRS left by a restart, which the in-memory-only
 *     sweep could never see
 *   - one chunk write in flight per lease (two writers appending to the same
 *     file would interleave bytes and corrupt the bundle)
 *   - disk watermark refuses new uploads exactly like receive-pack does
 */

import { spawn } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { Router, type Request, type Response } from 'express'
import { isDiskWriteBlocked } from '../../core/disk-watermark.js'
import { log } from '../../logging/index.js'

/** Fixed repo name inside the hub dir — one data repo per companion box. */
const HUB_REPO_NAME = 'walnut-data.git'

/** Hard per-upload byte budget. The 2026-08 rescue bundle was 465MB; the data
 *  repo's own pack has since passed 2.5GB, and a full-history rewrite bundle is
 *  the same order — a 2GB cap would fail such a push at chunk ~250 of 320. */
export const MAX_BUNDLE_BYTES = 4 * 1024 * 1024 * 1024
/** Max chunk body we accept in one request. Client default is 8MB. */
export const MAX_CHUNK_BYTES = 32 * 1024 * 1024
/** Concurrent upload leases (one pusher in practice; headroom for retries). */
export const MAX_SESSIONS = 4
/**
 * A lease untouched this long is abandoned — swept lazily.
 *
 * 24h, deliberately generous: the whole point of a resumable lease is that the
 * NEXT attempt (a compaction retry is tens of minutes later, a daily run 24h
 * later) can pick it up. The old 30min TTL expired between attempts, so every
 * retry started from chunk 1. Disk exposure is bounded by MAX_STAGING_BYTES,
 * not by the clock.
 */
export const SESSION_TTL_MS = 24 * 60 * 60_000
/**
 * Total bytes we let in-flight leases hold. With a 24h TTL the clock no longer
 * bounds staging, so this does: abandoned leases are evicted oldest-first to
 * stay under it (the hub disk filling up is a shipped outage, twice).
 */
export const MAX_STAGING_BYTES = 6 * 1024 * 1024 * 1024
/** A lease touched this recently is presumed LIVE — never evicted, never
 *  adopted by a second pusher of the same bundle. */
export const ACTIVE_SESSION_MS = 5 * 60_000
/** Sweeps are lazy; don't re-walk the staging dir on every single request. */
const SWEEP_INTERVAL_MS = 60_000

function hubDir(): string {
  return process.env.WALNUT_GIT_HUB_DIR ?? '/var/lib/walnut/git'
}

function hubRepo(): string {
  return path.join(hubDir(), HUB_REPO_NAME)
}

/** Staging area for in-flight bundle uploads (same fs as the hub repo). */
function stagingDir(): string {
  return path.join(hubDir(), 'bundle-uploads')
}

interface UploadSession {
  id: string
  dir: string
  bytes: number
  /** Highest contiguous seq received (chunks must arrive in order). */
  nextSeq: number
  touchedAt: number
  createdAt: number
  /**
   * Bundle identity as DECLARED by the client at start. Empty/0 when the client
   * predates resume support — such a lease works exactly as before (in-memory,
   * single run) but can never be resumed, because without the chunk size there
   * is no way to map a byte count back to a chunk index.
   */
  sha256: string
  totalBytes: number
  chunkBytes: number
  /** A chunk write is in flight. Two appenders would interleave bytes. */
  writing?: boolean
}

/** The subset of a lease that is persisted next to its chunk file. */
type UploadMeta = Omit<UploadSession, 'dir' | 'writing'>

const sessions = new Map<string, UploadSession>()
let lastSweepAt = 0

function metaPath(dir: string): string {
  return path.join(dir, 'meta.json')
}

function bundlePathFor(dir: string): string {
  return path.join(dir, 'data.bundle')
}

/** Persist lease progress. Write-then-rename so a torn write can't strand a
 *  half-JSON meta (which would make the lease unresumable, not just stale). */
async function writeMeta(s: UploadSession): Promise<void> {
  const meta: UploadMeta = {
    id: s.id, bytes: s.bytes, nextSeq: s.nextSeq, touchedAt: s.touchedAt,
    createdAt: s.createdAt, sha256: s.sha256, totalBytes: s.totalBytes, chunkBytes: s.chunkBytes,
  }
  const tmp = `${metaPath(s.dir)}.tmp`
  await fsp.writeFile(tmp, JSON.stringify(meta), 'utf-8')
  await fsp.rename(tmp, metaPath(s.dir))
}

async function readMeta(dir: string): Promise<UploadMeta | null> {
  try {
    const raw = await fsp.readFile(metaPath(dir), 'utf-8')
    const parsed = JSON.parse(raw) as Partial<UploadMeta>
    if (!parsed.id || !UPLOAD_ID_RE.test(parsed.id)) return null
    return {
      id: parsed.id,
      bytes: Number(parsed.bytes) || 0,
      nextSeq: Number(parsed.nextSeq) || 0,
      touchedAt: Number(parsed.touchedAt) || 0,
      createdAt: Number(parsed.createdAt) || 0,
      sha256: typeof parsed.sha256 === 'string' ? parsed.sha256 : '',
      totalBytes: Number(parsed.totalBytes) || 0,
      chunkBytes: Number(parsed.chunkBytes) || 0,
    }
  } catch {
    return null
  }
}

/**
 * Reconcile a persisted lease against the chunk file actually on disk.
 *
 * Pure so it can be reasoned about (and tested) on its own, because every case
 * here is a crash window: the chunk is appended BEFORE its meta is written, so
 * a hub that died in between leaves a file LONGER than meta.bytes (a chunk the
 * client was never told we have). Trusting the file would leave the client's
 * seq counter and our byte count disagreeing forever, so the tail gets cut back
 * to a whole number of chunks and the client simply resends that one.
 *
 * @returns the byte count / next seq to resume from, and where to truncate.
 */
export function reconcileResumeState(
  meta: Pick<UploadMeta, 'bytes' | 'nextSeq' | 'chunkBytes' | 'totalBytes'>,
  fileSize: number,
): { bytes: number; nextSeq: number; truncateTo: number } {
  const chunk = meta.chunkBytes
  // No declared chunk size (pre-resume client): bytes can't be mapped to a seq.
  if (!Number.isFinite(chunk) || chunk <= 0) return { bytes: 0, nextSeq: 0, truncateTo: 0 }
  const usable = Math.max(0, Math.min(fileSize, meta.bytes))
  // Every chunk is exactly `chunk` bytes except the LAST one of the bundle, so
  // a complete file is the one case where a partial tail is legitimate.
  if (meta.totalBytes > 0 && usable >= meta.totalBytes) {
    const complete = Math.ceil(meta.totalBytes / chunk)
    return { bytes: meta.totalBytes, nextSeq: complete, truncateTo: meta.totalBytes }
  }
  const whole = Math.floor(usable / chunk) * chunk
  const nextSeq = Math.min(whole / chunk, Math.max(0, meta.nextSeq))
  return { bytes: nextSeq * chunk, nextSeq, truncateTo: nextSeq * chunk }
}

/** Which part of a resume request contradicts the lease (null = same bundle). */
export function resumeMismatchReason(
  lease: Pick<UploadSession, 'sha256' | 'chunkBytes' | 'totalBytes'>,
  declared: { sha256?: string; chunkBytes?: number; totalBytes?: number },
): 'sha256' | 'chunkBytes' | 'totalBytes' | 'unknown-bundle' | null {
  // A lease with no recorded identity cannot prove it holds the caller's
  // bundle, so it must not be resumed into.
  if (!lease.sha256 || lease.chunkBytes <= 0) return 'unknown-bundle'
  if (declared.sha256 && declared.sha256 !== lease.sha256) return 'sha256'
  if (declared.chunkBytes !== undefined && declared.chunkBytes > 0 && declared.chunkBytes !== lease.chunkBytes) return 'chunkBytes'
  if (declared.totalBytes !== undefined && declared.totalBytes > 0 && lease.totalBytes > 0 && declared.totalBytes !== lease.totalBytes) return 'totalBytes'
  return null
}

async function evictSession(s: UploadSession, why: string): Promise<void> {
  sessions.delete(s.id)
  await fsp.rm(s.dir, { recursive: true, force: true }).catch(() => {})
  log.web.warn('bundle-push: dropped upload lease', { uploadId: s.id, bytes: s.bytes, why })
}

/** Lease ids with a staging dir on disk (the truth after a hub restart). */
async function listStagedIds(): Promise<string[]> {
  try {
    const entries = await fsp.readdir(stagingDir(), { withFileTypes: true })
    return entries.filter((e) => e.isDirectory() && UPLOAD_ID_RE.test(e.name)).map((e) => e.name)
  } catch {
    return []
  }
}

/** Adopt a lease dir into memory, repairing a torn tail. null = unusable. */
async function hydrateSession(id: string): Promise<UploadSession | null> {
  const dir = path.join(stagingDir(), id)
  const meta = await readMeta(dir)
  if (!meta) return null
  const fileSize = await fsp.stat(bundlePathFor(dir)).then((s) => s.size).catch(() => 0)
  const fixed = reconcileResumeState(meta, fileSize)
  if (fixed.truncateTo !== fileSize) {
    try {
      await fsp.truncate(bundlePathFor(dir), fixed.truncateTo)
    } catch {
      if (fixed.truncateTo > 0) return null // can't trust the file we can't repair
    }
    log.web.info('bundle-push: repaired lease tail on adopt', { uploadId: id, fileSize, truncatedTo: fixed.truncateTo })
  }
  const session: UploadSession = {
    id, dir, bytes: fixed.bytes, nextSeq: fixed.nextSeq, touchedAt: meta.touchedAt || Date.now(),
    createdAt: meta.createdAt || meta.touchedAt || Date.now(),
    sha256: meta.sha256, totalBytes: meta.totalBytes, chunkBytes: meta.chunkBytes,
  }
  sessions.set(id, session)
  return session
}

/**
 * Drop leases that went quiet and adopt the ones that didn't — called lazily
 * (throttled) from start/status/finish, so there is no timer to leak.
 *
 * Scanning DISK, not just the map, is the point: a hub restart empties the map
 * while every lease dir survives, and the old in-memory-only sweep could
 * therefore never reclaim them (nor let a client resume one).
 */
async function sweepStaleSessions(now = Date.now(), force = false): Promise<void> {
  if (!force && now - lastSweepAt < SWEEP_INTERVAL_MS) return
  lastSweepAt = now
  for (const s of [...sessions.values()]) {
    if (now - s.touchedAt > SESSION_TTL_MS) await evictSession(s, 'ttl-expired')
  }
  for (const id of await listStagedIds()) {
    if (sessions.has(id)) continue
    const dir = path.join(stagingDir(), id)
    const meta = await readMeta(dir)
    const touched = meta?.touchedAt
      || await fsp.stat(dir).then((st) => st.mtimeMs).catch(() => 0)
    if (!touched || now - touched > SESSION_TTL_MS) {
      await fsp.rm(dir, { recursive: true, force: true }).catch(() => {})
      log.web.warn('bundle-push: swept abandoned lease dir', { uploadId: id, ageMs: touched ? now - touched : null })
      continue
    }
    await hydrateSession(id)
  }
}

/** Lease by id — memory first, then disk (a restart empties memory only). */
async function getSession(id: string): Promise<UploadSession | null> {
  return sessions.get(id) ?? await hydrateSession(id)
}

function stagedBytes(): number {
  let total = 0
  for (const s of sessions.values()) total += s.bytes
  return total
}

/**
 * Make room for a new lease by evicting ABANDONED ones (oldest first). A lease
 * touched in the last ACTIVE_SESSION_MS belongs to a live pusher and is never
 * evicted — so a flood of new leases gets a 429 instead of stealing progress
 * from whoever is actually uploading.
 */
async function makeRoomForLease(now: number): Promise<boolean> {
  const overCap = (): boolean => sessions.size >= MAX_SESSIONS || stagedBytes() > MAX_STAGING_BYTES
  if (!overCap()) return true
  const evictable = [...sessions.values()]
    .filter((s) => now - s.touchedAt > ACTIVE_SESSION_MS)
    .sort((a, b) => a.touchedAt - b.touchedAt)
  for (const s of evictable) {
    if (!overCap()) break
    await evictSession(s, 'cap-eviction')
  }
  return !overCap()
}

/** Run a git command against the hub repo; resolve stdout, reject on nonzero. */
function gitHub(args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', ['-C', hubRepo(), ...args], { stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    let err = ''
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error(`git ${args[0]} timed out after ${timeoutMs}ms`))
    }, timeoutMs)
    child.stdout.on('data', (c: Buffer) => { out += c.toString('utf-8') })
    child.stderr.on('data', (c: Buffer) => { err = (err + c.toString('utf-8')).slice(-2000) })
    child.on('error', (e) => { clearTimeout(timer); reject(e) })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (code === 0) resolve(out.trim())
      else reject(new Error(`git ${args.join(' ')} exited ${code}: ${err.trim()}`))
    })
  })
}

/** Read a request body fully with a byte cap. Rejects (413) past the cap. */
function readBody(req: Request, cap: number): Promise<Buffer | null> {
  return new Promise((resolve) => {
    const parts: Buffer[] = []
    let total = 0
    let done = false
    req.on('data', (c: Buffer) => {
      if (done) return
      total += c.length
      if (total > cap) {
        done = true
        resolve(null)
        req.destroy()
        return
      }
      parts.push(c)
    })
    req.on('end', () => { if (!done) { done = true; resolve(Buffer.concat(parts)) } })
    req.on('error', () => { if (!done) { done = true; resolve(null) } })
  })
}

/** Only ever accept our own generated ids back — no path material from clients. */
const UPLOAD_ID_RE = /^[0-9a-f]{32}$/
const SHA256_RE = /^[0-9a-f]{64}$/
const OID_RE = /^[0-9a-f]{40,64}$/
/** Branch ref the CAS update may touch. Data hub only ever syncs main. */
const ALLOWED_REF_RE = /^refs\/heads\/[A-Za-z0-9._-]+$/

export const gitBundlePushRouter = Router()

/** Parse the client's declared bundle identity off the query string.
 *  Query, not a JSON body, on purpose: an older hub ignores unknown query
 *  params, so the same request shape works against both. */
function declaredIdentity(req: Request): { sha256: string; totalBytes: number; chunkBytes: number } {
  const sha256 = String(req.query.sha256 ?? '')
  const totalBytes = Number(req.query.bytes ?? 0)
  const chunkBytes = Number(req.query.chunk ?? 0)
  return {
    sha256: SHA256_RE.test(sha256) ? sha256 : '',
    totalBytes: Number.isFinite(totalBytes) && totalBytes > 0 ? Math.floor(totalBytes) : 0,
    chunkBytes: Number.isFinite(chunkBytes) && chunkBytes > 0 ? Math.floor(chunkBytes) : 0,
  }
}

// ── start: allocate (or re-adopt) an upload lease ─────────────────────────────
gitBundlePushRouter.post('/bundle/start', async (req: Request, res: Response) => {
  if (isDiskWriteBlocked()) {
    res.status(503).type('text/plain').send('data hub disk critically full — upload refused')
    return
  }
  if (!fs.existsSync(hubRepo())) {
    res.status(404).type('text/plain').send('data hub repo not found')
    return
  }
  const declared = declaredIdentity(req)
  // Fail fast on a bundle we could never accept: a 413 at chunk 250 of 320
  // costs the client half an hour and looks like a network fault.
  if (declared.totalBytes > MAX_BUNDLE_BYTES) {
    res.status(413).type('text/plain').send('bundle exceeds size budget')
    return
  }
  const now = Date.now()
  await sweepStaleSessions(now)

  // Re-adopt: the same bundle already has a lease that nobody is actively
  // pushing to. This is what makes a retry cheap even when the client lost its
  // own record of the lease id (fresh process, wiped state file).
  if (declared.sha256 && declared.chunkBytes > 0) {
    for (const s of sessions.values()) {
      if (now - s.touchedAt <= ACTIVE_SESSION_MS) continue // live pusher — hands off
      if (resumeMismatchReason(s, declared) !== null) continue
      s.touchedAt = now
      await writeMeta(s).catch(() => {})
      log.web.info('bundle-push: re-adopted existing lease for identical bundle', {
        uploadId: s.id, nextSeq: s.nextSeq, bytes: s.bytes,
      })
      res.json({
        uploadId: s.id, maxChunkBytes: MAX_CHUNK_BYTES, resumable: true,
        resumed: true, nextSeq: s.nextSeq, bytes: s.bytes, ttlMs: SESSION_TTL_MS,
      })
      return
    }
  }

  if (!await makeRoomForLease(now)) {
    res.status(429).type('text/plain').send('too many concurrent bundle uploads')
    return
  }
  const id = crypto.randomBytes(16).toString('hex')
  const dir = path.join(stagingDir(), id)
  const session: UploadSession = {
    id, dir, bytes: 0, nextSeq: 0, touchedAt: now, createdAt: now,
    sha256: declared.sha256, totalBytes: declared.totalBytes, chunkBytes: declared.chunkBytes,
  }
  try {
    await fsp.mkdir(dir, { recursive: true })
    await writeMeta(session)
  } catch (err) {
    log.web.error('bundle-push: cannot create staging dir', { error: err instanceof Error ? err.message : String(err) })
    res.status(500).type('text/plain').send('cannot stage upload')
    return
  }
  sessions.set(id, session)
  log.web.info('bundle-push: upload session started', {
    uploadId: id, declaredBytes: declared.totalBytes || null, chunkBytes: declared.chunkBytes || null,
  })
  res.json({
    uploadId: id, maxChunkBytes: MAX_CHUNK_BYTES, resumable: true,
    resumed: false, nextSeq: 0, bytes: 0, ttlMs: SESSION_TTL_MS,
  })
})

// ── status: how far did this lease get? ───────────────────────────────────────
// One small request answers "which chunks do you already have", so a client
// that died (or gave up) mid-upload resumes instead of restarting. Chunks are
// contiguous by construction, so the received set is exactly [0, nextSeq).
// A hub that predates this route answers express's own 404 (HTML, no `code`),
// which the client reads as "no resume support" and falls back to a full upload.
gitBundlePushRouter.get('/bundle/status', async (req: Request, res: Response) => {
  const id = String(req.query.upload ?? '')
  if (!UPLOAD_ID_RE.test(id)) {
    res.status(400).json({ ok: false, code: 'bad-request', error: 'bad upload id' })
    return
  }
  await sweepStaleSessions()
  const session = await getSession(id)
  if (!session) {
    res.status(404).json({ ok: false, code: 'expired', error: 'unknown or expired upload' })
    return
  }
  const declared = declaredIdentity(req)
  const mismatch = (declared.sha256 || declared.chunkBytes || declared.totalBytes)
    ? resumeMismatchReason(session, declared)
    : null
  if (mismatch) {
    // NOT an error the client should retry: its bundle is a different bundle.
    // 409 (same "your view of state is stale" meaning as the chunk route) tells
    // it to abandon this lease and start a fresh one.
    res.status(409).json({
      ok: false, code: 'mismatch', mismatch, error: `lease holds a different bundle (${mismatch})`,
      expected: { sha256: session.sha256, chunkBytes: session.chunkBytes, totalBytes: session.totalBytes },
    })
    return
  }
  res.json({
    ok: true,
    uploadId: session.id,
    /** Chunks [0, nextSeq) are stored; resume by sending nextSeq. */
    nextSeq: session.nextSeq,
    receivedChunks: session.nextSeq,
    bytes: session.bytes,
    chunkBytes: session.chunkBytes,
    sha256: session.sha256,
    totalBytes: session.totalBytes,
    complete: session.totalBytes > 0 && session.bytes >= session.totalBytes,
    maxChunkBytes: MAX_CHUNK_BYTES,
    ttlMs: SESSION_TTL_MS,
    expiresAt: new Date(session.touchedAt + SESSION_TTL_MS).toISOString(),
  })
})

// ── chunk: one piece, one request, one connection ────────────────────────────
gitBundlePushRouter.post('/bundle/chunk', async (req: Request, res: Response) => {
  const id = String(req.query.upload ?? '')
  const seq = Number(req.query.seq)
  if (!UPLOAD_ID_RE.test(id) || !Number.isInteger(seq) || seq < 0) {
    res.status(400).type('text/plain').send('bad upload id or seq')
    return
  }
  const session = await getSession(id)
  if (!session) {
    res.status(404).json({ ok: false, code: 'expired', error: 'unknown or expired upload' })
    return
  }
  // Out-of-order or duplicate chunk: tell the client where we are. A retried
  // chunk the server already has comes back as a no-op 200 (idempotent).
  if (seq < session.nextSeq) {
    res.json({ ok: true, nextSeq: session.nextSeq, duplicate: true })
    return
  }
  if (seq > session.nextSeq) {
    res.status(409).json({ ok: false, nextSeq: session.nextSeq })
    return
  }
  // One appender at a time. The seq gate alone doesn't serialize two clients
  // that both send `nextSeq` concurrently — they'd both pass it and interleave
  // bytes into the same file. Cheap to refuse; the loser retries with the
  // corrected seq.
  if (session.writing) {
    res.status(409).json({ ok: false, code: 'busy', nextSeq: session.nextSeq })
    return
  }
  // A chunk is the biggest single write on the box; racing the filesystem to 0%
  // is the ENOSPC outage. 503 is retryable and the lease survives for a resume.
  if (isDiskWriteBlocked()) {
    res.status(503).type('text/plain').send('data hub disk critically full — upload paused')
    return
  }

  const body = await readBody(req, MAX_CHUNK_BYTES)
  if (body === null || body.length === 0) {
    res.status(413).type('text/plain').send('chunk missing or too large')
    return
  }
  if (session.bytes + body.length > MAX_BUNDLE_BYTES) {
    await evictSession(session, 'over-size-budget')
    res.status(413).type('text/plain').send('bundle exceeds size budget')
    return
  }
  session.writing = true
  try {
    // Append-only file: chunks are contiguous by construction (seq gate above).
    await fsp.appendFile(bundlePathFor(session.dir), body)
    session.bytes += body.length
    session.nextSeq = seq + 1
    session.touchedAt = Date.now()
    // Progress on disk, so a hub restart (or a client that comes back tomorrow)
    // still knows how far this lease got. Written AFTER the append: a crash in
    // between leaves a longer file than meta claims, which hydrateSession()
    // trims back to a whole chunk boundary.
    await writeMeta(session).catch((err) => {
      log.web.warn('bundle-push: lease meta write failed (resume may restart)', {
        uploadId: id, error: err instanceof Error ? err.message : String(err),
      })
    })
  } catch (err) {
    log.web.error('bundle-push: chunk write failed', { uploadId: id, seq, error: err instanceof Error ? err.message : String(err) })
    res.status(500).type('text/plain').send('chunk write failed')
    return
  } finally {
    session.writing = false
  }
  res.json({ ok: true, nextSeq: session.nextSeq })
})

// ── finish: verify, fetch, CAS-update the ref ────────────────────────────────
gitBundlePushRouter.post('/bundle/finish', async (req: Request, res: Response) => {
  await sweepStaleSessions()
  const body = await readBody(req, 64 * 1024)
  let parsed: { uploadId?: string; sha256?: string; ref?: string; oldValue?: string; newValue?: string }
  try {
    parsed = JSON.parse((body ?? Buffer.alloc(0)).toString('utf-8'))
  } catch {
    res.status(400).type('text/plain').send('finish body must be JSON')
    return
  }
  const { uploadId, sha256, ref, oldValue, newValue } = parsed
  if (!uploadId || !UPLOAD_ID_RE.test(uploadId) || !sha256 || !SHA256_RE.test(sha256)
      || !ref || !ALLOWED_REF_RE.test(ref) || !newValue || !OID_RE.test(newValue)
      || (oldValue !== undefined && oldValue !== '' && !OID_RE.test(oldValue))) {
    res.status(400).type('text/plain').send('bad finish parameters')
    return
  }
  const session = await getSession(uploadId)
  if (!session) {
    res.status(404).json({ ok: false, code: 'expired', error: 'unknown or expired upload' })
    return
  }
  sessions.delete(uploadId) // single-shot: success or failure, session is spent
  const bundlePath = bundlePathFor(session.dir)
  const cleanup = (): void => { fs.rm(session.dir, { recursive: true, force: true }, () => {}) }

  try {
    // 1. Integrity: whole-file hash must match what the client computed.
    const hash = crypto.createHash('sha256')
    await new Promise<void>((resolve, reject) => {
      const s = fs.createReadStream(bundlePath)
      s.on('data', (c) => hash.update(c))
      s.on('end', resolve)
      s.on('error', reject)
    })
    const actual = hash.digest('hex')
    if (actual !== sha256) {
      log.web.warn('bundle-push: hash mismatch', { uploadId, expected: sha256, actual })
      res.status(422).json({ ok: false, error: 'hash mismatch — retransmit' })
      return
    }

    // 2. Structural check + prerequisites present in the hub.
    await gitHub(['bundle', 'verify', bundlePath], 120_000)

    // 3. Import objects. The bundle carries the ref value; fetch into a
    //    temporary ref so nothing user-visible moves before the CAS.
    const tmpRef = `refs/walnut/bundle-incoming-${uploadId.slice(0, 8)}`
    await gitHub(['fetch', '--no-write-fetch-head', bundlePath, `${ref.replace(/^refs\/heads\//, '')}:${tmpRef}`], 600_000)
    try {
      const fetched = await gitHub(['rev-parse', tmpRef], 30_000)
      if (fetched !== newValue) {
        res.status(422).json({ ok: false, error: `bundle tip ${fetched} does not match declared newValue` })
        return
      }
      // 4. Compare-and-swap on the real branch — force-with-lease semantics.
      //    `update-ref <ref> <new> <old>` fails atomically if <ref> != <old>.
      const casArgs = oldValue
        ? ['update-ref', ref, newValue, oldValue]
        : ['update-ref', ref, newValue, '0000000000000000000000000000000000000000']
      try {
        await gitHub(casArgs, 30_000)
      } catch {
        const current = await gitHub(['rev-parse', ref], 30_000).catch(() => '(unborn)')
        log.web.warn('bundle-push: CAS lost', { uploadId, ref, expected: oldValue, current })
        res.status(409).json({ ok: false, error: 'ref moved — refetch and retry', current })
        return
      }
    } finally {
      await gitHub(['update-ref', '-d', tmpRef], 30_000).catch(() => {})
    }

    log.web.info('bundle-push: ref updated via bundle', { uploadId, ref, newValue, bytes: session.bytes })
    res.json({ ok: true, ref, value: newValue })

    // Same post-push housekeeping as the smart-HTTP route: consolidate packs.
    const gc = spawn('git', [
      '-C', hubRepo(),
      '-c', 'gc.auto=6700', '-c', 'gc.autoPackLimit=8', '-c', 'repack.writeBitmaps=true',
      'gc', '--auto', '--quiet',
    ], { stdio: 'ignore', detached: true })
    gc.on('error', () => {})
    gc.unref()
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    log.web.warn('bundle-push: finish failed', { uploadId, error: message })
    res.status(422).json({ ok: false, error: message })
  } finally {
    cleanup()
  }
})

/** Test hook: forget all sessions and remove staging (fresh state per test). */
export async function _resetBundlePushForTesting(): Promise<void> {
  for (const s of sessions.values()) {
    await fsp.rm(s.dir, { recursive: true, force: true }).catch(() => {})
  }
  sessions.clear()
  lastSweepAt = 0
  await fsp.rm(stagingDir(), { recursive: true, force: true }).catch(() => {})
}

/** Test hook: drop the in-memory lease map WITHOUT touching disk — the exact
 *  state a hub restart leaves behind, which resume has to survive. */
export function _forgetBundleSessionsInMemoryForTesting(): void {
  sessions.clear()
  lastSweepAt = 0
}

/** Test hook: run a sweep now, ignoring the throttle. */
export async function _sweepBundleLeasesForTesting(now = Date.now()): Promise<void> {
  await sweepStaleSessions(now, true)
}
