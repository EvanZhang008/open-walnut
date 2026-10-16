/**
 * POST /bridge/replica (every follower): the primary keeps this box's copy of
 * its task store (docs/plan/walnut-control-plane.md "The companion's copy of
 * the tasks"; core/replication/task-replica-store.ts does the work).
 *
 *   {op:'sync', kind:'tasks'|'registry', entries:[{k,h}], asOf}  → {ok, need, held, removed}
 *   {op:'put',  kind:'tasks', rows:[Task]}                        → {ok, stored, held}
 *   {op:'put',  kind:'registry', registry:{...}}                  → {ok, stored}
 *
 * Kind 'search' is the copy of the search index (core/replication/
 * search-replica-store.ts; the steps are listed in search-replica-wire.ts):
 *   {op:'status'|'sync'|'put', kind:'search', …}
 *
 * Kind 'devices', on a host server only (host-server/device-copy.ts): the
 * hashes of the primary's phone and browser tokens, the whole list each time:
 *   {op:'put', kind:'devices', devices:[{name, tokenHash}], hash}  → {ok, hash, devices}
 *
 * Every step is dispatched by its kind (core/replication/kind-follower.ts,
 * docs/plan/walnut-replica-servers-impl.md section 4): a kind this build does
 * not keep is `404 unknown_kind`, a step with a newer schema `409 schema_newer`,
 * and the leader rests that kind for this follower.
 *
 * Same door as /bridge/ingest: only the primary's own machine credential, auth
 * before the body is read, gzip bodies, the limit on the inflated body.
 */

import express, { Router, type Request, type Response } from 'express'
import { log } from '../../logging/index.js'
import { authenticate, parseErrors } from './bridge-ingest.js'

export const BRIDGE_REPLICA_PATH = '/bridge/replica'
/** A put batch is at most 512 KB of rows (1 MB of search docs); a manifest of
 *  10k tasks is ~400 KB, of 12k search docs under 1 MB. */
const BODY_LIMIT = '8mb'

type DevicesStep = (body: Record<string, unknown>) => { ok: true; hash: string; devices: number } | { ok: false; status: 400; error: string }

let builtins: Promise<void> | null = null
/** The kinds every follower serves, registered once (core/replication/kind-follower.ts). */
function builtinKinds(): Promise<void> {
  builtins ??= (async () => {
    const [{ registerFollowerKind }, tasks, search] = await Promise.all([
      import('../../core/replication/kind-follower.js'),
      import('../../core/replication/task-replica-store.js'),
      import('../../core/replication/search-replica-store.js'),
    ])
    tasks.registerTaskFollowerKinds()
    ;(await import('../../core/replication/kinds/index.js')).registerCopyFollowerKinds()
    registerFollowerKind({
      kind: 'search',
      schemaVersion: 1,
      step: (op, body) => (op === 'status' ? search.searchReplicaStatus(body) : op === 'sync' ? search.searchReplicaSync(body) : op === 'put' ? search.searchReplicaPut(body) : { ok: false, status: 400, error: 'unknown_op' }),
    })
  })().catch((err) => { builtins = null; throw err })
  return builtins
}

async function replica(req: Request, res: Response, devices?: DevicesStep): Promise<void> {
  const started = Date.now()
  const body = (req.body ?? {}) as Record<string, unknown>
  try {
    await builtinKinds()
    const { followerStep } = await import('../../core/replication/kind-follower.js')
    const extra = devices
      ? [{ kind: 'devices', schemaVersion: 1, step: (op: string, b: Record<string, unknown>) => (op === 'put' ? devices(b) : { ok: false as const, status: 400 as const, error: 'unknown_op' }) }]
      : []
    const result = await followerStep(body, extra)
    if (!result.ok) {
      const { ok: _ok, status, ...rest } = result
      res.status(status).json({ ok: false, ...rest })
      return
    }
    res.json(result)
    log.web.debug('bridge replica: step', { op: body.op, kind: body.kind, ms: Date.now() - started })
  } catch (err) {
    log.web.warn('bridge replica: step failed', { op: body.op, kind: body.kind, error: err instanceof Error ? err.message : String(err) })
    res.status(500).json({ ok: false, error: 'write_failed' })
  }
}

/**
 * The same steps on a host server, where the primary reaches it on a stream
 * through the host's daemon (host-server/main.ts). No credential: only the
 * primary's own link to that daemon may open such a stream (stream-relay-core.ts).
 */
export function createLinkedReplicaRouter(opts: { devices?: DevicesStep } = {}): Router {
  const router = Router()
  router.post(
    '/',
    express.json({ limit: BODY_LIMIT }),
    (req, res, next) => { void replica(req, res, opts.devices).catch(next) },
  )
  router.use(parseErrors)
  return router
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
