/**
 * GET /api/replicas/status (the leader only): every follower's copies, kind by
 * kind (docs/plan/walnut-replica-servers-impl.md, section 4): entries, held,
 * asOf, the last refusal of the half rule and whether Settings should offer
 * the confirm. The generic kinds keep this state as they run
 * (core/replication/replica-status.ts); search and devices report a row.
 * Each kind says how old its copy is (`ageMs`), and `hosts` names, per host
 * that runs a server, the program running, any fallback, and the journal as
 * the replica last reported it: size, drainable and parked counts, the oldest
 * record (core/replication/host-replica-status.ts; section 13 of the plan).
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
  const [{ replicaStatuses }, { hostReplicaStatuses }, { peekHostServerViews }] = await Promise.all([
    import('../../core/replication/replica-status.js'),
    import('../../core/replication/host-replica-status.js'),
    import('../../core/host-server/index.js'),
  ])
  const now = Date.now()
  // `hosts` (WP14, section 13): the program each host runs, any fallback, and its journal.
  res.json({ ok: true, targets: await replicaStatuses(now), hosts: hostReplicaStatuses(peekHostServerViews(), now) })
})

replicasStatusRouter.post('/replicas/confirm-removal', async (req: Request, res: Response) => {
  if (leaderOnly(res)) return
  // The confirm lifts the one guard against a leader that lost its store: the
  // user's answer only, never a session's: it deletes the user's data on a replica, which the
  // team charter keeps for the user (an approval rule, listed in tests/core/agent-parity-ratchet.test.ts).
  if (req.get('x-walnut-caller-sid')) {
    res.status(403).json({ ok: false, error: 'human_only', message: 'Only the user may confirm a removal of most rows' })
    return
  }
  const body = (req.body ?? {}) as { target?: unknown; kind?: unknown; entries?: unknown; keys?: unknown }
  const target = typeof body.target === 'string' ? body.target : ''
  // WP11: a host's own copy of the notes, memory or skills (core/host-replica.ts), `host-<kind>`.
  const hostCopy = typeof body.kind === 'string' && /^host-(notes|memory|skills)$/.test(body.kind) && target.startsWith('host:') ? body.kind.slice(5) as 'notes' | 'memory' | 'skills' : null
  if (hostCopy) {
    const n = body.entries === undefined ? undefined : Number.isInteger(body.entries) && (body.entries as number) >= 0 ? body.entries as number : null
    const k = body.keys === undefined ? undefined : typeof body.keys === 'string' && /^[0-9a-f]{12}$/.test(body.keys) ? body.keys : null
    if (n === null || k === null) { res.status(400).json({ ok: false, error: 'bad_request' }); return }
    const { confirmHostReplicaRemoval } = await import('../../core/host-replica.js')
    const done = await confirmHostReplicaRemoval(target.slice('host:'.length), hostCopy, { ...(n === undefined ? {} : { entries: n }), ...(k === undefined ? {} : { keys: k }) })
    if (!done) { res.status(409).json({ ok: false, error: 'not_refused' }); return }
    res.json({ ok: true })
    return
  }
  const { COPY_KIND_NAMES, confirmCopyKindRemoval } = await import('../../core/replication/kinds/copy-kind.js')
  const copyKind = typeof body.kind === 'string' && (COPY_KIND_NAMES as readonly string[]).includes(body.kind) ? body.kind : null
  const kind = copyKind ?? (body.kind === 'registry' ? 'registry' : body.kind === undefined || body.kind === 'tasks' ? 'tasks' : null)
  const entries = body.entries === undefined ? undefined : Number.isInteger(body.entries) && (body.entries as number) >= 0 ? body.entries as number : null
  const keys = body.keys === undefined ? undefined : typeof body.keys === 'string' && /^[0-9a-f]{12}$/.test(body.keys) ? body.keys : null
  if (!target || !kind || entries === null || keys === null) {
    res.status(400).json({ ok: false, error: 'bad_request' })
    return
  }
  const { confirmTaskReplicaRemoval } = await import('../../core/replication/task-replica.js')
  const seen = { ...(entries === undefined ? {} : { entries }), ...(keys === undefined ? {} : { keys }) }
  // The WP4 copies (sessions, requests, boards, inbox) have their own scheduler.
  const confirmed = copyKind ? await confirmCopyKindRemoval(target, copyKind, seen) : await confirmTaskReplicaRemoval(target, kind as 'tasks' | 'registry', seen)
  if (!confirmed) {
    res.status(409).json({ ok: false, error: 'not_refused' })
    return
  }
  res.json({ ok: true })
})

/**
 * GET /api/replicas/logs?host=<alias>&n=&sources=replica,journal&match= (WP14): the
 * lines a host's replica and its daemon's journal logged ON the host, through the
 * daemon's `logs.tail` (cap replica-logs-v1; this Walnut's own home only). Read only;
 * never dials (a host not connected answers 503 at once) and waits 10 s at most, so a
 * slow host never pins a request. `scripts/walnut-logs.sh replica --host` reads it.
 */
replicasStatusRouter.get('/replicas/logs', async (req: Request, res: Response) => {
  if (leaderOnly(res)) return
  const host = typeof req.query.host === 'string' ? req.query.host.trim() : ''
  if (!host || host.length > 200) { res.status(400).json({ ok: false, error: 'bad_request', message: 'host is required' }); return }
  const list = (v: unknown): string[] | undefined => (typeof v === 'string' && v ? v.split(',').map((s) => s.trim()).filter(Boolean) : undefined)
  const n = typeof req.query.n === 'string' && /^\d+$/.test(req.query.n) ? Number(req.query.n) : 200
  const [{ getConnectedDaemonConnection }, { WALNUT_HOME }] = await Promise.all([
    import('../../providers/daemon-connection.js'),
    import('../../constants.js'),
  ])
  const conn = getConnectedDaemonConnection(host)
  if (!conn) { res.status(503).json({ ok: false, error: 'host_not_connected', message: `${host} is not connected to this Walnut right now` }); return }
  if (!conn.hasCapability('replica-logs-v1')) { res.status(409).json({ ok: false, error: 'daemon_needs_upgrade', message: `${host}'s daemon is older than logs.tail; it updates on its next connect` }); return }
  try {
    const reply = await conn.send('logs.tail', { home: WALNUT_HOME, sources: list(req.query.sources) ?? ['replica', 'journal'], n, ...(list(req.query.match) ? { match: list(req.query.match) } : {}) }, 10_000)
    if (reply.ok !== true) { res.status(502).json({ ok: false, error: String(reply.errorKind ?? 'refused'), message: String(reply.error ?? '') }); return }
    res.json({ ok: true, host, lines: reply.lines ?? [], files: reply.files ?? [], truncated: reply.truncated === true, running: reply.running === true })
  } catch (err) {
    res.status(504).json({ ok: false, error: 'no_answer', message: err instanceof Error ? err.message : String(err) })
  }
})
