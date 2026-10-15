/**
 * GET /api/replicas/status (the leader only): every follower's copies, kind by
 * kind (docs/plan/walnut-replica-servers-impl.md, section 4): entries, held,
 * asOf, the last refusal of the half rule and whether Settings should offer
 * the confirm. The generic kinds keep this state as they run
 * (core/replication/replica-status.ts); search and devices report a row.
 *
 * POST /api/replicas/confirm-removal {target, kind, entries?, keys?}: the
 * user's answer to a refusal three rounds in a row (the Settings row,
 * web/src/components/settings/sections/ReplicaRemovalGroup.tsx); the next
 * round sends `confirm:true`, bound to the refused count and keys (`entries`,
 * `keys`: the lastRefusal the user saw). 409 `not_refused` when there is
 * nothing to confirm (or the manifest moved); 403 `human_only` for a session
 * caller.
 *
 * A follower answers 404 `leader_only`: its own copies are not a leader's view.
 */

import { Router, type Request, type Response } from 'express'
import { isFollower } from '../../core/server-role.js'

export const replicasStatusRouter = Router()

let sourcesRegistered = false

async function ensureSources(): Promise<void> {
  if (sourcesRegistered) return
  sourcesRegistered = true
  const [{ registerStatusSource }, search] = await Promise.all([
    import('../../core/replication/replica-status.js'),
    import('../../core/replication/search-replica.js'),
  ])
  registerStatusSource('search', async () => search.followerSearchStatuses().map((s) => ({
    target: { id: s.id, kind: s.kind, label: s.label },
    status: {
      kind: 'search', action: s.state, refusals: 0, needsConfirm: false,
      ...(s.docs !== undefined ? { entries: s.docs } : {}),
      ...(typeof s.syncedAt === 'number' ? { syncedAt: s.syncedAt } : {}),
      ...(s.error ? { error: s.error } : {}),
    },
  })))
}

function leaderOnly(res: Response): boolean {
  if (!isFollower()) return false
  res.status(404).json({ ok: false, error: 'leader_only' })
  return true
}

replicasStatusRouter.get('/replicas/status', async (_req: Request, res: Response) => {
  if (leaderOnly(res)) return
  await ensureSources()
  const { replicaStatuses } = await import('../../core/replication/replica-status.js')
  res.json({ ok: true, targets: await replicaStatuses() })
})

replicasStatusRouter.post('/replicas/confirm-removal', async (req: Request, res: Response) => {
  if (leaderOnly(res)) return
  // The confirm lifts the one guard against a leader that lost its store: the
  // user's answer only, never a session's (as board-v1's human-only actions).
  if (req.get('x-walnut-caller-sid')) {
    res.status(403).json({ ok: false, error: 'human_only', message: 'Only the user may confirm a removal of most rows' })
    return
  }
  const body = (req.body ?? {}) as { target?: unknown; kind?: unknown; entries?: unknown; keys?: unknown }
  const target = typeof body.target === 'string' ? body.target : ''
  const kind = body.kind === 'registry' ? 'registry' : body.kind === undefined || body.kind === 'tasks' ? 'tasks' : null
  const entries = body.entries === undefined ? undefined : Number.isInteger(body.entries) && (body.entries as number) >= 0 ? body.entries as number : null
  const keys = body.keys === undefined ? undefined : typeof body.keys === 'string' && /^[0-9a-f]{12}$/.test(body.keys) ? body.keys : null
  if (!target || !kind || entries === null || keys === null) {
    res.status(400).json({ ok: false, error: 'bad_request' })
    return
  }
  const { confirmTaskReplicaRemoval } = await import('../../core/replication/task-replica.js')
  const seen = { ...(entries === undefined ? {} : { entries }), ...(keys === undefined ? {} : { keys }) }
  if (!(await confirmTaskReplicaRemoval(target, kind, seen))) {
    res.status(409).json({ ok: false, error: 'not_refused' })
    return
  }
  res.json({ ok: true })
})
