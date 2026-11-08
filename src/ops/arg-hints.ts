/**
 * "Did you mean" hints for an unknown op argument key (parseOpArgs).
 *
 * The caller is almost always an agent; `Unrecognized key: "query"` alone costs
 * it a `tools help` round trip. A hint is added only when the intended key is
 * clear, and the args are never rewritten:
 *   - a typo: the unknown key is one or two edits (a swap counts as one, case
 *     is free) from exactly one closest declared key, and the call did not set
 *     that key (`titel` -> `title`, `Limit` -> `limit`);
 *   - a stand-in: the object has exactly one unknown key, it is no near miss of
 *     any declared key, and exactly one required key is missing (`search`
 *     called with `query` where `q` is required).
 *   - a common other name: the unknown key is a usual word for exactly one
 *     declared key the call did not set (`query` or `search` for `q`, `max` for
 *     `limit`, `prompt` for `text` or `message`, whichever the op declares).
 *     2026-11-01: a small local model called task_list with `query` and, told
 *     only that the key was unknown, gave up and blamed the user.
 * Anything else (several candidates, several unknown keys with no typo, an
 * unrelated name) gets no "did you mean". Every unknown-key refusal also names
 * the keys the object takes (declaredKeysNote), "did you mean" or not, so the
 * next call can be right; a few well-known wrong keys get a line saying what to
 * do instead (unknownKeyNotes). A list where the op takes one comma-separated
 * string gets that string spelled out (invalidTypeHint). Nothing is coerced.
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
 * them. A name listed for several keys hints only where the op declares exactly
 * one of them (`prompt` reads as `text` for task_send, `message` for task_start).
 */
const OTHER_NAMES: Record<string, readonly string[]> = {
  q: ['query', 'search', 'keyword', 'keywords', 'term', 'terms', 'filter', 'text'],
  limit: ['max', 'max_results', 'count', 'top', 'n', 'size', 'page_size'],
  project: ['project_name', 'projectName'],
  text: ['prompt', 'message', 'msg', 'body', 'content'],
  message: ['prompt', 'text', 'msg', 'body', 'content'],
}

/**
 * Wrong keys that mean something the op does another way, keyed by the
 * declared key that does it: the line says how, it never maps the value.
 */
const KEY_NOTES: Record<string, { keys: readonly string[]; note: (key: string) => string }> = {
  // 2026-11-06: task_list with include_completed; completed tasks are in by default.
  completion: {
    keys: ['include_completed', 'include_complete', 'include_done', 'show_completed', 'completed'],
    note: (key) => `"${key}" is no key here: completed tasks are already listed by default; `
      + 'to leave them out pass "completion" (e.g. "todo,in_progress")',
  },
}

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

/**
 * The hint for one `unrecognized_keys` issue (`; did you mean "q"?`), or '' when
 * the intended key is not clear. `data` is the args as they were validated.
 */
export function unknownKeyHint(root: Shape, data: unknown, path: PropertyKey[], keys: string[]): string {
  const shape = shapeAt(root, path)
  const obj = valueAt(data, path)
  if (!shape || keys.length === 0 || typeof obj !== 'object' || obj === null || Array.isArray(obj)) return ''
  const given = obj as Record<string, unknown>
  const declared = Object.keys(shape)

  const picks = new Map<string, string>()
  // A usual other name first: "message" on task_send means text, never the messageId it is two edits from.
  for (const key of keys) {
    const targets = Object.keys(OTHER_NAMES).filter((k) => OTHER_NAMES[k].includes(key) && declared.includes(k))
    if (targets.length === 1 && given[targets[0]] === undefined) picks.set(key, targets[0])
  }
  let near = false
  for (const key of keys) {
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
  if (!near && keys.length === 1 && !picks.has(keys[0])) {
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

/** Lines for well-known wrong keys at `path` (`; "include_completed" is no key here: ...`), or ''. */
export function unknownKeyNotes(root: Shape, path: PropertyKey[], keys: string[]): string {
  const shape = shapeAt(root, path)
  if (!shape) return ''
  return keys.map((key) => {
    const hit = Object.keys(KEY_NOTES).find((k) => Object.prototype.hasOwnProperty.call(shape, k) && KEY_NOTES[k].keys.includes(key))
    return hit ? `; ${KEY_NOTES[hit].note(key)}` : ''
  }).join('')
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
