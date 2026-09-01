/**
 * Task routes — thin pass-through to core task-manager functions.
 */

import { Router, type Request, type Response, type NextFunction } from 'express'
import { log } from '../../logging/index.js'
import { VALID_PHASES } from '../../core/phase.js'
import {
  addTask,
  listTasks,
  queryTasksPage,
  queryTasksSlimPage,
  getTask,
  completeTask,
  toggleComplete,
  setPhaseBulk,
  updateTask,
  deleteTask,
  deleteTasksByIds,
  mergeTaskInto,
  ActiveSessionError,
  ActiveChildrenError,
  InvalidProjectNameError,
  InvalidFocusTierError,
  ProjectSourceConflictError,
  addNote,
  updateNote,
  updateDescription,
  updateSummary,
  reorderTasks,
  getAllTags,
  CircularDependencyError,
  isTaskBlocked,
  groupTasks,
  addToGroup,
  removeFromGroup,
  renameGroup,
  setGroupHidden,
  listGroups,
  createFolder,
  deleteFolder,
  setFolderParent,
  getCustomTiers,
  getBoardCounts,
  setPluginTaskField,
  newTaskPinDefault,
  type SlimTask,
} from '../../core/task-manager.js'
import {
  bulkGetFromTasks,
  BulkGetError,
  type BulkGetResult,
} from '../../core/task-bulk-get.js'
import { listSessions } from '../../core/session-tracker.js'
import { bus, EventNames } from '../../core/event-bus.js'
import {
  LEGACY_STATUS_TO_COMPLETION,
  MAX_QUERY_LIMIT,
  TaskQueryError,
  type TaskQuery,
  type TaskQueryTime,
} from '../../core/task-query.js'
import { VALID_PRIORITIES, type Task, type ProcessStatus, type SessionMode } from '../../core/types.js'
import { parseQuickTask } from '../../core/quick-task-parse.js'
import { buildProjectDigest, type ProjectDigest } from '../../core/quick-task-digest.js'
import {
  SUGGEST_FIELDS,
  recordSuggestDiff,
  summarizeSuggestAccuracy,
  type SuggestDiffEntry,
  type SuggestField,
} from '../../core/suggest-accuracy.js'

/** Session info used during enrichment (includes mode for slot inference). */
interface SessionInfo {
  process_status: ProcessStatus
  activity?: string
  mode: SessionMode
  provider?: import('../../core/types.js').SessionProvider
  engine?: import('../../core/types.js').SessionEngine
  planCompleted?: boolean
  archived?: boolean
  /** Pending permission/AskUserQuestion prompt (record.pendingPermission). */
  pendingPermission?: { toolName?: string }
}

/** Map SessionInfo to the enriched status shape attached to tasks. */
function toSlotStatus(info: SessionInfo, slot?: 'plan' | 'exec'): { process_status: ProcessStatus; activity?: string; mode?: SessionMode; provider?: import('../../core/types.js').SessionProvider; engine?: import('../../core/types.js').SessionEngine; planCompleted?: boolean } {
  return {
    process_status: info.process_status,
    activity: info.activity,
    mode: info.mode,
    provider: info.provider,
    engine: info.engine,
    ...(info.planCompleted ? { planCompleted: true } : {}),
  }
}

/** Whether a session is still active (not in a terminal state). */
function isActiveSession(info: SessionInfo): boolean {
  return info.process_status !== 'error'
}

/** Enrich tasks that have slot sessions with session status info. */
export async function enrichTasksWithSessionStatus(tasks: Task[]): Promise<Task[]> {
  // Collect ALL session IDs needed across all tasks
  const sessionIds = new Set<string>()
  for (const t of tasks) {
    if (t.session_id) sessionIds.add(t.session_id)
    if (t.plan_session_id) sessionIds.add(t.plan_session_id)
    if (t.exec_session_id) sessionIds.add(t.exec_session_id)
    if (t.session_ids) for (const sid of t.session_ids) sessionIds.add(sid)
  }

  // Single read of the session store — avoids N file reads via getSessionByClaudeId.
  // Graceful degradation: if session store is unreadable, return tasks without enrichment.
  let allSessions: Awaited<ReturnType<typeof listSessions>>
  try {
    allSessions = await listSessions()
  } catch (err) {
    log.web.warn('session enrichment skipped — failed to read session store', {
      error: err instanceof Error ? err.message : String(err),
    })
    return tasks
  }

  // Build reverse map: taskId → session records that reference it.
  // This catches sessions linked via session record's taskId field even when
  // the task's session_ids/session_id fields are out of sync (e.g., linkSessionSlot
  // failed due to file lock contention or ambiguous prefix).
  // Excludes embedded subagent runs (triage, general agent) — these are high-volume
  // housekeeping sessions that should not appear in the session pill.
  const taskIds = new Set(tasks.map((t) => t.id))
  const sessionsByTaskId = new Map<string, typeof allSessions>()
  for (const rec of allSessions) {
    if (rec.taskId && taskIds.has(rec.taskId) && rec.provider !== 'embedded') {
      sessionIds.add(rec.claudeSessionId)
      let list = sessionsByTaskId.get(rec.taskId)
      if (!list) { list = []; sessionsByTaskId.set(rec.taskId, list) }
      list.push(rec)
    }
  }

  if (sessionIds.size === 0) return tasks

  const sessionMap = new Map<string, SessionInfo>()
  for (const rec of allSessions) {
    if (sessionIds.has(rec.claudeSessionId)) {
      sessionMap.set(rec.claudeSessionId, {
        process_status: rec.process_status,
        activity: rec.activity,
        mode: rec.mode,
        provider: rec.provider,
        engine: rec.engine,
        planCompleted: rec.planCompleted,
        archived: rec.archived,
        pendingPermission: rec.pendingPermission,
      })
    }
  }

  return tasks.map((t) => {
    const enriched: Task = { ...t }

    // Merge sessions discovered via session record's taskId but missing from task fields.
    // This heals the data inconsistency where linkSessionSlot/linkSession failed (e.g., file
    // lock contention) but createSessionRecord succeeded — the session record has taskId set
    // but the task's session_ids/session_id were never updated.
    const taskSessions = sessionsByTaskId.get(t.id)
    if (taskSessions) {
      if (!enriched.session_ids) enriched.session_ids = []
      for (const rec of taskSessions) {
        if (!enriched.session_ids.includes(rec.claudeSessionId)) {
          enriched.session_ids.push(rec.claudeSessionId)
        }
      }
      // Backfill session_id with most recent non-archived session (iterate in reverse
      // since allSessions is in insertion/chronological order).
      // Also heal when session_id points to an archived session — this happens when
      // handleStart's link path wrote an archived sessionId back into the slot (see
      // the guard in claude-code-session.ts). Treat it the same as missing.
      // Note: sessionMap.get(...) returning undefined means "session record unknown" —
      // we treat that as "not archived" (safe default) and keep whatever was there.
      const currentSingle = enriched.session_id ? sessionMap.get(enriched.session_id) : undefined
      if (!enriched.session_id || currentSingle?.archived) {
        if (currentSingle?.archived) {
          log.web.warn('healing archived session_id in enrichment — possible handleStart guard regression', {
            taskId: t.id, archivedSessionId: enriched.session_id,
          })
        }
        let replacement: string | undefined
        for (let i = taskSessions.length - 1; i >= 0; i--) {
          if (!taskSessions[i].archived) {
            replacement = taskSessions[i].claudeSessionId
            break
          }
        }
        enriched.session_id = replacement
      }

      // Heal plan/exec slots if they point to archived sessions (same poisoning vector).
      // plan_session_id is cleared but NOT backfilled: plan is a per-run artifact,
      // and backfilling would surface stale plans as if they were the current plan.
      if (enriched.plan_session_id && sessionMap.get(enriched.plan_session_id)?.archived) {
        enriched.plan_session_id = undefined
      }
      if (enriched.exec_session_id && sessionMap.get(enriched.exec_session_id)?.archived) {
        enriched.exec_session_id = undefined
      }
      // Backfill exec_session_id from most recent non-plan active session —
      // exec is the default run-mode slot, so surfacing a live exec session is desired.
      if (!enriched.exec_session_id) {
        for (let i = taskSessions.length - 1; i >= 0; i--) {
          const s = taskSessions[i]
          if (!s.archived && s.mode !== 'plan') {
            enriched.exec_session_id = s.claudeSessionId
            break
          }
        }
      }
    }

    // Filter archived sessions early — all downstream logic only sees live sessions.
    if (enriched.session_ids) {
      enriched.session_ids = enriched.session_ids.filter(sid => !sessionMap.get(sid)?.archived)
    }

    // Enrich the new single-slot session_status from task.session_id
    const singleInfo = enriched.session_id ? sessionMap.get(enriched.session_id) : undefined
    if (singleInfo && !singleInfo.archived) {
      enriched.session_status = {
        process_status: singleInfo.process_status,
        activity: singleInfo.activity,
        mode: singleInfo.mode,
        provider: singleInfo.provider,
        engine: singleInfo.engine,
        ...(singleInfo.planCompleted ? { planCompleted: true } : {}),
        // Rides the task list so circles/pills can show the red waiting state
        // without a per-session status fetch (2026-08-14: Satellite list gave
        // zero signal for sessions blocked on a human click).
        ...(singleInfo.pendingPermission
          ? { pendingPermissionTool: singleInfo.pendingPermission.toolName ?? 'unknown' }
          : {}),
      }
    }

    // Enrich from explicit slot fields (strip mode before attaching) — backward compat.
    // Use enriched.* (healed) rather than t.* so archived sessions that were poisoning
    // the slot don't surface as a live plan/exec status.
    const planInfo = enriched.plan_session_id ? sessionMap.get(enriched.plan_session_id) : undefined
    if (planInfo && !planInfo.archived) enriched.plan_session_status = toSlotStatus(planInfo, 'plan')
    const execInfo = enriched.exec_session_id ? sessionMap.get(enriched.exec_session_id) : undefined
    if (execInfo && !execInfo.archived) enriched.exec_session_status = toSlotStatus(execInfo, 'exec')

    // Infer missing slot statuses from session_ids + session mode.
    // Covers: from_plan fallback (SESSION_SEND doesn't call linkSessionSlot),
    // sessionReady rejection, async gap before sessionReady resolves, and
    // older tasks created before exec_session_id tracking was added.
    // Only infer from non-terminal sessions (completed/error sessions fall
    // through to the "N sessions" history pill instead).
    if ((!enriched.plan_session_status || !enriched.exec_session_status) && enriched.session_ids?.length) {
      // Iterate in reverse so the most recent session wins (session_ids is chronological)
      for (let i = enriched.session_ids.length - 1; i >= 0; i--) {
        const sid = enriched.session_ids[i]
        // Skip sessions already covered by slot fields
        if (sid === enriched.plan_session_id || sid === enriched.exec_session_id) continue
        const info = sessionMap.get(sid)
        if (!info || !isActiveSession(info)) continue
        if (!enriched.plan_session_status && (info.mode === 'plan' || info.planCompleted)) {
          enriched.plan_session_status = toSlotStatus(info, 'plan')
        } else if (!enriched.exec_session_status && info.mode !== 'plan' && !info.planCompleted) {
          enriched.exec_session_status = toSlotStatus(info, 'exec')
        }
      }
    }

    return enriched
  })
}

export const tasksRouter = Router()

/** Extract a single string param (Express may return string | string[]). */
function param(value: string | string[]): string {
  return Array.isArray(value) ? value[0] : value
}

const VALID_STATUSES = ['todo', 'in_progress', 'done']
const VALID_PHASES_ARRAY = [...VALID_PHASES]

// ── GET /api/tasks query parsing ──
//
// The route is a THIN adapter: it turns query-string text into a TaskQuery and
// hands the semantics to queryTasks(). There are deliberately no route-local
// filter predicates any more — a second copy of "what does pinned mean" is
// exactly how REST, the agent tool and the two UIs drifted apart before.
//
// Legacy singulars (status/project/source/tags/sprint) fold into the canonical
// arrays. Canonical `completion` supersedes `status`; there is NO implicit
// hiding of COMPLETE on REST (that default lives only in the agent-tool adapter).
//
// There is also NO route-local default `limit`: no limit param means every
// matching row, which is what the web list and the whole pinned board need. A
// page-size default belongs to the adapter that wants one (the `task_list` op),
// and the response carries `total` / `truncated` so a capped answer is visible.

/** A rejected query param. Carries the message the route returns as 400. */
class QueryParamError extends Error {}

/**
 * Read one query param as a string. Express 5's simple query parser turns
 * `?x=1&x=2` into an array, so a bare `.split()` on `req.query` values would
 * throw (→ 500) instead of answering 400. Repeats take the LAST value (matching
 * how a comma list would read). The object branch is purely defensive: the
 * simple parser never produces one, but a swapped-in extended parser would.
 */
function queryString(value: unknown, name: string): string | undefined {
  if (value === undefined) return undefined
  if (typeof value === 'string') return value
  if (Array.isArray(value)) {
    const last = value[value.length - 1]
    if (typeof last === 'string') return last
  }
  throw new QueryParamError(`${name} must be a single value`)
}

/** Comma-separated list → trimmed values. Empty entries are kept ('' = Inbox). */
function csv(value: string): string[] {
  return value.split(',').map((v) => v.trim())
}

function parseBoolParam(value: string, name: string): boolean {
  if (value === 'true') return true
  if (value === 'false') return false
  throw new QueryParamError(`${name} must be "true" or "false"`)
}

function parsePositiveIntParam(value: string, name: string): number {
  if (!/^\d+$/.test(value)) throw new QueryParamError(`${name} must be a positive integer`)
  const parsed = Number(value)
  if (parsed < 1) throw new QueryParamError(`${name} must be a positive integer`)
  return parsed
}

/**
 * Query string → TaskQuery. Throws QueryParamError for shapes the shared
 * normalizer can't see (unknown time_basis without a window, last_hours AND
 * last_days together); every other invalid value is caught by
 * normalizeTaskQuery's TaskQueryError inside queryTasks().
 */
function parseTaskQueryParams(rawQuery: Record<string, unknown>): TaskQuery {
  const query: TaskQuery = {}
  // Normalize every param this parser reads to `string | undefined` up front, so
  // no branch below has to worry about Express's array/object shapes.
  const raw: Record<string, string | undefined> = {}
  for (const name of [
    'completion', 'status', 'phases', 'projects', 'project', 'priorities',
    'sources', 'source', 'sprints', 'sprint', 'tags_any', 'tags', 'tags_all', 'tag',
    'pinned', 'unread', 'blocked', 'working_set', 'focus_tier', 'q', 'ids', 'parent_task_id',
    'group_id', 'time_basis', 'last_hours', 'last_days', 'time_from',
    'time_until', 'sort', 'limit',
  ]) {
    raw[name] = queryString(rawQuery[name], name)
  }

  // completion wins over the legacy status alias when both are present.
  if (raw.completion !== undefined) {
    query.completion = csv(raw.completion) as TaskQuery['completion']
  } else if (raw.status !== undefined) {
    const statuses = csv(raw.status)
    const unknown = statuses.find((s) => !VALID_STATUSES.includes(s))
    if (unknown !== undefined) throw new QueryParamError(`status must be one of: ${VALID_STATUSES.join(', ')}`)
    query.completion = statuses.map((s) => LEGACY_STATUS_TO_COMPLETION[s])
  }
  if (raw.phases !== undefined) query.phases = csv(raw.phases) as TaskQuery['phases']

  // Legacy singulars fold into the canonical arrays. `project=''` is meaningful
  // (Inbox) so presence, not truthiness, decides.
  if (raw.projects !== undefined) query.projects = csv(raw.projects)
  else if (raw.project !== undefined) query.projects = [raw.project]
  if (raw.priorities !== undefined) query.priorities = csv(raw.priorities) as TaskQuery['priorities']
  if (raw.sources !== undefined) query.sources = csv(raw.sources)
  else if (raw.source !== undefined) query.sources = [raw.source]
  if (raw.sprints !== undefined) query.sprints = csv(raw.sprints)
  else if (raw.sprint !== undefined) query.sprints = [raw.sprint]

  // An empty value means NO CONDITION on every tag param (`?tags_any=`,
  // `?tags_all=`, legacy `?tags=` alike). Setting tagsAny to [] would instead
  // mean "match nothing" (`[].some` is false), which no caller asks for by
  // typing an empty value.
  if (raw.tags_any !== undefined) {
    const values = csv(raw.tags_any).filter(Boolean)
    if (values.length > 0) query.tagsAny = values
  } else if (raw.tags !== undefined) {
    const legacy = csv(raw.tags).filter(Boolean)
    if (legacy.length > 0) query.tagsAny = legacy
  }
  if (raw.tags_all !== undefined) {
    const values = csv(raw.tags_all).filter(Boolean)
    if (values.length > 0) query.tagsAll = values
  }
  // `tag` — single exact tag, the task_list op's legacy arg name. Lowest
  // precedence of the three tag spellings.
  if (query.tagsAny === undefined && raw.tag !== undefined && raw.tag !== '') {
    query.tagsAny = [raw.tag]
  }
  // Empty csv value = no condition, matching the tag params above.
  if (raw.focus_tier !== undefined) {
    const values = csv(raw.focus_tier).filter(Boolean)
    if (values.length > 0) query.focusTiers = values
  }
  if (raw.ids !== undefined) {
    const values = csv(raw.ids).filter(Boolean)
    if (values.length > 0) query.ids = values
  }
  if (raw.q !== undefined) query.q = raw.q

  for (const name of ['pinned', 'unread', 'blocked'] as const) {
    if (raw[name] !== undefined) query[name] = parseBoolParam(raw[name]!, name)
  }
  if (raw.working_set !== undefined) query.workingSet = parseBoolParam(raw.working_set, 'working_set')
  if (raw.parent_task_id !== undefined) query.parentTaskId = raw.parent_task_id
  if (raw.group_id !== undefined) query.groupId = raw.group_id

  if (raw.time_basis !== undefined) {
    if (raw.last_hours !== undefined && raw.last_days !== undefined) {
      throw new QueryParamError('last_hours and last_days are mutually exclusive')
    }
    const time: TaskQueryTime = { basis: raw.time_basis as TaskQueryTime['basis'] }
    if (raw.last_hours !== undefined) {
      time.last = { value: parsePositiveIntParam(raw.last_hours, 'last_hours'), unit: 'hours' }
    } else if (raw.last_days !== undefined) {
      time.last = { value: parsePositiveIntParam(raw.last_days, 'last_days'), unit: 'days' }
    }
    if (raw.time_from !== undefined) time.from = raw.time_from
    if (raw.time_until !== undefined) time.until = raw.time_until
    query.time = time
  } else if (raw.last_hours !== undefined || raw.last_days !== undefined
             || raw.time_from !== undefined || raw.time_until !== undefined) {
    throw new QueryParamError('time_basis is required when a time window is given')
  }

  if (raw.sort !== undefined) query.sort = raw.sort as TaskQuery['sort']
  if (raw.limit !== undefined) {
    if (!/^\d+$/.test(raw.limit)) {
      throw new QueryParamError(`limit must be an integer from 1 to ${MAX_QUERY_LIMIT}`)
    }
    query.limit = Number(raw.limit)
  }
  return query
}

// GET /api/tasks — list with optional filters (see parseTaskQueryParams)
// ?slim=1 — omit note and conversation_log fields (~400KB savings)
// ?fields=list — slim + drop summary/description/ext (home list payload)
tasksRouter.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const t0 = Date.now()
    const rawQuery = req.query as Record<string, unknown>

    let query: TaskQuery
    let isMinimal: boolean
    let isSlim: boolean
    try {
      const fields = queryString(rawQuery.fields, 'fields')
      // fields=list implies slim + drops summary/description/ext for the home
      // list payload (~2.6MB saved); the regular ?slim=1 path keeps them inline.
      isMinimal = fields === 'list'
      isSlim = queryString(rawQuery.slim, 'slim') === '1' || isMinimal
      query = parseTaskQueryParams(rawQuery)
    } catch (err) {
      if (err instanceof QueryParamError) { res.status(400).json({ error: err.message }); return }
      throw err
    }

    let queried: Task[] | SlimTask[]
    // Rows matched BEFORE `limit`, echoed back so a capped answer is detectable
    // (see the `total` / `truncated` fields on the response below).
    let total: number
    let truncated: boolean
    try {
      const page = isSlim
        ? await queryTasksSlimPage(query, { minimal: isMinimal })
        : await queryTasksPage(query)
      queried = page.tasks
      total = page.total
      truncated = page.truncated
    } catch (err) {
      if (err instanceof TaskQueryError) { res.status(400).json({ error: err.message }); return }
      throw err
    }
    const tList = Date.now()

    // enrichTasksWithSessionStatus reads session_id / session_ids / slot IDs
    // and writes session_status / plan_session_status / exec_session_status —
    // none of which overlap note/conversation_log. Safe to reuse on SlimTask
    // via a Task cast (the helper only reads/writes shared fields).
    const enriched = await enrichTasksWithSessionStatus(queried as unknown as Task[])
    const tEnrich = Date.now()
    const tasksWithBlocked = enriched.map((t) => ({
      ...t,
      ...(t.depends_on?.length ? { is_blocked: isTaskBlocked(t, enriched) } : {}),
    }))
    // `total` / `truncated` are additive: `tasks` keeps its exact old shape, and
    // a caller that passed no limit always sees truncated=false.
    //
    // A board read also gets the AUTHORITATIVE per-tier counts, so a caller that
    // buckets the rows itself can compare and notice a short list instead of
    // reporting it as the board. Only computed for working_set — it is a second
    // store read no other query needs.
    const board = query.workingSet === true ? await getBoardCounts() : undefined
    res.json({ tasks: tasksWithBlocked, total, truncated, ...(board ? { board } : {}) })
    const tDone = Date.now()
    const elapsed = tDone - t0
    if (elapsed > 200) {
      log.web.warn('GET /api/tasks slow', {
        totalMs: elapsed, queryMs: tList - t0, enrichMs: tEnrich - tList,
        serializeMs: tDone - tEnrich, taskCount: queried.length, slim: isSlim,
      })
    }
  } catch (err) {
    next(err)
  }
})

// GET /api/tasks/meta/tags — all unique tags with frequency counts (for autocomplete)
tasksRouter.get('/meta/tags', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const tags = await getAllTags()
    res.json({ tags })
  } catch (err) {
    next(err)
  }
})

// GET /api/tasks/meta/sprints — all unique sprint names with task counts
tasksRouter.get('/meta/sprints', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const tasks = (await listTasks({})).filter((t) => !t.title.startsWith('.metadata'))
    const sprintCounts = new Map<string, number>()
    for (const t of tasks) {
      if (t.sprint) {
        sprintCounts.set(t.sprint, (sprintCounts.get(t.sprint) ?? 0) + 1)
      }
    }
    const sprints = [...sprintCounts.entries()]
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count)
    res.json({ sprints })
  } catch (err) {
    next(err)
  }
})

// GET /api/tasks/enriched — tasks with computed fields
tasksRouter.get('/enriched', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const tasks = (await listTasks({})).filter((t) => !t.title.startsWith('.metadata'))
    const now = Date.now()

    const enriched = tasks.map((t) => {
      const overdue = t.due_date ? new Date(t.due_date).getTime() < now && t.status !== 'done' : false

      return {
        ...t,
        overdue,
      }
    })

    res.json({ tasks: enriched })
  } catch (err) {
    next(err)
  }
})

// GET /api/tasks/groups — list all virtual groups. MUST be registered before
// GET /:id below, or Express treats "groups" as a task id (returns 404).
tasksRouter.get('/groups', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    res.json({ groups: await listGroups() })
  } catch (err) {
    next(err)
  }
})

// POST /api/tasks/quick-parse — parse natural-language task metadata
tasksRouter.post('/quick-parse', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { text, timeZone } = req.body as { text?: unknown; timeZone?: unknown }
    if (typeof text !== 'string' || text.trim() === '') {
      res.status(400).json({ error: 'text must be a non-empty string' })
      return
    }
    if (text.length > 500) {
      res.status(400).json({ error: 'text must be at most 500 characters' })
      return
    }
    if (typeof timeZone !== 'string' || timeZone.length === 0 || timeZone.length > 64) {
      res.status(400).json({ error: 'timeZone must be a valid IANA timezone' })
      return
    }
    // Relative dates resolve against the browser's timezone, not the server's.
    try {
      new Intl.DateTimeFormat('en-US', { timeZone })
    } catch {
      res.status(400).json({ error: 'timeZone must be a valid IANA timezone' })
      return
    }

    const startedAt = Date.now()
    let projectDigest: ProjectDigest = { digest: '', projects: [] }
    try {
      projectDigest = await buildProjectDigest()
    } catch (err) {
      log.web.warn('quick-parse project digest unavailable', {
        error: err instanceof Error ? err.message : String(err),
      })
    }
    const { parse, parseMs, model } = await parseQuickTask(text, {
      timeZone,
      projectDigest: projectDigest.digest,
      knownProjects: projectDigest.projects,
      customTiers: await getCustomTiers(),
    })
    log.web.info('quick-parse', {
      parseMs,
      totalMs: Date.now() - startedAt,
      model,
      textLen: text.length,
    })
    res.json(parse)
  } catch (err) {
    next(err)
  }
})

// ─── Suggestion accuracy ledger ──────────────────────────────────────────────
// The draft column's background parse fills the launch pills while the user types.
// These two routes are the only way to tell whether it is any good: the client
// posts what was suggested vs. what the launch carried, and the summary turns it
// into per-field numbers. Registered BEFORE GET /:id, or Express reads the path as
// a task id.

/** Cap on entries per commit — seven fields exist; anything more is a client bug. */
const MAX_SUGGEST_ENTRIES = 20
/** Values are project names / tiers / dates / paths, never prose. */
const MAX_SUGGEST_VALUE_CHARS = 300

// POST /api/tasks/suggest-feedback — record one commit's suggested-vs-chosen pairs
tasksRouter.post('/suggest-feedback', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { surface, entries, textLen } = req.body as {
      surface?: unknown; entries?: unknown; textLen?: unknown
    }
    if (typeof surface !== 'string' || surface.trim() === '' || surface.length > 40) {
      res.status(400).json({ error: 'surface must be a short non-empty string' })
      return
    }
    if (!Array.isArray(entries) || entries.length > MAX_SUGGEST_ENTRIES) {
      res.status(400).json({ error: `entries must be an array of at most ${MAX_SUGGEST_ENTRIES} items` })
      return
    }
    // Unknown fields and over-long values are DROPPED, not 400: this is
    // best-effort telemetry riding a launch the user already committed, so a
    // client that learns a new field must never be able to fail the write.
    const clean: SuggestDiffEntry[] = []
    for (const raw of entries) {
      if (!raw || typeof raw !== 'object') continue
      const { field, suggested, chosen } = raw as Record<string, unknown>
      if (typeof field !== 'string' || !SUGGEST_FIELDS.includes(field as SuggestField)) continue
      if (typeof suggested !== 'string' || suggested === '' || suggested.length > MAX_SUGGEST_VALUE_CHARS) continue
      clean.push({
        field: field as SuggestField,
        suggested,
        ...(typeof chosen === 'string' && chosen.length <= MAX_SUGGEST_VALUE_CHARS ? { chosen } : {}),
      })
    }
    await recordSuggestDiff({
      surface: surface.trim(),
      entries: clean,
      ...(typeof textLen === 'number' && Number.isFinite(textLen) && textLen >= 0
        ? { textLen: Math.min(Math.round(textLen), 1_000_000) }
        : {}),
    })
    res.status(204).end()
  } catch (err) {
    next(err)
  }
})

// GET /api/tasks/suggest-accuracy?limit=N — per-field accuracy + the newest diffs
tasksRouter.get('/suggest-accuracy', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const raw = req.query.limit
    const limit = typeof raw === 'string' && /^\d+$/.test(raw) ? Number(raw) : 20
    res.json(await summarizeSuggestAccuracy(limit))
  } catch (err) {
    next(err)
  }
})

// GET /api/tasks/bulk?ids=a,b,c&fields=title,phase,progress — many tasks, few
// fields, ONE call. Declared BEFORE '/:id' or Express would read 'bulk' as an id.
//
// `fields` is a projection, not a hint: only the named fields come back, so a
// triage pass can ask for `progress` (the note's status bullets) without dragging
// the multi-KB Work Log along. An unresolvable id is a per-item error entry.
tasksRouter.get('/bulk', async (req: Request, res: Response, next: NextFunction) => {
  try {
    let ids: string[]
    let fields: string[] | undefined
    try {
      const rawIds = queryString(req.query.ids, 'ids')
      if (rawIds === undefined || csv(rawIds).filter(Boolean).length === 0) {
        throw new QueryParamError('ids is required — a comma list of task ids')
      }
      ids = csv(rawIds).filter(Boolean)
      const rawFields = queryString(req.query.fields, 'fields')
      fields = rawFields === undefined ? undefined : csv(rawFields).filter(Boolean)
    } catch (err) {
      if (err instanceof QueryParamError) { res.status(400).json({ error: err.message }); return }
      throw err
    }

    // ONE store read for the whole batch — that is the point of the route. Prefix
    // resolution needs every task anyway (an id may be a unique prefix).
    const allTasks = await listTasks({})
    let result: BulkGetResult
    try {
      result = bulkGetFromTasks(ids, allTasks, fields)
    } catch (err) {
      if (err instanceof BulkGetError) { res.status(400).json({ error: err.message }); return }
      throw err
    }
    res.json({ count: result.items.length, errors: result.errors, fields: result.fields, tasks: result.items })
  } catch (err) {
    next(err)
  }
})

// GET /api/tasks/board-counts — authoritative per-tier counts of the pinned board
tasksRouter.get('/board-counts', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    res.json(await getBoardCounts())
  } catch (err) {
    next(err)
  }
})

// GET /api/tasks/:id
tasksRouter.get('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = param(req.params.id)
    const task = await getTask(id)
    const [enriched] = await enrichTasksWithSessionStatus([task])
    const allTasks = await listTasks({})
    const taskWithDeps: Record<string, unknown> = { ...enriched }
    if (enriched.depends_on?.length) {
      taskWithDeps.is_blocked = isTaskBlocked(enriched, allTasks)
      taskWithDeps.resolved_dependencies = enriched.depends_on.map((depId: string) => {
        const dep = allTasks.find((t) => t.id === depId)
        return dep ? { id: dep.id, title: dep.title, phase: dep.phase } : { id: depId, title: '(not found)', phase: 'UNKNOWN' }
      })
    }
    const dependents = allTasks.filter((t) => t.depends_on?.includes(enriched.id))
    if (dependents.length > 0) {
      taskWithDeps.dependents = dependents.map((t) => ({ id: t.id, title: t.title, phase: t.phase }))
    }
    // Child tasks — handle both full-ID and prefix parent_task_id (legacy data)
    const children = allTasks.filter((t) => t.parent_task_id && enriched.id.startsWith(t.parent_task_id))
    if (children.length > 0) {
      taskWithDeps.children = children.map((t) => ({
        id: t.id, title: t.title, phase: t.phase, status: t.status, priority: t.priority,
      }))
    }
    // Parent task — resolve parent_task_id (may be prefix) to actual parent info
    if (enriched.parent_task_id) {
      const parent = allTasks.find((t) => t.id.startsWith(enriched.parent_task_id!))
      if (parent) {
        taskWithDeps.parent = { id: parent.id, title: parent.title, phase: parent.phase, status: parent.status }
      }
    }
    res.json({ task: taskWithDeps })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (msg.includes('No task found matching')) {
      res.status(404).json({ error: msg })
      return
    }
    next(err)
  }
})

// POST /api/tasks — create
tasksRouter.post('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { title, priority, status, pinned, focus_tier: focusTier } = req.body

    if (typeof title !== 'string' || title.trim() === '') {
      res.status(400).json({ error: 'title must be a non-empty string' })
      return
    }
    if (pinned !== undefined && typeof pinned !== 'boolean') {
      res.status(400).json({ error: 'pinned must be a boolean' })
      return
    }
    // null joins '' as "not specified" so a client can send its whole create
    // shape unconditionally (same tolerance the date fields have).
    if (focusTier !== undefined && focusTier !== null && typeof focusTier !== 'string') {
      res.status(400).json({ error: 'focus_tier must be a string ("" / null = not specified)' })
      return
    }
    if (priority !== undefined && !VALID_PRIORITIES.includes(priority)) {
      res.status(400).json({ error: `priority must be one of: ${VALID_PRIORITIES.join(', ')}` })
      return
    }
    if (status !== undefined && !VALID_STATUSES.includes(status)) {
      res.status(400).json({ error: `status must be one of: ${VALID_STATUSES.join(', ')}` })
      return
    }
    if (req.body.depends_on !== undefined) {
      if (!Array.isArray(req.body.depends_on) || !req.body.depends_on.every((d: unknown) => typeof d === 'string')) {
        res.status(400).json({ error: 'depends_on must be an array of strings' })
        return
      }
    }
    if (req.body.project !== undefined && typeof req.body.project !== 'string') {
      res.status(400).json({ error: 'project must be a string ("" = Inbox)' })
      return
    }
    // source is passed through to addTask; validation happens in task-manager against
    // the project registry (a claimed project's source wins; Inbox is local-only).
    // asyncPush: the web UI is optimistic (renders the task immediately), so don't block the
    // HTTP response on an external sync round-trip — push runs in the background and backfills
    // ext/sync_error via TASK_UPDATED. Local-source tasks never push regardless.
    // pinned: this is the human create surface (Quick Add, the calendar popover,
    // "create task for later"), so the task lands on the board in Satellite
    // unless the client said otherwise — see newTaskPinDefault.
    // focus_tier: passed EXPLICITLY (not left to the req.body spread) so the
    // create-time tier is part of this route's contract, and so the tier lands
    // in the SAME store write as the pin — a create-then-setFocusTier pair
    // silently drops the task out of the picked tier when the second write
    // fails. addTask (resolveNewTaskTier) owns the value rules; an unknown tier
    // or a pinned:false + tier contradiction throws InvalidFocusTierError → 400
    // below, never a silent fall-through to Satellite.
    const result = await addTask({
      ...req.body,
      pinned: newTaskPinDefault(pinned),
      // Overwrite whatever the spread carried (`null` is a legal "not
      // specified" on the wire but not a legal AddTaskInput value).
      focus_tier: typeof focusTier === 'string' ? focusTier : undefined,
      asyncPush: true,
    })
    log.web.info('task created via REST', { taskId: result.task.id, project: result.task.project || '' })
    bus.emit(EventNames.TASK_CREATED, { task: result.task }, ['web-ui', 'main-agent'], { source: 'api' })
    res.status(201).json(result)
  } catch (err) {
    if (err instanceof ProjectSourceConflictError) {
      res.status(409).json({
        error: err.message,
        project: err.project,
        intended_source: err.intendedSource,
        existing_source: err.existingSource,
      })
      return
    }
    if (err instanceof InvalidProjectNameError) {
      res.status(400).json({ error: err.message, project: err.project })
      return
    }
    if (err instanceof InvalidFocusTierError) {
      res.status(400).json({ error: err.message, focus_tier: err.tier })
      return
    }
    next(err)
  }
})

// PATCH /api/tasks/reorder — reorder tasks within ONE project group.
// `project: ''` is valid and means Inbox (the single grouping layer is optional),
// so the guard is a type check, NOT a truthiness check.
// (Must be before /:id to avoid matching "reorder" as an ID)
tasksRouter.patch('/reorder', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { project, taskIds } = req.body as { project: string; taskIds: string[] }

    if (typeof project !== 'string') {
      res.status(400).json({ error: "project must be a string ('' = Inbox)" })
      return
    }
    if (!Array.isArray(taskIds) || taskIds.length === 0 || !taskIds.every((id: unknown) => typeof id === 'string')) {
      res.status(400).json({ error: 'taskIds must be a non-empty array of strings' })
      return
    }

    await reorderTasks(project, taskIds)
    bus.emit(EventNames.TASK_REORDERED, { project, taskIds }, ['web-ui'], { source: 'api' })
    res.json({ ok: true })
  } catch (err) {
    next(err)
  }
})

// ── Batch (multi-select) operations ──
// Registered BEFORE the `/:id` routes so Express doesn't read "batch" as a task id
// (same reason the `/groups…` paths sit above `/:id`).
//
// Both endpoints are PARTIAL-SUCCESS by design: they always return 200 with
// { changed|deleted, failed[] }. A single un-completable task (active children) or
// busy task (active session) must not void the other 9 the user picked. The client
// applies `changed`/`deleted` and surfaces `failed` as a warning.

/** Validate a batch body's task_ids array. Returns the ids, or null after replying 400. */
function batchIds(req: Request, res: Response): string[] | null {
  const { task_ids: taskIds } = req.body as { task_ids?: unknown }
  if (!Array.isArray(taskIds) || taskIds.length === 0 || !taskIds.every((id) => typeof id === 'string')) {
    res.status(400).json({ error: 'task_ids must be a non-empty array of strings' })
    return null
  }
  return taskIds as string[]
}

// POST /api/tasks/batch/phase — set the phase of many tasks in one store write
tasksRouter.post('/batch/phase', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const taskIds = batchIds(req, res)
    if (!taskIds) return
    const { phase } = req.body as { phase?: string }
    if (typeof phase !== 'string' || !VALID_PHASES.has(phase)) {
      res.status(400).json({ error: `phase must be one of: ${VALID_PHASES_ARRAY.join(', ')}` })
      return
    }

    const { changed, failed, syncFailed } = await setPhaseBulk(taskIds, phase as Task['phase'])
    log.web.info('tasks batch phase via REST', { count: taskIds.length, changed: changed.length, failed: failed.length, syncFailed: syncFailed.length, phase })

    // Per-task events so every surface (web-ui lists, main-agent) reconciles the
    // same way it does for a single complete — the bulk `{ }` form would force a
    // full refetch and blank the list mid-animation.
    const eventName = phase === 'COMPLETE' ? EventNames.TASK_COMPLETED : EventNames.TASK_UPDATED
    for (const task of changed) {
      bus.emit(eventName, { task }, ['web-ui', 'main-agent'], { source: 'api' })
    }
    // syncFailed is reported separately from failed — those tasks DID change locally,
    // only their external push failed, so the client must not roll them back.
    res.json({ changed, failed, syncFailed })
  } catch (err) {
    next(err)
  }
})

// POST /api/tasks/batch/delete — delete many tasks in one store write.
// POST (not DELETE) because the id list travels in the body; DELETE-with-body is
// poorly supported across proxies/clients.
tasksRouter.post('/batch/delete', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const taskIds = batchIds(req, res)
    if (!taskIds) return
    const force = req.body?.force === true || req.query.force === 'true'

    const { deleted, failed } = await deleteTasksByIds(taskIds, { force })
    log.web.info('tasks batch delete via REST', { count: taskIds.length, deleted: deleted.length, failed: failed.length, force })

    for (const task of deleted) {
      bus.emit(EventNames.TASK_DELETED, { id: task.id, task }, ['web-ui', 'main-agent'], { source: 'api' })
    }
    res.json({ deleted, failed })
  } catch (err) {
    next(err)
  }
})

// ── Virtual task groups ──
// NOTE: the POST/PATCH `/groups…` paths are registered before the POST/PATCH
// `/:id` routes below so Express doesn't treat "groups" as a task id. The
// GET `/groups` listing is registered separately, above GET `/:id` (search for
// "GET /api/tasks/groups — list" earlier in this file), for the same reason.

// POST /api/tasks/groups — create a group from ≥2 tasks
tasksRouter.post('/groups', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { task_ids, label } = req.body as { task_ids?: string[]; label?: string }
    if (!Array.isArray(task_ids) || task_ids.length < 2 || !task_ids.every((id) => typeof id === 'string')) {
      res.status(400).json({ error: 'task_ids must be an array of at least 2 task id strings' })
      return
    }
    const result = await groupTasks(task_ids, label)
    bus.emit(EventNames.TASK_GROUPS_CHANGED, { group_id: result.group_id, label: result.label }, ['web-ui', 'main-agent'], { source: 'api' })
    // Refine the AI label in the background when the caller didn't supply one.
    if (!label?.trim()) {
      const gid = result.group_id
      const ids = result.member_ids
      void (async () => {
        try {
          const titles: string[] = []
          for (const id of ids) {
            try { titles.push((await getTask(id)).title) } catch { /* skip */ }
          }
          const { summarizeGroupLabel } = await import('../../core/fork-title.js')
          const aiLabel = await summarizeGroupLabel(titles)
          if (!aiLabel) return
          const r = await renameGroup(gid, aiLabel)
          bus.emit(EventNames.TASK_GROUPS_CHANGED, { group_id: r.group_id, label: r.label }, ['web-ui', 'main-agent'], { source: 'api' })
        } catch (err) {
          log.web.warn('group label refine failed', { groupId: gid, error: err instanceof Error ? err.message : String(err) })
        }
      })()
    }
    res.json(result)
  } catch (err) {
    sendFolderError(res, err)
  }
})

// POST /api/tasks/groups/:groupId/add — add tasks to a group
tasksRouter.post('/groups/:groupId/add', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const groupId = param(req.params.groupId)
    const { task_ids } = req.body as { task_ids?: string[] }
    if (!Array.isArray(task_ids) || task_ids.length < 1 || !task_ids.every((id) => typeof id === 'string')) {
      res.status(400).json({ error: 'task_ids must be a non-empty array of task id strings' })
      return
    }
    const result = await addToGroup(groupId, task_ids)
    bus.emit(EventNames.TASK_GROUPS_CHANGED, { group_id: result.group_id, label: result.label }, ['web-ui', 'main-agent'], { source: 'api' })
    res.json(result)
  } catch (err) {
    sendFolderError(res, err)
  }
})

// POST /api/tasks/groups/remove — remove tasks from their group(s)
tasksRouter.post('/groups/remove', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { task_ids } = req.body as { task_ids?: string[] }
    if (!Array.isArray(task_ids) || task_ids.length < 1 || !task_ids.every((id) => typeof id === 'string')) {
      res.status(400).json({ error: 'task_ids must be a non-empty array of task id strings' })
      return
    }
    const result = await removeFromGroup(task_ids)
    bus.emit(EventNames.TASK_GROUPS_CHANGED, { dissolved_group_ids: result.dissolved_group_ids }, ['web-ui', 'main-agent'], { source: 'api' })
    res.json(result)
  } catch (err) {
    next(err)
  }
})

// PATCH /api/tasks/groups/:groupId — rename a group
tasksRouter.patch('/groups/:groupId', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const groupId = param(req.params.groupId)
    const { label } = req.body as { label?: string }
    if (typeof label !== 'string' || !label.trim()) {
      res.status(400).json({ error: 'label must be a non-empty string' })
      return
    }
    const result = await renameGroup(groupId, label)
    bus.emit(EventNames.TASK_GROUPS_CHANGED, { group_id: result.group_id, label: result.label }, ['web-ui', 'main-agent'], { source: 'api' })
    res.json(result)
  } catch (err) {
    next(err)
  }
})

// PATCH /api/tasks/groups/:groupId/hidden — show/hide a group in the Focus area.
// Registered as a distinct 3-segment path so it isn't shadowed by the 2-segment
// rename route above (`/groups/:groupId`).
tasksRouter.patch('/groups/:groupId/hidden', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const groupId = param(req.params.groupId)
    const { hidden } = req.body as { hidden?: boolean }
    if (typeof hidden !== 'boolean') {
      res.status(400).json({ error: 'hidden must be a boolean' })
      return
    }
    const result = await setGroupHidden(groupId, hidden)
    bus.emit(EventNames.TASK_GROUPS_CHANGED, { group_id: result.group_id, hidden: result.hidden }, ['web-ui', 'main-agent'], { source: 'api' })
    res.json(result)
  } catch (err) {
    next(err)
  }
})

// ── Folders (the group model's v9 face: per-project, nestable, empty-valid) ──

/** Folder op errors: unknown ids → 404, everything else (same-project rule,
 *  nesting depth/cycle, empty label) is caller-fixable → 400. */
function sendFolderError(res: Response, err: unknown): void {
  const msg = err instanceof Error ? err.message : String(err)
  res.status(/not found/i.test(msg) ? 404 : 400).json({ error: msg })
}

// POST /api/tasks/folders — create an EMPTY folder under a project ('' = Inbox),
// optionally nested via parent_id. The "project + → New folder" entry point.
tasksRouter.post('/folders', async (req: Request, res: Response) => {
  try {
    const { label, project, parent_id } = req.body as { label?: string; project?: string; parent_id?: string }
    if (typeof label !== 'string' || !label.trim()) {
      res.status(400).json({ error: 'label must be a non-empty string' })
      return
    }
    if (typeof project !== 'string') {
      res.status(400).json({ error: "project must be a string ('' = Inbox)" })
      return
    }
    if (parent_id !== undefined && typeof parent_id !== 'string') {
      res.status(400).json({ error: 'parent_id must be a string when provided' })
      return
    }
    const result = await createFolder(label, project, parent_id)
    bus.emit(EventNames.TASK_GROUPS_CHANGED, { group_id: result.group_id, label: result.label }, ['web-ui', 'main-agent'], { source: 'api' })
    res.status(201).json(result)
  } catch (err) {
    sendFolderError(res, err)
  }
})

// PATCH /api/tasks/folders/:groupId — move a folder in the nesting tree.
// Body: { parent_id: string | null } (null = make it top-level).
tasksRouter.patch('/folders/:groupId', async (req: Request, res: Response) => {
  try {
    const groupId = param(req.params.groupId)
    const { parent_id } = req.body as { parent_id?: string | null }
    if (parent_id !== null && typeof parent_id !== 'string') {
      res.status(400).json({ error: 'parent_id must be a string or null' })
      return
    }
    const result = await setFolderParent(groupId, parent_id)
    bus.emit(EventNames.TASK_GROUPS_CHANGED, { group_id: result.group_id }, ['web-ui', 'main-agent'], { source: 'api' })
    res.json(result)
  } catch (err) {
    sendFolderError(res, err)
  }
})

// DELETE /api/tasks/folders/:groupId — delete a folder. Consequence-free:
// members fall back to the project in place, child folders re-parent, no task
// is ever deleted.
tasksRouter.delete('/folders/:groupId', async (req: Request, res: Response) => {
  try {
    const groupId = param(req.params.groupId)
    const result = await deleteFolder(groupId)
    bus.emit(EventNames.TASK_GROUPS_CHANGED, { dissolved_group_ids: [result.group_id] }, ['web-ui', 'main-agent'], { source: 'api' })
    res.json(result)
  } catch (err) {
    sendFolderError(res, err)
  }
})

// PUT /api/tasks/:id/plugin-field — set a plugin-declared task field
// (manifest taskFields). Body: { pluginId, key, value } — value null/'' clears.
// Generic UI path: the kebab menu's per-plugin field pickers write here; the
// plugin's own push logic translates the stored value for its remote API.
tasksRouter.put('/:id/plugin-field', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = param(req.params.id)
    const { pluginId, key, value } = (req.body ?? {}) as { pluginId?: unknown; key?: unknown; value?: unknown }
    if (typeof pluginId !== 'string' || !pluginId || typeof key !== 'string' || !key) {
      res.status(400).json({ error: 'pluginId and key are required strings' })
      return
    }
    if (value !== null && value !== undefined && typeof value !== 'string') {
      res.status(400).json({ error: 'value must be a string or null' })
      return
    }
    const result = await setPluginTaskField(id, pluginId, key, (value as string | null | undefined) ?? null)
    log.web.info('plugin task field set via REST', { taskId: id, pluginId, key, cleared: !value })
    res.json({ task: result.task })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (/does not declare|not clearable/.test(message)) {
      res.status(400).json({ error: message })
      return
    }
    if (/No task found/.test(message)) {
      res.status(404).json({ error: message })
      return
    }
    next(err)
  }
})

// PATCH /api/tasks/:id — update fields
tasksRouter.patch('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = param(req.params.id)
    if (req.body.priority !== undefined && !VALID_PRIORITIES.includes(req.body.priority)) {
      res.status(400).json({ error: `priority must be one of: ${VALID_PRIORITIES.join(', ')}` })
      return
    }
    if (req.body.phase !== undefined && !VALID_PHASES.has(req.body.phase)) {
      res.status(400).json({ error: `phase must be one of: ${VALID_PHASES_ARRAY.join(', ')}` })
      return
    }
    if (req.body.unread !== undefined && typeof req.body.unread !== 'boolean') {
      res.status(400).json({ error: 'unread must be a boolean' })
      return
    }
    if (req.body.walnut_agent !== undefined && typeof req.body.walnut_agent !== 'boolean') {
      res.status(400).json({ error: 'walnut_agent must be a boolean' })
      return
    }
    if (req.body.parent_task_id !== undefined && typeof req.body.parent_task_id !== 'string') {
      res.status(400).json({ error: 'parent_task_id must be a string (task ID or empty string to remove)' })
      return
    }
    // Tag validation
    for (const field of ['add_tags', 'remove_tags', 'set_tags'] as const) {
      if (req.body[field] !== undefined) {
        if (!Array.isArray(req.body[field]) || !req.body[field].every((t: unknown) => typeof t === 'string')) {
          res.status(400).json({ error: `${field} must be an array of strings` })
          return
        }
      }
    }
    // Sprint validation
    if (req.body.sprint !== undefined && typeof req.body.sprint !== 'string') {
      res.status(400).json({ error: 'sprint must be a string (sprint name or empty string to clear)' })
      return
    }
    if (req.body.project !== undefined && typeof req.body.project !== 'string') {
      res.status(400).json({ error: 'project must be a string ("" = Inbox)' })
      return
    }
    // Dependency validation
    for (const field of ['add_depends_on', 'remove_depends_on', 'set_depends_on'] as const) {
      if (req.body[field] !== undefined) {
        if (!Array.isArray(req.body[field]) || !req.body[field].every((d: unknown) => typeof d === 'string')) {
          res.status(400).json({ error: `${field} must be an array of strings` })
          return
        }
      }
    }
    // asyncPush: the UI's PATCH must ack as soon as the local write lands — awaiting
    // the external sync round-trip (2-3s each) held browser connections long enough
    // to saturate the 6-per-origin pool and time out every other request (2026-07-31).
    // Push failures still surface via sync_error + TASK_UPDATED, which the UI renders.
    // Phase-transition automation rides the task:phase-changed bus event emitted
    // inside updateTask — no inline executor.
    const result = await updateTask(id, req.body, { source: 'api', extraTargets: ['main-agent'], asyncPush: true })
    log.web.info('task updated via REST', { taskId: id, fields: Object.keys(req.body) })

    res.json(result)
  } catch (err) {
    if (err instanceof ProjectSourceConflictError) {
      res.status(409).json({
        error: err.message,
        project: err.project,
        intended_source: err.intendedSource,
        existing_source: err.existingSource,
      })
      return
    }
    if (err instanceof InvalidProjectNameError) {
      res.status(400).json({ error: err.message, project: err.project })
      return
    }
    if (err instanceof ActiveChildrenError) {
      res.status(409).json({ error: err.message, active_children: err.activeCount })
      return
    }
    if (err instanceof CircularDependencyError) {
      res.status(409).json({ error: err.message, task_id: err.taskId, dep_id: err.depId })
      return
    }
    next(err)
  }
})

// POST /api/tasks/:id/complete
tasksRouter.post('/:id/complete', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = param(req.params.id)
    const result = await completeTask(id)
    log.web.info('task completed via REST', { taskId: id })
    bus.emit(EventNames.TASK_COMPLETED, { task: result.task }, ['web-ui', 'main-agent'], { source: 'api' })
    res.json(result)
  } catch (err) {
    if (err instanceof ActiveChildrenError) {
      res.status(409).json({ error: err.message, active_children: err.activeCount })
      return
    }
    next(err)
  }
})

// POST /api/tasks/:id/merge — merge duplicate tasks INTO :id (the survivor).
// Session links are the point: victims' session_ids/slots union into the
// survivor and sessions.task_id rows are re-pointed BEFORE the victim rows
// disappear. This is the sanctioned dedup path — a bare DELETE on a duplicate
// drops whichever links that copy held (the H-1B RFE incident).
tasksRouter.post('/:id/merge', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const survivorPrefix = param(req.params.id)
    const victims: unknown = req.body?.victim_ids
    if (!Array.isArray(victims) || victims.length === 0 || !victims.every((v) => typeof v === 'string' && v.trim())) {
      res.status(400).json({ error: 'victim_ids must be a non-empty array of task ids' })
      return
    }
    // Resolve prefixes → full ids up front (getTask throws on unknown/ambiguous).
    const survivor = await getTask(survivorPrefix)
    const victimTasks = []
    for (const v of victims) victimTasks.push(await getTask(v))
    if (victimTasks.some((t) => t.id === survivor.id)) {
      res.status(400).json({ error: 'survivor cannot be one of the victims' })
      return
    }
    let sessionsRelinked = 0
    for (const victim of victimTasks) {
      const result = await mergeTaskInto(survivor.id, victim.id)
      sessionsRelinked += result.sessionsRelinked
    }
    const merged = await getTask(survivor.id)
    log.web.info('tasks merged via REST', {
      survivorId: survivor.id, victimIds: victimTasks.map((t) => t.id), sessionsRelinked,
    })
    res.json({ task: merged, merged: victimTasks.length, sessions_relinked: sessionsRelinked })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (msg.includes('No task found matching')) {
      res.status(404).json({ error: msg })
      return
    }
    if (msg.includes('Ambiguous ID prefix')) {
      res.status(400).json({ error: msg })
      return
    }
    next(err)
  }
})

// POST /api/tasks/:id/toggle-complete
tasksRouter.post('/:id/toggle-complete', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = param(req.params.id)
    const result = await toggleComplete(id)
    res.json(result)
  } catch (err) {
    if (err instanceof ActiveChildrenError) {
      res.status(409).json({ error: err.message, active_children: err.activeCount })
      return
    }
    next(err)
  }
})

// DELETE /api/tasks/:id — delete a task (blocked if active sessions exist, unless ?force=true)
tasksRouter.delete('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = param(req.params.id)
    const force = req.query.force === 'true'
    try {
      const result = await deleteTask(id)
      log.web.info('task deleted via REST', { taskId: id })
      bus.emit(EventNames.TASK_DELETED, { id: result.task.id, task: result.task }, ['web-ui', 'main-agent'], { source: 'api' })
      res.status(204).end()
    } catch (err) {
      if (err instanceof ActiveSessionError && force) {
        // Force mode: stop sessions and retry
        const { completeTaskSessions } = await import('../../core/session-tracker.js')
        const { clearSessionSlot } = await import('../../core/task-manager.js')
        await completeTaskSessions(err.activeSessionIds)
        for (const sid of err.activeSessionIds) {
          try { await clearSessionSlot(id, sid) } catch { /* best-effort */ }
        }
        const result = await deleteTask(id)
        log.web.info('task force-deleted via REST (stopped sessions)', { taskId: id, stoppedSessions: err.activeSessionIds.length })
        bus.emit(EventNames.TASK_DELETED, { id: result.task.id, task: result.task }, ['web-ui', 'main-agent'], { source: 'api' })
        res.status(204).end()
        return
      }
      if (err instanceof ActiveSessionError) {
        res.status(409).json({
          error: `Cannot delete task: has active sessions: ${err.activeSessionIds.join(', ')}`,
          active_session_ids: err.activeSessionIds,  // kept for API compat
        })
        return
      }
      throw err
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (msg.includes('No task found matching')) {
      res.status(404).json({ error: msg })
      return
    }
    next(err)
  }
})

// POST /api/tasks/:id/notes
tasksRouter.post('/:id/notes', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = param(req.params.id)
    const { content } = req.body as { content: string }
    const result = await addNote(id, content)
    res.json(result)
  } catch (err) {
    next(err)
  }
})

// PUT /api/tasks/:id/note — replace entire note
tasksRouter.put('/:id/note', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = param(req.params.id)
    const { content } = req.body as { content: string }
    const result = await updateNote(id, content)
    res.json(result)
  } catch (err) {
    next(err)
  }
})

// PUT /api/tasks/:id/description — update description
tasksRouter.put('/:id/description', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = param(req.params.id)
    const { content } = req.body as { content: string }
    const result = await updateDescription(id, content)
    res.json(result)
  } catch (err) {
    next(err)
  }
})

// PUT /api/tasks/:id/summary — update summary
tasksRouter.put('/:id/summary', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = param(req.params.id)
    const { content } = req.body as { content: string }
    const result = await updateSummary(id, content)
    res.json(result)
  } catch (err) {
    next(err)
  }
})

// PUT /api/tasks/:id/depends-on — set dependencies directly
tasksRouter.put('/:id/depends-on', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = param(req.params.id)
    const { depends_on } = req.body as { depends_on: string[] }
    if (!Array.isArray(depends_on) || !depends_on.every((d: unknown) => typeof d === 'string')) {
      res.status(400).json({ error: 'depends_on must be an array of strings' })
      return
    }
    const result = await updateTask(id, { set_depends_on: depends_on }, { source: 'api', extraTargets: ['main-agent'] })
    res.json(result)
  } catch (err) {
    if (err instanceof CircularDependencyError) {
      res.status(409).json({ error: err.message, task_id: err.taskId, dep_id: err.depId })
      return
    }
    next(err)
  }
})
