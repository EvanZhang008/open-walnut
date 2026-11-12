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
 *   POST /api/v1/projects/:name/make-local { outside?: 'archive'|'keep', limit? }
 *        A project stops syncing, a batch at a time: each synced task is made local as above (its
 *        outside copy archived by default), and once none syncs the project itself turns Local.
 *        -> { done, processed, failed, remaining }
 *   POST /api/v1/private-tasks/test        { text, words?, provider?, ai?, ai_rule? }
 *        -> { match, invalid, ai?: { pass, reason } | { error } }
 *        Which hard rule (the given list, else the provider's) a text matches, and with `ai`
 *        whether it passes the AI rule (the given one, else the provider's) (Settings).
 *   GET  /api/v1/private-tasks/providers   -> { providers: [{ id, name, check, check_set,
 *        check_default, words, ai, ai_rule, ai_rule_default, icon_url? }] }
 *        Every loaded task provider and its rules (provider-rules.ts), defaults filled in.
 *
 * Writes answer 501 on a replica (the companion or a host): the primary owns task sources.
 */
import { Router, type Request, type Response } from 'express'
import { isFollower } from '../../core/server-role.js'
import { log } from '../../logging/index.js'
import { body, header, param, resolveTask, RouteError } from './board-v1.js'
import { sendV1Error as sendError } from './v1-control-relay.js'
import { sendLinkFailure } from '../middleware/link-failure-answer.js'

export const privateTasksV1Router = Router()

const OUTSIDE = new Set(['keep', 'archive', 'neutralize'])
/** How long the user's quoted words must be for a session's release. */
const MIN_USER_WORDS = 10

function route(fn: (req: Request, res: Response) => Promise<void>) {
  return (req: Request, res: Response) => {
    fn(req, res).catch((err: unknown) => {
      if (err instanceof RouteError) return sendError(res, err.status, err.code, err.message, err.extra)
      if (sendLinkFailure(req, res, err)) return
      sendError(res, 500, 'internal', err instanceof Error ? err.message : String(err))
    })
  }
}

function refuseOnReplica(): void {
  if (isFollower()) throw new RouteError(501, 'not_supported_cloud', 'Task sources are changed on the primary box')
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
  await settleHoldLetter(task.sync_hold, { how: 'made_local' }, task.id)
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
      : out.reason === 'target_changed' ? `Its project now syncs to ${await serviceName(out.task?.sync_hold?.target ?? '')}, so nothing was sent. Choose Sync again to send it there.`
      : `The task was not sent (${out.reason}).`
    throw new RouteError(409, out.reason ?? 'not_released', msg)
  }
  // Its letter is settled only once it went out: a refused release leaves the user's decision open.
  await settleHoldLetter(task.sync_hold, { how: sid ? 'agent_sent' : 'user_sent' }, task.id)
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

/** Tasks one call turns local at most: each is a store write, so a big project goes in batches. */
const PROJECT_BATCH_DEFAULT = 25
const PROJECT_BATCH_MAX = 200

privateTasksV1Router.post('/projects/:name/make-local', route(async (req, res) => {
  refuseOnReplica()
  const b = body(req)
  const outside = b.outside === undefined ? 'archive' : b.outside
  if (outside !== 'archive' && outside !== 'keep') throw new RouteError(400, 'bad_request', 'outside must be archive or keep')
  const limit = b.limit === undefined ? PROJECT_BATCH_DEFAULT : b.limit
  if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > PROJECT_BATCH_MAX) {
    throw new RouteError(400, 'bad_request', `limit must be an integer from 1 to ${PROJECT_BATCH_MAX}`)
  }
  const tm = await import('../../core/task-manager.js')
  const { serviceName } = await import('../../core/private-tasks/sync-gate.js')
  const record = await tm.getProjectRecord(param(req.params.name))
  if (!record) throw new RouteError(404, 'not_found', `No project "${param(req.params.name)}"`)
  if (record.source === 'local') {
    res.json({ project: record.name, done: true, processed: [], failed: [], remaining: 0, outcome: `"${record.name}" is a local project already.` })
    return
  }
  const from = record.source
  const service = await serviceName(from)
  const synced = () => tm.listTasks({ project: record.name }).then((ts) => ts.filter((t) => t.source === from))
  // Parents first: a parent takes its same-service subtasks with it.
  const batch = (await synced()).sort((a, c) => Number(!!a.parent_task_id) - Number(!!c.parent_task_id)).slice(0, limit)
  const processed: Array<{ id: string; outside: string; children: number }> = []
  const failed: Array<{ id: string; error: string }> = []
  const at = new Date().toISOString()
  for (const t of batch) {
    const now = await tm.getTask(t.id).catch(() => null)
    if (!now || now.source !== from) continue // went local with its parent
    // A finished task's copy too: an edit after it finished may never have reached the service,
    // and completing a completed item changes nothing.
    const action = outside
    try {
      const made = await tm.makeTaskLocal(t.id, { state: 'chosen', by: 'user', at, reason: `Its project stopped syncing to ${service}` }, action)
      if (!made.outside.done) failed.push({ id: t.id, error: `local now, but its copy in ${service} was not closed: ${made.outside.error}` })
      processed.push({ id: t.id, outside: made.outside.done ? action : 'unchanged', children: made.children.length })
    } catch (err) {
      failed.push({ id: t.id, error: err instanceof Error ? err.message : String(err) })
    }
  }
  const remaining = (await synced()).length
  let done = false
  let holdsCleared = 0
  if (remaining === 0) {
    const flipped = await tm.setProjectLocal(record.name)
    done = !!flipped
    holdsCleared = flipped?.holdsCleared ?? 0
  }
  log.web.info('private tasks: project batch made local', {
    project: record.name, from, processed: processed.length, failed: failed.length, remaining, done,
    bySession: !!header(req, 'x-walnut-caller-sid'),
  })
  res.json({
    project: record.name, from, service, done, processed, failed, remaining, holds_cleared: holdsCleared,
    outcome: done
      ? `"${record.name}" no longer syncs to ${service}: every task in it is local.${failed.length ? ` ${failed.length} copy(ies) in ${service} were not closed; see failed.` : ''}`
      : `${processed.length} task(s) turned local in this call, ${remaining} still sync to ${service}. Call again to continue.`,
  })
}))

privateTasksV1Router.post('/private-tasks/test', route(async (req, res) => {
  const b = body(req)
  if (typeof b.text !== 'string') throw new RouteError(400, 'bad_request', 'text must be a string')
  if (b.words !== undefined && (!Array.isArray(b.words) || b.words.some((w) => typeof w !== 'string'))) {
    throw new RouteError(400, 'bad_request', 'words must be an array of strings')
  }
  if (b.provider !== undefined && typeof b.provider !== 'string') throw new RouteError(400, 'bad_request', 'provider must be a string')
  if (b.ai_rule !== undefined && typeof b.ai_rule !== 'string') throw new RouteError(400, 'bad_request', 'ai_rule must be a string')
  const { MAX_AI_RULE } = await import('../../core/private-tasks/provider-rules.js')
  if (typeof b.ai_rule === 'string' && b.ai_rule.length > MAX_AI_RULE) throw new RouteError(400, 'bad_request', `ai_rule is longer than ${MAX_AI_RULE} characters`)
  if (b.text.length > 20_000) throw new RouteError(400, 'bad_request', 'text is longer than 20000 characters')
  const { matchPrivateWords, invalidPrivateWords } = await import('../../core/private-tasks/private-words.js')
  const { syncRulesFor } = await import('../../core/private-tasks/provider-rules.js')
  const config = await (await import('../../core/config-manager.js')).getConfig()
  const rules = await syncRulesFor(config, (b.provider as string | undefined) ?? '')
  const words = (b.words as string[] | undefined) ?? (b.provider ? rules.words : config.private_tasks?.words ?? [])
  const out: Record<string, unknown> = { match: matchPrivateWords(words, [b.text]), invalid: invalidPrivateWords(words) }
  // The AI rule only when asked (Settings' Ask AI): one fast-model call, pass or fail with a reason.
  if (b.ai === true && b.text.trim()) {
    const { judgeTaskPrivacy } = await import('../../core/private-tasks/privacy-judge.js')
    const { serviceName } = await import('../../core/private-tasks/sync-gate.js')
    try {
      const verdict = await judgeTaskPrivacy({
        title: b.text.slice(0, 500), rule: ((b.ai_rule as string | undefined) ?? '').trim() || rules.aiRule,
        ...(b.provider ? { service: await serviceName(b.provider as string) } : {}),
      })
      out.ai = { pass: !verdict.private, reason: verdict.reason }
    } catch (err) {
      out.ai = { error: err instanceof Error ? err.message : String(err) }
    }
  }
  res.json(out)
}))

/** Every loaded task provider (a plugin that syncs tasks), by name. */
async function taskProviders() {
  const { registry } = await import('../../core/integration-registry.js')
  return registry.getAll().filter((p) => p.id !== 'local' && p.hasSync !== false).sort((a, b) => a.name.localeCompare(b.name))
}

privateTasksV1Router.get('/private-tasks/providers', route(async (_req, res) => {
  const { getConfig } = await import('../../core/config-manager.js')
  const { DEFAULT_AI_RULE, resolveSyncRules } = await import('../../core/private-tasks/provider-rules.js')
  const { findPluginIcon, pluginIconUrl } = await import('../../core/plugins/plugin-icon.js')
  const config = await getConfig()
  const providers = await Promise.all((await taskProviders()).map(async (p) => {
    const r = resolveSyncRules(config, p.id, p.syncAudience)
    // The plugin's own icon, as Settings › Plugins draws it; none is fine (a monogram).
    const icon = p.pluginDir ? await findPluginIcon(p.pluginDir).catch(() => null) : null
    return {
      id: p.id, name: p.name, check: r.check, check_set: r.checkSet, check_default: r.checkDefault,
      words: r.words, ai: r.ai, ai_rule: r.aiRule, ai_rule_default: DEFAULT_AI_RULE,
      ...(icon?.ok ? { icon_url: pluginIconUrl(p.id, icon) } : {}),
    }
  }))
  res.json({ providers })
}))

/** The earlier shape of the list above (a window opened before 2026-11-02 still asks for it). */
privateTasksV1Router.get('/private-tasks/services', route(async (_req, res) => {
  const { getConfig } = await import('../../core/config-manager.js')
  const { resolveSyncRules } = await import('../../core/private-tasks/provider-rules.js')
  const config = await getConfig()
  const services = (await taskProviders()).map((p) => {
    const r = resolveSyncRules(config, p.id, p.syncAudience)
    return { id: p.id, name: p.name, audience: r.check ? 'shared' : 'self', default: r.checkDefault ? 'shared' : 'self', set: r.checkSet }
  })
  res.json({ services })
}))
