/**
 * Task ops — ported byte-compatible from the original hand-written MCP tools
 * (same names, same descriptions, same result shapes), now declared once for
 * every surface (MCP / CLI / gateway).
 */

import { z } from 'zod'
import { defineOp, type HttpBinding } from './registry.js'
import { materializeBinding } from './executor.js'
import { taskRefTag } from '../utils/entity-refs.js'
import { TASK_IS_INERT, REPLY_ARRIVES_HINT, dispatchHint, withOutcome } from './outcome.js'
import { PHASE_ORDER } from '../core/phase.js'
import {
  BULK_GET_FIELDS,
  BULK_GET_FIELD_GROUPS,
  DEFAULT_BULK_GET_FIELDS,
  MAX_BULK_GET_IDS,
} from '../core/task-bulk-get.js'

const PRIORITY = z.enum(['immediate', 'important', 'backlog', 'none'])
const STATUS = z.enum(['todo', 'in_progress', 'done'])
// Derived from PHASE_ORDER, never a hardcoded copy: phase.ts is the ONE place
// the lifecycle is declared, so adding/renaming a phase there reaches every
// surface (MCP tool schema, CLI help, gateway) without a second edit.
const TASK_PHASE = z.enum(PHASE_ORDER)

const REF_INSTRUCTION =
  'Include the `ref` string verbatim in your reply to the user so Walnut renders a clickable task pill.'

/** Attach the ref tag + paste instruction to a task-mutating result. */
function withRef(task: unknown, extra: Record<string, unknown> = {}): Record<string, unknown> {
  const t = (task ?? {}) as { id?: unknown; title?: unknown }
  const id = typeof t.id === 'string' ? t.id : ''
  const title = typeof t.title === 'string' ? t.title : ''
  return { ...extra, task, ref: taskRefTag(id, title), instruction: REF_INSTRUCTION }
}

/** Task id out of a v1 task body, for the outcome lines. */
function taskId(task: unknown): string {
  const id = (task as { id?: unknown } | undefined)?.id
  return typeof id === 'string' ? id : ''
}

/** Does this task body show a session attached? Absent field → assume none. */
function hasSession(task: unknown): boolean {
  const t = (task ?? {}) as { session_id?: unknown; session_ids?: unknown }
  if (typeof t.session_id === 'string' && t.session_id) return true
  return Array.isArray(t.session_ids) && t.session_ids.length > 0
}

const SORT = z.enum(['updated_desc', 'created_desc', 'completed_desc', 'priority', 'title_asc', 'pin_order'])
const TIME_BASIS = z.enum(['created', 'updated', 'created_or_updated', 'due', 'completed'])

/**
 * Page size task_list applies when the caller named no limit. NOT a zod
 * `.default()`: a schema default is injected before the handler can see whether
 * this is a board read, which is exactly how working_set=true silently came back
 * capped at 50 rows of a 120-row board (2026-08-30 regression).
 */
const DEFAULT_TASK_LIST_LIMIT = 50

// Server-root-absolute: /api/tasks is the canonical composable-query route (the
// same engine the web UI filters ride), not the frozen /api/v1 mobile projection.
const TASK_LIST_BINDING: HttpBinding = { method: 'GET', path: '/api/tasks' }

defineOp({
  name: 'task_list',
  title: 'List / query Walnut tasks',
  description:
    'Query the user\'s tasks with any combination of filters (fields AND together; comma lists OR ' +
    'within a field). No status default (completed tasks included), but limit defaults to 50 — narrow ' +
    'with filters or raise limit (max 200) instead of paging by hand. ' +
    'Working set (the pinned board): pass working_set=true to get the WHOLE board (no default limit, ' +
    'however many pins there are) in board order, each row carrying focus_tier + pin_order — an absent ' +
    'focus_tier on a pinned row means the Satellite (default) tier. focus_tier filters match pinned rows ' +
    'only: "satellite" matches pinned rows with no ' +
    'stored tier; focus/backlog/wait/ct_* match exactly. Time windows: time_basis + a window. last_hours/' +
    'last_days look BACKWARD from now — for upcoming deadlines use time_basis=due with time_from/' +
    'time_until (bare YYYY-MM-DD accepted; until is exclusive). basis "completed" finds recently ' +
    'finished work. Returns { count, total, truncated, tasks } with slim rows: count = rows returned, ' +
    'total = rows that matched before the limit, truncated = true when total > count (there ARE more ' +
    'rows — never read a truncated result as the full picture; narrow the filters or raise limit). ' +
    'working_set also returns `board`: the server\'s own pinned counts (pinned_total/active/completed ' +
    'plus per-tier total/active/completed) — check your own per-tier bucketing against it before ' +
    'reporting a board. Use task_get for full detail on one task, or task_get_bulk for many tasks with ' +
    'chosen fields.',
  input: {
    status: STATUS.optional().describe('Legacy 3-state: todo | in_progress | done'),
    completion: z.string().optional().describe('Comma list of todo | in_progress | complete (in_progress includes AGENT_COMPLETE)'),
    phases: z.string().optional().describe(`Comma list of exact phases: ${PHASE_ORDER.join(' | ')}`),
    project: z.string().optional().describe('Project name (exact, case-insensitive); "" for the Inbox'),
    projects: z.string().optional().describe('Comma list of project names'),
    priorities: z.string().optional().describe('Comma list of immediate | important | backlog | none'),
    source: z.string().optional().describe('Task source (exact), e.g. "local"'),
    sprint: z.string().optional().describe('Sprint name (exact)'),
    tag: z.string().optional().describe('Exact tag match (single)'),
    tags_any: z.string().optional().describe('Comma list — match tasks carrying ANY of these tags'),
    tags_all: z.string().optional().describe('Comma list — match tasks carrying ALL of these tags'),
    pinned: z.boolean().optional().describe('Filter pinned/unpinned tasks'),
    focus_tier: z.string().optional().describe('Comma list of pin tiers: focus | satellite | backlog | wait | a custom ct_* id. Only pinned tasks match; satellite = pinned with no stored tier'),
    working_set: z.boolean().optional().describe('Shortcut: the WHOLE pinned board (all tiers, completed pins included) sorted by pin_order — no default limit, so the board is never silently cut'),
    unread: z.boolean().optional().describe('Tasks with agent output the human has not opened yet'),
    blocked: z.boolean().optional().describe('Tasks blocked/unblocked by incomplete dependencies'),
    parent_task_id: z.string().optional().describe('Children of this parent task (exact id)'),
    group_id: z.string().optional().describe('Members of a virtual group (exact id, e.g. "g_xxx")'),
    q: z.string().optional().describe('Case-insensitive substring on the task title'),
    ids: z.string().optional().describe('Comma list of exact task ids — fetch a specific set in one call'),
    time_basis: TIME_BASIS.optional().describe('Which timestamp the window filters: created | updated | created_or_updated | due | completed'),
    last_hours: z.number().int().positive().optional().describe('Relative window: the last N hours'),
    last_days: z.number().int().positive().optional().describe('Relative window: the last N days'),
    time_from: z.string().optional().describe('Absolute window start (inclusive), ISO-8601 or YYYY-MM-DD'),
    time_until: z.string().optional().describe('Absolute window end (exclusive), ISO-8601 or YYYY-MM-DD'),
    sort: SORT.optional().describe('Result order (default updated_desc; working_set defaults to pin_order)'),
    // Optional in the SCHEMA, defaulted in the handler: the full store is
    // thousands of rows and several MB, so an unfiltered reply still gets a
    // page size — but working_set means "the whole board", and a zod default
    // would cap it before the handler could tell the two apart.
    limit: z.number().int().min(1).max(200).optional().describe(`Max rows (1-200), applied after sort. Default ${DEFAULT_TASK_LIST_LIMIT}, EXCEPT working_set=true which returns the whole board unless you pass a limit`),
    fields: z.enum(['list', 'full']).default('list').describe('list = slim rows (default); full = every field including note (heavy — combine with ids or a small limit)'),
  },
  // Declared so the route-parity test and the generated docs keep pointing at
  // the real route; the handler below is what actually executes (it needs to
  // decide the limit from the args first).
  bind: TASK_LIST_BINDING,
  handler: async (args, call) => {
    // The board shortcut is exempt from the page-size default BY CONTRACT: a
    // partial board reads as "these are all your pinned tasks", which is a wrong
    // answer, not a small one. An explicit limit is still honored.
    const effective: Record<string, unknown> = { ...args }
    if (effective.limit === undefined && args.working_set !== true) {
      effective.limit = DEFAULT_TASK_LIST_LIMIT
    }
    const { path } = materializeBinding(TASK_LIST_BINDING, effective)
    const body = await call('GET', path) as
      { tasks?: unknown[]; total?: unknown; board?: unknown } | undefined
    const tasks = body?.tasks
    // An unexpected 200 body (a proxy's HTML page, a shape change) must not
    // read as "you have 0 tasks" — pass it through so the caller sees it.
    if (!Array.isArray(tasks)) return body
    // total comes from the server (rows matched before the limit). A server too
    // old to send it can only be reported as "no more than what you got".
    const total = typeof body?.total === 'number' ? body.total : tasks.length
    const truncated = total > tasks.length
    return {
      count: tasks.length,
      total,
      truncated,
      // Board reads carry the server's own per-tier counts — check your bucketing
      // against them before reporting a board.
      ...(body?.board ? { board: body.board } : {}),
      ...(truncated
        ? {
          hint: `Showing ${tasks.length} of ${total} matching tasks — this result is CUT. `
            + 'Narrow the filters or raise limit (max 200) before drawing any conclusion from it.',
        }
        : {}),
      tasks,
    }
  },
  tags: { readonly: true, remote: 'allow' },
})

defineOp({
  name: 'task_get',
  title: 'Get one Walnut task',
  description:
    'Full detail for one task — including description, note, summary, session_ids, and ' +
    'dependency/child/parent decorations that the list view omits. The id accepts a unique prefix.',
  input: {
    id: z.string().min(1).describe('Task id or a unique id prefix'),
  },
  bind: { method: 'GET', path: '/tasks/:id' },
  // A bare phase word ("todo") reads as "queued for execution" in most agent
  // frameworks. Say the part the word hides: whether a session is attached.
  mapResult: ({ body, args }) => {
    const b = (body ?? {}) as Record<string, unknown>
    const task = (b.task ?? b) as Record<string, unknown>
    const phase = typeof task.phase === 'string' ? task.phase
      : typeof task.status === 'string' ? task.status : 'unknown'
    const attached = hasSession(task)
    const id = taskId(task) || String(args.id ?? '')
    return withOutcome(
      { ...b },
      attached
        ? `Phase ${phase}, with a session attached — that session is where the work lives.`
        : `Phase ${phase}, and NO session is attached: nothing is working on this task. ${TASK_IS_INERT}`,
      attached
        ? 'Read what it did with session_transcript, or add context with session_send '
          + `'{"to":"${id}","text":"..."}'.`
        : dispatchHint(id),
    )
  },
  tags: { readonly: true, remote: 'allow' },
})

defineOp({
  name: 'task_get_bulk',
  title: 'Get many Walnut tasks with chosen fields',
  description:
    'Read up to 50 tasks in ONE call, returning only the fields you name — the triage counterpart to '
    + 'task_get (which answers one task in full). Use this for a board or project review instead of a '
    + 'task_get per row. `fields` is a projection: '
    + `${BULK_GET_FIELDS.join(', ')}, plus the group alias "dates" (`
    + `${BULK_GET_FIELD_GROUPS.dates.join(', ')}). Omitted fields default to `
    + `${DEFAULT_BULK_GET_FIELDS.join(', ')}. `
    + '"progress" is DERIVED: just the note\'s Progress bullets as { status, text } rows (status is '
    + 'DONE | WIP | WAIT | TODO | BLOCKED) plus progress_counts — the state of the work WITHOUT the '
    + 'multi-KB Work Log, so ask for progress rather than note. Rows come back in the order the ids '
    + 'were given, and an id that matches nothing (or several tasks) becomes an { id, error } entry '
    + 'instead of failing the whole call — check `errors` in the result.',
  input: {
    ids: z.array(z.string().min(1)).min(1).max(MAX_BULK_GET_IDS)
      .describe(`Task ids (exact, or a unique id prefix) — 1 to ${MAX_BULK_GET_IDS} per call`),
    fields: z.array(z.string().min(1)).optional()
      .describe(`Fields to return: ${BULK_GET_FIELDS.join(' | ')} | dates. Omit for the triage default (${DEFAULT_BULK_GET_FIELDS.join(', ')})`),
  },
  // Same server-root-absolute family as task_list: /api/tasks is the canonical
  // task query surface. Arrays materialize as comma lists in the query string.
  bind: { method: 'GET', path: '/api/tasks/bulk' },
  tags: { readonly: true, remote: 'allow' },
})

defineOp({
  name: 'task_create',
  title: 'Create a Walnut task',
  description:
    'Record a task. Creating a task starts NOTHING: a task is an inert record, and only a session ' +
    'does work — so pass start_session=true when the work should begin now (one call: the task is ' +
    'created, then a session is started on it), or call session_start yourself later. An omitted/empty ' +
    'project means Inbox, and an unknown project name auto-creates its registry row. A new task lands ' +
    'on the pinned board in the Satellite tier; pass focus_tier to put it straight into another tier, ' +
    'or pinned=false to keep it off the board (pinning is human attention, never dispatch). The result ' +
    'carries a `ref` tag plus `outcome` / `next`.',
  input: {
    title: z.string().min(1).describe('Task title (required)'),
    project: z.string().optional().describe('Project name; omit or "" for the Inbox'),
    priority: PRIORITY.optional().describe('immediate | important | backlog | none'),
    due_date: z.string().optional().describe('YYYY-MM-DD or a full ISO-8601 datetime'),
    description: z.string().optional().describe('Longer body text (write-only)'),
    pinned: z.boolean().optional().describe('Join the pinned board (default true). false keeps the task off the board'),
    // Exact ids only — this rides straight to the server, which validates
    // against the registry. Label tolerance lives in the agent tool.
    focus_tier: z.string().optional().describe('Pin tier the task is born into (implies pinned): focus | satellite | backlog | wait | a registered ct_* id. Omit for Satellite; unknown tiers are rejected, not silently downgraded'),
    start_session: z.boolean().optional().describe('Also start a coding session on the new task (create + dispatch in one call). Default false: creating a task starts nothing'),
    start_message: z.string().optional().describe('First instruction for that session (only with start_session; defaults to a sentence naming the task)'),
  },
  /**
   * Handler, not a plain binding, because of `start_session`. The two steps are
   * deliberately NOT one transaction: if the create succeeds and the start
   * fails, the task EXISTS, so failing the whole call would tell the agent the
   * opposite of the truth. The result then carries the task, `session_error`,
   * and the retry line — an honest partial success.
   */
  handler: async (args, call) => {
    const { start_session: startSession, start_message: startMessage, ...fields } = args
    const created = await call('POST', '/tasks', fields) as { task?: unknown } | undefined
    const task = created?.task
    const id = taskId(task)
    if (startSession !== true) {
      return withOutcome(
        withRef(task),
        `Task recorded. No session is working on it. ${TASK_IS_INERT}`,
        dispatchHint(id),
      )
    }
    try {
      const started = await call(
        'POST',
        `/tasks/${encodeURIComponent(id)}/start`,
        startMessage === undefined ? {} : { message: startMessage },
      ) as Record<string, unknown> | undefined
      const sessionId = typeof started?.sessionId === 'string' ? started.sessionId : ''
      return withOutcome(
        withRef(task, { session: started }),
        `Task recorded AND a session was started on it${sessionId ? ` (${sessionId})` : ''}; it is working now.`,
        REPLY_ARRIVES_HINT,
      )
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return withOutcome(
        withRef(task, { session_error: message }),
        `Task recorded, but the session did NOT start (${message}). The task exists; nothing is running.`,
        `Retry the dispatch alone: walnut tools call session_start '{"task":"${id}","message":"..."}'`,
      )
    }
  },
  tags: { readonly: false, remote: 'allow' },
})

defineOp({
  name: 'task_update',
  title: 'Update a Walnut task',
  description:
    'Patch any supported task fields. Use phase=AGENT_COMPLETE when work is done and ready to look at, ' +
    'and phase=COMPLETE when it is finished; a blocked or parked task is just TODO. ' +
    '`tags` is a full replacement ([] clears). Pass "" to clear due_date/start_date.',
  input: {
    id: z.string().min(1).describe('Task id or a unique id prefix'),
    status: STATUS.optional().describe('Legacy status: todo | in_progress | done'),
    phase: TASK_PHASE.optional().describe('Task lifecycle phase'),
    priority: PRIORITY.optional(),
    due_date: z.string().optional().describe('ISO-8601 date/datetime, or "" to clear'),
    start_date: z.string().optional().describe('ISO-8601 date/datetime, or "" to clear'),
    project: z.string().optional().describe('Project name; "" = Inbox'),
    title: z.string().optional().describe('New title (non-empty, <= 500 chars)'),
    description: z.string().optional().describe('Replaces the description (write-only)'),
    tags: z.array(z.string()).optional().describe('FULL replacement of the task tags'),
  },
  handler: async (args, call) => {
    const { id, ...fields } = args
    const body: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(fields)) {
      if (v !== undefined) body[k] = v
    }
    if (Object.keys(body).length === 0) {
      throw new Error('task_update needs at least one field to change besides `id`.')
    }
    const patched = await call('PATCH', `/tasks/${encodeURIComponent(String(id))}`, body) as
      { task?: unknown } | undefined
    const task = patched?.task
    const changed = Object.keys(body).join(', ')
    // A phase write is bookkeeping. It does not start work, and it does not
    // stop a session that is already running — the single most common wrong
    // assumption about this op.
    const running = hasSession(task)
    const outcome = `Task fields updated (${changed}). No session was started or stopped by this. `
      + (running ? 'Its existing session keeps running.' : `No session is attached. ${TASK_IS_INERT}`)
    const next = body.phase === 'AGENT_COMPLETE'
      ? 'Marked ready for the human to look at. Nothing else is required of you.'
      : running
        ? `Talk to its session: walnut tools call session_send '{"to":"${taskId(task) || String(id)}","text":"..."}'`
        : dispatchHint(taskId(task) || String(id))
    return withOutcome({ ...(patched ?? {}) }, outcome, next)
  },
  tags: { readonly: false, remote: 'allow', destructive: false },
})

defineOp({
  name: 'task_complete',
  title: 'Complete a Walnut task',
  description:
    'Mark a task done. The id accepts a unique prefix. The result carries a ' +
    '`ref` tag — paste it verbatim in your reply so the user gets a clickable task pill.',
  input: {
    id: z.string().min(1).describe('Task id or a unique id prefix'),
  },
  // POST /complete, NOT PATCH {status:'done'}: only completeTask() semantics
  // surface a sync-push failure (the v1 PATCH swallows it via asyncPush).
  // Same reasoning as the CLI's `done`.
  bind: { method: 'POST', path: '/tasks/:id/complete' },
  mapResult: ({ body }) => {
    const task = (body as { task?: unknown } | undefined)?.task
    const running = hasSession(task)
    return withOutcome(
      withRef(task, { completed: true }),
      'Task marked complete. Completing a task does not stop anything: '
      + (running
        ? 'the session it owns is still alive and still costs a process.'
        : 'no session was attached to it.'),
      running
        ? 'If that work is really finished, stop the session from the Walnut UI (or leave it to the idle reaper).'
        : 'Nothing else is required.',
    )
  },
  // remote 'allow': completing a task is ordinary, reversible work. This was
  // briefly 'deny' as the gateway half of the human-only completion gate; that
  // whole distinction is gone, and a peer session finishing a task it was asked
  // to finish is the point of the gateway.
  tags: { readonly: false, remote: 'allow', destructive: false },
})

defineOp({
  name: 'task_merge',
  title: 'Merge duplicate Walnut tasks',
  description:
    'Merge duplicate copies of a task into one survivor. Victims\' session links (session_ids, ' +
    'session slots, sessions.task_id) move onto the survivor BEFORE the victim rows are deleted, ' +
    'so no conversation history is lost. ALWAYS use this for duplicate cleanup — a plain ' +
    'task_delete on a duplicate destroys whichever session links that copy held.',
  input: {
    survivor_id: z.string().min(1).describe('Task id (or unique prefix) that survives the merge'),
    victim_ids: z.array(z.string().min(1)).min(1).describe('Duplicate task ids to merge into the survivor and delete'),
  },
  handler: async (args, call) => {
    const { survivor_id, victim_ids } = args
    const body = await call('POST', `/tasks/${encodeURIComponent(String(survivor_id))}/merge`, {
      victim_ids,
    }) as { task?: unknown; merged?: number; sessions_relinked?: number }
    return withOutcome(
      withRef(body?.task, { merged: body?.merged, sessions_relinked: body?.sessions_relinked }),
      `${body?.merged ?? 0} duplicate task(s) deleted; `
      + `${body?.sessions_relinked ?? 0} session link(s) moved onto the survivor, so no conversation was lost. `
      + 'Running sessions were not interrupted.',
      `Read the survivor back if you need its merged state: walnut tools call task_get '{"id":"${taskId(body?.task) || String(survivor_id)}"}'`,
    )
  },
  tags: { readonly: false, remote: 'deny', destructive: true },
})

defineOp({
  name: 'task_delete',
  title: 'Delete a Walnut task',
  description:
    'Permanently delete a task. Only do this when the user explicitly asked for a deletion — ' +
    'completing a task (task_complete) is almost always what is wanted instead. A task with ' +
    'active sessions refuses the delete unless force is true (which stops those sessions first).',
  input: {
    id: z.string().min(1).describe('Task id or a unique id prefix'),
    force: z.boolean().optional().describe('Stop the task\'s active sessions and delete anyway'),
  },
  handler: async (args, call) => {
    const { id, force } = args
    await call('DELETE', `/tasks/${encodeURIComponent(String(id))}${force ? '?force=true' : ''}`)
    return withOutcome(
      { deleted: true, id },
      force === true
        ? 'Task deleted permanently, and its active sessions were stopped first.'
        : 'Task deleted permanently. It had no active session (a task with one refuses the delete unless force is true).',
      'Nothing else is required. This cannot be undone, so do not delete anything else the user did not name.',
    )
  },
  tags: { readonly: false, remote: 'deny', destructive: true },
})
