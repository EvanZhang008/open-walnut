/**
 * A watch on a task (src/core/sessions/task-watch.ts): who hears where it stands, and how often at least.
 *
 *   GET /api/v1/tasks/:id/watch   { task_id, title, watch: TaskWatch | null, due_at: ISO | null }
 *   PUT /api/v1/tasks/:id/watch   { every: "30m" | "3h" | "1d", for?: task id }   sets (or replaces) it
 *                                 { off: true }                                     ends it
 *
 * The watcher is `for`, else the caller's own task, else (a person) the VP or Main that follows the
 * task. Anyone may set one, a person or any task (2026-10-27, the user: "all human action can be
 * done by agent also"). A completed task takes none (409 task_complete: the write would announce
 * the completion again).
 */
import { Router, type Request, type Response } from 'express'
import { role } from '../../core/server-role.js'
import { parseWatchEvery, watchDueAt, type TaskWatch } from '../../core/sessions/task-watch.js'
import { resolveCaller } from '../../core/sessions/session-send-core.js'
import { getTask, listTasks, updateTaskRaw } from '../../core/task-manager.js'
import { log } from '../../logging/index.js'
import { body, header, param, resolveTask, RouteError } from './board-v1.js'
import { sendV1Error as sendError } from './v1-control-relay.js'

export const taskWatchV1Router = Router()

function route(fn: (req: Request, res: Response) => Promise<void>) {
  return (req: Request, res: Response) => {
    fn(req, res).catch((err: unknown) => {
      if (err instanceof RouteError) return sendError(res, err.status, err.code, err.message, err.extra)
      sendError(res, 500, 'internal', err instanceof Error ? err.message : String(err))
    })
  }
}

const view = (task: { id: string; title: string; watch?: TaskWatch | null }, due: number | null) => ({
  task_id: task.id, title: task.title, watch: task.watch ?? null, due_at: due === null ? null : new Date(due).toISOString(),
})

taskWatchV1Router.get('/tasks/:id/watch', route(async (req, res) => {
  const task = await resolveTask(param(req.params.id))
  res.json(view(task, watchDueAt(task)))
}))

taskWatchV1Router.put('/tasks/:id/watch', route(async (req, res) => {
  if (role() === 'replica') throw new RouteError(501, 'not_supported_cloud', 'A watch is set on the primary box')
  const task = await resolveTask(param(req.params.id))
  const b = body(req)
  let next: TaskWatch | null = null
  if (b.off !== true) {
    let everyMs: number
    try { everyMs = parseWatchEvery(b.every) } catch (err) { throw new RouteError(400, 'bad_request', (err as Error).message) }
    const sid = header(req, 'x-walnut-caller-sid')
    const caller = sid ? await resolveCaller(sid).catch(() => null) : null
    const callerTaskId = caller?.kind === 'session' ? caller.record.taskId ?? undefined : undefined
    let by = typeof b.for === 'string' && b.for.trim() ? (await resolveTask(b.for.trim())).id : callerTaskId
    if (!by) {
      // A person: the node that follows the task hears it.
      const { followContext, statusFollowersOf } = await import('../../core/sessions/status-push.js')
      const { byId, vpOf, main } = await followContext(await listTasks())
      by = statusFollowersOf(task, byId, vpOf, main).find((f) => f.phase !== 'COMPLETE' && f.status !== 'done')?.id
    }
    if (!by) throw new RouteError(400, 'bad_request', 'Nobody to tell: pass for (the task that hears it)')
    if (by === task.id) throw new RouteError(400, 'bad_request', 'A task cannot watch itself: pass for (the task that hears it)')
    const watcher = await getTask(by).catch(() => null)
    next = { by, ...(watcher ? { by_name: watcher.title.slice(0, 120) } : {}), every_ms: everyMs, set_at: new Date().toISOString() }
  }
  let complete = false
  await updateTaskRaw(task.id, { watch: next }, {
    emitEvent: true, source: 'task-watch',
    shouldUpdate: (cur) => { complete = cur.phase === 'COMPLETE' || cur.status === 'done'; return !complete },
  })
  if (complete) throw new RouteError(409, 'task_complete', `"${task.title}" is complete: a watch ends with a completion.`)
  log.task.info(next ? 'task watch set' : 'task watch ended', { taskId: task.id, by: next?.by, everyMs: next?.every_ms })
  const row = await getTask(task.id).catch(() => ({ ...task, watch: next }))
  res.json(view(row, watchDueAt(row)))
}))
