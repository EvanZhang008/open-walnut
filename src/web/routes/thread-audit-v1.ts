/**
 * The thread check's counts and its run-now (experiment threads_audit, core/org/thread-audit.ts;
 * op thread_audit). Additive.
 *
 *   GET  /api/v1/thread-audit[?days=N][&task=<id>]   { on, days: [{ date, totals, nodes: { [taskId]: counts } }], totals }
 *                                                     counts = { passes, found, reported, fixed (each { repeat, unasked, stale, thin }), calls, callMs };
 *                                                     newest day first, N days (default 7, at most 60), one node with `task`
 *   POST /api/v1/thread-audit/run { task }            one pass for that node now: { ran, why?, found, told: [{ kind, key, thread, other?, why }],
 *                                                     fixed, delivery, pairs, calls, callMs }; with the switch off { ran: false, why: "off" }
 *
 * Both answer 503 primary_only on a replica (threads live on the leader). The read answers within
 * READ_DEADLINE_MS or 503 busy; the run answers within RUN_DEADLINE_MS or 202 { running: true }
 * (the pass goes on, its counts show on the read).
 */
import { Router, type Request, type Response } from 'express'
import { followerName, isFollower } from '../../core/server-role.js'
import { body, resolveTask, RouteError } from './board-v1.js'
import { sendV1Error } from './v1-control-relay.js'
import { sendLinkFailure } from '../middleware/link-failure-answer.js'

export const threadAuditV1Router = Router()

const READ_DEADLINE_MS = 5_000
const RUN_DEADLINE_MS = 90_000
const TIMED_OUT = Symbol('timed-out')

function within<T>(p: Promise<T>, ms: number): Promise<T | typeof TIMED_OUT> {
  let timer: ReturnType<typeof setTimeout> | undefined
  return Promise.race([p, new Promise<typeof TIMED_OUT>((resolve) => { timer = setTimeout(() => resolve(TIMED_OUT), ms); timer.unref?.() })])
    .finally(() => clearTimeout(timer))
}

function fail(req: Request, res: Response, err: unknown): void {
  if (err instanceof RouteError) { sendV1Error(res, err.status, err.code, err.message); return }
  // A run tells the node, which can be a session on another host: a link that failed says so.
  if (sendLinkFailure(req, res, err)) return
  sendV1Error(res, 500, 'internal', err instanceof Error ? err.message : String(err))
}

const primaryOnly = (res: Response) => sendV1Error(res, 503, 'primary_only', `${followerName()} could not reach your Mac just now.`)

threadAuditV1Router.get('/thread-audit', async (req: Request, res: Response) => {
  try {
    if (isFollower()) { primaryOnly(res); return }
    const n = Number(req.query.days ?? 7)
    if (!Number.isInteger(n) || n < 1 || n > 60) throw new RouteError(400, 'bad_request', '`days` must be a whole number from 1 to 60')
    const task = typeof req.query.task === 'string' && req.query.task.trim() ? (await resolveTask(req.query.task.trim())).id : undefined
    const read = (async () => {
      const [{ readAudit, countsView }, { threadAuditOn }] = await Promise.all([import('../../core/org/thread-audit-store.js'), import('../../core/org/thread-audit.js')])
      return { on: await threadAuditOn(), ...countsView(await readAudit(), { days: n, ...(task ? { task } : {}) }, Date.now()) }
    })()
    const out = await within(read, READ_DEADLINE_MS)
    if (out === TIMED_OUT) { sendV1Error(res, 503, 'busy', 'The thread check\'s counts could not be read in time: try again.'); return }
    res.json(out)
  } catch (err) { fail(req, res, err) }
})

threadAuditV1Router.post('/thread-audit/run', async (req: Request, res: Response) => {
  try {
    if (isFollower()) { primaryOnly(res); return }
    const raw = body(req).task
    if (typeof raw !== 'string' || !raw.trim()) throw new RouteError(400, 'bad_request', '`task` (a task that keeps Threads) is required')
    const task = await resolveTask(raw.trim())
    const { auditNode } = await import('../../core/org/thread-audit.js')
    const out = await within(auditNode(task.id), RUN_DEADLINE_MS)
    if (out === TIMED_OUT) { res.status(202).json({ running: true, task: task.id }); return }
    res.json(out)
  } catch (err) { fail(req, res, err) }
})
