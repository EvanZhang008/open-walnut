/**
 * Task ops — ported byte-compatible from the original hand-written MCP tools
 * (same names, same descriptions, same result shapes), now declared once for
 * every surface (MCP / CLI / gateway).
 */

import { z } from 'zod'
import { defineOp } from './registry.js'
import { taskRefTag } from '../utils/entity-refs.js'
import { PHASE_ORDER } from '../core/phase.js'

const PRIORITY = z.enum(['immediate', 'important', 'backlog', 'none'])
const STATUS = z.enum(['todo', 'in_progress', 'done'])
// Derived from PHASE_ORDER, never a hardcoded copy: phase.ts is the ONE place
// the lifecycle is declared, so adding/renaming a phase there reaches every
// surface (MCP tool schema, CLI help, gateway) without a second edit.
const TASK_PHASE = z.enum(PHASE_ORDER)

const REF_INSTRUCTION =
  'Include the `ref` string verbatim in your reply to the user so Walnut renders a clickable task pill.'

/** Attach the ref tag + paste instruction to a task-mutating result. */
function withRef(task: unknown, extra: Record<string, unknown> = {}): unknown {
  const t = (task ?? {}) as { id?: unknown; title?: unknown }
  const id = typeof t.id === 'string' ? t.id : ''
  const title = typeof t.title === 'string' ? t.title : ''
  return { ...extra, task, ref: taskRefTag(id, title), instruction: REF_INSTRUCTION }
}

const SORT = z.enum(['updated_desc', 'created_desc', 'completed_desc', 'priority', 'title_asc', 'pin_order'])
const TIME_BASIS = z.enum(['created', 'updated', 'created_or_updated', 'due', 'completed'])

defineOp({
  name: 'task_list',
  title: 'List / query Walnut tasks',
  description:
    'Query the user\'s tasks with any combination of filters (fields AND together; comma lists OR ' +
    'within a field). No status default (completed tasks included), but limit defaults to 50 — narrow ' +
    'with filters or raise limit (max 200) instead of paging by hand. ' +
    'Working set (the pinned board): pass working_set=true to get pinned tasks in board order, each ' +
    'row carrying focus_tier + pin_order — an absent focus_tier on a pinned row means the Satellite ' +
    '(default) tier. focus_tier filters match pinned rows only: "satellite" matches pinned rows with no ' +
    'stored tier; focus/backlog/wait/ct_* match exactly. Time windows: time_basis + a window. last_hours/' +
    'last_days look BACKWARD from now — for upcoming deadlines use time_basis=due with time_from/' +
    'time_until (bare YYYY-MM-DD accepted; until is exclusive). basis "completed" finds recently ' +
    'finished work. Returns { count, tasks } with slim rows; use task_get for full detail on one task.',
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
    working_set: z.boolean().optional().describe('Shortcut: the whole pinned board (all tiers, completed pins included) sorted by pin_order'),
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
    // Defaulted, not optional: the full store is thousands of rows and several
    // MB — an unbounded reply is useless to a model and blocks the server's
    // event loop. Every other list op defaults its page size too.
    limit: z.number().int().min(1).max(200).default(50).describe('Max rows (1-200, default 50), applied after sort'),
    fields: z.enum(['list', 'full']).default('list').describe('list = slim rows (default); full = every field including note (heavy — combine with ids or a small limit)'),
  },
  // Server-root-absolute bind: /api/tasks is the canonical composable-query
  // route (the same engine the web UI filters ride), not the frozen /api/v1
  // mobile projection.
  bind: { method: 'GET', path: '/api/tasks' },
  mapResult: ({ body }) => {
    const tasks = (body as { tasks?: unknown[] } | undefined)?.tasks
    // An unexpected 200 body (a proxy's HTML page, a shape change) must not
    // read as "you have 0 tasks" — pass it through so the caller sees it.
    if (!Array.isArray(tasks)) return body
    return { count: tasks.length, tasks }
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
  tags: { readonly: true, remote: 'allow' },
})

defineOp({
  name: 'task_create',
  title: 'Create a Walnut task',
  description:
    'Record a task without starting any work or session. Use this only when the user wants tracking ' +
    'without execution; use `delegate` when work should start now. An omitted/empty project means ' +
    'Inbox, and an unknown project name auto-creates its registry row. The result carries a `ref` tag.',
  input: {
    title: z.string().min(1).describe('Task title (required)'),
    project: z.string().optional().describe('Project name; omit or "" for the Inbox'),
    priority: PRIORITY.optional().describe('immediate | important | backlog | none'),
    due_date: z.string().optional().describe('YYYY-MM-DD or a full ISO-8601 datetime'),
    description: z.string().optional().describe('Longer body text (write-only)'),
  },
  bind: { method: 'POST', path: '/tasks' },
  mapResult: ({ body }) => withRef((body as { task?: unknown } | undefined)?.task),
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
    return call('PATCH', `/tasks/${encodeURIComponent(String(id))}`, body)
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
  mapResult: ({ body }) => withRef((body as { task?: unknown } | undefined)?.task, { completed: true }),
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
    return withRef(body?.task, { merged: body?.merged, sessions_relinked: body?.sessions_relinked })
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
    return { deleted: true, id }
  },
  tags: { readonly: false, remote: 'deny', destructive: true },
})
