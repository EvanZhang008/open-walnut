/**
 * /api/v1 "wait until" endpoints (additive; src/core/task-waiting.ts):
 *
 *   POST   /tasks/:id/wait  { condition, routine_id, ttl? }  → { task }   park the task on a trigger
 *   DELETE /tasks/:id/wait                              → { task }   stop waiting (deletes the trigger)
 *
 * `:id` may be "this": the task of the calling session (the `x-walnut-caller-sid`
 * header the ops executor stamps), which is how a session parks its own task.
 */
import { Router, type Request, type Response, type NextFunction } from 'express'
import { SessionControlError } from '../../core/sessions/session-controls.js'

export const taskWaitV1Router = Router()

function sendError(res: Response, status: number, message: string): void {
  const code = status === 404 ? 'not_found' : status === 409 ? 'conflict' : status === 501 ? 'not_supported_cloud'
    : status >= 500 ? 'unavailable' : 'bad_request'
  res.status(status).json({ error: { code, message } })
}

async function resolveTaskId(req: Request): Promise<string> {
  const raw = Array.isArray(req.params.id) ? req.params.id.join('/') : String(req.params.id ?? '')
  if (raw !== 'this') {
    const { getTask } = await import('../../core/task-manager.js')
    const task = await getTask(raw).catch((err: unknown) => {
      throw new SessionControlError(err instanceof Error ? err.message : `no task ${raw}`, /Ambiguous/i.test(String(err)) ? 400 : 404)
    })
    return task.id
  }
  const header = req.headers['x-walnut-caller-sid']
  const sid = (Array.isArray(header) ? header[0] : header ?? '').trim()
  if (!sid) throw new SessionControlError('no calling session: pass the task id instead of "this"', 400)
  const { getSessionByClaudeId } = await import('../../core/session-tracker.js')
  const rec = await getSessionByClaudeId(sid).catch(() => null)
  if (!rec?.taskId) throw new SessionControlError('the calling session has no task: pass the task id instead of "this"', 400)
  return rec.taskId
}

async function handle(res: Response, next: NextFunction, fn: () => Promise<unknown>): Promise<void> {
  try {
    res.json({ task: await fn() })
  } catch (err) {
    if (err instanceof SessionControlError) { sendError(res, err.statusCode, err.message); return }
    next(err)
  }
}

taskWaitV1Router.post('/tasks/:id/wait', (req: Request, res: Response, next: NextFunction) => handle(res, next, async () => {
  const body = (req.body ?? {}) as Record<string, unknown>
  const { setTaskWaiting } = await import('../../core/task-waiting.js')
  return await setTaskWaiting({
    taskId: await resolveTaskId(req),
    condition: body.condition,
    routineId: body.routine_id ?? body.routineId,
    ttl: body.ttl,
    source: 'api-v1',
  })
}))

taskWaitV1Router.delete('/tasks/:id/wait', (req: Request, res: Response, next: NextFunction) => handle(res, next, async () => {
  const { stopTaskWaiting } = await import('../../core/task-waiting.js')
  return await stopTaskWaiting(await resolveTaskId(req), { source: 'api-v1' })
}))
