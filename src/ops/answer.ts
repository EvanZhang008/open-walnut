/**
 * answer.ts: what an agent reads back from an op is small by construction.
 *
 * 2026-11-21: seven days of sessions made 27,251 Walnut calls; 1,712 answers were
 * over 10,000 characters and 207 were cut by the agent's own harness, which then
 * shows a success as a failure. The big ones were not big reads: a write
 * (thread_update, task_complete) answered the whole object it had just changed.
 *
 * So every op has an answer policy, and the executor holds every agent caller to it:
 *   - a WRITE answers a receipt: what changed (ids, the new state, counts, outcome,
 *     next), never the object written. The object is read with the op named in `whole`.
 *   - a READ answers content, up to its own cap; what does not fit is cut, and the
 *     answer says what was cut and how to read it whole.
 * An op may give its own compact form (`shape`); the cap below holds whatever it gives.
 * `"_full": true` in the arguments lifts both for one call (a script that needs all of it).
 *
 * Pure and dependency-free: the guard test runs it over every op.
 */
import type { WalnutOp } from './registry.js'

export interface OpAnswer {
  /**
   * `receipt`: the answer of a write is what changed, never the object written.
   * `content`: the answer is what was asked for (a read, or a write that runs
   * something and returns its output).
   */
  kind: 'receipt' | 'content'
  /** The most characters of JSON one answer carries; the kind's default when left out. */
  max?: number
  /** How to read whole what was left out, as a call: `task_get {"id":"<id>"}`. */
  whole?: string
  /**
   * The op's own compact form of its result, for an agent caller. Returns the
   * result to answer; whatever it returns is still held to `max`.
   */
  shape?: (ctx: { result: unknown; args: Record<string, unknown> }) => unknown
  /**
   * Calls whose answer is never shaped or cut: one of Walnut's own hooks, whose output a
   * harness reads as it is (the read-back after a compaction). The guard test lists the ops that may.
   */
  whole_for?: (args: Record<string, unknown>) => boolean
}

/** A receipt: ids, a state, a count, an outcome and a next step. */
export const RECEIPT_MAX_CHARS = 2_000
/** Content: under what an agent's shell keeps of a command's output (about 10,000 characters). */
export const CONTENT_MAX_CHARS = 8_000
/** No op may declare more: the largest answer an agent's MCP client keeps is about 25,000 characters. */
export const ANSWER_CEILING_CHARS = 24_000

/** The argument that lifts the policy for one call. Never one of an op's own arguments. */
export const FULL_ARG = '_full'

/** Take `_full` out of the arguments; true when the caller asked for the whole answer. */
export function takeFullArg(args: Record<string, unknown>): { full: boolean; bad?: string } {
  if (!Object.hasOwn(args, FULL_ARG)) return { full: false }
  const given = args[FULL_ARG]
  delete args[FULL_ARG]
  if (typeof given !== 'boolean') return { full: false, bad: `${FULL_ARG}: expected true or false` }
  return { full: given }
}

export interface AnswerPolicy { kind: 'receipt' | 'content'; max: number; whole?: string }

/** The policy an op answers under: its own, else a receipt for a write and content for a read. */
export function answerPolicy(op: Pick<WalnutOp, 'answer' | 'tags'>): AnswerPolicy {
  const kind = op.answer?.kind ?? (op.tags.readonly ? 'content' : 'receipt')
  const max = Math.min(op.answer?.max ?? (kind === 'receipt' ? RECEIPT_MAX_CHARS : CONTENT_MAX_CHARS), ANSWER_CEILING_CHARS)
  return { kind, max, ...(op.answer?.whole ? { whole: op.answer.whole } : {}) }
}

/**
 * Every text Walnut shortens ends with this mark, so a write can tell a shortened text from a
 * whole one: an agent that reads a cut note and writes it back would delete the rest.
 */
export const cutMark = (more: number): string => `[Walnut cut: ${more} more characters]`
/** A text shortened by cutMark, or one page of a longer document (doc-page.ts). */
const CUT_TEXT = /\[Walnut cut: \d+ more characters\]|\[Walnut: this is part of a longer document/

/** The path of the first string in `value` that holds shortened text, or undefined. */
export function cutTextPath(value: unknown, path = '', depth = 0): string | undefined {
  if (typeof value === 'string') return CUT_TEXT.test(value) ? path || '(root)' : undefined
  if (!value || typeof value !== 'object' || depth > 8) return undefined
  const entries: [string, unknown][] = Array.isArray(value) ? value.map((v, i) => [`[${i}]`, v]) : Object.entries(value as Record<string, unknown>)
  for (const [k, v] of entries) {
    const found = cutTextPath(v, Array.isArray(value) ? `${path}${k}` : path ? `${path}.${k}` : k, depth + 1)
    if (found) return found
  }
  return undefined
}

/**
 * Why a write that stores what it is given is refused: one of its texts is a shortened read.
 * Only for a receipt write (it stores an object); a write that runs something may carry any text.
 */
export function cutTextRefusal(op: Pick<WalnutOp, 'answer' | 'tags' | 'name'>, args: Record<string, unknown>): string | undefined {
  if (op.tags.readonly || answerPolicy(op).kind !== 'receipt') return undefined
  const at = cutTextPath(args)
  if (!at) return undefined
  return `${op.name} refused: \`${at}\` holds text Walnut shortened when you read it (it carries a "[Walnut cut: ...]" or "part of a longer document" line). `
    + 'Stored as it is, the rest would be deleted. Read it whole first (repeat the read with "_full": true, or the call its _cut note names), then write again. If you mean to store only this part, take the mark line out.'
}

/** Keys whose text says what happened or what to do next: never cut. */
const KEEP_KEYS = new Set(['outcome', 'next', 'ref', 'instruction', 'walnut_note', 'error', 'code', 'hint'])
const keepKey = (key: string): boolean => KEEP_KEYS.has(key) || /(^id$|_id$|Id$|^path$|_path$|Path$|^file$|^url$)/.test(key)

interface Leaf { parent: Record<string, unknown> | unknown[]; key: string | number; path: string; size: number }

function leaves(value: unknown, path: string, out: { strings: Leaf[]; arrays: Leaf[] }, parent?: Leaf['parent'], key?: Leaf['key']): void {
  if (typeof value === 'string') {
    // A kept key is kept while it is short: an id or a path, never a 10,000 character value under such a name.
    if (parent && !(typeof key === 'string' && keepKey(key) && value.length <= 300)) out.strings.push({ parent, key: key!, path, size: value.length })
    return
  }
  if (Array.isArray(value)) {
    if (parent && value.length > 1) out.arrays.push({ parent, key: key!, path, size: JSON.stringify(value).length })
    value.forEach((item, i) => leaves(item, `${path}[${i}]`, out, value, i))
    return
  }
  if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (k === '_cut') continue
      leaves(v, path ? `${path}.${k}` : k, out, value as Record<string, unknown>, k)
    }
  }
}

const size = (value: unknown): number => (JSON.stringify(value) ?? 'null').length

/** Room the `_cut` note itself takes. */
const NOTE_ROOM = 420
/** The most cut fields the note names; the rest are counted. */
const NOTE_FIELDS = 6

/** From this size an answer gets the one-walk coarse cut first. */
const COARSE_FROM_CHARS = 400_000

/** One walk: every long text to 2,000 characters and every long list to 40 rows. */
function coarse(value: unknown, note: (path: string, chars: number, items: number) => void, path = '', depth = 0): void {
  if (!value || typeof value !== 'object' || depth > 12) return
  const container = value as Record<string | number, unknown>
  if (Array.isArray(value) && value.length > 40) {
    note(path, 0, value.length - 40)
    value.length = 40
  }
  const keys: (string | number)[] = Array.isArray(value) ? value.map((_, i) => i) : Object.keys(value)
  for (const k of keys) {
    const v = container[k]
    const at = typeof k === 'number' ? `${path}[${k}]` : path ? `${path}.${k}` : k
    if (typeof v === 'string' && v.length > 2_000) {
      container[k] = `${v.slice(0, 2_000)}… ${cutMark(v.length - 2_000)}`
      note(at, v.length - 2_000, 0)
    } else coarse(v, note, at, depth + 1)
  }
}

/**
 * `value` held to `max` characters of JSON. Long strings are cut first (to
 * `floor` characters at least), then the tails of lists, then strings again to a
 * short head. The answer says what was cut under `_cut`. A value that cannot be
 * made to fit (nothing left to cut) is returned as far as it got.
 */
export function cutToFit(value: unknown, max: number, whole?: string): unknown {
  if (size(value) <= max) return value
  const root: Record<string, unknown> = value && typeof value === 'object' && !Array.isArray(value)
    ? JSON.parse(JSON.stringify(value)) as Record<string, unknown>
    : { result: JSON.parse(JSON.stringify(value ?? null)) as unknown }
  const cuts = new Map<string, { chars: number; items: number }>()
  const note = (path: string, chars: number, items: number): void => {
    // A cut inside a list item is told once for the list.
    const name = path.replace(/\[\d+\]/g, '[]')
    const had = cuts.get(name) ?? { chars: 0, items: 0 }
    cuts.set(name, { chars: had.chars + chars, items: had.items + items })
  }
  let budget = Math.max(200, max - NOTE_ROOM)
  const collect = (): { strings: Leaf[]; arrays: Leaf[] } => {
    const found: { strings: Leaf[]; arrays: Leaf[] } = { strings: [], arrays: [] }
    leaves(root, '', found)
    return found
  }
  // One walk per pass: the biggest strings give up what the answer is over by, down to `floor`.
  const cutStrings = (floor: number): void => {
    for (let pass = 0; pass < 4; pass++) {
      let over = size(root) - budget
      if (over <= 0) return
      // A text already at this floor carries its mark: it is not cut again.
      const long = collect().strings
        .filter((l) => l.size > floor + 60 || (l.size > floor && !/\[Walnut cut: \d+ more characters\]$/.test((l.parent as Record<string | number, unknown>)[l.key] as string)))
        .sort((x, y) => y.size - x.size)
      if (!long.length) return
      for (const leaf of long) {
        if (over <= 0) break
        const text = (leaf.parent as Record<string | number, unknown>)[leaf.key] as string
        // What is over is counted in JSON characters, where a newline or a quote is two.
        const json = JSON.stringify(text).length - 2
        const ratio = Math.max(1, json / Math.max(1, text.length))
        const keep = Math.max(floor, Math.min(text.length - 1, Math.floor((json - over) / ratio) - 60))
        const cut = text.length - keep
        ;(leaf.parent as Record<string | number, unknown>)[leaf.key] = `${text.slice(0, keep)}… ${cutMark(cut)}`
        note(leaf.path, cut, 0)
        over -= Math.floor(cut * ratio) - 40
      }
    }
  }
  // The biggest list loses rows from its end until the answer fits or one row is left; then the next list.
  const cutArrays = (): void => {
    for (let round = 0; round < 60; round++) {
      const over = size(root) - budget
      if (over <= 0) return
      const leaf = collect().arrays.sort((a, b) => b.size - a.size)[0]
      if (!leaf) return
      const list = (leaf.parent as Record<string | number, unknown>)[leaf.key] as unknown[]
      let freed = 0
      let dropped = 0
      while (list.length > 1 && freed < over) {
        freed += size(list.pop()) + 1
        dropped++
      }
      note(leaf.path, 0, dropped)
    }
  }
  // Last: the biggest nested object or list is left out whole, until the answer fits.
  const dropBranches = (): void => {
    for (let round = 0; round < 200; round++) {
      const over = size(root) - budget
      if (over <= 0) return
      let best: { parent: Record<string, unknown> | unknown[]; key: string | number; path: string; size: number } | undefined
      const walk = (value: unknown, path: string, depth: number): void => {
        if (!value || typeof value !== 'object') return
        const entries: [string | number, unknown][] = Array.isArray(value) ? value.map((v, i) => [i, v]) : Object.entries(value as Record<string, unknown>)
        for (const [k, v] of entries) {
          if (k === '_cut' || (typeof k === 'string' && keepKey(k))) continue
          const at = typeof k === 'number' ? `${path}[${k}]` : path ? `${path}.${k}` : k
          if (v && typeof v === 'object') {
            const n = size(v)
            // The smallest branch that alone covers what is over, else the biggest one.
            if (n > 60 && (!best || (n >= over ? (best.size < over || n < best.size) : (best.size < over && n > best.size)))) {
              best = { parent: value as Record<string, unknown> | unknown[], key: k, path: at, size: n }
            }
            if (depth < 6) walk(v, at, depth + 1)
          }
        }
      }
      walk(root, '', 0)
      if (!best) return
      ;(best.parent as Record<string | number, unknown>)[best.key] = `[left out: ${best.size} characters]`
      note(best.path, best.size, 0)
    }
  }
  // A very large answer first loses its long texts and long lists in one walk: the passes below
  // measure the whole answer each round, and a few megabytes of that would hold the server up.
  if (size(root) > COARSE_FROM_CHARS) coarse(root, note)
  const noteOf = (): Record<string, unknown> => {
    const entries = [...cuts.entries()]
    const fields: Record<string, string> = {}
    for (const [path, c] of entries.slice(0, NOTE_FIELDS)) {
      fields[path.length > 60 ? `${path.slice(0, 57)}...` : path] = [c.items ? `${c.items} more items` : '', c.chars ? `${c.chars} more characters` : ''].filter(Boolean).join(', ')
    }
    return {
      note: `Shortened to fit ${max} characters; nothing failed.`,
      fields,
      ...(entries.length > NOTE_FIELDS ? { more_fields: entries.length - NOTE_FIELDS } : {}),
      whole: whole
        ? `${whole}, or repeat this call with "${FULL_ARG}": true`
        : `Repeat this call with "${FULL_ARG}": true`,
    }
  }
  // The note's own size is known only once the cuts are: a second round takes what it is over by.
  for (let round = 0; round < 3; round++) {
    cutStrings(1_000)
    cutArrays()
    cutStrings(160)
    dropBranches()
    delete root._cut
    const noted = size({ ...root, _cut: noteOf() })
    if (noted <= max) break
    budget -= noted - max + 20
  }
  root._cut = noteOf()
  // Nothing left to shorten and still over (a wide object of short kept values): whole keys go, last first.
  const first = new Set(['id', 'ok', 'outcome', 'next', 'ref', 'error', 'code', '_cut'])
  const rest = Object.keys(root).filter((k) => !first.has(k))
  let left = 0
  while (size(root) > max && rest.length) {
    delete root[rest.pop()!]
    left++
  }
  if (left) (root._cut as Record<string, unknown>).keys_left_out = left
  return root
}

/**
 * What an agent caller reads for `result`: the op's own compact form, held to its cap.
 * `full` (the caller's `_full: true`) returns the result as the server gave it.
 */
export function agentAnswer(
  op: Pick<WalnutOp, 'answer' | 'tags' | 'name'>,
  args: Record<string, unknown>,
  result: unknown,
  full = false,
): unknown {
  if (full || result === undefined || result === null) return result
  if (op.answer?.whole_for?.(args)) return result
  const policy = answerPolicy(op)
  let shaped = result
  if (op.answer?.shape) {
    // A shape that cannot read an answer it did not expect never fails the call.
    try { shaped = op.answer.shape({ result, args }) ?? result } catch { shaped = result }
  }
  // A result JSON cannot hold (a cycle, a BigInt) is answered as it is: the op ran, the answer must not fail it.
  try { return cutToFit(shaped, policy.max, policy.whole) } catch { return shaped }
}
