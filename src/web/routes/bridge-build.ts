/**
 * /bridge/build (cloud mode only): the Mac keeps its companion on the Mac's own
 * build (docs/plan/walnut-companion-unified-replica.md, stage 1; the contract is
 * core/companion-build/wire.ts, the work core/companion-build/box.ts).
 *
 *   GET  /bridge/build                                      → BoxBuildStatus
 *   PUT  /bridge/build/package?id&offset&size&sha256 (raw)  → UploadReply
 *   POST /bridge/build/install  InstallRequest              → StepReply (202 when it started)
 *   POST /bridge/build/activate {id}                        → StepReply (202 when it started)
 *
 * Same door as /bridge/ingest: only the primary's own machine credential, and
 * auth runs before any body is read.
 */

import express, { Router, type NextFunction, type Request, type Response } from 'express'
import { log } from '../../logging/index.js'
import { boxBuildStatus, putPackageChunk, startActivate, startInstall } from '../../core/companion-build/box.js'
import { MAX_CHUNK_BYTES } from '../../core/companion-build/wire.js'
import { authenticate } from './bridge-ingest.js'

const ERROR_STATUS: Record<string, number> = {
  bad_request: 400,
  refused: 403,
  offset_mismatch: 409,
  busy: 409,
  no_package: 409,
  not_installed: 409,
  too_large: 413,
  sha_mismatch: 422,
  disk_full: 507,
}

function answer(res: Response, reply: { ok: boolean; error?: string }, okStatus = 200): void {
  res.status(reply.ok ? okStatus : ERROR_STATUS[reply.error ?? ''] ?? 500).json(reply)
}

type Step = (req: Request, res: Response) => Promise<void>
/** A step that throws answers a plain 500: never a stack trace. */
function step(name: string, fn: Step) {
  return (req: Request, res: Response) => {
    fn(req, res).catch((err) => {
      log.web.warn(`bridge build: ${name} failed`, { error: err instanceof Error ? err.message : String(err) })
      if (!res.headersSent) res.status(500).json({ ok: false, message: 'the box could not do this step' })
    })
  }
}

const text = (v: unknown) => (typeof v === 'string' ? v : '')
const whole = (v: unknown) => (typeof v === 'string' && /^\d{1,16}$/.test(v) ? Number(v) : Number.NaN)

/** Body parser failures in the contract's shape; anything else a plain 500. */
function buildErrors(err: unknown, req: Request, res: Response, _next: NextFunction): void {
  const e = err as { type?: string; status?: number } | null
  const upload = req.path === '/package' ? { received: 0, size: 0, complete: false } : {}
  if (res.headersSent) return
  if (e?.type === 'entity.too.large') {
    res.status(413).json({ ok: false, ...upload, error: 'too_large', message: `a chunk is at most ${MAX_CHUNK_BYTES} bytes` })
    return
  }
  if (e && typeof e.status === 'number' && e.status >= 400 && e.status < 500) {
    res.status(400).json({ ok: false, ...upload, error: 'bad_request', message: 'the body could not be read' })
    return
  }
  log.web.warn('bridge build: request failed', { path: req.path, error: err instanceof Error ? err.message : String(err) })
  res.status(500).json({ ok: false, message: 'the box could not do this step' })
}

export function createBridgeBuildRouter(): Router {
  const router = Router()
  router.use((req, res, next) => { void authenticate(req, res, next).catch(next) })
  router.get('/', step('status', async (_req, res) => {
    res.json(await boxBuildStatus())
  }))
  router.put(
    '/package',
    // One byte over the chunk cap still parses, so the box answers too_large in its own words.
    express.raw({ type: () => true, limit: MAX_CHUNK_BYTES + 1 }),
    step('upload', async (req, res) => {
      const q = req.query
      const bytes = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0)
      answer(res, await putPackageChunk({ id: text(q.id), offset: whole(q.offset), size: whole(q.size), sha256: text(q.sha256) }, bytes))
    }),
  )
  router.post('/install', express.json({ limit: '256kb' }), step('install', async (req, res) => {
    const reply = await startInstall(req.body)
    answer(res, reply, reply.state === 'running' ? 202 : 200)
  }))
  router.post('/activate', express.json({ limit: '256kb' }), step('activate', async (req, res) => {
    const reply = await startActivate(req.body)
    answer(res, reply, reply.state === 'smoking' ? 202 : 200)
  }))
  router.use(buildErrors)
  return router
}
