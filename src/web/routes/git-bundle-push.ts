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
 *   POST /git/data/bundle/start                 → { uploadId }
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
 * Server-side safety:
 *   - uploads are staged under the hub dir (same filesystem, easy cleanup),
 *     never executed, and only ever handed to `git bundle verify` + `git fetch`
 *   - per-upload byte cap + global concurrent-upload cap
 *   - stale sessions swept on every start/finish (no timer to leak)
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

/** Hard per-upload byte budget. The 2026-08 rescue bundle was 465MB. */
export const MAX_BUNDLE_BYTES = 2 * 1024 * 1024 * 1024
/** Max chunk body we accept in one request. Client default is 8MB. */
export const MAX_CHUNK_BYTES = 32 * 1024 * 1024
/** Concurrent upload sessions (one pusher in practice; headroom for retries). */
const MAX_SESSIONS = 4
/** A session untouched this long is abandoned — swept lazily. */
export const SESSION_TTL_MS = 30 * 60_000

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
}

const sessions = new Map<string, UploadSession>()

/** Drop sessions that went quiet — called lazily from start/finish. */
function sweepStaleSessions(now = Date.now()): void {
  for (const [id, s] of sessions) {
    if (now - s.touchedAt > SESSION_TTL_MS) {
      sessions.delete(id)
      fs.rm(s.dir, { recursive: true, force: true }, () => {})
      log.web.warn('bundle-push: swept stale upload session', { uploadId: id, bytes: s.bytes })
    }
  }
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

// ── start: allocate an upload session ────────────────────────────────────────
gitBundlePushRouter.post('/bundle/start', (req: Request, res: Response) => {
  if (isDiskWriteBlocked()) {
    res.status(503).type('text/plain').send('data hub disk critically full — upload refused')
    return
  }
  if (!fs.existsSync(hubRepo())) {
    res.status(404).type('text/plain').send('data hub repo not found')
    return
  }
  sweepStaleSessions()
  if (sessions.size >= MAX_SESSIONS) {
    res.status(429).type('text/plain').send('too many concurrent bundle uploads')
    return
  }
  const id = crypto.randomBytes(16).toString('hex')
  const dir = path.join(stagingDir(), id)
  try {
    fs.mkdirSync(dir, { recursive: true })
  } catch (err) {
    log.web.error('bundle-push: cannot create staging dir', { error: err instanceof Error ? err.message : String(err) })
    res.status(500).type('text/plain').send('cannot stage upload')
    return
  }
  sessions.set(id, { id, dir, bytes: 0, nextSeq: 0, touchedAt: Date.now() })
  log.web.info('bundle-push: upload session started', { uploadId: id })
  res.json({ uploadId: id, maxChunkBytes: MAX_CHUNK_BYTES })
})

// ── chunk: one piece, one request, one connection ────────────────────────────
gitBundlePushRouter.post('/bundle/chunk', async (req: Request, res: Response) => {
  const id = String(req.query.upload ?? '')
  const seq = Number(req.query.seq)
  if (!UPLOAD_ID_RE.test(id) || !Number.isInteger(seq) || seq < 0) {
    res.status(400).type('text/plain').send('bad upload id or seq')
    return
  }
  const session = sessions.get(id)
  if (!session) {
    res.status(404).type('text/plain').send('unknown or expired upload')
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

  const body = await readBody(req, MAX_CHUNK_BYTES)
  if (body === null || body.length === 0) {
    res.status(413).type('text/plain').send('chunk missing or too large')
    return
  }
  if (session.bytes + body.length > MAX_BUNDLE_BYTES) {
    sessions.delete(id)
    await fsp.rm(session.dir, { recursive: true, force: true })
    res.status(413).type('text/plain').send('bundle exceeds size budget')
    return
  }
  try {
    // Append-only file: chunks are contiguous by construction (seq gate above).
    await fsp.appendFile(path.join(session.dir, 'data.bundle'), body)
  } catch (err) {
    log.web.error('bundle-push: chunk write failed', { uploadId: id, seq, error: err instanceof Error ? err.message : String(err) })
    res.status(500).type('text/plain').send('chunk write failed')
    return
  }
  session.bytes += body.length
  session.nextSeq = seq + 1
  session.touchedAt = Date.now()
  res.json({ ok: true, nextSeq: session.nextSeq })
})

// ── finish: verify, fetch, CAS-update the ref ────────────────────────────────
gitBundlePushRouter.post('/bundle/finish', async (req: Request, res: Response) => {
  sweepStaleSessions()
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
  const session = sessions.get(uploadId)
  if (!session) {
    res.status(404).type('text/plain').send('unknown or expired upload')
    return
  }
  sessions.delete(uploadId) // single-shot: success or failure, session is spent
  const bundlePath = path.join(session.dir, 'data.bundle')
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
  await fsp.rm(stagingDir(), { recursive: true, force: true }).catch(() => {})
}
