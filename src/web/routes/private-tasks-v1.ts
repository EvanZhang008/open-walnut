/**
 * Private tasks: a task kept local in a project that syncs to an outside service
 * (src/core/private-tasks/). The web task menu, the phone and the ops use the same routes.
 *
 *   POST /api/v1/tasks/:id/make-local      { outside?: 'keep'|'archive'|'neutralize' }
 *        A synced task stops syncing and stays in its project with all of its content; its outside
 *        copy is kept, archived (completed there) or neutralized (title and text replaced, then
 *        completed). A local task in a project that syncs is marked Local by choice.
 *   POST /api/v1/tasks/:id/sync-to-project { user_words? }
 *        A local task gets its project's outside source and is sent there. Sending a task out is
 *        the user's decision: a session caller passes user_words quoting the user's ask.
 *   POST /api/v1/tasks/:id/outside-copy    { action: 'archive'|'neutralize' }
 *        Change the outside copy a task turned local left behind.
 *   POST /api/v1/private-tasks/test        { text, words? } -> { match, invalid }
 *        Which of the user's private words (or the given list) a text matches (Settings).
 *
 * Writes answer 501 on the cloud companion: the primary owns task sources.
 */
import { Router, type Request, type Response } from 'express'
import { placement } from '../../core/server-role.js'
import { log } from '../../logging/index.js'
import { body, header, param, resolveTask, RouteError } from './board-v1.js'
import { sendV1Error as sendError } from './v1-control-relay.js'

export const privateTasksV1Router = Router()

const OUTSIDE = new Set(['keep', 'archive', 'neutralize'])
/** How long the user's quoted words must be for a session's release. */
const MIN_USER_WORDS = 10

function route(fn: (req: Request, res: Response) => Promise<void>) {
  return (req: Request, res: Response) => {
    fn(req, res).catch((err: unknown) => {
      if (err instanceof RouteError) return sendError(res, err.status, err.code, err.message, err.extra)
      sendError(res, 500, 'internal', err instanceof Error ? err.message : String(err))
    })
  }
}

function refuseOnReplica(): void {
  if (placement() === 'cloud') throw new RouteError(501, 'not_supported_cloud', 'Task sources are changed on the primary box')
}

async function viewOf(taskId: string) {
  const { getTask } = await import('../../core/task-manager.js')
  const { projectTask } = await import('../../core/task-projection.js')
  return projectTask(await getTask(taskId))
}

privateTasksV1Router.post('/tasks/:id/make-local', route(async (req, res) => {
  refuseOnReplica()
  const task = await resolveTask(param(req.params.id))
  const b = body(req)
  const outside = b.outside === undefined ? 'keep' : b.outside
  if (typeof outside !== 'string' || !OUTSIDE.has(outside)) throw new RouteError(400, 'bad_request', 'outside must be keep, archive or neutralize')
  const { makeTaskLocal } = await import('../../core/task-manager.js')
  const { serviceName, settleHoldLetter } = await import('../../core/private-tasks/sync-gate.js')
  const sid = header(req, 'x-walnut-caller-sid')
  await settleHoldLetter(task.sync_hold, 'It was made local from the task menu')
  const made = await makeTaskLocal(task.id, {
    state: 'chosen', by: 'user', at: new Date().toISOString(),
    reason: sid ? 'An agent made it local' : 'You made it local',
  }, outside as 'keep' | 'archive' | 'neutralize')
  const service = made.from ? await serviceName(made.from) : task.sync_hold ? await serviceName(task.sync_hold.target) : undefined
  log.web.info('private tasks: made local', { taskId: task.id, from: made.from, outside, bySession: !!sid })
  res.json({
    task: await viewOf(task.id),
    unlinked: made.unlinked,
    ...(made.from ? { from: made.from } : {}),
    ...(service ? { service } : {}),
    children: made.children,
    outside: made.outside,
    outcome: !made.unlinked
      ? 'The task was local already; it is now marked Local by choice.'
      : `The task no longer syncs to ${service}. ${made.outside.action === 'keep'
        ? `Its copy in ${service} is kept as it was and is no longer updated.`
        : made.outside.done
          ? `Its copy in ${service} was ${made.outside.action === 'archive' ? 'archived' : 'neutralized and archived'}.`
          : `Its copy in ${service} was not changed: ${made.outside.error}.`}`,
  })
}))

privateTasksV1Router.post('/tasks/:id/sync-to-project', route(async (req, res) => {
  refuseOnReplica()
  const task = await resolveTask(param(req.params.id))
  const sid = header(req, 'x-walnut-caller-sid')
  const words = body(req).user_words
  if (sid && (typeof words !== 'string' || words.trim().length < MIN_USER_WORDS)) {
    throw new RouteError(403, 'user_decision', 'Sending a task kept local to an outside service is the user\'s decision. '
      + 'Pass user_words with what the user said asking for it (quoted).')
  }
  const { releaseSyncHold } = await import('../../core/task-manager.js')
  const { serviceName, settleHoldLetter } = await import('../../core/private-tasks/sync-gate.js')
  const out = await releaseSyncHold(task.id, undefined, 'user')
  if (!out.released) {
    const msg = out.reason === 'already_synced' ? 'The task already syncs to its project\'s service.'
      : out.reason === 'project_local' ? 'Its project does not sync to an outside service.'
      : out.reason === 'project_conflict' ? 'Its project is reserved for another service.'
      : `The task was not sent (${out.reason}).`
    throw new RouteError(409, out.reason ?? 'not_released', msg)
  }
  // Its letter is settled only once it went out: a refused release leaves the user's decision open.
  await settleHoldLetter(task.sync_hold, sid ? 'An agent sent it, at the user\'s words' : 'You sent it from the task menu')
  log.web.info('private tasks: sent to its project\'s service', { taskId: task.id, source: out.task?.source, bySession: !!sid })
  res.json({
    task: await viewOf(task.id),
    released: true,
    service: await serviceName(out.task!.source),
    ...(out.syncResult && !out.syncResult.success ? { sync_error: out.syncResult.error } : {}),
  })
}))

privateTasksV1Router.post('/tasks/:id/outside-copy', route(async (req, res) => {
  refuseOnReplica()
  const task = await resolveTask(param(req.params.id))
  const action = body(req).action
  if (action !== 'archive' && action !== 'neutralize') throw new RouteError(400, 'bad_request', 'action must be archive or neutralize')
  const { actOnOutsideCopy } = await import('../../core/task-manager.js')
  const r = await actOnOutsideCopy(task.id, action)
  if (!r.done) throw new RouteError(409, 'outside_copy_unchanged', r.error ?? 'The outside copy was not changed')
  res.json({ task: await viewOf(task.id), done: true, action })
}))

privateTasksV1Router.post('/private-tasks/test', route(async (req, res) => {
  const b = body(req)
  if (typeof b.text !== 'string') throw new RouteError(400, 'bad_request', 'text must be a string')
  if (b.words !== undefined && (!Array.isArray(b.words) || b.words.some((w) => typeof w !== 'string'))) {
    throw new RouteError(400, 'bad_request', 'words must be an array of strings')
  }
  const { matchPrivateWords, invalidPrivateWords } = await import('../../core/private-tasks/private-words.js')
  const words = (b.words as string[] | undefined) ?? (await (await import('../../core/config-manager.js')).getConfig()).private_tasks?.words ?? []
  res.json({ match: matchPrivateWords(words, [b.text]), invalid: invalidPrivateWords(words) })
}))
