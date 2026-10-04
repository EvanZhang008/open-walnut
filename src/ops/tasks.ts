/**
 * Agent-facing task ops, sharing one declaration across MCP, the CLI, and the daemon gateway.
 */

import { z } from 'zod'
import { defineOp, type HttpBinding } from './registry.js'
import { materializeBinding } from './executor.js'
import { taskRefTag } from '../utils/entity-refs.js'
import { dispatchHint, withOutcome } from './outcome.js'
import { startTask, TASK_START_INPUT, taskView } from './task-execution.js'
import { PHASE_ORDER } from '../core/phase.js'
import {
  BULK_GET_FIELDS,
  BULK_GET_FIELD_GROUPS,
  DEFAULT_BULK_GET_FIELDS,
  MAX_BULK_GET_IDS,
} from '../core/task-bulk-get.js'

const PRIORITY = z.enum(['immediate', 'important', 'backlog', 'none'])
// Derived from PHASE_ORDER, never a hardcoded copy: phase.ts is the ONE place
// the lifecycle is declared, so adding/renaming a phase there reaches every
// surface (MCP tool schema, CLI help, gateway) without a second edit.
const TASK_PHASE = z.enum(PHASE_ORDER)

const REF_INSTRUCTION =
  'Include the `ref` string verbatim in your reply to the user so Walnut renders a clickable task pill.'

/**
 * The task's id, title and phase at the TOP of a result whose task sits under
 * `.task`: the three fields a caller reads next (`jq -r .id`), so it never has
 * to know where the full task lives (a leader session read nulls off the top
 * of task_get, 2026-10-02).
 */
function headline(task: unknown): Record<string, unknown> {
  const t = (task ?? {}) as { id?: unknown; title?: unknown; phase?: unknown }
  return {
    ...(typeof t.id === 'string' ? { id: t.id } : {}),
    ...(typeof t.title === 'string' ? { title: t.title } : {}),
    ...(typeof t.phase === 'string' ? { phase: t.phase } : {}),
  }
}

/** Attach the ref tag + paste instruction to a task-mutating result. */
function withRef(task: unknown, extra: Record<string, unknown> = {}): Record<string, unknown> {
  const t = (task ?? {}) as { id?: unknown; title?: unknown }
  const id = typeof t.id === 'string' ? t.id : ''
  const title = typeof t.title === 'string' ? t.title : ''
  return { ...headline(task), ...extra, task, ref: taskRefTag(id, title), instruction: REF_INSTRUCTION }
}

/** Task id out of a v1 task body, for the outcome lines. */
function taskId(task: unknown): string {
  const id = (task as { id?: unknown } | undefined)?.id
  return typeof id === 'string' ? id : ''
}

/**
 * Does this task body show a session attached?
 *
 * 'unknown' is a real third answer and must stay one: the PATCH and complete
 * responses return a SLIM projection with no session fields at all, so reading a
 * missing field as "none" makes the result state the opposite of the truth (it
 * told a task being updated from inside its own live session that nothing was
 * working on it). When the body cannot answer, say nothing about attachment.
 */
function sessionState(task: unknown): 'attached' | 'none' | 'unknown' {
  const t = (task ?? {}) as Record<string, unknown>
  for (const key of ['session_id', 'exec_session_id'] as const) {
    if (typeof t[key] === 'string' && t[key]) return 'attached'
  }
  if (Array.isArray(t.session_ids) && t.session_ids.length > 0) return 'attached'
  const reported = 'session_id' in t || 'session_ids' in t || 'exec_session_id' in t
  return reported ? 'none' : 'unknown'
}

/**
 * The clock clause of a WAITING outcome. The server fills a default wait_until
 * when the caller named none, so the stored task, not the request, says when
 * the task comes back by itself; "" asked for no clock and gets no clause.
 */
function waitClockNote(task: unknown, requested: unknown): string {
  const stored = (task as { wait_until?: unknown } | undefined)?.wait_until
  const until = typeof stored === 'string' && stored ? stored : typeof requested === 'string' && requested ? requested : ''
  return until ? `, or the clock at ${until}` : ''
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

/**
 * The fields a `fields=list` row keeps, in this order. Everything else the REST
 * route sends is dropped before the row reaches a caller.
 *
 * Why the projection lives HERE and not in the route: /api/tasks is shared with
 * the web UI, which reads a much wider row (and still reads the internal
 * `status`). Narrowing the route would mean rewriting the UI's completion checks
 * in the same change. This seam narrows the AGENT's view only.
 *
 * What the route's own "slim" row actually was: 34 keys, ~1160 bytes each, so a
 * 58-row project listing came back at 75KB and had to be hand-compressed before
 * anything could read it. Most of that was internal bookkeeping (has_note,
 * has_summary, has_ext, ledger_desc, pin_order on unpinned rows, _syncedAt AND
 * _synced_at, two nested session_status objects, session_id AND exec_session_id
 * AND session_ids).
 *
 * Deliberately absent:
 *   - `status`      internal 3-state projection of `phase`, and lossy: it cannot
 *                   say NEED_ACTION (see Task.status). `phase` is the one answer.
 *   - `unread`      redundant with phase — readMarkerForPhase sets it on exactly
 *                   NEED_ACTION, so it never adds information to a row that
 *                   already carries the phase.
 *   - `priority`    not what anyone filters or sorts a list by in practice.
 *   - has_* flags   "there is a note" is not actionable; task_get answers it.
 *   - session objects  liveness belongs to a session read, not a task row.
 *
 * Always-present keys stay present even when empty so a sorted or time-windowed
 * result is explainable without a follow-up call; the rest are omitted when
 * absent (an absent key is cheaper to read than a null).
 */
const TASK_LIST_ALWAYS = ['id', 'title', 'phase', 'project', 'updated_at'] as const
const TASK_LIST_WHEN_SET = [
  'due_date', 'start_date', 'completed_at', 'focus_tier', 'pin_order',
  'parent_task_id', 'group_id', 'sprint', 'tags', 'is_blocked',
] as const

/** Project ONE REST row onto the lean agent-facing shape. */
function leanTaskRow(row: unknown): unknown {
  if (row === null || typeof row !== 'object' || Array.isArray(row)) return row
  const src = row as Record<string, unknown>
  const out: Record<string, unknown> = {}
  for (const key of TASK_LIST_ALWAYS) out[key] = key === 'project' ? (src.project ?? '') : src[key]
  // pinned is a flag, not a value: always answer it, as a real boolean.
  out.execution = taskView(src).execution
  out.pinned = Boolean(src.pinned)
  for (const key of TASK_LIST_WHEN_SET) {
    const value = src[key]
    if (value === undefined || value === null || value === '') continue
    if (Array.isArray(value) && value.length === 0) continue
    // pin_order is board bookkeeping — meaningless on an unpinned row.
    if (key === 'pin_order' && !out.pinned) continue
    out[key] = value
  }
  return out
}

// Server-root-absolute: /api/tasks is the canonical composable-query route (the
// same engine the web UI filters ride), not the frozen /api/v1 mobile projection.
const TASK_LIST_BINDING: HttpBinding = { method: 'GET', path: '/api/tasks' }

/** GET /api/v1/me — where the calling session stands (src/core/sessions/caller-placement.ts). */
interface CallerMe {
  kind?: 'human' | 'external' | 'unknown' | 'untracked' | 'ask' | 'worker'
  task?: { id?: string; title?: string; project?: string; group_id?: string; group_label?: string }
}

/** Filters that already say WHERE to look, so task_list applies no caller default. */
// Board queries count too: tiers, pins and unread are the human's working set,
// never a folder's. A lookup (a title search or a tag) does NOT: it starts near and widens.
const TASK_LIST_PLACEMENT_FILTERS = [
  'project', 'projects', 'group_id', 'ids', 'working_set', 'parent_task_id', 'focus_tier', 'pinned', 'unread',
] as const

/** Filters that look for particular tasks: with no hit near the caller, the search widens. */
const TASK_LIST_LOOKUP_FILTERS = ['q', 'tag', 'tags_any', 'tags_all'] as const

/** The lookup a widened result names, in the caller's own words. */
function lookupLabel(args: Record<string, unknown>): string {
  if (args.q !== undefined) return `"${String(args.q)}"`
  const tags = [args.tag, args.tags_any, args.tags_all].filter((v) => v !== undefined).map(String)
  return `tag ${tags.join(', ')}`
}

/** The line a defaulted (not asked-for) scope carries, so the ring is never mistaken for the board. */
function scopeDefaultHint(scope: string | undefined, you: Record<string, unknown> | undefined): string {
  const project = typeof you?.project === 'string' && you.project ? `project ${you.project}` : 'the Inbox'
  const folder = typeof you?.group_label === 'string' && you.group_label ? `folder "${you.group_label}"` : 'your folder'
  return scope === 'folder'
    ? `Listed ${folder} in ${project} by default, because you called from inside a task. `
      + 'Pass scope:"project" for your whole project or scope:"all" for the board.'
    : `Listed ${project} by default (your task sits in no folder). Pass scope:"all" for the board.`
}

defineOp({
  name: 'task_list',
  title: 'List / query Walnut tasks',
  description:
    'Query the user\'s tasks with any combination of filters (fields AND together; comma lists OR ' +
    'within a field). No phase default (completed tasks included), but limit defaults to 50 — narrow ' +
    'with filters or raise limit (max 200) instead of paging by hand. ' +
    'State is `phase`: TODO | IN_PROGRESS | NEED_ACTION | COMPLETE. NEED_ACTION means the agent handed ' +
    'the work back and is waiting on the human (turn finished, permission prompt, or an error) — it is ' +
    'NOT done. There is no `status` field. ' +
    'Working set (the pinned board): pass working_set=true to get the WHOLE board (no default limit, ' +
    'however many pins there are) in board order, each row carrying focus_tier + pin_order — an absent ' +
    'focus_tier on a pinned row means the Satellite (default) tier. focus_tier filters match pinned rows ' +
    'only: "satellite" matches pinned rows with no ' +
    'stored tier; focus/wait/ct_* match exactly. Time windows: time_basis + a window. last_hours/' +
    'last_days look BACKWARD from now — for upcoming deadlines use time_basis=due with time_from/' +
    'time_until (bare YYYY-MM-DD accepted; until is exclusive). basis "completed" finds recently ' +
    'finished work. Returns { count, total, truncated, tasks } with slim rows: count = rows returned, ' +
    'total = rows that matched before the limit, truncated = true when total > count (there ARE more ' +
    'rows — never read a truncated result as the full picture; narrow the filters or raise limit). ' +
    'A slim row is id, title, phase, project, updated_at, pinned, plus dates/board/parent keys only ' +
    'when set — pass fields=full for the whole record. ' +
    'working_set also returns `board`: the server\'s own pinned counts (pinned_total/active/completed ' +
    'plus per-tier total/active/completed) — check your own per-tier bucketing against it before ' +
    'reporting a board. Use task_get for full detail on one task, or task_get_bulk for many tasks with ' +
    'chosen fields.',
  input: {
    // `status` is intentionally NOT an input here. It could not express
    // NEED_ACTION (it folded that into in_progress), so every caller reaching for
    // it lost the "waiting on the human" rows. Use phases= or completion=.
    completion: z.string().optional().describe('Comma list of todo | in_progress | complete (in_progress includes NEED_ACTION)'),
    phases: z.string().optional().describe(`Comma list of exact phases: ${PHASE_ORDER.join(' | ')}`),
    project: z.string().optional().describe('Project name (exact, case-insensitive); "" for the Inbox'),
    projects: z.string().optional().describe('Comma list of project names'),
    priorities: z.string().optional().describe('Comma list of immediate | important | backlog | none'),
    source: z.string().optional().describe('Task source (exact), e.g. "local"'),
    sprint: z.string().optional().describe('Sprint name (exact)'),
    tag: z.string().optional().describe('Exact tag match (single). Tags are key:value (a plain word means label:<word>); created:YYYY-MM-DD / updated:YYYY-MM-DD match the task\'s own dates'),
    tags_any: z.string().optional().describe('Comma list — match tasks carrying ANY of these tags'),
    tags_all: z.string().optional().describe('Comma list — match tasks carrying ALL of these tags'),
    pinned: z.boolean().optional().describe('Filter pinned/unpinned tasks'),
    focus_tier: z.string().optional().describe('Comma list of pin tiers: focus | satellite | wait (Parked) | a custom ct_* id. Only pinned tasks match; satellite = pinned with no stored tier'),
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
    scope: z.enum(['folder', 'project', 'all']).optional().describe('How far around the caller to look: folder, project, or all (the whole board). From inside a task the DEFAULT is folder (project when your task has no folder); pass all for the board. A lookup (q, tag, tags_any, tags_all) with no hit there widens by itself to your project, then the board. Elsewhere the default is the whole board'),
  },
  // Declared so the route-parity test and the generated docs keep pointing at
  // the real route; the handler below is what actually executes (it needs to
  // decide the limit from the args first).
  bind: TASK_LIST_BINDING,
  handler: async (args, call) => {
    // The board shortcut is exempt from the page-size default BY CONTRACT: a
    // partial board reads as "these are all your pinned tasks", which is a wrong
    // answer, not a small one. An explicit limit is still honored.
    const { scope: askedScope, ...effective } = args
    let scope = askedScope
    let me: CallerMe | undefined
    // From inside a task, "list tasks" means the work beside you: the folder
    // ring by default. A call that already says WHERE to look (a project, a
    // folder, ids, the board, a parent) is not second-guessed, and neither is
    // any caller Walnut does not place work from (the Personal AI, a human).
    if (scope === undefined && !TASK_LIST_PLACEMENT_FILTERS.some((k) => args[k] !== undefined)) {
      me = await call('GET', '/me').then((b) => b as CallerMe, () => undefined)
      if (me?.kind === 'worker') scope = 'folder'
    }
    const defaulted = askedScope === undefined && scope !== undefined
    let appliedScope = scope
    let you: Record<string, unknown> | undefined
    if (scope && scope !== 'all') {
      me ??= await call('GET', '/me') as CallerMe
      const place = me?.task
      if (!place?.id) throw new Error('Cannot locate the caller. Use scope=all or omit scope.')
      // A caller in no folder has nothing narrower than its project.
      appliedScope = scope === 'folder' && !place.group_id ? 'project' : scope
      you = {
        id: place.id, title: place.title, project: place.project ?? '',
        ...(place.group_id ? { group_id: place.group_id } : {}),
        ...(place.group_label ? { group_label: place.group_label } : {}),
      }
      const key = appliedScope === 'folder' ? 'group_id' : 'project'
      const value = String(appliedScope === 'folder' ? place.group_id : (place.project ?? ''))
      const requested = effective[key];
      if (requested !== undefined && (key === 'project' ? String(requested).toLowerCase() !== value.toLowerCase() : requested !== value)) {
        return { count: 0, total: 0, truncated: false, scope: appliedScope, you, tasks: [] }
      }
      effective[key] = value
    }
    if (effective.limit === undefined && args.working_set !== true) {
      effective.limit = DEFAULT_TASK_LIST_LIMIT
    }
    const fetchList = async () => {
      const { path } = materializeBinding(TASK_LIST_BINDING, effective)
      return await call('GET', path) as { tasks?: unknown[]; total?: unknown; board?: unknown } | undefined
    }
    let body = await fetchList()
    // A lookup nobody scoped (a title search, a tag) starts near and WIDENS on no
    // hit (folder, then project, then the board): an agent checking "does this
    // exist yet?" must not read an empty folder as "no, create it", and one
    // finding the task a ticket tag names must not stop at its own folder.
    let widenedFrom: string | undefined
    const lookup = TASK_LIST_LOOKUP_FILTERS.some((k) => args[k] !== undefined)
    while (defaulted && lookup && Array.isArray(body?.tasks) && body.tasks.length === 0
        && (appliedScope === 'folder' || appliedScope === 'project')) {
      widenedFrom ??= appliedScope
      if (appliedScope === 'folder') {
        delete effective.group_id
        effective.project = String(you?.project ?? '')
        appliedScope = 'project'
      } else {
        delete effective.project
        appliedScope = 'all'
      }
      body = await fetchList()
    }
    const tasks = body?.tasks
    // An unexpected 200 body (a proxy's HTML page, a shape change) must not
    // read as "you have 0 tasks" — pass it through so the caller sees it.
    if (!Array.isArray(tasks)) return body
    // total comes from the server (rows matched before the limit). A server too
    // old to send it can only be reported as "no more than what you got".
    const total = typeof body?.total === 'number' ? body.total : tasks.length
    const truncated = total > tasks.length
    // fields=full is the escape hatch and passes the route's row through intact.
    const rows = args.fields === 'full'
      ? tasks.map((t) => t && typeof t === 'object' && !Array.isArray(t) ? taskView(t as Record<string, unknown>) : t)
      : tasks.map(leanTaskRow)
    const hints = [
      widenedFrom
        ? `Nothing in your ${widenedFrom} matched ${lookupLabel(args)}, so this searched ${appliedScope === 'all' ? 'the whole board' : 'your whole project'}.`
        : defaulted ? scopeDefaultHint(appliedScope as string | undefined, you) : '',
      truncated
        ? `Showing ${tasks.length} of ${total} matching tasks — this result is CUT. `
          + 'Narrow the filters or raise limit (max 200) before drawing any conclusion from it.'
        : '',
    ].filter(Boolean)
    return {
      ...(scope ? { scope: appliedScope, ...(you ? { you } : {}) } : {}),
      count: tasks.length,
      total,
      truncated,
      // Board reads carry the server's own per-tier counts — check your bucketing
      // against them before reporting a board.
      ...(body?.board ? { board: body.board } : {}),
      ...(hints.length ? { hint: hints.join(' ') } : {}),
      tasks: rows,
    }
  },
  tags: { readonly: true, remote: 'allow' },
})

defineOp({
  name: 'task_get',
  title: 'Get one Walnut task',
  description:
    'Full detail for one task, including description, note, summary, execution, and ' +
    'dependency/child/parent decorations that the list view omits. The id accepts a unique prefix. ' +
    'The task is under `task`; its id, title and phase are repeated at the top level.',
  input: {
    id: z.string().min(1).describe('Task id or a unique id prefix'),
  },
  bind: { method: 'GET', path: '/api/tasks/:id' },
  // A bare phase word ("todo") reads as "queued for execution" in most agent
  // frameworks. Say the part the word hides: whether a session is attached.
  mapResult: ({ body, args }) => {
    const b = (body ?? {}) as Record<string, unknown>
    const task = b.task as Record<string, unknown> | undefined
    if (!task || typeof task.id !== 'string' || !task.id) throw new Error('Task response is incomplete; retry task_get.')
    const phase = typeof task.phase === 'string' ? task.phase : 'unknown'
    const view = taskView(task)
    const execution = view.execution as { state: string }
    const id = taskId(task) || String(args.id ?? '')
    return withOutcome(
      { ...headline(view), ...b, task: view },
      `Task phase: ${phase}. Execution: ${execution.state}.`,
      execution.state === 'not_started'
        ? dispatchHint(id)
        : `Read task_history or add context with task_send '{"to":"${id}","text":"..."}'.`,
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

/** Where POST /tasks says a new task landed (additive `placement`). */
interface Placement {
  project?: string
  group_id?: string
  group_label?: string
  folder_created?: boolean
  inherited_from?: string
  parent_task_id?: string
  /** The board tier taken from your task: a tier id, 'satellite' or 'unpinned'. */
  tier?: string
  /** The long title you sent; the server cut it to a few words (task.title). */
  title_shortened_from?: string
  /** Your task's other open subtasks (the team you already lead), newest first. */
  open_subtasks?: { id: string; title: string; phase: string }[]
  more_open_subtasks?: number
  warning?: string
}

const TIER_NAMES: Record<string, string> = { focus: 'Focus', satellite: 'Satellite', wait: 'Parked' }

/** One sentence naming where the task landed, or '' for a server too old to say. */
function placementSentence(p: Placement | undefined): string {
  if (!p) return ''
  const project = p.project ? `project ${p.project}` : 'the Inbox'
  const folder = p.group_id
    ? `, folder "${p.group_label || p.group_id}"${p.folder_created ? ' (new, holding your task and this one)' : ''}`
    : ''
  const why = p.parent_task_id ? ', as a subtask of your task' : p.inherited_from ? ', beside your task' : ''
  const tier = !p.tier ? ''
    : p.tier === 'unpinned' ? ', off the pinned board like your task'
    : `, in ${TIER_NAMES[p.tier] ?? `tier ${p.tier}`} like your task`
  const warning = p.warning ? ` ${p.warning}.` : ''
  return `Filed in ${project}${folder}${why}${tier}.${warning} `
}

/** One sentence when the server cut a long title (Walnut titles are a few words). */
function titleCutSentence(p: Placement | undefined, task: Record<string, unknown> | undefined, hadDescription: boolean): string {
  if (!p?.title_shortened_from) return ''
  const kept = hadDescription ? '' : '; the full text is in the description'
  return `Title shortened to "${String(task?.title ?? '')}" (${p.title_shortened_from.length} chars sent, a few words expected${kept}). `
}

/**
 * The team the caller already leads, named after every create: a subtask owns
 * an area, so work that belongs to one of these goes there, not to a new task.
 */
function teamSentence(p: Placement | undefined): string {
  const team = p?.open_subtasks
  if (!team?.length) return ''
  const total = team.length + (p?.more_open_subtasks ?? 0)
  const shown = team.slice(0, 5)
  // Code points, so a cut never splits a surrogate pair.
  const short = (s: string) => { const c = Array.from(s); return c.length > 60 ? `${c.slice(0, 59).join('')}…` : s }
  const list = shown.map((t) => `"${short(t.title)}" (${t.id}, ${t.phase})`).join('; ')
  const more = total > shown.length ? `; and ${total - shown.length} more (open_items lists them)` : ''
  return `Your task also leads ${total} other open subtask${total === 1 ? '' : 's'}: ${list}${more}. `
    + 'Each owns its area: more work in one of those areas goes to that task with task_send, not to a new task. '
    + 'The user follows your workers on your Board (skill walnut-board), not in your chat. '
}

defineOp({
  name: 'task_create',
  title: 'Create and start a task (record_only to defer)',
  description:
    'Create a task AND START WORK by default, in one call. A task is a separate session on the user\'s ' +
    'board that they open, message and steer. From a coding session, create one only on the user\'s signal: ' +
    'they ask for a task, name the parts they want as separate tasks, or need it to run where your ' +
    'session cannot (another host, later, after this session ends); record_only=true when they only want ' +
    'it written down (a placeholder, nothing runs). Otherwise do the work with your own tools (todo list, ' +
    'subagents, agent teams) however big it is: size alone is never a reason, and follow-ups you find are ' +
    'yours to do here. A task is a teammate that owns one area with a clear goal, never a step: one task ' +
    'per ask (ask the user before splitting), and more work in an area goes to the task that owns ' +
    'it (task_send; a finished one reopens). The result lists the other open subtasks you lead. Words: a "subagent" is Claude Code\'s Agent tool inside your session, never a ' +
    'Walnut task; a "subtask" or "task" is a Walnut task, which this creates. In Walnut\'s own chat, where ' +
    'you dispatch, the user asking for the work is the signal. Pass message for the instruction and cwd/host ' +
    'to override project defaults. Keep the returned task id: task_send adds context, task_history ' +
    'reads the conversation, task_get reports execution. If starting fails the task still exists; ' +
    'fix the cause and use task_start with that id, never create a duplicate. Placement: called from ' +
    'inside a task, the new task lands BESIDE yours by default: same project, your folder (Walnut makes ' +
    'one holding both when yours has none, and a subfolder of yours holding both when yours also holds ' +
    'other work), same host and directory. Name a project to file it elsewhere ' +
    '("" = Inbox); a folder never follows work into another project. Wherever it lands, the new task is your SUBTASK (Sub on the board), from a Personal AI conversation too. Called from anywhere else, an ' +
    'omitted project means the configured default project (normally the Inbox). A new project name ' +
    'creates its registry row. The result\'s ' +
    '`placement` says where it landed. From inside a task the new task is born in your board tier ' +
    '(Focus work stays Focus); elsewhere it is pinned in Satellite. pinned or focus_tier override that; ' +
    'focus_tier changes board position, not execution.',
  input: {
    title: z.string().min(1).describe('Task title: a few words naming the specific subject, like a commit subject (under 60 characters; the server cuts a longer one from a session). The brief goes in message or description'),
    project: z.string().optional().describe('Project name; "" for the Inbox. Omit to use your own task\'s project (from inside a task) or the Inbox (elsewhere)'),
    group_id: z.string().optional().describe('Folder id (g_...) inside the target project; "" for no folder. Omit to join your own task\'s folder (a new one when it has none) when the task lands in your project'),
    priority: PRIORITY.optional().describe('immediate | important | backlog | none'),
    due_date: z.string().optional().describe('YYYY-MM-DD or a full ISO-8601 datetime'),
    description: z.string().optional().describe('Longer body text (write-only)'),
    pinned: z.boolean().optional().describe('Join the pinned board. Default: your task\'s (from inside a task), otherwise true. false keeps the task off the board'),
    // Exact ids only — this rides straight to the server, which validates
    // against the registry. Label tolerance lives in the agent tool.
    focus_tier: z.string().optional().describe('Pin tier the task is born into (implies pinned): focus | satellite | wait (Parked) | a registered ct_* id. Omit for your task\'s tier (from inside a task) or Satellite (elsewhere); unknown tiers are rejected, not silently downgraded'),
    record_only: z.boolean().optional().describe('Explicitly save a placeholder WITHOUT starting work. Default false: create and start'),
    ...TASK_START_INPUT,
    start_session: z.boolean().optional().describe('Legacy spelling: false means record_only=true; true starts work (already the default)'),
    start_message: z.string().trim().min(1).optional().describe('Legacy spelling of message; do not combine with message'),
  },
  handler: async (args, call) => {
    const { record_only, start_session, start_message, message, ...rest } = args
    if (record_only !== undefined && start_session !== undefined && record_only === start_session) {
      throw new Error('record_only and start_session conflict. Use record_only=true to defer, or omit both to start.')
    }
    if (message !== undefined && start_message !== undefined) throw new Error('Use message, not both message and start_message.')
    const recordOnly = record_only === true || start_session === false
    const launch: Record<string, unknown> = {}
    const fields: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(rest)) {
      if (value !== undefined) (key in TASK_START_INPUT ? launch : fields)[key] = value
    }
    // Where the first start runs also decides what cwd the task records (a task
    // stores no host), so the create hears it too, as hints it never stores raw.
    if (typeof launch.cwd === 'string') fields.launch_cwd = launch.cwd
    if (typeof launch.host === 'string') fields.launch_host = launch.host
    const instruction = message ?? start_message ?? args.description
    if (instruction) launch.message = instruction
    if (!fields.description && instruction) fields.description = instruction
    if (recordOnly && (message !== undefined || start_message !== undefined || Object.keys(launch).some((k) => k !== 'message'))) {
      throw new Error('record_only does not accept execution options. Omit record_only to start work.')
    }
    const created = await call('POST', '/tasks', fields) as
      { task?: Record<string, unknown>; placement?: Placement } | undefined
    const task = created?.task
    const id = taskId(task)
    if (!task || !id) throw new Error('Create response has no task id. Check task_list before retrying; the write may have succeeded.')
    const placement = created?.placement
    const view = {
      ...taskView(task),
      ...(placement?.group_id ? { group_id: placement.group_id } : {}),
      ...(placement?.parent_task_id ? { parent_task_id: placement.parent_task_id } : {}),
    }
    const extra = placement ? { placement } : {}
    const where = placementSentence(placement) + titleCutSentence(placement, task, fields.description !== undefined)
      + teamSentence(placement)
    if (recordOnly) {
      return withOutcome(
        withRef({ ...view, execution: { state: 'not_started' } }, { ...extra, execution: { state: 'not_started' } }),
        `${where}Placeholder saved. Work was explicitly not started.`,
        `Start it when requested: walnut tools call task_start '{"id":"${id}"}'`,
      )
    }
    try {
      const started = await startTask(id, launch, call)
      return withOutcome(
        withRef({ ...view, execution: started.execution }, { ...extra, ...started }),
        `${where}${String(started.outcome)}`, String(started.next),
      )
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err)
      // The server's running-subtask cap (subtask-limits.ts): a definite "no",
      // not an unconfirmed start, so the task is a placeholder until one finishes.
      if (error.includes('(too_many_running_subtasks)')) {
        return withOutcome(
          withRef({ ...view, execution: { state: 'not_started', error } }, {
            ...extra, execution: { state: 'not_started', error }, start_error: error,
          }),
          `${where}Task ${id} was created but NOT started: ${error}`,
          `Start it after one of the running subtasks finishes: walnut tools call task_start '{"id":"${id}"}'`,
        )
      }
      return withOutcome(
        withRef({ ...view, execution: { state: 'unconfirmed', error } }, {
          ...extra, execution: { state: 'unconfirmed', error }, start_error: error,
        }),
        `${where}Task ${id} was created, but starting work was not confirmed: ${error}`,
        `Do not create another task. Read task_get, then retry with task_start '{"id":"${id}"}' after resolving the error.`,
      )
    }
  },
  resultError: (result) => (result as { start_error?: string } | undefined)?.start_error,
  timeoutMs: 40_000,
  tags: { readonly: false, remote: 'allow' },
})

/** Where PATCH /tasks/:id says a task's leader link moved (additive `placement`; '' = released). */
interface LeaderPlacement {
  parent_task_id?: string
  parent_title?: string
  previous_parent_task_id?: string
  previous_parent_title?: string
}

/** The adopt or release sentence, or '' when the PATCH did not change the leader link. */
function leaderSentence(task: unknown, id: string, p: LeaderPlacement | undefined): string {
  if (typeof p?.parent_task_id !== 'string') return ''
  const named = (title: string | undefined, ref: string) => (title ? `"${title}" (${ref})` : ref)
  const title = (task as { title?: unknown } | undefined)?.title
  const self = named(typeof title === 'string' ? title : undefined, id)
  if (p.parent_task_id) {
    return `${self} is now a worker of ${named(p.parent_title, p.parent_task_id)}. It keeps its project and folder; `
      + 'its stops, completions, errors and waits now reach that task.'
  }
  const previous = p.previous_parent_task_id ? ` of ${named(p.previous_parent_title, p.previous_parent_task_id)}` : ''
  return `${self} is no longer a worker${previous}. It keeps its project and folder; `
    + 'its stops, completions, errors and waits no longer reach that task.'
}

defineOp({
  name: 'task_update',
  title: 'Update a Walnut task',
  description:
    'Patch any supported task fields. Use phase=NEED_ACTION when work is done and ready to look at, ' +
    'and phase=COMPLETE when it is finished. phase=WAITING parks the task on something that has not ' +
    'happened yet (a trigger you armed, a reply, a time): it stays in its lists and its board section, the end ' +
    'of this turn does not hand it back, and the next message into it (a trigger fire, the user, a peer) moves ' +
    'it to IN_PROGRESS. Set it as the LAST call of the turn. wait_until (ISO datetime) wakes it at ' +
    'that time when nothing else did; left out, a task entering WAITING gets 3 days from now, and "" means ' +
    'no clock at all. `tags` is a full replacement ([] clears). Pass "" to clear due_date/start_date.',
  input: {
    id: z.string().min(1).describe('Task id or a unique id prefix'),
    // No `status` input. It was the more dangerous of the two write paths: a
    // 3-state value cannot say NEED_ACTION, so "the agent is done, look at this"
    // was only reachable through phase — and status:'done' silently jumped a task
    // to COMPLETE, which is the human's call, not the agent's.
    phase: TASK_PHASE.optional()
      .describe('Task lifecycle phase — the one state field. NEED_ACTION = handed back to the human; '
        + 'WAITING = parked until something happens (any new message brings it back)'),
    wait_until: z.string().optional()
      .describe('With phase=WAITING: ISO-8601 datetime at which the task is woken if nothing else did. '
        + 'Left out when entering WAITING = 3 days from now; "" = no clock (the wait has no end of its own)'),
    priority: PRIORITY.optional(),
    due_date: z.string().optional().describe('ISO-8601 date/datetime, or "" to clear'),
    start_date: z.string().optional().describe('ISO-8601 date/datetime, or "" to clear'),
    project: z.string().optional().describe('Project name; "" = Inbox'),
    title: z.string().optional().describe('New title: a few words (under 60 characters from a session, the server cuts a longer one; <= 500)'),
    description: z.string().optional().describe('Replaces the description (write-only)'),
    tags: z.array(z.string()).optional().describe('FULL replacement of the task tags, each key:value (e.g. team:marina, sev:2; a plain word is stored as label:<word>)'),
    parent_task_id: z.string().optional().describe('Adopt or release: set to your own task id to make an existing task a worker of yours (it keeps its project and folder; its stops, completions, errors and waits then reach you), or "" to release it.'),
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
      { task?: unknown; title_shortened_from?: string; placement?: LeaderPlacement } | undefined
    const task = patched?.task
    const changed = Object.keys(body).join(', ')
    // A phase write is bookkeeping. It does not start work, and it does not
    // stop a session that is already running — the single most common wrong
    // assumption about this op.
    const attachment = sessionState(task)
    const cut = patched?.title_shortened_from
      ? `Title shortened to "${String((task as Record<string, unknown> | undefined)?.title ?? '')}" (a few words expected). `
      : ''
    // A leader link the server changed is said in place of the field list.
    const link = leaderSentence(task, taskId(task) || String(id), patched?.placement)
    const others = Object.keys(body).filter((k) => k !== 'parent_task_id')
    const fieldsLine = !link ? `Task fields updated (${changed}). `
      : `${link} ${others.length > 0 ? `Other fields updated (${others.join(', ')}). ` : ''}`
    const outcome = `${fieldsLine}${cut}No session was started or stopped by this. `
      + 'Execution is unchanged.'
    const next = body.phase === 'NEED_ACTION'
      ? 'Marked ready for the human to look at. Nothing else is required of you.'
      : body.phase === 'WAITING'
        ? 'The task is waiting. End your turn now: the next message into it (a trigger fire, the user, a peer'
          + `${waitClockNote(task, body.wait_until)}) brings it back to In Progress.`
      : attachment === 'attached'
        ? `Talk to its session: walnut tools call task_send '{"to":"${taskId(task) || String(id)}","text":"..."}'`
        : dispatchHint(taskId(task) || String(id), attachment === 'none')
    return withOutcome({
      ...headline(task), ...(patched ?? {}),
      ...(task && typeof task === 'object' ? { task: taskView(task as Record<string, unknown>) } : {}),
    }, outcome, next)
  },
  tags: { readonly: false, remote: 'allow', destructive: false },
})

/** What completion does to the task's own sessions (completeTaskSessions): a live one is stopped. */
const COMPLETED_OUTCOME = 'Task marked complete. Its own session, if one was live, is stopped; its leader, if it has one, hears about it unless the leader is you.'

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
    return withOutcome(
      withRef(task && typeof task === 'object' ? taskView(task as Record<string, unknown>) : task, { completed: true }),
      COMPLETED_OUTCOME,
      'No further action is required.',
    )
  },
  // remote 'allow': completing a task is ordinary, reversible work. This was
  // briefly 'deny' as the gateway half of the human-only completion gate; that
  // whole distinction is gone, and a peer session finishing a task it was asked
  // to finish is the point of the gateway.
  tags: { readonly: false, remote: 'allow', destructive: false },
})

const MAX_BULK_WRITE = 50

/** One row of a bulk write result: the task's headline, or why that id failed. */
interface BulkRow { id: string; ok: boolean; title?: string; phase?: string; error?: string }

/** Run `one` for every id, in order, never stopping at a failure; one row each. */
async function bulkRows(ids: string[], one: (id: string) => Promise<unknown>): Promise<BulkRow[]> {
  const rows: BulkRow[] = []
  for (const id of ids) {
    try {
      const body = await one(id) as { task?: unknown } | undefined
      const h = headline(body?.task) as { title?: string; phase?: string }
      rows.push({ id: taskId(body?.task) || id, ok: true, ...(h.title ? { title: h.title } : {}), ...(h.phase ? { phase: h.phase } : {}) })
    } catch (err) {
      rows.push({ id, ok: false, error: err instanceof Error ? err.message : String(err) })
    }
  }
  return rows
}

/** The bulk result: counts first, then the rows, then one sentence per outcome. */
function bulkResult(rows: BulkRow[], verb: string, next: string): Record<string, unknown> {
  const done = rows.filter((r) => r.ok)
  const failed = rows.filter((r) => !r.ok)
  const failures = failed.length
    ? ` ${failed.length} failed: ${failed.slice(0, 5).map((r) => `${r.id} (${r.error})`).join('; ')}${failed.length > 5 ? '; …' : ''}.`
    : ''
  return withOutcome(
    { changed: done.length, failed: failed.length, rows },
    `${done.length} of ${rows.length} task${rows.length === 1 ? '' : 's'} ${verb}.${failures}`,
    failed.length ? 'Fix the failed ids and retry only those; the others are done.' : next,
  )
}

defineOp({
  name: 'task_update_bulk',
  title: 'Update many Walnut tasks in one call',
  description:
    'Patch up to 50 tasks in ONE call: the same fields as task_update, one object per task, applied in ' +
    'order with every server check a single task_update gets (title brake, adoption depth, phase guards). ' +
    'One failing task does not stop the others: the result lists every row with ok or an error. From a ' +
    'remote session this costs ONE write of the gateway budget instead of one per task (a bulk rename of ' +
    '25 workers used to take minutes of backoff).',
  input: {
    updates: z.array(z.object({
      id: z.string().min(1).describe('Task id or a unique id prefix'),
      phase: TASK_PHASE.optional(),
      wait_until: z.string().optional(),
      priority: PRIORITY.optional(),
      due_date: z.string().optional(),
      start_date: z.string().optional(),
      project: z.string().optional(),
      title: z.string().optional(),
      description: z.string().optional(),
      tags: z.array(z.string()).optional(),
      parent_task_id: z.string().optional(),
    }).strict()).min(1).max(MAX_BULK_WRITE)
      .describe(`1 to ${MAX_BULK_WRITE} patches, each { id, ...fields } with at least one field besides id`),
  },
  routes: [{ method: 'PATCH', path: '/tasks/:id' }],
  handler: async (args, call) => {
    const updates = args.updates as Array<Record<string, unknown>>
    const bodies = new Map<string, Record<string, unknown>>()
    for (const u of updates) {
      const { id, ...fields } = u
      const body: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(fields)) if (v !== undefined) body[k] = v
      if (Object.keys(body).length === 0) throw new Error(`task_update_bulk: the patch for ${String(id)} changes no field.`)
      // Two patches for one id would silently keep the last; say so instead.
      if (bodies.has(String(id))) throw new Error(`task_update_bulk: ${String(id)} appears twice; send one patch per task.`)
      bodies.set(String(id), body)
    }
    const rows = await bulkRows([...bodies.keys()], (id) => call('PATCH', `/tasks/${encodeURIComponent(id)}`, bodies.get(id)))
    return bulkResult(rows, 'updated. No session was started or stopped by this',
      'Nothing else is required; task_get reads any one of them.')
  },
  // The timeout covers the whole loop: each PATCH is a store write.
  timeoutMs: 120_000,
  tags: { readonly: false, remote: 'allow', destructive: false },
})

defineOp({
  name: 'task_complete_bulk',
  title: 'Complete many Walnut tasks in one call',
  description:
    'Mark up to 50 tasks done in ONE call, each with task_complete semantics (a task with running ' +
    'subtasks is refused and listed as failed; the others still complete). From a remote session this ' +
    'costs ONE write of the gateway budget instead of one per task.',
  input: {
    ids: z.array(z.string().min(1)).min(1).max(MAX_BULK_WRITE)
      .describe(`1 to ${MAX_BULK_WRITE} task ids (exact, or a unique id prefix)`),
  },
  routes: [{ method: 'POST', path: '/tasks/:id/complete' }],
  handler: async (args, call) => {
    const ids = [...new Set((args.ids as string[]).map((s) => s.trim()).filter(Boolean))]
    const rows = await bulkRows(ids, (id) => call('POST', `/tasks/${encodeURIComponent(id)}/complete`))
    return bulkResult(rows, 'marked complete. Their own live sessions are stopped; a leader hears about each unless the leader is you',
      'No further action is required.')
  },
  timeoutMs: 120_000,
  tags: { readonly: false, remote: 'allow', destructive: false },
})

defineOp({
  name: 'task_merge',
  title: 'Merge duplicate Walnut tasks',
  description:
    'Merge duplicate copies of a task into one survivor. Victims\' session links (session_ids, ' +
    'session slots, sessions.task_id) move onto the survivor BEFORE the victim rows are deleted, ' +
    'so no conversation history is lost. ALWAYS use this for duplicate cleanup — a plain ' +
    'task_delete on a duplicate destroys whichever session links that copy held. From a session on ' +
    'another host it reaches only your own work: your subtasks and the tasks in your own folder ' +
    '(a 403 names the ids out of reach); on the Walnut host it is not limited.',
  input: {
    survivor_id: z.string().min(1).describe('Task id (or unique prefix) that survives the merge'),
    victim_ids: z.array(z.string().min(1)).min(1).describe('Duplicate task ids to merge into the survivor and delete'),
  },
  // The one merge route is the legacy /api/tasks one; a v1 path 404s (the op
  // posted there until 2026-10-02 and never worked).
  routes: [{ method: 'POST', path: '/api/tasks/:survivor_id/merge' }],
  handler: async (args, call) => {
    const { survivor_id, victim_ids } = args
    const body = await call('POST', `/api/tasks/${encodeURIComponent(String(survivor_id))}/merge`, {
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
  // remote 'allow' with a server-side reach check (core/sessions/merge-reach.ts):
  // a remote session merges its own work, not the board.
  tags: { readonly: false, remote: 'allow', destructive: true },
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
  // The batch route deletes tasks too. The handler never sends it, but the `api`
  // passthrough must refuse it with this op (origin-policy.ts).
  routes: [{ method: 'DELETE', path: '/tasks/:id' }, { method: 'POST', path: '/tasks/batch/delete' }],
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

const TAG_DISPLAY_PATH = '/tasks/meta/tag-display'

defineOp({
  name: 'tag_display_list',
  title: 'List which tags a task shows',
  description:
    'The rules deciding how tags appear as pills on a task (rows, cards, table, detail badges, session header). ' +
    'Every tag is key:value. A rule names one tag (`label:urgent`) or a key (`ticket-id:*`, every tag starting ' +
    '`ticket-id:`) and says shown (whole tag), value (only the text after the key) or hidden; source is builtin ' +
    '(walnut:* machine tags never show), user, plugin (with pluginId), or default (Walnut\'s: labels read as their ' +
    'value, created:/updated: dates hidden). The user\'s rule beats a plugin\'s, a plugin\'s beats Walnut\'s default; ' +
    'an exact tag beats its key; a tag no rule names shows whole. Display only: hidden tags are still searched, ' +
    'filtered (task_list tag) and editable. `links` says what a tag\'s pill opens: a URL with {value} where the ' +
    'tag\'s value goes, from the user (an empty link means none) or a plugin (e.g. a ticket key to its tracker).',
  input: {},
  bind: { method: 'GET', path: TAG_DISPLAY_PATH },
  tags: { readonly: true, remote: 'allow' },
})

defineOp({
  name: 'tag_display_set',
  title: 'Show, shorten or hide a tag on tasks',
  description:
    'Set the user\'s rule for one tag or a key (`<key>:*`): shown (whole tag), value (only the text after ' +
    'the key, e.g. a ticket id without `ticket:`) or hidden on task pills. display null removes the user\'s ' +
    'rule, so a plugin default (or Walnut\'s) applies again. walnut:* is fixed. With link instead (or as well), ' +
    'sets what the pill opens: an http(s) URL with {value} where the tag\'s value goes, "" for no link, null to ' +
    'remove your link. Returns every rule and link now in force. Display only: nothing is removed from any task.',
  input: {
    pattern: z.string().min(1).describe('One tag (e.g. "label:urgent") or a key as "<key>:*" (e.g. "ticket-id:*")'),
    display: z.enum(['shown', 'value', 'hidden']).nullable().optional().describe('shown | value | hidden, or null to remove your rule'),
    link: z.string().nullable().optional().describe('URL template with {value}, e.g. "https://tracker.example.com/{value}"; "" = no link; null removes your link'),
  },
  bind: { method: 'PUT', path: TAG_DISPLAY_PATH },
  tags: { readonly: false, remote: 'deny' },
})
