/**
 * /api/v1 task extras (additive, Wave 2) — virtual task groups, tag catalog,
 * NL quick-parse, and custom focus-tier CRUD (Wave 1 shipped the tier READ +
 * pin management; this completes tier management). Semantics identical to the
 * web routes (tasks.ts / focus.ts) — same task-manager functions throughout.
 *
 *   GET    /tasks/meta/tags               → { tags: [{ tag, count }] }
 *   GET    /tasks/groups                  → { groups }
 *   POST   /tasks/groups { task_ids, label? } → group result
 *   POST   /tasks/groups/:groupId/add { task_ids } → group result
 *   POST   /tasks/groups/remove { task_ids }       → { removed_ids, dissolved_group_ids }
 *   PATCH  /tasks/groups/:groupId { label }        → { group_id, label }
 *   PATCH  /tasks/groups/:groupId/hidden { hidden } → { group_id, hidden }
 *   POST   /tasks/quick-parse { text, timeZone }   → QuickTaskParse
 *   POST   /focus/tiers { label }         → { tier, tiers }
 *   PUT    /focus/tiers/:id { label }     → { tier, tiers }
 *   DELETE /focus/tiers/:id               → { tiers, moved }
 *
 * Cloud companion (REPLICA): groups/tiers are Class A for the local store BUT
 * group membership (group_id) and the tier registry are NOT in the outbox
 * update whitelist, so replica-side changes stay replica-local until the next
 * projection import overwrites them. That silent-revert is worse than an
 * honest error → groups + tier CRUD answer 501 not_supported_cloud on a
 * REPLICA. Tags read and quick-parse work on both boxes (quick-parse is
 * stateless; the replica has its own model credentials for the Personal AI).
 *
 * Frozen-contract note: everything here is additive (docs/reference/api-v1.md).
 */

import { Router, type Request, type Response, type NextFunction } from 'express'
import { CLOUD_MODE } from '../../constants.js'
import { log } from '../../logging/index.js'
import { bus, EventNames } from '../../core/event-bus.js'
import { sendV1Error as sendError } from './v1-control-relay.js'
import { PIN_TIER_POLICY, RETIRED_PIN_TIERS } from '../../core/types.js'

export const taskExtrasV1Router = Router()

/** The box-level relay id (the action names no session). */
const SERVER_RELAY_SID = '__server__'
/** A phone reads the rules at launch: a slow bridge must not hold its pills for 30s. */
const TAG_DISPLAY_RELAY_TIMEOUT_MS = 8_000

/** Registry writes have no replica→primary write-back — refuse loudly on cloud. */
function replicaRefused(res: Response, what: string): boolean {
  if (!CLOUD_MODE) return false
  sendError(res, 501, 'not_supported_cloud', `${what} runs on the primary box only (no replica write-back channel)`)
  return true
}

/** Validate a body's task_ids array. Returns ids or null after replying 400. */
function bodyTaskIds(req: Request, res: Response, min: number): string[] | null {
  const ids = (req.body ?? {}).task_ids
  if (!Array.isArray(ids) || ids.length < min || !ids.every((id: unknown) => typeof id === 'string')) {
    sendError(res, 400, 'bad_request', `task_ids must be an array of at least ${min} task id strings`)
    return null
  }
  return ids as string[]
}

/** Map task-manager group errors to the frozen shape. True = handled. */
function sendGroupError(res: Response, err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err)
  if (/not found/i.test(msg)) {
    sendError(res, 404, 'not_found', msg)
    return true
  }
  if (/at least 2 tasks|label cannot be empty|Ambiguous ID prefix|No task found matching/i.test(msg)) {
    sendError(res, 400, 'bad_request', msg)
    return true
  }
  return false
}

// ─── Tags ────────────────────────────────────────────────────────────────────

// GET /api/v1/tasks/meta/tags — unique tags with frequency counts (autocomplete).
taskExtrasV1Router.get('/tasks/meta/tags', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const { getAllTags } = await import('../../core/task-manager.js')
    res.json({ tags: await getAllTags() })
  } catch (err) {
    next(err)
  }
})

// GET /api/v1/tasks/meta/tag-display — which tags a task shows (core/tag-display-rules.ts):
// Walnut's own rule, the user's, plugin defaults and Walnut's defaults. Clients compile them once and filter
// the pills they draw; `task:tag-display-changed` says when to read them again.
// `links` (additive, 2026-10): what a tag's pill opens, the user's then plugin defaults.
// REPLICA: the user's rules live in the primary's config.yaml and plugin defaults in its memory,
// so it asks the primary (`server.tag-display`); when the Mac cannot be reached it answers its
// own (Walnut's rules only) rather than an error, because the pills still need some answer.
taskExtrasV1Router.get('/tasks/meta/tag-display', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    if (CLOUD_MODE) {
      const { callPrimaryControl } = await import('./v1-control-relay.js')
      const outcome = await callPrimaryControl('server.tag-display', SERVER_RELAY_SID, {}, TAG_DISPLAY_RELAY_TIMEOUT_MS)
      if (outcome.ok && Array.isArray(outcome.result.rules)) {
        res.json({ rules: outcome.result.rules, links: Array.isArray(outcome.result.links) ? outcome.result.links : [] })
        return
      }
      log.web.warn('v1 tag-display: primary unavailable, answering the replica\'s own rules', {
        failure: outcome.ok ? 'malformed' : outcome.failure.kind,
      })
    }
    const { readTagDisplayState } = await import('../../core/tag-display.js')
    res.json(await readTagDisplayState())
  } catch (err) {
    next(err)
  }
})

// PUT /api/v1/tasks/meta/tag-display { pattern, display: 'shown' | 'value' | 'hidden' | null }:
// the user's rule for one tag or `<key>:*` (null removes it). `{ pattern, link }` instead sets
// the user's link (a template with {value}, '' for none, null removes it). Answers the rules
// and links in force. The rules live in the primary's config.yaml: a REPLICA relays the change.
taskExtrasV1Router.put('/tasks/meta/tag-display', async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (CLOUD_MODE) {
      const { relayControlAction } = await import('./v1-control-relay.js')
      await relayControlAction(res, 'server.tag-display.set', SERVER_RELAY_SID, (req.body ?? {}) as Record<string, unknown>, 200)
      return
    }
    const { applyUserTagChange, TagRuleInputError } = await import('../../core/tag-display.js')
    try {
      res.json(await applyUserTagChange(req.body))
    } catch (err) {
      if (err instanceof TagRuleInputError) { sendError(res, 400, 'bad_request', err.message); return }
      throw err
    }
  } catch (err) {
    next(err)
  }
})

// GET /api/v1/tasks/meta/sprints (Wave 3) — unique sprint names with task
// counts, most-used first. Class A.
taskExtrasV1Router.get('/tasks/meta/sprints', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const { listTasks } = await import('../../core/task-manager.js')
    const tasks = (await listTasks({})).filter((t) => !t.title.startsWith('.metadata'))
    const sprintCounts = new Map<string, number>()
    for (const t of tasks) {
      if (t.sprint) sprintCounts.set(t.sprint, (sprintCounts.get(t.sprint) ?? 0) + 1)
    }
    const sprints = [...sprintCounts.entries()]
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count)
    res.json({ sprints })
  } catch (err) {
    next(err)
  }
})

// GET /api/v1/tasks/enriched (Wave 3) — full task rows + computed fields
// (currently `overdue`). Class A. NOTE: task-v1's GET /tasks/:id forwards the
// literal "enriched" here (RESERVED_TASK_SUBPATHS).
taskExtrasV1Router.get('/tasks/enriched', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const { listTasks } = await import('../../core/task-manager.js')
    const tasks = (await listTasks({})).filter((t) => !t.title.startsWith('.metadata'))
    const now = Date.now()
    const enriched = tasks.map((t) => ({
      ...t,
      overdue: t.due_date ? new Date(t.due_date).getTime() < now && t.status !== 'done' : false,
    }))
    res.json({ tasks: enriched })
  } catch (err) {
    next(err)
  }
})

// ─── Virtual task groups ─────────────────────────────────────────────────────
// Registration order matters (same rule as tasks.ts): the explicit /groups
// paths must never be shadowed by an /:id route — this router has none.

// GET /api/v1/tasks/groups — all groups with labels + hidden flag + member ids.
// REPLICA: its rows are built from the slim projection, which carries no
// group_id, so its own store knows no folder membership. It serves the listing
// the primary pushes on its task projection (`groups`), and its own store only
// when the primary predates that.
taskExtrasV1Router.get('/tasks/groups', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const { listGroups } = await import('../../core/task-manager.js')
    res.json({ groups: await listGroups() })
  } catch (err) {
    next(err)
  }
})

// POST /api/v1/tasks/groups { task_ids, label? } — create a group from ≥2 tasks.
// Unlike the web route, no async AI label refinement is fired here: mobile
// clients read the response synchronously, and the label refine loop belongs
// to the web console's live event stream.
taskExtrasV1Router.post('/tasks/groups', async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (replicaRefused(res, 'Group management')) return
    const taskIds = bodyTaskIds(req, res, 2)
    if (!taskIds) return
    const label = (req.body ?? {}).label
    if (label !== undefined && typeof label !== 'string') {
      sendError(res, 400, 'bad_request', 'label must be a string')
      return
    }
    const { groupTasks } = await import('../../core/task-manager.js')
    try {
      const result = await groupTasks(taskIds, label)
      bus.emit(EventNames.TASK_GROUPS_CHANGED, { group_id: result.group_id, label: result.label }, ['web-ui'], { source: 'api-v1' })
      res.status(201).json(result)
    } catch (err) {
      if (sendGroupError(res, err)) return
      throw err
    }
  } catch (err) {
    next(err)
  }
})

// POST /api/v1/tasks/groups/:groupId/add { task_ids } — add tasks to a group.
taskExtrasV1Router.post('/tasks/groups/:groupId/add', async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (replicaRefused(res, 'Group management')) return
    const taskIds = bodyTaskIds(req, res, 1)
    if (!taskIds) return
    const { addToGroup } = await import('../../core/task-manager.js')
    try {
      const result = await addToGroup(String(req.params.groupId), taskIds)
      bus.emit(EventNames.TASK_GROUPS_CHANGED, { group_id: result.group_id, label: result.label }, ['web-ui'], { source: 'api-v1' })
      res.json(result)
    } catch (err) {
      if (sendGroupError(res, err)) return
      throw err
    }
  } catch (err) {
    next(err)
  }
})

// POST /api/v1/tasks/groups/remove { task_ids } — remove tasks from their group(s).
taskExtrasV1Router.post('/tasks/groups/remove', async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (replicaRefused(res, 'Group management')) return
    const taskIds = bodyTaskIds(req, res, 1)
    if (!taskIds) return
    const { removeFromGroup } = await import('../../core/task-manager.js')
    try {
      const result = await removeFromGroup(taskIds)
      bus.emit(EventNames.TASK_GROUPS_CHANGED, { dissolved_group_ids: result.dissolved_group_ids }, ['web-ui'], { source: 'api-v1' })
      res.json(result)
    } catch (err) {
      if (sendGroupError(res, err)) return
      throw err
    }
  } catch (err) {
    next(err)
  }
})

// PATCH /api/v1/tasks/groups/:groupId { label } — rename a group.
taskExtrasV1Router.patch('/tasks/groups/:groupId', async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (replicaRefused(res, 'Group management')) return
    const { label } = (req.body ?? {}) as { label?: unknown }
    if (typeof label !== 'string' || !label.trim()) {
      sendError(res, 400, 'bad_request', 'label must be a non-empty string')
      return
    }
    const { renameGroup } = await import('../../core/task-manager.js')
    try {
      const result = await renameGroup(String(req.params.groupId), label)
      bus.emit(EventNames.TASK_GROUPS_CHANGED, { group_id: result.group_id, label: result.label }, ['web-ui'], { source: 'api-v1' })
      res.json(result)
    } catch (err) {
      if (sendGroupError(res, err)) return
      throw err
    }
  } catch (err) {
    next(err)
  }
})

// PATCH /api/v1/tasks/groups/:groupId/hidden { hidden } — show/hide in Focus.
taskExtrasV1Router.patch('/tasks/groups/:groupId/hidden', async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (replicaRefused(res, 'Group management')) return
    const { hidden } = (req.body ?? {}) as { hidden?: unknown }
    if (typeof hidden !== 'boolean') {
      sendError(res, 400, 'bad_request', 'hidden must be a boolean')
      return
    }
    const { setGroupHidden } = await import('../../core/task-manager.js')
    try {
      const result = await setGroupHidden(String(req.params.groupId), hidden)
      bus.emit(EventNames.TASK_GROUPS_CHANGED, { group_id: result.group_id, hidden: result.hidden }, ['web-ui'], { source: 'api-v1' })
      res.json(result)
    } catch (err) {
      if (sendGroupError(res, err)) return
      throw err
    }
  } catch (err) {
    next(err)
  }
})

// ─── NL quick-parse (stateless) ──────────────────────────────────────────────

// POST /api/v1/tasks/quick-parse { text, timeZone } — parse natural-language
// task metadata (title/dates/priority/pinTier/project) with the fast model.
taskExtrasV1Router.post('/tasks/quick-parse', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { text, timeZone } = (req.body ?? {}) as { text?: unknown; timeZone?: unknown }
    if (typeof text !== 'string' || text.trim() === '') {
      sendError(res, 400, 'bad_request', 'text must be a non-empty string')
      return
    }
    if (text.length > 500) {
      sendError(res, 400, 'bad_request', 'text must be at most 500 characters')
      return
    }
    if (typeof timeZone !== 'string' || timeZone.length === 0 || timeZone.length > 64) {
      sendError(res, 400, 'bad_request', 'timeZone must be a valid IANA timezone')
      return
    }
    // Relative dates resolve against the CLIENT's timezone, not the server's.
    try {
      new Intl.DateTimeFormat('en-US', { timeZone })
    } catch {
      sendError(res, 400, 'bad_request', 'timeZone must be a valid IANA timezone')
      return
    }

    // Same opt-in gate as the web route, for the same reason: skip the all-tasks
    // digest walk when the answer is already decided. See agent.quick_parse.
    const { quickParseEnabled, unparsedTask } = await import('../../core/quick-task-parse.js')
    if (!(await quickParseEnabled())) {
      res.json(unparsedTask(text).parse)
      return
    }

    const startedAt = Date.now()
    const { buildProjectDigest } = await import('../../core/quick-task-digest.js')
    let projectDigest: import('../../core/quick-task-digest.js').ProjectDigest = { digest: '', projects: [], summaries: {} }
    try {
      projectDigest = await buildProjectDigest()
    } catch (err) {
      log.web.warn('v1 quick-parse project digest unavailable', {
        error: err instanceof Error ? err.message : String(err),
      })
    }
    const { parseQuickTask } = await import('../../core/quick-task-parse.js')
    const { getCustomTiers } = await import('../../core/task-manager.js')
    const { parse, parseMs, model } = await parseQuickTask(text, {
      timeZone,
      projectDigest: projectDigest.digest,
      knownProjects: projectDigest.projects,
      projectSummaries: projectDigest.summaries,
      customTiers: await getCustomTiers(),
    })
    log.web.info('v1 quick-parse', {
      parseMs, totalMs: Date.now() - startedAt, model, textLen: text.length,
    })
    res.json(parse)
  } catch (err) {
    next(err)
  }
})

// ─── Custom focus-tier CRUD (registry writes) ────────────────────────────────

// POST /api/v1/focus/tiers { label } — create a custom tier.
taskExtrasV1Router.post('/focus/tiers', async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (replicaRefused(res, 'Focus tier management')) return
    const { label } = (req.body ?? {}) as { label?: unknown }
    const { createCustomTier } = await import('../../core/task-manager.js')
    try {
      res.status(201).json(await createCustomTier(typeof label === 'string' ? label : ''))
    } catch (err) {
      if (err instanceof Error && (err.message.startsWith('Tier label') || err.message.startsWith('Too many custom tiers'))) {
        sendError(res, 400, 'bad_request', err.message)
        return
      }
      throw err
    }
  } catch (err) {
    next(err)
  }
})

// PUT /api/v1/focus/tiers/:id { label } — rename a custom tier.
taskExtrasV1Router.put('/focus/tiers/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (replicaRefused(res, 'Focus tier management')) return
    const { label } = (req.body ?? {}) as { label?: unknown }
    const { renameCustomTier } = await import('../../core/task-manager.js')
    try {
      res.json(await renameCustomTier(String(req.params.id), typeof label === 'string' ? label : ''))
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('Tier not found')) {
        sendError(res, 404, 'not_found', err.message)
        return
      }
      if (err instanceof Error && err.message.startsWith('Tier label')) {
        sendError(res, 400, 'bad_request', err.message)
        return
      }
      throw err
    }
  } catch (err) {
    next(err)
  }
})

// Retired names stay here: an old client deleting 'backlog' gets the same
// answer a built-in gets, never a 404 "Tier not found".
const BUILTIN_TIERS: readonly string[] = [...PIN_TIER_POLICY.map((entry) => entry.tier), ...Object.keys(RETIRED_PIN_TIERS)]

// DELETE /api/v1/focus/tiers/:id — delete a custom tier (members → satellite).
taskExtrasV1Router.delete('/focus/tiers/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (replicaRefused(res, 'Focus tier management')) return
    // Built-ins would otherwise fall through to a misleading 404 "Tier not found".
    if (BUILTIN_TIERS.includes(String(req.params.id))) {
      sendError(res, 400, 'bad_request', 'Built-in tiers cannot be deleted')
      return
    }
    const { deleteCustomTier } = await import('../../core/task-manager.js')
    try {
      res.json(await deleteCustomTier(String(req.params.id)))
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('Tier not found')) {
        sendError(res, 404, 'not_found', err.message)
        return
      }
      throw err
    }
  } catch (err) {
    next(err)
  }
})

// Router-level error funnel — keeps unexpected failures in the frozen shape.
taskExtrasV1Router.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  log.web.error('api-v1 task extras route error', {
    error: err instanceof Error ? err.message : String(err),
  })
  if (res.headersSent) {
    res.end()
    return
  }
  sendError(res, 500, 'internal', 'Internal server error')
})
