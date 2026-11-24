/**
 * GET /api/delivery: where messages to sessions got to, from the delivery ledger
 * (core/sessions/delivery-ledger.ts). Read only. `id` (a message id), `task` (every session of the
 * task; its id or a prefix task_get takes), `session`, `state` (read, written, queued, parked, held, carried, dropped, failed, cancelled,
 * sent), `days` (1 to 14, default 3), `limit` (default 200, newest first). A message still waiting says
 * for how many minutes (`waitingMin`). The answer says how many
 * matched and counts them by state.
 */
import { Router, type NextFunction, type Request, type Response } from 'express'
import { readDeliveryLines, trailsOf, DELIVERY_KEEP_DAYS } from '../../core/sessions/delivery-ledger.js'

export const deliveryRouter = Router()

const one = (v: unknown): string => (typeof v === 'string' ? v.trim() : '')

deliveryRouter.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = one(req.query.id)
    // A task's short id (`mabc1234` for `mabc1234-5678`) names it too, as task_get takes it.
    let task = one(req.query.task)
    if (task) {
      const { getTask } = await import('../../core/task-manager.js')
      task = (await getTask(task).catch(() => null))?.id ?? task
    }
    const session = one(req.query.session)
    const state = one(req.query.state)
    const days = Math.min(DELIVERY_KEEP_DAYS, Math.max(1, Number(req.query.days) || 3))
    const limit = Math.min(1000, Math.max(1, Number(req.query.limit) || 200))
    let sessions = new Set<string>(session ? [session] : [])
    if (task) {
      const { getSessionsForTask } = await import('../../core/session-tracker.js')
      sessions = new Set([...sessions, ...(await getSessionsForTask(task).catch(() => [])).map((s) => s.claudeSessionId)])
    }
    const trails = trailsOf(await readDeliveryLines(days), Date.now()).filter((t) => (!id || t.id === id)
      && (!task || t.taskId === task || (t.sessionId !== undefined && sessions.has(t.sessionId)))
      && (!session || t.sessionId === session)
      && (!state || t.state === state))
    const byState: Record<string, number> = {}
    for (const t of trails) byState[t.state] = (byState[t.state] ?? 0) + 1
    const newest = trails.sort((a, b) => (b.steps[0]?.at ?? '').localeCompare(a.steps[0]?.at ?? '')).slice(0, limit)
    res.json({ count: trails.length, byState, days, messages: newest })
  } catch (err) {
    next(err)
  }
})
