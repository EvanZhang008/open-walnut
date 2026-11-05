/**
 * Regular expressions whose worst case is linear in the text: the same answer as
 * `new RegExp(source, 'i').test(text)` (non-unicode mode; `ignoreCase: false` drops the `i`), except
 * that `\p{…}` / `\P{…}` are Unicode properties as in the unicode mode (unicode-property.ts), in
 * O(text length x states) time, so no pattern can hold the thread that runs it (a few small shapes
 * run on the native engine instead, fast-path.ts says which and what bounds them). For patterns
 * from people or agents that run where a slow match would freeze everything else.
 *
 * parse.ts reads the full non-unicode grammar (Annex B included), compile.ts builds Thompson NFAs
 * with counted repeats expanded and clamped by `maxLength`, match.ts runs them as a Pike VM with
 * lookarounds as precomputed position predicates, case-fold.ts is the `i` flag, prefilter.ts a
 * literal check before the NFA, fast-path.ts the patterns safe to hand to the native engine,
 * glob.ts a linear `*` glob, min-length.ts the fewest characters a match needs. Refused: what the
 * native engine refuses and a `\p{…}` that names no property (`invalid`, with a plain reason read
 * from the pattern: syntax-error.ts), a back-reference (`backreference`: no linear matcher exists
 * for one), a pattern over `maxStates` NFA states once repeats are expanded (`too-big`; lookaround
 * bodies count twice), and syntax this parser cannot map (`unsupported`; none is known).
 */
import { compilePattern, TooManyStates } from './compile.js'
import { boundedForBacktracking } from './fast-path.js'
import { runPattern } from './match.js'
import { matchesEveryText, minMatchLength } from './min-length.js'
import { parsePattern, PatternRefusal } from './parse.js'
import { buildPrefilter } from './prefilter.js'
import { syntaxErrorReason } from './syntax-error.js'
import { hasPropertyEscape } from './unicode-property.js'

export { compileGlob } from './glob.js'
export { caseTable } from './case-fold.js'

export const DEFAULT_MAX_LENGTH = 1000
/**
 * With every state live at every position of a 300-character text, a pattern at this cap takes
 * about 12 ms per test on ASCII text and 16 ms on non-ASCII text at worst (a dev desktop,
 * 2026-11-04; tests/lib/linear-regex-timing.test.ts prints it).
 */
export const DEFAULT_MAX_STATES = 3000

export type LinearRefusal = 'invalid' | 'backreference' | 'too-big' | 'unsupported'

export interface LinearOptions {
  /** The longest text `test` accepts (it throws on a longer one); counted repeats clamp to it. */
  maxLength?: number
  maxStates?: number
  ignoreCase?: boolean
  /** Run whole texts on the native engine for the bounded shapes fast-path.ts accepts. Default on. */
  nativeFastPath?: boolean
  /** Reject texts without the pattern's required literal before the NFA (prefilter.ts). Default on. */
  prefilter?: boolean
}

export interface TestOptions {
  /** The real text goes on after `text`: then a match is reported only when it surely holds. */
  truncated?: boolean
  /** The real character right after `text`, when `truncated`. */
  next?: string
}

export interface LinearMatcher {
  ok: true
  states: number
  /** Whole texts run on the native engine (fast-path.ts). */
  native: boolean
  /** The fewest characters a match consumes, with counts as written (min-length.ts). */
  minLength: number
  /** It matches every text, whatever it holds (min-length.ts `matchesEveryText`). */
  matchesAll: boolean
  test(text: string, options?: TestOptions): boolean
}

export type LinearResult = LinearMatcher | { ok: false; reason: LinearRefusal; detail: string }

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error))

export function compileLinear(source: string, options: LinearOptions = {}): LinearResult {
  const maxLength = options.maxLength ?? DEFAULT_MAX_LENGTH
  const maxStates = options.maxStates ?? DEFAULT_MAX_STATES
  const ignoreCase = options.ignoreCase ?? true
  try {
    new RegExp(source, ignoreCase ? 'i' : '')
  } catch (error) {
    return { ok: false, reason: 'invalid', detail: syntaxErrorReason(source, messageOf(error)) }
  }
  let compiled: ReturnType<typeof compilePattern>
  let prefilter: RegExp | null
  let fast: RegExp | null
  let minLength: number
  let matchesAll: boolean
  try {
    const tree = parsePattern(source, ignoreCase)
    minLength = minMatchLength(tree)
    matchesAll = matchesEveryText(tree)
    compiled = compilePattern(tree, maxLength, maxStates)
    prefilter = options.prefilter === false ? null : buildPrefilter(tree)
    // The native engine reads `\p{L}` as the text `p{L}`, so a pattern with a property never runs there.
    fast = options.nativeFastPath !== false && !hasPropertyEscape(source) && boundedForBacktracking(tree, source)
      ? new RegExp(source, ignoreCase ? 'i' : '') : null
  } catch (error) {
    if (error instanceof PatternRefusal) return { ok: false, reason: error.reason, detail: error.message }
    if (error instanceof TooManyStates) return { ok: false, reason: 'too-big', detail: `more than ${maxStates} states` }
    // A stack overflow from nesting thousands of groups deep.
    if (error instanceof RangeError) return { ok: false, reason: 'too-big', detail: 'nested too deeply' }
    return { ok: false, reason: 'unsupported', detail: messageOf(error) }
  }
  return {
    ok: true,
    states: compiled.states,
    native: fast !== null,
    minLength,
    matchesAll,
    test(text, testOptions = {}) {
      if (text.length > maxLength) throw new RangeError(`text is ${text.length} characters, over maxLength ${maxLength}`)
      const truncated = testOptions.truncated === true
      // A cut text needs the cut's own `$`, `\b` and lookahead answers: always the NFA.
      if (fast && !truncated) return fast.test(text)
      if (prefilter && !prefilter.test(text)) return false
      const next = truncated && testOptions.next ? testOptions.next.charCodeAt(0) : -1
      return runPattern(compiled, text, truncated, next)
    },
  }
}
