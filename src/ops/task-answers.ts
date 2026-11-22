/**
 * task-answers.ts: what an agent reads back from the task ops (the policy is answer.ts).
 *
 * 2026-11-21: a week of sessions showed the task writes answering the whole task they had just
 * changed (task_complete p95 17,000 characters: the task with its 8,000-character note, field_at
 * with 20 timestamps, an engine switch's moved list) and task_get answering every field it holds
 * (p95 22,000, max 92,000). Their compact forms live here:
 *   - a write answers a receipt (receipt): the task's id, title, phase, status and project, the
 *     fields the call set, the counts and refusals it reports, ref, outcome and next;
 *   - task_get answers the task without Walnut's bookkeeping, its long texts cut with a pointer to
 *     the rest (compactTaskView), or only the fields asked for (pickTaskFields, every caller);
 *   - task_list and task_get_bulk rows are held to one answer, with an honest count (fitRows).
 * The executor shapes only an agent's answer; server code, the web UI and plugins read the raw
 * result, and `"_full": true` gives an agent the raw result for one call.
 *
 * Every text cut here goes through cutText (answer-text.ts) and so ends with the
 * `[Walnut cut: N more characters]` mark: a write given such a text back is refused, so a cut
 * note, description or list never replaces the whole one.
 */
import type { OpAnswer } from './answer.js'
import { cutText, isObj, jsonChars, jsonSize as size, type Obj } from './answer-text.js'

type Shape = NonNullable<OpAnswer['shape']>

/** How a receipt or a cut answer names the whole task. */
const WHOLE_TASK = 'task_get {"id":"<id>"}'
/**
 * A title is never cut under this: an agent may pass it back to task_update, and a real title
 * is a few words (the server cuts a session's long one when it is written).
 */
const TITLE_MAX = 200

/**
 * A value the call set, as a receipt names it: whole when small, else its JSON cut with the mark
 * (a string where a list or an object was), so it can never be sent back as the whole value.
 */
function shortValue(v: unknown, max = 160): unknown {
  if (typeof v === 'string') return cutText(v, max)
  if (v && typeof v === 'object' && size(v) > max) return cutText(JSON.stringify(v), max)
  return v
}

/** What the task asks the user now, cut to its state and its words. */
function shortStatus(us: unknown): Obj | undefined {
  if (!isObj(us) || typeof us.state !== 'string') return undefined
  return {
    state: us.state,
    ...(typeof us.ask === 'string' && us.ask ? { ask: cutText(us.ask, 300) } : {}),
    ...(typeof us.waitingOn === 'string' && us.waitingOn ? { waitingOn: cutText(us.waitingOn, 200) } : {}),
    ...(typeof us.until === 'string' && us.until ? { until: us.until } : {}),
  }
}

/** The run's state, with its error and what a queued start waits for. */
function shortExecution(ex: unknown): Obj | undefined {
  if (!isObj(ex) || typeof ex.state !== 'string') return undefined
  const out: Obj = { state: ex.state }
  for (const k of ['error', 'waiting_for', 'waits_for_host', 'queued_at']) {
    if (typeof ex[k] === 'string' && ex[k]) out[k] = cutText(ex[k], 300)
  }
  return out
}

/**
 * The task as a receipt names it: id, title, phase, project, the user's status and the run's
 * state, plus the stored value of each field the call set (`fields`; the argument's value when
 * the answer did not carry the field). `task.id`, `task.title` and `task.phase` stay where the
 * old answer had them, so a caller that read them there still does.
 */
export function taskReceipt(task: unknown, set: { fields?: string[]; args?: Obj } = {}): Obj {
  const t = isObj(task) ? task : {}
  const out: Obj = {}
  if (typeof t.id === 'string') out.id = t.id
  if (typeof t.title === 'string') out.title = cutText(t.title, TITLE_MAX)
  if (typeof t.phase === 'string') out.phase = t.phase
  if (typeof t.project === 'string') out.project = t.project
  // Where it sits: its folder and its leader.
  for (const k of ['group_id', 'parent_task_id']) if (typeof t[k] === 'string' && t[k]) out[k] = t[k]
  const status = shortStatus(t.user_status)
  if (status) out.user_status = status
  const execution = shortExecution(t.execution)
  if (execution) out.execution = execution
  for (const k of set.fields ?? []) {
    if (k in out) continue
    const v = k in t ? t[k] : set.args?.[k]
    if (v !== undefined) out[k] = shortValue(v)
  }
  return out
}

/** Keys whose words say what happened and what to do next: kept whole, last, in this order. */
const CLOSING = ['hint', 'error', 'code', 'ref', 'instruction', 'outcome', 'next', 'walnut_note'] as const
/** Never in a receipt, whatever their size: the object written and Walnut's bookkeeping of it. */
const NEVER = new Set([
  'note', 'summary', 'description', 'history', 'messages', 'conversation_log', 'field_at', 'applied_ops',
  'asks_answered', 'asks_withdrawn', 'engine_switch', 'completions', 'session_ids', 'legacy_session_ids',
])
/** Any other key of a result is kept when it is this small (a count, a flag, an id list, a reason). */
const SMALL_JSON = 400

function smallValue(key: string, v: unknown): unknown {
  if (typeof v === 'string') return cutText(v, /error/i.test(key) ? 600 : key === 'title' || key.endsWith('_title') ? TITLE_MAX : 300)
  if (v === null || typeof v !== 'object') return v
  return size(v) <= SMALL_JSON ? v : undefined
}

export interface ReceiptSpec {
  /** The task fields the call set, read from its arguments: named under `changed`, their values on `task`. */
  changed?: (args: Obj) => string[]
  /** A top-level key of the result in its own short form; undefined leaves it out. */
  keep?: Record<string, (value: unknown) => unknown>
  /** Keys the receipt adds, from the result and the arguments. */
  add?: (result: Obj, args: Obj) => Obj
  /** Only the headline, `add` and the closing words: the rest of the result is not about this task (the board's lists). */
  only?: boolean
}

/**
 * A write's receipt: what changed, never the object written. The headline (id, title, phase),
 * the task as taskReceipt names it, the fields the call set, every small key of the result (a
 * count, a flag, an error, a refusal's reasons), then ref, instruction, outcome and next.
 */
export function receipt(result: unknown, args: Obj, spec: ReceiptSpec = {}): unknown {
  if (!isObj(result)) return result
  const changed = spec.changed ? spec.changed(args) : []
  const out: Obj = {}
  for (const k of ['id', 'title', 'phase'] as const) {
    const v = result[k]
    if (v !== undefined) out[k] = k === 'title' && typeof v === 'string' ? cutText(v, TITLE_MAX) : v
  }
  if (isObj(result.task)) out.task = taskReceipt(result.task, { fields: changed, args })
  else if (result.task === null) out.task = null
  if (changed.length) out.changed = changed
  Object.assign(out, spec.add?.(result, args))
  if (!spec.only) {
    for (const [k, v] of Object.entries(result)) {
      if (k in out || k === 'task' || (CLOSING as readonly string[]).includes(k)) continue
      const own = spec.keep?.[k]
      const kept = own ? own(v) : NEVER.has(k) ? undefined : smallValue(k, v)
      if (kept !== undefined) out[k] = kept
    }
  }
  for (const k of CLOSING) if (result[k] !== undefined) out[k] = result[k]
  return out
}

/** A task write's answer policy: a receipt, the whole task read with task_get. */
export function taskReceiptAnswer(spec: ReceiptSpec = {}, max?: number): OpAnswer {
  return { kind: 'receipt', whole: WHOLE_TASK, ...(max ? { max } : {}), shape: ({ result, args }) => receipt(result, args, spec) }
}

/** The receipt of a task write with nothing of its own to keep. */
export const TASK_RECEIPT: OpAnswer = taskReceiptAnswer()

/** Arguments that steer a call but are not a field of the task (a guard's proof, a retry key, a launch option). */
const NOT_TASK_FIELDS = new Set([
  'id', 'force', 'reason', 'user_words', 'project_reason', 'confirm_new', 'new_reason', 'idempotency_key',
  'record_only', 'start_session', 'start_message', 'message', 'cwd', 'host', 'model', 'mode', 'engine', 'effort',
  'user_request', 'create_cwd', 'workspace', 'expect_reply', 'reply_timeout', 'hands_on', 'start_attempt_id', 'thread',
])
const fieldsSet = (args: Obj): string[] => Object.keys(args).filter((k) => args[k] !== undefined && !NOT_TASK_FIELDS.has(k))

/** Where task_create filed the task (or where its start runs), without the team it already leads. */
function placementReceipt(v: unknown): unknown {
  if (!isObj(v)) return v
  const out: Obj = {}
  for (const [k, x] of Object.entries(v)) {
    if (k === 'open_subtasks') { if (Array.isArray(x)) out.open_subtask_count = x.length + (typeof v.more_open_subtasks === 'number' ? v.more_open_subtasks : 0); continue }
    if (k === 'more_open_subtasks') continue
    out[k] = typeof x === 'string' ? cutText(x, 200) : x
  }
  return out
}

/** Rows naming other tasks (open subtasks): the first few, each id and phase (the outcome names their titles). */
function taskRows(v: unknown, max = 5): unknown {
  if (!Array.isArray(v)) return v
  return v.slice(0, max).map((r) => (isObj(r) ? { id: r.id, phase: r.phase } : r))
}

const reportOf = (r: Obj): Obj | undefined => (isObj(r.task) && isObj(r.task.result_report) ? r.task.result_report : undefined)

export const TASK_CREATE_ANSWER = taskReceiptAnswer({ changed: fieldsSet, keep: { placement: placementReceipt } }, 3_000)

export const TASK_UPDATE_ANSWER = taskReceiptAnswer({ changed: fieldsSet })

/** A completion's receipt keeps what it left not done (Partial) and the open subtasks it did not touch. */
export const TASK_COMPLETE_ANSWER = taskReceiptAnswer({
  keep: { open_subtasks: (v) => taskRows(v) },
  add: (r) => {
    const report = reportOf(r)
    const notDone = report && !report.settled && Array.isArray(report.not_done) ? report.not_done : []
    return notDone.length ? { not_done: notDone.slice(0, 8).map((x) => cutText(String(x), 200)) } : {}
  },
})

export const TASK_NOT_DONE_SETTLE_ANSWER = taskReceiptAnswer({
  add: (r) => {
    const settled = reportOf(r)?.settled
    return isObj(settled) ? { settled: { how: settled.how, ...(typeof settled.note === 'string' ? { note: cutText(settled.note, 200) } : {}) } } : {}
  },
})

/** A bulk write's rows: each id and whether it went through, a failure's error. */
export const TASK_BULK_ANSWER = taskReceiptAnswer({
  keep: {
    rows: (v) => (Array.isArray(v) ? v.map((r) => (isObj(r)
      ? { id: r.id, ok: r.ok, ...(typeof r.error === 'string' ? { error: cutText(r.error, 200) } : {}) } : r)) : v),
  },
}, 4_000)

/** task_pin_set (src/ops/work.ts): the route answers the whole board's pinned ids. */
export const TASK_PIN_SET_ANSWER = taskReceiptAnswer({
  only: true,
  add: (r, a) => ({ id: a.id, pinned: a.pinned, ...(Array.isArray(r.pinned_tasks) ? { pinned_count: r.pinned_tasks.length } : {}) }),
})

/** task_focus_tier_set (src/ops/work.ts): the route answers every tier of the board. */
export const TASK_FOCUS_TIER_SET_ANSWER = taskReceiptAnswer({ only: true, add: (_r, a) => ({ id: a.id, tier: a.tier }) })

// ── task_get ──────────────────────────────────────────────────────────────────

/**
 * How much of each long text task_get gives an agent under its own cap, in JSON characters (what
 * the cap counts: a tab, a quote or a newline is two); the rest is one call away (`fields`). The
 * summary is the note's own Executive Summary, which the head of the note already carries. A
 * smaller cap (the CLI's) gives each its share of it (textLimits).
 */
export const TASK_GET_TEXT_MAX = { note: 4_000, description: 1_500, summary: 600 } as const
/** task_get's cap for an agent. */
const TASK_GET_MAX = 12_000

type TextLimits = { note: number; description: number; summary: number }

/** `limits` for an answer held to `max` instead of `full`: each its share, never under a few lines. */
function textLimits(limits: TextLimits, max: number, full: number): TextLimits {
  if (max >= full) return limits
  const k = max / full
  return { note: Math.max(600, Math.floor(limits.note * k)), description: Math.max(300, Math.floor(limits.description * k)), summary: Math.max(200, Math.floor(limits.summary * k)) }
}
/** The most rows of a related-task list (children, dependents) task_get gives an agent. */
const RELATED_ROWS_MAX = 20
/** Standing instructions (Main's, a lead's) kept in task_get; the session's own prompt carries them whole. */
const INSTRUCTIONS_MAX = 1_500
/** A plugin's own data on the task, kept when this small. */
const EXT_MAX = 600

/**
 * Walnut's own bookkeeping on a task: no agent decides on it. task_get leaves it out for an
 * agent and names what it left out under `omitted`; `fields` reads any of it.
 */
const BOOKKEEPING = new Set([
  'status', 'field_at', 'applied_ops', 'created_by_op', 'completions', 'session_ids', 'legacy_session_ids',
  'plan_session_id', 'exec_session_id', 'summary_session_id', 'launch_source', 'routine_start', 'start_queue',
  'engine_pick', 'ledger_desc', 'last_session_update', '_syncedAt', '_synced_at', 'auto_links', 'link_names',
  'family_group_id', 'org_avatar', 'brief', 'brief_refresh', 'promise_alarm', 'needs_recheck', 'letter_recheck',
  'matter_news', 'recheck_watch', 'last_words', 'action_snoozes', 'asks_withdrawn', 'conversation_log',
  'has_note', 'has_summary', 'has_ext',
])

const hasValue = (v: unknown): boolean => v !== undefined && v !== null && v !== '' && !(Array.isArray(v) && v.length === 0)

/**
 * The longest field (in JSON characters) task_get's `fields` answers whole under a cap of `max`:
 * the cap less the id, the key and room for a second short field.
 */
const wholeFieldMax = (max: number): number => max - 500

/** The call that reads one field of the task whole: `_full` once the field alone is past the cap. */
function wholeFieldCall(id: string, key: string, text: string, max: number): string {
  return jsonChars(text) > wholeFieldMax(max)
    ? `task_get {"id":"${id}","fields":["${key}"],"_full":true}`
    : `task_get {"id":"${id}","fields":["${key}"]}`
}

/**
 * `out[key]` = `text` held to `max` JSON characters, cut at a line end with the mark, and beside it
 * `<key>_cut` naming the call that reads it whole. A text that fits is set as it is.
 */
function cutField(out: Obj, key: string, text: string, max: number, id: string, answerMax = TASK_GET_MAX): void {
  const kept = cutText(text, max, { json: true, lineEnd: true })
  out[key] = kept
  if (kept !== text) out[`${key}_cut`] = `${wholeFieldCall(id, key, text, answerMax)} reads it whole`
}

/** A related task (child, dependent, parent) as a row: id, title, phase, and what it asks the user. */
function relatedRow(r: unknown): unknown {
  if (!isObj(r)) return r
  const status = shortStatus(r.user_status)
  return { id: r.id, title: typeof r.title === 'string' ? cutText(r.title, TITLE_MAX) : r.title, phase: r.phase, ...(status ? { user_status: status } : {}) }
}

/** The latest engine switch or move, without the moved list and the message it carried. */
function engineSwitchView(v: unknown): unknown {
  if (!isObj(v)) return v
  const out: Obj = {}
  for (const k of ['state', 'at', 'to', 'move', 'from_host', 'session_id', 'resumed', 'moved_count']) if (v[k] !== undefined) out[k] = v[k]
  if (typeof v.error === 'string') out.error = cutText(v.error, 300)
  if (Array.isArray(v.moved)) out.moved_count = v.moved.length
  return out
}

/**
 * A task as task_get gives it to an agent: every field an agent decides on (phase, execution,
 * the wait fields, parent, tags, links, result_report, user_status, its requests and asks), the
 * long texts cut to `limits` with a pointer to the rest, the related-task lists cut to their
 * first rows, and Walnut's bookkeeping left out (named under `omitted`). `answerMax` is the cap
 * the answer is held to, which decides whether reading a field whole needs `_full`.
 */
export function compactTaskView(task: Obj, limits: TextLimits = TASK_GET_TEXT_MAX, answerMax = TASK_GET_MAX): Obj {
  const id = typeof task.id === 'string' ? task.id : ''
  const out: Obj = {}
  const omitted: string[] = []
  for (const [k, v] of Object.entries(task)) {
    if (BOOKKEEPING.has(k)) { if (hasValue(v)) omitted.push(k); continue }
    if (k === 'note' || k === 'description' || k === 'summary') {
      if (typeof v === 'string') cutField(out, k, v, limits[k], id, answerMax)
      else out[k] = v
      continue
    }
    if (k === 'asks_answered' && task.ask_answered) { if (hasValue(v)) omitted.push(k); continue }
    if (k === 'engine_switch') { out[k] = engineSwitchView(v); continue }
    if (k === 'parent') { out[k] = relatedRow(v); continue }
    if ((k === 'children' || k === 'dependents' || k === 'resolved_dependencies') && Array.isArray(v)) {
      out[k] = v.slice(0, RELATED_ROWS_MAX).map(relatedRow)
      if (v.length > RELATED_ROWS_MAX) {
        out[`${k}_more`] = `${v.length - RELATED_ROWS_MAX} more`
          + (k === 'children' ? `: task_list {"parent_task_id":"${id}"} lists them all` : '')
      }
      continue
    }
    if (k === 'org_instructions' && isObj(v) && typeof v.text === 'string' && jsonChars(v.text) > INSTRUCTIONS_MAX) {
      const text: Obj = {}
      cutField(text, 'text', v.text, INSTRUCTIONS_MAX, id, answerMax)
      out[k] = { ...v, ...text, text_cut: `${wholeFieldCall(id, 'org_instructions', v.text, answerMax)} reads them whole` }
      continue
    }
    if (k === 'ext' && size(v) > EXT_MAX) { omitted.push(k); continue }
    out[k] = v
  }
  if (omitted.length) out.omitted = omitted
  return out
}

/** The field names `fields` asks for: a list, or one comma list. */
export function askedFields(v: unknown): string[] | undefined {
  const list = typeof v === 'string' ? v.split(',') : Array.isArray(v) ? v.map(String) : undefined
  const names = list?.map((s) => s.trim()).filter(Boolean)
  return names?.length ? names : undefined
}

/**
 * task_get with `fields`: the id and those fields only, whole (the task's own, or a line the
 * answer adds beside it: deliverable, latest); a name the task has no value for is listed in `absent`.
 */
export function pickTaskFields(answer: Obj, fields: string[]): Obj {
  const task = isObj(answer.task) ? answer.task : {}
  const out: Obj = { id: answer.id ?? task.id }
  const absent: string[] = []
  for (const f of fields) {
    if (f === 'id') continue
    const v = f in task ? task[f] : answer[f]
    if (v === undefined) absent.push(f)
    else out[f] = v
  }
  return absent.length ? { ...out, absent } : out
}

/**
 * A `fields` answer over the cap: its longest texts cut with the mark until it fits, each with
 * `<key>_cut` naming `_full`, so a field that is not whole never reads as whole.
 */
function fitFields(result: Obj, max: number): Obj {
  if (size(result) <= max) return result
  const out: Obj = { ...result }
  const id = String(out.id ?? '')
  const texts = Object.keys(out).filter((k) => k !== 'id' && typeof out[k] === 'string').sort((a, b) => size(out[b]) - size(out[a]))
  for (const k of texts) {
    // Room for this field: what the answer is over by comes off it, with space for its `_cut` line.
    const over = size(out) - max + 200
    if (over <= 0) break
    const text = out[k] as string
    out[k] = cutText(text, Math.max(200, jsonChars(text) - over), { json: true, lineEnd: true })
    out[`${k}_cut`] = `task_get {"id":"${id}","fields":["${k}"],"_full":true} reads it whole`
  }
  return out
}

const taskGetShape: Shape = ({ result, args, max }) => {
  if (!isObj(result)) return result
  // Fields asked for are already the answer (pickTaskFields): whole when they fit, else marked.
  if (askedFields(args.fields)) return fitFields(result, max)
  if (!isObj(result.task)) return result
  return { ...result, task: compactTaskView(result.task, textLimits(TASK_GET_TEXT_MAX, max, TASK_GET_MAX), max) }
}

export const TASK_GET_ANSWER: OpAnswer = { kind: 'content', max: TASK_GET_MAX, whole: WHOLE_TASK, shape: taskGetShape }

// ── task_list and task_get_bulk ───────────────────────────────────────────────

/** A list or bulk answer under its own cap: the most rows that fit, never a row cut off at the end without a word. */
const LIST_ANSWER_MAX = 12_000
/** First guess at the room the hint fitRows writes takes; the fit is then checked whole. */
const FIT_ROOM = 400

/**
 * `result` with its `key` rows held to `max` characters: the first rows that fit, `count` set to
 * the rows given and `truncated` to true, and the hint saying how many were left out and how to
 * read them (`more`). A result that fits is returned with the rows as given.
 */
function fitRows(result: Obj, key: string, rows: unknown[], max: number, more: (left: unknown[]) => string): Obj {
  const whole: Obj = { ...result, [key]: rows }
  if (size(whole) <= max) return whole
  let used = size({ ...result, [key]: [] }) + FIT_ROOM
  let kept = 0
  for (const row of rows) {
    used += size(row) + 1
    if (used > max) break
    kept++
  }
  const answer = (n: number): Obj => {
    const words = `${rows.length - n} more row(s) did not fit in this answer: ${more(rows.slice(n))}`
    return {
      ...result,
      [key]: rows.slice(0, n),
      ...('count' in result ? { count: n } : {}),
      ...('truncated' in result ? { truncated: true } : {}),
      hint: typeof result.hint === 'string' && result.hint ? `${result.hint} ${words}` : words,
    }
  }
  let out = answer(Math.max(1, kept))
  // The hint names the rows left out, so its own size moves with the cut: check the whole answer.
  while (kept > 1 && size(out) > max) out = answer(--kept)
  return out
}

const idsOf = (rows: unknown[]): string[] => rows.flatMap((r) => (isObj(r) && typeof r.id === 'string' ? [r.id] : []))

/** A slim task_list row with its long words cut: what it asks, what it waits on, the asks below it. */
function leanRowView(row: unknown): unknown {
  if (!isObj(row)) return row
  const out: Obj = { ...row }
  if (typeof row.title === 'string') out.title = cutText(row.title, TITLE_MAX)
  if (isObj(row.user_status)) {
    out.user_status = Object.fromEntries(Object.entries(row.user_status).map(([k, v]) => [k, typeof v === 'string' ? cutText(v, 300) : v]))
  }
  if (Array.isArray(row.asks_below) && row.asks_below.length) {
    out.asks_below = row.asks_below.slice(0, 3).map((a) => (isObj(a) ? { ...a, ...(typeof a.ask === 'string' ? { ask: cutText(a.ask, 200) } : {}) } : a))
    if (row.asks_below.length > 3) out.asks_below_more = row.asks_below.length - 3
  }
  return out
}

/** A full task_list row (fields=full) or a bulk row: its texts held to a share of one answer. */
const ROW_TEXT_MAX = { note: 600, description: 300, summary: 300 } as const

const taskListShape: Shape = ({ result, args, max }) => {
  if (!isObj(result) || !Array.isArray(result.tasks)) return result
  const full = args.fields === 'full'
  const rows = result.tasks.map((row) => (!isObj(row) ? row : full ? compactTaskView(row, ROW_TEXT_MAX, max) : leanRowView(row)))
  return fitRows(result, 'tasks', rows, max,
    (left) => `narrow the filters, read them with task_get_bulk {"ids":${JSON.stringify(idsOf(left).slice(0, 50))}}, or repeat with "_full": true.`)
}

export const TASK_LIST_ANSWER: OpAnswer = { kind: 'content', max: LIST_ANSWER_MAX, whole: WHOLE_TASK, shape: taskListShape }

const taskGetBulkShape: Shape = ({ result, max }) => {
  if (!isObj(result) || !Array.isArray(result.tasks)) return result
  const n = Math.max(1, result.tasks.length)
  // Each row's texts get an even share of the answer, never less than a few lines.
  const share = Math.min(1, max / LIST_ANSWER_MAX)
  const limits = {
    note: Math.max(400, Math.floor((8_000 * share) / n)),
    description: Math.max(300, Math.floor((3_000 * share) / n)),
    summary: Math.max(300, Math.floor((4_000 * share) / n)),
  }
  const rows = result.tasks.map((row) => {
    if (!isObj(row)) return row
    const id = typeof row.id === 'string' ? row.id : ''
    const out: Obj = {}
    for (const [k, v] of Object.entries(row)) {
      if ((k === 'note' || k === 'description' || k === 'summary') && typeof v === 'string') cutField(out, k, v, limits[k], id, max)
      else out[k] = v
    }
    return out
  })
  return fitRows(result, 'tasks', rows, max,
    (left) => `task_get_bulk ${JSON.stringify({ ids: idsOf(left) })} reads them.`)
}

export const TASK_GET_BULK_ANSWER: OpAnswer = { kind: 'content', max: LIST_ANSWER_MAX, whole: WHOLE_TASK, shape: taskGetBulkShape }
