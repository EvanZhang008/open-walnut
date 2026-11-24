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
 * The cap also depends on where the answer is printed (ANSWER_SURFACES): an MCP tool's answer
 * goes to the agent as compact JSON and its client keeps about 25,000 characters, while
 * `walnut tools call` prints pretty JSON into a shell whose harness keeps about 10 KB
 * (2026-11-22: skill_read answered 19,354 bytes through the CLI and was saved to a file). So an
 * answer is held to the smaller of the op's cap and the surface's, measured as that surface prints it.
 *
 * Pure: the guard test runs it over every op.
 */
import type { WalnutOp } from './registry.js'
import { ANSWER_LIMITS, PROGRAM_CLIENT, cliAnswerText } from '../lib/tool-answer-size.js'

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
  shape?: (ctx: ShapeContext) => unknown
  /**
   * Calls whose answer is never shaped or cut: one of Walnut's own hooks, whose output a
   * harness reads as it is (the read-back after a compaction). The guard test lists the ops that may.
   */
  whole_for?: (args: Record<string, unknown>) => boolean
}

/**
 * Where an agent reads an answer, and how much of it that place keeps. `max` is what Walnut holds an
 * answer to, in `unit`, measured on the text that surface prints (printedSize); `keeps` is where
 * the agent's harness stops passing an answer on (lib/tool-answer-size.ts, read off session records).
 */
export const ANSWER_SURFACES = {
  /** A Walnut MCP tool (src/mcp/tools.ts, walnut-mcp-stdio.ts): compact JSON, counted in characters. */
  mcp: { max: 24_000, unit: 'chars', keeps: ANSWER_LIMITS.mcp.max },
  /**
   * `walnut tools call` in a session's shell (src/commands/tools.ts, wn-cli.ts): pretty JSON and a
   * newline (cliAnswerText), counted in UTF-8 bytes, which is never less than its characters
   * (Chinese text is 3 bytes a character). Answers under about 9 KB passed in real sessions.
   */
  cli: { max: 8_000, unit: 'bytes', keeps: ANSWER_LIMITS.cli.max },
} as const satisfies Record<string, { max: number; unit: 'chars' | 'bytes'; keeps: number }>

export type AnswerSurface = keyof typeof ANSWER_SURFACES

/** Every surface, for the guard test and the callers that name one. */
export const ANSWER_SURFACE_NAMES = Object.keys(ANSWER_SURFACES) as AnswerSurface[]

/** A caller that names no surface (an older CLI or daemon) is held to the smaller cap: a too-small answer costs one more call, a too-big one is lost. */
export const surfaceOf = (v: unknown): AnswerSurface => (v === 'mcp' ? 'mcp' : 'cli')

/**
 * The surface a session's gateway call is shaped for, or none: a program (PROGRAM_CLIENT, wn-cli's
 * own loops) reads the whole answer, as the same loop does on the Mac. Every gateway that shapes
 * a session's answer asks this (capability-router.ts, backup-gateway.ts).
 */
export const agentSurfaceOf = (v: unknown): AnswerSurface | undefined => (v === PROGRAM_CLIENT ? undefined : surfaceOf(v))

/** What one agent answer is held to: `max` in its surface's unit, measured by printedSize. */
export interface AnswerFit { max: number; surface: AnswerSurface }

/** What an op's shape builds from: the result, the call's arguments, and the cap the answer is held to. */
export interface ShapeContext extends AnswerFit { result: unknown; args: Record<string, unknown> }

/** Past this many compact characters the printed text is not built: such an answer is over every cap already. */
const PRINTED_MEASURE_MAX = 400_000

/** `value`'s size as `surface` prints it, in that surface's unit. */
export function printedSize(value: unknown, surface: AnswerSurface): number {
  const compact = JSON.stringify(value) ?? 'null'
  if (surface === 'mcp' || compact.length > PRINTED_MEASURE_MAX) return compact.length
  return Buffer.byteLength(cliAnswerText(value), 'utf-8')
}

/**
 * One UTF-16 unit of a string's content, as `surface` counts it once printed as JSON: an escape
 * (a newline, a quote) is two or six, and on the CLI a character outside ASCII is its UTF-8 bytes
 * (a surrogate pair is 4 bytes, 2 for each half).
 */
export function textCost(code: number, surface: AnswerSurface = 'mcp'): number {
  if (code === 0x22 || code === 0x5c) return 2
  if (code < 0x20) return code === 0x0a || code === 0x0d || code === 0x09 || code === 0x08 || code === 0x0c ? 2 : 6
  if (code < 0x80 || surface === 'mcp') return 1
  if (code < 0x800 || (code >= 0xd800 && code <= 0xdfff)) return 2
  return 3
}

/** A receipt: ids, a state, a count, an outcome and a next step. */
export const RECEIPT_MAX_CHARS = 2_000
/** Content: under what an agent's shell keeps of a command's output (about 10,000 characters). */
export const CONTENT_MAX_CHARS = 8_000
/** No op may declare more: the largest surface's cap (an agent's MCP client keeps about 25,000 characters). */
export const ANSWER_CEILING_CHARS: number = ANSWER_SURFACES.mcp.max

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

/** What `op`'s answer to an agent on `surface` is held to: the smaller of its own cap and the surface's. */
export function answerFit(op: Pick<WalnutOp, 'answer' | 'tags'>, surface: AnswerSurface): AnswerFit {
  return { surface, max: Math.min(answerPolicy(op).max, ANSWER_SURFACES[surface].max) }
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

/**
 * A conversation's rows (each has a `role`; the timed ones are oldest first): a cut keeps its newest
 * end, the rows a reader came for. 2026-11-24: task_history {"limit":14} read 63 rows and the agent got
 * the oldest 13, the newest reply gone. Any other list is cut from its end, as before.
 */
export function newestLast(list: readonly unknown[]): boolean {
  let prev = -Infinity
  let timed = 0
  for (const item of list) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return false
    const row = item as Record<string, unknown>
    if (typeof row.role !== 'string') return false
    const t = typeof row.timestamp === 'string' ? Date.parse(row.timestamp) : NaN
    if (Number.isNaN(t)) continue
    if (t < prev) return false
    prev = t
    timed++
  }
  return timed >= 2
}

/** One walk: every long text to 2,000 characters and every long list to 40 rows (a conversation's newest 40). */
function coarse(value: unknown, note: (path: string, chars: number, items: number, older?: boolean) => void, path = '', depth = 0): void {
  if (!value || typeof value !== 'object' || depth > 12) return
  const container = value as Record<string | number, unknown>
  if (Array.isArray(value) && value.length > 40) {
    const older = newestLast(value)
    note(path, 0, value.length - 40, older)
    if (older) value.splice(0, value.length - 40)
    else value.length = 40
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
 * `floor` characters at least), then the tails of lists (a conversation's oldest rows, newestLast), then strings again to a
 * short head. The answer says what was cut under `_cut`. A value that cannot be
 * made to fit (nothing left to cut) is returned as far as it got.
 */
export function cutToFit(value: unknown, max: number, whole?: string): unknown {
  if (size(value) <= max) return value
  const root: Record<string, unknown> = value && typeof value === 'object' && !Array.isArray(value)
    ? JSON.parse(JSON.stringify(value)) as Record<string, unknown>
    : { result: JSON.parse(JSON.stringify(value ?? null)) as unknown }
  const cuts = new Map<string, { chars: number; items: number; older: number }>()
  const note = (path: string, chars: number, items: number, older = false): void => {
    // A cut inside a list item is told once for the list.
    const name = path.replace(/\[\d+\]/g, '[]')
    const had = cuts.get(name) ?? { chars: 0, items: 0, older: 0 }
    cuts.set(name, { chars: had.chars + chars, items: had.items + (older ? 0 : items), older: had.older + (older ? items : 0) })
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
  // The biggest list loses rows from its end (a conversation: from its start) until the answer fits
  // or one row is left; then the next list.
  const cutArrays = (): void => {
    for (let round = 0; round < 60; round++) {
      const over = size(root) - budget
      if (over <= 0) return
      const leaf = collect().arrays.sort((a, b) => b.size - a.size)[0]
      if (!leaf) return
      const list = (leaf.parent as Record<string | number, unknown>)[leaf.key] as unknown[]
      const older = newestLast(list)
      let freed = 0
      let dropped = 0
      while (list.length > 1 && freed < over) {
        freed += size(older ? list.shift() : list.pop()) + 1
        dropped++
      }
      note(leaf.path, 0, dropped, older)
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
      fields[path.length > 60 ? `${path.slice(0, 57)}...` : path] = [c.older ? `${c.older} older items` : '', c.items ? `${c.items} more items` : '', c.chars ? `${c.chars} more characters` : ''].filter(Boolean).join(', ')
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

/** The smallest budget a shape or the cutter is asked to build for (cutToFit's own floor). */
const BUDGET_FLOOR = 200

/**
 * The next budget, in compact JSON characters, after an answer of `compact` characters printed
 * `printed` against `max`: the same share of what printed over, less a margin. Undefined when no
 * smaller one is left to try.
 */
function smaller(budget: number, compact: number, printed: number, max: number): number | undefined {
  const next = Math.floor((Math.min(budget, compact) * max) / printed) - Math.max(16, Math.ceil(max / 200))
  return next < budget && next >= BUDGET_FLOOR ? next : undefined
}

/**
 * `value` held to `fit`, printed as its surface prints it. cutToFit counts compact JSON
 * characters, which a pretty print or a non-ASCII text outgrows: the budget shrinks by what the
 * printed text was over until it fits.
 */
function cutToPrinted(value: unknown, fit: AnswerFit, whole?: string): unknown {
  let budget = fit.max
  let out = cutToFit(value, budget, whole)
  for (let round = 0; round < 8; round++) {
    const printed = printedSize(out, fit.surface)
    const next = printed > fit.max ? smaller(budget, size(out), printed, fit.max) : undefined
    if (next === undefined) return out
    budget = next
    out = cutToFit(value, budget, whole)
  }
  return out
}

/**
 * What an agent caller reads for `result` on `surface`: the op's own compact form, held to the
 * smaller of the op's cap and the surface's, measured as the surface prints it. A shape builds for
 * the `max` it is given; when its answer prints over the cap (pretty JSON, Chinese text), it builds
 * again for a smaller one, so a page and its "read on" offset still agree. Only what a shape cannot
 * make fit is cut by cutToFit. `full` (the caller's `_full: true`) returns the result as the server gave it.
 */
export function agentAnswer(
  op: Pick<WalnutOp, 'answer' | 'tags' | 'name'>,
  args: Record<string, unknown>,
  result: unknown,
  full = false,
  surface: AnswerSurface = 'cli',
): unknown {
  if (full || result === undefined || result === null) return result
  if (op.answer?.whole_for?.(args)) return result
  const policy = answerPolicy(op)
  const fit = answerFit(op, surface)
  const shape = op.answer?.shape
  // A shape that cannot read an answer it did not expect never fails the call.
  const build = (max: number): unknown => {
    if (!shape) return result
    try { return shape({ result, args, max, surface }) ?? result } catch { return result }
  }
  let budget = fit.max
  let shaped = build(budget)
  // A result JSON cannot hold (a cycle, a BigInt) is answered as it is: the op ran, the answer must not fail it.
  try {
    for (let round = 0; shape && round < 4; round++) {
      const printed = printedSize(shaped, surface)
      const next = printed > fit.max ? smaller(budget, size(shaped), printed, fit.max) : undefined
      if (next === undefined) break
      const again = build(next)
      // A shape that gives the same answer for any budget is left to the cutter.
      if (printedSize(again, surface) >= printed) break
      budget = next
      shaped = again
    }
    return cutToPrinted(shaped, fit, policy.whole)
  } catch { return shaped }
}
