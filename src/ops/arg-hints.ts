/**
 * Unknown op argument keys (parseOpArgs): read under the key meant when that is
 * certain, else refused with a "did you mean" hint.
 *
 * The caller is almost always an agent, and a refusal costs it one more model
 * request: 1,389 refusals for an unknown key on one host in three days
 * (2026-11-23), most of them a usual other name for a declared key.
 *
 * Read as the declared key (inferRenames; the answer's walnut_note says so, so
 * the caller learns the name), only at the top level, only when the call did not
 * set that key (or set it to the very same value: the other name is dropped),
 * only when the whole call then validates, never for a key with its own line
 * (KEY_NOTES), and only for:
 *   - a spelling of a declared key: case, `_` and `-` aside (`taskId` -> `task_id`);
 *   - on a core op (registry owner "core"; a plugin's op never, whatever its name),
 *     another name for what the call is about: `task`, `task_id` (any spelling)
 *     for the op's one task key, `thread`, `thread_id` for its one thread key,
 *     `letter`, `letter_id` for its one letter key, and `id` for the one key of
 *     the thing the op is named for (a task_ or team_ op's task, a thread_ op's
 *     thread, a human_inbox_ op's letter). A board op's own `id` is a post or a
 *     project, so a bare `id` there is no guess at its task;
 *   - a usual other name (OTHER_NAMES `read`) for exactly one declared key.
 * An op's own other names (WalnutOp.renamedInput) are moved before validation
 * and noted the same way (executor.ts).
 *
 * Everything else is refused, from the call as it came, and the refusal helps:
 *   - a typo: the unknown key is one or two edits (a swap counts as one) from
 *     exactly one closest declared key the call did not set (`titel` -> `title`);
 *   - a stand-in: the object has exactly one unknown key, it is no near miss of
 *     any declared key, and exactly one required key is missing;
 *   - a usual other name or spelling whose call still fails another way, or a
 *     name that only often means the key (OTHER_NAMES `hint`: `filter` for `q`).
 *     2026-11-01: a small local model called task_list with `query` and, told
 *     only that the key was unknown, gave up and blamed the user.
 * Anything else (several candidates, several unknown keys with no typo, an
 * unrelated name) gets no "did you mean". Every unknown-key refusal also names
 * the keys the object takes (declaredKeysNote), "did you mean" or not, so the
 * next call can be right; a few well-known wrong keys get a line saying what to
 * do instead (unknownKeyNotes): a key in another unit (`timeout` where the op
 * takes `timeout_ms`) is never read as it, it is told the key and its unit. A
 * list where the op takes one comma-separated string gets that string spelled
 * out (invalidTypeHint); any other value of the wrong kind gets the key's own
 * description (keyMeaningHint). No value is coerced.
 */

import type { z } from 'zod'

type Shape = Record<string, z.ZodType>

const WRAPPERS = new Set(['optional', 'nullable', 'default', 'prefault', 'readonly', 'catch', 'nonoptional'])

function defOf(schema: unknown): { type?: string; [k: string]: unknown } | undefined {
  return (schema as { _zod?: { def?: { type?: string } } } | undefined)?._zod?.def
}

/** Strip optional/default/pipe wrappers down to the schema that holds the shape. */
function unwrap(schema: unknown): unknown {
  for (let i = 0; i < 16; i++) {
    const def = defOf(schema)
    if (!def) return schema
    if (def.type && WRAPPERS.has(def.type)) schema = def.innerType
    else if (def.type === 'pipe') schema = def.in
    else return schema
  }
  return schema
}

/** The declared shape of the object at `path` inside the op input, if it is one. */
function shapeAt(root: Shape, path: PropertyKey[]): Shape | undefined {
  let shape: Shape | undefined = root
  let node: unknown
  for (const seg of path) {
    if (shape) {
      if (typeof seg !== 'string' || !Object.prototype.hasOwnProperty.call(shape, seg)) return undefined
      node = unwrap(shape[seg])
      shape = undefined
    } else {
      const def = defOf(node)
      if (def?.type !== 'array' || typeof seg !== 'number') return undefined
      node = unwrap(def.element)
    }
    const def = defOf(node)
    if (def?.type === 'object') shape = def.shape as Shape
  }
  return shape
}

function valueAt(data: unknown, path: PropertyKey[]): unknown {
  let v = data
  for (const seg of path) {
    if (typeof v !== 'object' || v === null) return undefined
    v = (v as Record<PropertyKey, unknown>)[seg]
  }
  return v
}

/** Optimal string alignment distance: insert, delete, substitute, swap neighbours. */
export function editDistance(a: string, b: string): number {
  const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)])
  for (let j = 1; j <= b.length; j++) d[0][j] = j
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost)
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1)
    }
  }
  return d[a.length][b.length]
}

/**
 * Usual other names for a declared key, the way models and people reach for
 * them. A name listed for several keys counts only where the op declares exactly
 * one of them (`prompt` reads as `text` for task_send, `message` for task_start).
 *  - `read`: means the key on every op that declares it, in the same unit (every
 *    `limit` is a count of rows): a call using one is read as the key (inferRenames).
 *  - `hint`: often means the key, sometimes something else (task_list `filter` is
 *    meant as a phase filter, `body` or `content` as the letter body rather than
 *    human_inbox_send's preview `text`): a refusal names the key, nothing is read.
 *    An op that knows the name means its key lists it in its renamedInput.
 *  - `notOn`: ops whose key of that name means another thing (thread_get's
 *    `message` is a message id): neither read nor hinted there.
 * Never list a name of another unit.
 */
const OTHER_NAMES: Record<string, { read: readonly string[]; hint?: readonly string[]; notOn?: readonly string[] }> = {
  q: { read: ['query', 'search', 'keyword', 'keywords', 'term', 'terms'], hint: ['filter', 'text'] },
  limit: { read: ['max', 'max_results', 'count', 'top', 'n', 'size', 'page_size'] },
  project: { read: ['project_name', 'projectName'] },
  text: { read: ['prompt', 'message', 'msg'], hint: ['body', 'content'], notOn: ['human_inbox_send', 'browser'] },
  message: { read: ['prompt', 'text', 'msg'], hint: ['body', 'content'], notOn: ['thread_get', 'thread_split', 'router_context'] },
}

/** The keys `key` is a usual other name of on `op`: read ones only, or (`hints`) hint ones too. */
function otherNameTargets(key: string, declared: readonly string[], op: string | undefined, hints: boolean): string[] {
  return Object.keys(OTHER_NAMES).filter((k) => {
    const n = OTHER_NAMES[k]
    if (!declared.includes(k) || (op !== undefined && n.notOn?.includes(op))) return false
    return n.read.includes(key) || (hints && !!n.hint?.includes(key))
  })
}

/**
 * Wrong keys that mean something the op does another way, or the same thing in
 * another unit: the line says how, the value is never read. An entry applies
 * where the op declares `declared` and, with `ops`, only to those ops.
 * The keys are 2026-11-20 to 11-23 refusals of real calls.
 */
export const KEY_NOTES: readonly { keys: readonly string[]; declared?: string; ops?: readonly string[]; note: (key: string) => string }[] = [
  // 2026-11-06: task_list with include_completed; completed tasks are in by default.
  {
    declared: 'completion',
    keys: ['include_completed', 'include_complete', 'include_done', 'show_completed', 'completed'],
    note: (key) => `"${key}" is no key here: completed tasks are already listed by default; `
      + 'to leave them out pass "completion" (e.g. "todo,in_progress")',
  },
  // A time limit in another unit: seconds read as milliseconds would end a run at once.
  {
    declared: 'timeout_ms',
    keys: ['timeout', 'timeoutSeconds', 'timeout_seconds', 'timeout_s', 'timeout_sec', 'timeout_secs', 'timeout_min', 'seconds'],
    note: (key) => `"${key}" is no key here: the time limit is "timeout_ms", in milliseconds (120000 = 2 minutes)`,
  },
  {
    declared: 'timeoutSeconds',
    keys: ['timeout', 'timeout_ms', 'timeoutMs', 'timeout_s', 'timeout_sec', 'seconds'],
    note: (key) => `"${key}" is no key here: the time limit is "timeoutSeconds", in seconds`,
  },
  {
    declared: 'timeout_min',
    keys: ['timeout', 'timeout_ms', 'timeoutMs', 'timeoutSeconds', 'timeout_seconds', 'timeout_s'],
    note: (key) => `"${key}" is no key here: the time limit is "timeout_min", in minutes`,
  },
  // Keys whose content the caller thinks is saved: refused, with where it goes.
  {
    ops: ['task_update'],
    keys: ['summary'],
    note: (key) => `"${key}" is no key here: "description" replaces the task's description, "report" sets what it `
      + 'waits on next; a result of finished work goes in task_complete "result"',
  },
  {
    ops: ['task_note_write'],
    keys: ['section', 'heading', 'title'],
    note: (key) => `"${key}" is no key here: the note is one Markdown text, replaced whole or added to with `
      + 'mode "append"; put a heading in content',
  },
  {
    ops: ['task_create'],
    keys: ['parent_task_id', 'parent', 'parent_id'],
    note: (key) => `"${key}" is no key here: a task created from your task is filed as its subtask already; `
      + 'task_update "parent_task_id" adopts an existing task',
  },
  // Names that often mean a key and here mean another (OTHER_NAMES `hint`): say which key is which.
  {
    ops: ['human_inbox_send'],
    keys: ['body', 'content', 'message'],
    note: (key) => `"${key}" is no key here: the letter's body is "markdown" (or "html"); "text" is only the short preview`,
  },
  {
    ops: ['task_create'],
    keys: ['content', 'body'],
    note: (key) => `"${key}" is no key here: the task's text is "description"; "message" is what its work starts with`,
  },
  {
    ops: ['task_list'],
    keys: ['filter'],
    note: (key) => `"${key}" is no key here: "q" searches titles; "phases" or "completion" filter by state`,
  },
  // Keys naming a thing the op does not take.
  {
    ops: ['agent_memory_read'],
    keys: ['id'],
    note: (key) => `"${key}" is no key here: "task" names whose memory to read (a task id, default yours), "file" one file of it`,
  },
  {
    ops: ['thread_list'],
    keys: ['id', 'thread', 'thread_id'],
    note: (key) => `"${key}" is no key here: "task" names whose threads to list, "ids" lists only these; thread_get "id" reads one`,
  },
  {
    // A board op's own `id` is a post or a project, so a bare one is never read as the board's task.
    ops: ['board_get', 'board_set', 'board_edit', 'board_post', 'board_remind', 'board_lanes_set', 'board_card_set'],
    keys: ['id'],
    note: (key) => `"${key}" is no key here: the board's task is "task" (default: your team's board)`,
  },
  {
    // 2026-11-27: memory_read called with a search; it reads one whole file.
    ops: ['memory_read'],
    keys: ['query', 'q', 'search', 'keyword', 'keywords', 'term', 'text'],
    note: (key) => `"${key}" is no key here: memory_read reads one whole memory file ("doc": global or user); `
      + 'to search memory, notes and past work, use search "q"',
  },
  {
    ops: ['host_load'],
    keys: ['host', 'hosts'],
    note: (key) => `"${key}" is no key here: host_load reads every host; host_get "host" reads one`,
  },
  {
    ops: ['trigger_delete', 'trigger_pause', 'trigger_resume'],
    keys: ['name'],
    note: (key) => `"${key}" is no key here: this takes the trigger's "id"; trigger_list "name" finds it`,
  },
]

/**
 * The declared key `key` is a typo of: `near` when any declared key is within
 * reach (case-only differences included), `target` only when exactly one is
 * closest. Short keys need proportionally closer matches.
 */
function typoMatch(key: string, declared: string[]): { near: boolean; target?: string } {
  let best: string | undefined
  let bestD = Infinity
  let tie = false
  for (const c of declared) {
    if (c === key) continue
    const d = editDistance(key.toLowerCase(), c.toLowerCase())
    if (d > 2 || d * 2 > Math.min(key.length, c.length)) continue
    if (d < bestD) { best = c; bestD = d; tie = false } else if (d === bestD) tie = true
  }
  return { near: best !== undefined, target: tie ? undefined : best }
}

/** A key's spelling with case, `_` and `-` set aside: `taskId`, `task_id` and `TaskID` read alike. */
function spelling(key: string): string {
  return key.toLowerCase().replace(/[_-]/g, '')
}

/** The things an id names that ops are about, and the key names for each (by spelling). */
type Subject = 'task' | 'thread' | 'letter'
const SUBJECT_NAMES: Record<Subject, readonly string[]> = {
  task: ['task', 'taskid'],
  thread: ['thread', 'threadid'],
  letter: ['letter', 'letterid'],
}

function subjectNamed(key: string): Subject | undefined {
  const s = spelling(key)
  return (Object.keys(SUBJECT_NAMES) as Subject[]).find((k) => SUBJECT_NAMES[k].includes(s))
}

/**
 * The thing a core op is about, by its name: what its own `id` names and what a bare `id` in a
 * call means. A plugin's op (`<plugin>_<name>`) is about none of them, whatever its name. A board
 * op is about none either: its own `id` is a post or a project, and a bare `id` is no guess at its
 * task (only `task_id` or `taskId` is).
 */
function opSubject(op: string | undefined): Subject | undefined {
  if (!op) return undefined
  if (/^(task|team)_/.test(op)) return 'task'
  if (op.startsWith('thread_')) return 'thread'
  if (op.startsWith('human_inbox_')) return 'letter'
  return undefined
}

/** The thing the declared key `key` of the core op `op` names, if it names one of them. */
function declaredSubject(key: string, op: string): Subject | undefined {
  return key === 'id' ? opSubject(op) : subjectNamed(key)
}

/**
 * The declared key an unknown `key` means for certain, or undefined: a spelling of it, another
 * name for what the call is about (`core`: a core op's name, top level only), or a usual other
 * name (with `hints`, the hint-only ones too); each only when exactly one declared key fits.
 * Whether the call already set that key is the caller's check.
 */
function meantKey(key: string, declared: readonly string[], op: string | undefined, core: string | undefined, hints: boolean): string | undefined {
  const one = (c: readonly string[]) => (c.length === 1 ? c[0] : undefined)
  const spelled = declared.filter((k) => spelling(k) === spelling(key))
  if (spelled.length) return one(spelled)
  const kind = !core ? undefined : spelling(key) === 'id' ? opSubject(core) : subjectNamed(key)
  if (kind && core) {
    const same = declared.filter((k) => declaredSubject(k, core) === kind)
    if (same.length) return one(same)
  }
  return one(otherNameTargets(key, declared, op, hints))
}

/** Two argument values alike: the same JSON. */
function sameValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

/**
 * The unknown top-level keys of a call to `op` to read as declared keys, as [from, to] pairs:
 * each to a key the call did not set, or set to the very same value (`dup`: the other name is
 * only dropped, as renamedInput does), never two to one key, never a key with its own line
 * (KEY_NOTES). `core`: the op is Walnut's own (registry owner "core"), so the id names apply.
 * parseOpArgs keeps them only when the call then validates.
 */
export function inferRenames(op: string, root: Shape, given: Record<string, unknown>, keys: readonly string[], core = false): { from: string; to: string; dup: boolean }[] {
  const declared = Object.keys(root)
  const picks: { from: string; to: string; dup: boolean }[] = []
  for (const key of keys) {
    if (keyNote(root, [], key, op)) continue
    const to = meantKey(key, declared, op, core ? op : undefined, false)
    if (!to) continue
    if (given[to] === undefined) picks.push({ from: key, to, dup: false })
    else if (sameValue(given[to], given[key])) picks.push({ from: key, to, dup: true })
  }
  return picks.filter((p) => picks.filter((o) => o.to === p.to).length === 1)
}

/** The line an answer carries for keys read under another name, so the next call uses the right one. */
export function renameNote(op: string, renamed: readonly (readonly [string, string])[]): string {
  const pairs = renamed.map(([from, to]) => `"${from}" as "${to}"`).join(', ')
  return `Read ${pairs}, the ${renamed.length === 1 ? 'key' : 'keys'} ${op} takes.`
}

/**
 * The hint for one `unrecognized_keys` issue (`; did you mean "q"?`), or '' when
 * the intended key is not clear. `data` is the args as they were validated.
 */
export function unknownKeyHint(root: Shape, data: unknown, path: PropertyKey[], keys: string[], op?: string, core = false): string {
  const shape = shapeAt(root, path)
  const obj = valueAt(data, path)
  if (!shape || keys.length === 0 || typeof obj !== 'object' || obj === null || Array.isArray(obj)) return ''
  const given = obj as Record<string, unknown>
  const declared = Object.keys(shape)

  const picks = new Map<string, string>()
  // A key with its own line (unknownKeyNotes) gets that line, never a guess beside it.
  const guessed = keys.filter((key) => !keyNote(shape, path, key, op))
  // The key a call is read as first: "message" on task_send means text, never the messageId it is two edits from.
  for (const key of guessed) {
    const target = meantKey(key, declared, path.length ? undefined : op, core && !path.length ? op : undefined, true)
    if (target && given[target] === undefined) picks.set(key, target)
  }
  let near = false
  for (const key of guessed) {
    const m = typoMatch(key, declared)
    near ||= m.near
    // The closest key is already set: a duplicate, not a typo of it.
    if (!picks.has(key) && m.target && given[m.target] === undefined) picks.set(key, m.target)
  }
  // Two unknown keys aimed at one declared key: neither is clear.
  const aimed = [...picks.values()]
  for (const [key, target] of [...picks]) {
    if (aimed.indexOf(target) !== aimed.lastIndexOf(target)) picks.delete(key)
  }

  // A key that looks like a typo of some declared key is never read as a stand-in for another.
  if (!near && keys.length === 1 && guessed.length === 1 && !picks.has(keys[0])) {
    const missing = declared.filter((k) => given[k] === undefined && !shape[k].safeParse(undefined).success)
    if (missing.length === 1) picks.set(keys[0], missing[0])
  }
  if (picks.size === 0) return ''
  if (keys.length === 1) return `; did you mean "${picks.get(keys[0])}"?`
  return `; did you mean ${[...picks].map(([key, target]) => `"${target}" for "${key}"`).join(', ')}?`
}

/**
 * The keys the object at `path` takes, for an unknown-key refusal that names no
 * intended key: `; task_list takes: completion, phases, project, q, …`. '' when
 * the schema cannot be walked there.
 */
export function declaredKeysNote(root: Shape, path: PropertyKey[], what: string): string {
  const shape = shapeAt(root, path)
  if (!shape) return ''
  const keys = Object.keys(shape)
  if (keys.length === 0) return ''
  const shown = keys.slice(0, 40)
  return `; ${what} takes: ${shown.join(', ')}${keys.length > shown.length ? ', …' : ''}`
}

/**
 * Lines for well-known wrong keys at `path` of a call to `op`
 * (`; "include_completed" is no key here: ...`), or ''. An entry for named ops applies at the top level.
 */
export function unknownKeyNotes(root: Shape, path: PropertyKey[], keys: string[], op?: string): string {
  const shape = shapeAt(root, path)
  if (!shape) return ''
  return keys.map((key) => {
    const hit = keyNote(shape, path, key, op)
    return hit ? `; ${hit.note(key)}` : ''
  }).join('')
}

function keyNote(shape: Shape, path: PropertyKey[], key: string, op: string | undefined): (typeof KEY_NOTES)[number] | undefined {
  return KEY_NOTES.find((n) => n.keys.includes(key)
    && (n.declared === undefined || Object.prototype.hasOwnProperty.call(shape, n.declared))
    && (n.ops === undefined || (path.length === 0 && op !== undefined && n.ops.includes(op))))
}

/**
 * A value of another kind than its key takes (an object key given a string, a choice given a list):
 * what the key is, from its own description, so the next call is right. `code` is zod's issue code:
 * a choice given a string is told its options by zod already. 2026-11-26 and 27: host_exec
 * `wait_for: "exit"` and task_list `fields: ["id", "title"]` were refused with the types alone.
 */
export function keyMeaningHint(root: Shape, data: unknown, path: PropertyKey[], code: string): string {
  const key = path[path.length - 1]
  if (typeof key !== 'string') return ''
  const value = valueAt(data, path)
  // A key left out is told it is required, as before; a choice given a string has its options from zod.
  if (value === undefined || (code === 'invalid_value' && typeof value === 'string')) return ''
  if (code !== 'invalid_type' && code !== 'invalid_value') return ''
  const shape = shapeAt(root, path.slice(0, -1))
  if (!shape || !Object.prototype.hasOwnProperty.call(shape, key)) return ''
  const d = descriptionOf(shape[key]).trim()
  if (!d) return ''
  return `; ${key} is: ${d.length > 300 ? `${d.slice(0, 300)}…` : d}`
}

/** The field's description, read through its optional/default/pipe wrappers. */
function descriptionOf(schema: unknown): string {
  for (let i = 0; i < 16 && schema; i++) {
    const d = (schema as { description?: unknown }).description
    if (typeof d === 'string' && d) return d
    const def = defOf(schema)
    if (def?.type && WRAPPERS.has(def.type)) schema = def.innerType
    else if (def?.type === 'pipe') schema = def.in
    else return ''
  }
  return ''
}

/**
 * For an `invalid_type` issue where the op takes ONE comma-separated string and
 * the call sent a list of plain values, the string it should have sent:
 * `; types takes one comma-separated string, e.g. "task,session", not a list`.
 * 2026-11-06: search with "types":["task","session"]. '' otherwise; the call is
 * still refused, never joined for it.
 */
export function invalidTypeHint(root: Shape, data: unknown, path: PropertyKey[], expected: unknown): string {
  if (expected === 'array' && path.length) {
    // The other way round: a list key given one string (thread_create supersedes "th-...").
    const value = valueAt(data, path)
    const key = path[path.length - 1]
    if (typeof value !== 'string' || typeof key !== 'string') return ''
    const items = value.split(',').map((v) => v.trim()).filter(Boolean)
    return `; ${key} takes a list, e.g. ${JSON.stringify(items.length ? items : [value])}, not a string`
  }
  if (expected !== 'string' || path.length === 0) return ''
  const value = valueAt(data, path)
  if (!Array.isArray(value) || value.length === 0) return ''
  if (!value.every((v) => typeof v === 'string' || typeof v === 'number')) return ''
  const key = path[path.length - 1]
  const shape = shapeAt(root, path.slice(0, -1))
  if (typeof key !== 'string' || !shape || !Object.prototype.hasOwnProperty.call(shape, key)) return ''
  if (!/comma/i.test(descriptionOf(shape[key]))) return ''
  return `; ${key} takes one comma-separated string, e.g. ${JSON.stringify(value.join(','))}, not a list`
}
