/**
 * POST /bridge/ingest (cloud mode only): the primary's projection and transcript
 * uploads, over plain HTTPS instead of the bridge WebSocket.
 *
 * Why a second lane (2026-09-29 field evidence, docs/reference/cloud-sync.md
 * "Why bulk uploads leave the bridge"): the bridge is ONE long-lived TLS stream,
 * and every far-side close of it lined up with bulk in flight. The replica's TLS
 * terminator logged corrupted records ("bad record MAC") on uploads from the Mac
 * in the same minutes, git pushes included, so the bytes were damaged on the
 * way. A damaged record ends the whole TLS connection. On the bridge that is
 * every RPC, stream and phone attach at once; on this lane it is one request,
 * which the Mac retries on its next sweep. The 1.2MB task list was in flight at
 * most of those closes, so it is exactly the traffic that moves here.
 *
 * Auth: only the primary's own machine credential (`bridge-local`, the token its
 * daemon dials /bridge with). Device tokens and other machines get 403; a
 * missing token 401; a wrong one 401 and a strike on the per-IP limiter, the
 * same rule every other cloud auth gate follows. Auth runs BEFORE the body is
 * read, so an unauthenticated caller never makes this box inflate megabytes.
 *
 * Bodies may be gzip (the Mac always sends gzip: a 1.6MB task list is ~10x
 * smaller on the wire). The limit applies to the INFLATED body, sized above the
 * list-lane cap (PROJECTION_PUSH_MAX_BYTES, 4MB).
 */

import express, { Router, type NextFunction, type Request, type Response } from 'express'
import { log } from '../../logging/index.js'

export const BRIDGE_INGEST_PATH = '/bridge/ingest'
const PRIMARY_MACHINE_DEVICE = 'bridge-local'
const BODY_LIMIT = '6mb'
const INGEST_KINDS = new Set(['projection-upsert', 'transcript-upsert'])

export type IngestCredential = { name: string; kind: 'device' | 'api_key' | 'machine' } | null

/** Admission, pure: who may write the replica's cache copies. */
export function ingestAdmission(cred: IngestCredential): { ok: true } | { ok: false; status: 401 | 403 } {
  if (!cred) return { ok: false, status: 401 }
  if (cred.kind !== 'machine' || cred.name !== PRIMARY_MACHINE_DEVICE) return { ok: false, status: 403 }
  return { ok: true }
}

async function authenticate(req: Request, res: Response, next: NextFunction): Promise<void> {
  // Cloud mode sets `trust proxy: loopback`, so req.ip is the client behind the
  // local reverse proxy, the same key the other cloud gates rate-limit on.
  const ip = req.ip ?? req.socket.remoteAddress ?? 'unknown'
  const { isAuthRateLimited, recordAuthFailure } = await import('../middleware/auth-rate-limit.js')
  if (isAuthRateLimited(ip)) {
    res.status(429).json({ error: 'rate_limited' })
    return
  }
  const header = req.headers.authorization
  const token = header?.startsWith('Bearer ') ? header.slice(7) : ''
  if (!token) {
    res.status(401).json({ error: 'unauthorized' })
    return
  }
  const { validateBearerCredential } = await import('../middleware/auth.js')
  const cred = await validateBearerCredential(token)
  const admission = ingestAdmission(cred)
  if (!admission.ok) {
    if (!cred) recordAuthFailure(ip)
    log.web.warn('bridge ingest: refused', { ip, status: admission.status, name: cred?.name, kind: cred?.kind })
    res.status(admission.status).json({ error: admission.status === 401 ? 'unauthorized' : 'not_primary' })
    return
  }
  next()
}

async function ingest(req: Request, res: Response): Promise<void> {
  const started = Date.now()
  const body = req.body as { kind?: unknown; data?: unknown } | undefined
  const kind = body?.kind
  if (typeof kind !== 'string' || !INGEST_KINDS.has(kind)) {
    res.status(400).json({ error: 'unknown_kind' })
    return
  }
  try {
    const { applyBridgeCacheFrame } = await import('./events-v1.js')
    const written = await applyBridgeCacheFrame(kind as 'projection-upsert' | 'transcript-upsert', body?.data)
    if (!written) {
      res.status(400).json({ error: 'invalid_payload' })
      return
    }
    res.json({ ok: true })
    log.web.debug('bridge ingest: stored', {
      kind,
      wireBytes: Number(req.headers['content-length']) || null,
      encoding: req.headers['content-encoding'] ?? 'identity',
      ms: Date.now() - started,
    })
  } catch (err) {
    log.web.warn('bridge ingest: write failed', { kind, error: err instanceof Error ? err.message : String(err) })
    res.status(500).json({ error: 'write_failed' })
  }
}

/** Body-parser failures in the contract's JSON shape (Express's default is HTML). */
function parseErrors(err: unknown, _req: Request, res: Response, next: NextFunction): void {
  const e = err as { type?: string; status?: number } | null
  if (e?.type === 'entity.too.large') {
    res.status(413).json({ error: 'too_large' })
    return
  }
  if (e && typeof e.status === 'number' && e.status >= 400 && e.status < 500) {
    res.status(400).json({ error: 'bad_body' })
    return
  }
  next(err)
}

export function createBridgeIngestRouter(): Router {
  const router = Router()
  router.post(
    '/',
    (req, res, next) => { void authenticate(req, res, next).catch(next) },
    express.json({ limit: BODY_LIMIT }),
    (req, res, next) => { void ingest(req, res).catch(next) },
  )
  router.use(parseErrors)
  return router
}
