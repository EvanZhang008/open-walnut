/**
 * Snooze one thing a task asks of the user (src/core/action-needed.ts), not the task:
 *
 *   PUT /api/v1/tasks/:id/actions/:item/snooze   { until: ISO time }   snoozes it until then
 *                                                { until: null }       brings it back now
 *   -> { task_id, item, snoozed_until: ISO | null, user_status }
 *
 * `item` is the item's own id (an approval's apr-..., a prompt's request id, a letter's lt-..., a
 * Board choice id or an ask id), as `user_status.actions[].id` names it. A person or any task may
 * snooze (agent parity); the write records who. 404 action_not_found for an item the task does not
 * ask now, 400 for a time in the past or more than a year ahead.
 */
import { Router, type Request, type Response } from 'express'
import { role } from '../../core/server-role.js'
import { writeSnooze } from '../../core/action-needed.js'
import { resolveCaller } from '../../core/sessions/session-send-core.js'
import { getTask, updateTaskRaw } from '../../core/task-manager.js'
import { log } from '../../logging/index.js'
import { body, header, param, resolveTask, RouteError } from './board-v1.js'
import { sendV1Error as sendError } from './v1-control-relay.js'
import { sendLinkFailure } from '../middleware/link-failure-answer.js'

export const taskActionsV1Router = Router()

const YEAR_MS = 366 * 24 * 60 * 60_000

function route(fn: (req: Request, res: Response) => Promise<void>) {
  return (req: Request, res: Response) => {
    fn(req, res).catch((err: unknown) => {
      if (err instanceof RouteError) return sendError(res, err.status, err.code, err.message, err.extra)
      if (sendLinkFailure(req, res, err)) return
      sendError(res, 500, 'internal', err instanceof Error ? err.message : String(err))
    })
  }
}

taskActionsV1Router.put('/tasks/:id/actions/:item/snooze', route(async (req, res) => {
  if (role() === 'replica') throw new RouteError(501, 'not_supported_cloud', 'A snooze is set on the primary box')
  const task = await resolveTask(param(req.params.id))
  const item = param(req.params.item).trim()
  const b = body(req)
  let until: string | null = null
  if (b.until !== null && b.until !== undefined) {
    const at = typeof b.until === 'string' ? Date.parse(b.until) : NaN
    const now = Date.now()
    if (!Number.isFinite(at)) throw new RouteError(400, 'bad_request', 'until must be an ISO time, or null to bring it back')
    if (at <= now) throw new RouteError(400, 'bad_request', 'until is in the past')
    if (at > now + YEAR_MS) throw new RouteError(400, 'bad_request', 'until is more than a year ahead')
    until = new Date(at).toISOString()
  }
  const known = (task.user_status?.actions ?? []).some((a) => a.id === item)
  const snoozed = (task.action_snoozes ?? []).some((s) => s.id === item)
  // Bringing back one that is gone is a no-op; snoozing one the task does not ask is a mistake.
  if (!known && !(until === null && snoozed)) {
    throw new RouteError(404, 'action_not_found', `"${task.title}" asks nothing with the id ${item} now (read user_status.actions)`)
  }
  const sid = header(req, 'x-walnut-caller-sid')
  const caller = sid ? await resolveCaller(sid).catch(() => null) : null
  const by = caller?.kind === 'session' ? caller.record.taskId ? `task:${caller.record.taskId}` : 'session' : 'human'
  await updateTaskRaw(task.id, (cur) => ({ action_snoozes: writeSnooze(cur.action_snoozes, item, until, Date.now(), by) }),
    { emitEvent: true, source: 'action-snooze' })
  log.task.info(until ? 'action snoozed' : 'action unsnoozed', { taskId: task.id, item, until, by })
  // The row moves at once: derive this task's status again before answering.
  // Within a bound: a slow pass must not hold the answer past its caller's timeout (user-status-sync.ts).
  const { syncUserStatuses, STATUS_ANSWER_WAIT_MS } = await import('../../core/user-status-sync.js')
  const { withinMs } = await import('../../lib/within-ms.js')
  await withinMs(syncUserStatuses(new Set([task.id])).catch(() => 0), STATUS_ANSWER_WAIT_MS, 0)
  const row = await getTask(task.id).catch(() => task)
  res.json({ task_id: task.id, item, snoozed_until: until, user_status: row.user_status ?? null })
}))
