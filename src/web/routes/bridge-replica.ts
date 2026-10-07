/**
 * POST /bridge/replica (cloud mode only): the primary keeps this box's copy of
 * its task store (docs/plan/walnut-control-plane.md "The companion's copy of
 * the tasks"; core/replication/task-replica-store.ts does the work).
 *
 *   {op:'sync', kind:'tasks'|'registry', entries:[{k,h}], asOf}  → {ok, need, held, removed}
 *   {op:'put',  kind:'tasks', rows:[Task]}                        → {ok, stored, held}
 *   {op:'put',  kind:'registry', registry:{...}}                  → {ok, stored}
 *
 * Same door as /bridge/ingest: only the primary's own machine credential, auth
 * before the body is read, gzip bodies, the limit on the inflated body.
 */

import express, { Router, type Request, type Response } from 'express'
import { log } from '../../logging/index.js'
import { authenticate, parseErrors } from './bridge-ingest.js'

export const BRIDGE_REPLICA_PATH = '/bridge/replica'
/** A put batch is at most 512 KB of rows; a manifest of 10k tasks is ~400 KB. */
const BODY_LIMIT = '8mb'

async function replica(req: Request, res: Response): Promise<void> {
  const started = Date.now()
  const body = (req.body ?? {}) as { op?: unknown; kind?: unknown }
  const store = await import('../../core/replication/task-replica-store.js')
  try {
    const result = body.op === 'sync' ? await store.replicaSync(body)
      : body.op === 'put' ? await store.replicaPut(body)
        : { ok: false as const, status: 400 as const, error: 'unknown_op' }
    if (!result.ok) {
      res.status(result.status).json({ ok: false, error: result.error })
      return
    }
    res.json(result)
    log.web.debug('bridge replica: step', { op: body.op, kind: body.kind, ms: Date.now() - started })
  } catch (err) {
    log.web.warn('bridge replica: step failed', { op: body.op, kind: body.kind, error: err instanceof Error ? err.message : String(err) })
    res.status(500).json({ ok: false, error: 'write_failed' })
  }
}

export function createBridgeReplicaRouter(): Router {
  const router = Router()
  router.post(
    '/',
    (req, res, next) => { void authenticate(req, res, next).catch(next) },
    express.json({ limit: BODY_LIMIT }),
    (req, res, next) => { void replica(req, res).catch(next) },
  )
  router.use(parseErrors)
  return router
}
