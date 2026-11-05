/**
 * `subject: { re }` runs synchronously on the event loop (ingest, recompute, live preview), so every
 * pattern runs in src/lib/linear-regex: time linear in the subject whatever the pattern, the same
 * answer as `new RegExp(pattern, 'i').test(subject)` (with `\p{…}` as a Unicode property, as the
 * unicode mode reads it). Matching sees the first 300 characters of a
 * subject; past them it finds only a match that ends inside them. Refused on write: an invalid
 * pattern, one over 200 characters, a back-reference (no linear matcher exists for one), and repeat
 * counts that make too many states to check quickly. A rule a file already holds with a pattern
 * Walnut will not run is loaded switched off with its own line (`ruleOffReason`: why, and the way
 * back on), never failing the file (an older Walnut accepted too-big patterns, and a hand edit can
 * hold any): sort-rules-schema.ts. The Settings editor checks with this same module
 * (`@open-walnut/mail-subject-pattern`), so it refuses what the server refuses, in these sentences,
 * and it shows `hint` under the field: a pattern that runs but will not match as it seems meant to
 * (`warn`: pasted slashes, spaces at an end, more than 300 characters, every subject), with the
 * pattern one click makes of it (`fix`) where there is one. An
 * invalid pattern's reason is read from the pattern (src/lib/linear-regex/syntax-error.ts), so it
 * reads the same in the browser; only a cause that scan does not know shows the engine's own words,
 * and syntax only a newer engine knows is invalid in an older browser. The server checks again on
 * save, so neither lets a pattern through. A leading `(?i)`, how other tools say "ignore case", runs
 * without it, with a hint (an older Walnut refuses such a file and keeps its last good rules).
 */
import { compileLinear } from '../../lib/linear-regex/index.js'

export const MAX_PATTERN_LENGTH = 200
export const SUBJECT_MATCH_CHARS = 300

export function patternTooLong(length: number): string {
  return `This pattern is ${length} characters; the limit is ${MAX_PATTERN_LENGTH}. Shorten it, or split it into two rules.`
}
export const PATTERN_BACKREFERENCE = 'This pattern refers to a group by number or name (\\1, \\k<name>), which mail rules do not support. Write out the text it should match instead.'
export const PATTERN_TOO_BIG = 'This pattern repeats too many times to check quickly. Use smaller numbers in {n,m}.'

/** On the row of a rule loaded switched off: why, and the way back on (`ruleOffReason`). */
export const RULE_OFF_TOO_BIG = 'This rule is off: its pattern repeats too many times to check quickly. Edit it with smaller numbers in {n,m} to turn it on.'
export const RULE_OFF_BACKREFERENCE = 'This rule is off: its pattern refers to a group by number or name (\\1, \\k<name>), which mail rules do not support. Edit it without one to turn it on.'
export function ruleOffInvalid(detail: string): string {
  return `This rule is off until its pattern is fixed: ${detail}`
}
export const RULE_OFF_UNSUPPORTED = 'This rule is off: mail rules cannot check its pattern yet. Edit it to turn it on.'
export function ruleOffTooLong(length: number): string {
  return `This rule is off: its pattern is ${length} characters; the limit is ${MAX_PATTERN_LENGTH}. Shorten it, or split it into two rules, to turn it on.`
}

/**
 * A line under a pattern that runs (`hint`); none of them blocks a save. `warn`: the rule would not
 * do what it seems to; `fix`: the pattern one click makes of it, with the button's words.
 */
export interface PatternHint { text: string; warn: boolean; fix?: { label: string; pattern: string } }

export const HINT_SLASHES_FLAGS = 'Patterns here take no slashes or flags; as written, this matches only subjects that contain them.'
export const HINT_SLASHES = 'Patterns here take no slashes; as written, this matches only subjects that contain them.'
export const HINT_NEEDS_MORE = `This pattern needs more than ${SUBJECT_MATCH_CHARS} characters, but only the first ${SUBJECT_MATCH_CHARS} of a subject are checked, so it never matches. Make it need ${SUBJECT_MATCH_CHARS} or fewer.`
export const HINT_MATCHES_ALL = 'This pattern matches every subject, so the rule would take all mail.'
export const HINT_EMPTY_CHOICE = 'The | with nothing on one side matches every subject, so the rule would take all mail.'
export const HINT_INLINE_IGNORE_CASE = 'Leave out (?i): patterns already ignore case.'
export function spacesHint(at: 'start' | 'end' | 'both', count: number, rest: string): string {
  const what = count === 1 ? 'a space' : `${count} spaces`
  // The rest of the pattern, quoted when short, so the line says where the spaces must be.
  const text = rest.length <= 30 ? `"${rest}"` : 'the rest of the pattern'
  if (at === 'both') return `This pattern starts and ends with spaces, so it matches only where spaces come before and after ${text}.`
  return at === 'start'
    ? `This pattern starts with ${what}, so it matches only where ${what} ${count === 1 ? 'comes' : 'come'} before ${text}.`
    : `This pattern ends with ${what}, so it matches only where ${what} ${count === 1 ? 'follows' : 'follow'} ${text}.`
}
/** `(?i)` at the front, as other tools write "ignore case": run without it, since matching already does. */
const INLINE_IGNORE_CASE = '(?i)'
/**
 * Changes when what a subject pattern matches changes (2026-11-04: the linear matcher; `$` no longer
 * holds at the 300-character cut), so verdicts of rules with a pattern are sorted again once.
 */
export const SUBJECT_MATCHER_REV = 'linear-1'

export function invalidPatternSentence(detail: string): string {
  return `This pattern is not a valid regular expression: ${detail}`
}

export type SubjectRefusal = 'too-long' | 'invalid' | 'backreference' | 'too-big' | 'unsupported'
export type SubjectPattern =
  | { ok: true; test: (subject: string) => boolean; hint?: PatternHint }
  | { ok: false; reason: SubjectRefusal; message: string; detail: string }

// The same patterns are asked about again and again (each rules change, each labeler batch, each
// keystroke of the editor); a compiled matcher holds no state, so one is shared. Bounded by count.
const MEMO_LIMIT = 1000
const memo = new Map<string, SubjectPattern>()

/** A compiled case-insensitive matcher, or the sentence explaining why not. */
export function compileSubjectPattern(pattern: string): SubjectPattern {
  const known = memo.get(pattern)
  if (known) return known
  const result = compileUncached(pattern)
  if (memo.size >= MEMO_LIMIT) memo.clear()
  memo.set(pattern, result)
  return result
}

function subjectPatternOf(when: unknown): string | undefined {
  const subject = typeof when === 'object' && when !== null ? (when as { subject?: unknown }).subject : undefined
  if (typeof subject !== 'object' || subject === null || typeof (subject as { re?: unknown }).re !== 'string') return undefined
  return (subject as { re: string }).re
}

/**
 * Why a rule with this `when` is loaded switched off, with the way back on, or undefined when it is
 * not: a subject pattern Walnut will not run (too big, too long, a back-reference, invalid). It never
 * matches; the file keeps the rule and its pattern as written.
 */
export function ruleOffReason(when: unknown): string | undefined {
  const pattern = subjectPatternOf(when)
  if (pattern === undefined) return undefined
  const compiled = compileSubjectPattern(pattern)
  if (compiled.ok) return undefined
  switch (compiled.reason) {
    case 'too-big': return RULE_OFF_TOO_BIG
    case 'too-long': return ruleOffTooLong(pattern.length)
    case 'backreference': return RULE_OFF_BACKREFERENCE
    case 'invalid': return ruleOffInvalid(compiled.detail)
    case 'unsupported': return RULE_OFF_UNSUPPORTED
  }
}

/**
 * What the editor says, once and calmly, under a rule's own stored pattern while it is open, when
 * that pattern keeps the rule off: the way back on, with the exact cause. Undefined for a pattern
 * Walnut runs.
 */
export function heldPatternLine(pattern: string): string | undefined {
  const compiled = compileSubjectPattern(pattern)
  if (compiled.ok) return undefined
  switch (compiled.reason) {
    case 'too-big': return 'This rule stays off until this pattern is made smaller. Use smaller numbers in {n,m}.'
    case 'too-long': return `This rule stays off until this pattern is ${MAX_PATTERN_LENGTH} characters or fewer; it is ${pattern.length}. Shorten it, or split it into two rules.`
    case 'backreference': return 'This rule stays off until this pattern no longer refers to a group by number or name (\\1, \\k<name>).'
    case 'invalid': return `This rule stays off until this pattern is fixed: ${compiled.detail}`
    case 'unsupported': return `This rule stays off until this pattern is written another way (${compiled.detail}).`
  }
}

/** Plain spaces and tabs at the start and the end (an escaped one, `\ `, is meant). */
function edgeSpaces(pattern: string): { start: number; end: number } {
  const start = /^[ \t]*/.exec(pattern)![0].length
  if (start === pattern.length) return { start: 0, end: 0 }
  let end = /[ \t]*$/.exec(pattern)![0].length
  const before = pattern.length - end - 1
  let slashes = 0
  for (let i = before; i >= 0 && pattern[i] === '\\'; i -= 1) slashes += 1
  if (slashes % 2 === 1) end = 0
  return { start, end }
}

/** Whether a `|` outside a class has nothing on one side (at an end, beside `(`, `)` or another `|`). */
function emptyChoiceAt(pattern: string): 'start' | 'end' | 'inside' | null {
  let inClass = false
  let found: 'start' | 'end' | 'inside' | null = null
  for (let i = 0; i < pattern.length; i += 1) {
    const c = pattern[i]
    if (c === '\\') { i += 1; continue }
    if (inClass) { if (c === ']') inClass = false; continue }
    if (c === '[') { inClass = true; continue }
    if (c !== '|') continue
    if (i === 0) return 'start'
    if (i === pattern.length - 1) return 'end'
    const prev = pattern[i - 1]
    const next = pattern[i + 1]
    if (prev === '(' || prev === '|' || next === ')' || next === '|' || pattern.slice(i - 3, i) === '(?:') found = 'inside'
  }
  return found
}

/** The line under a pattern that runs, or undefined: the first that applies, the one that matters most. */
function hintOf(pattern: string, body: string, minLength: number, matchesAll: boolean): PatternHint | undefined {
  const slashes = /^\/(.+)\/([a-z]*)$/.exec(pattern)
  if (slashes) return { text: slashes[2] ? HINT_SLASHES_FLAGS : HINT_SLASHES, warn: true, fix: { label: 'Remove them', pattern: slashes[1]! } }
  const spaces = edgeSpaces(pattern)
  if (spaces.start || spaces.end) {
    const at = spaces.start && spaces.end ? 'both' : spaces.start ? 'start' : 'end'
    const count = spaces.start + spaces.end
    const fixed = pattern.slice(spaces.start, pattern.length - spaces.end)
    return { text: spacesHint(at, count, fixed), warn: true, fix: { label: count === 1 ? 'Remove it' : 'Remove them', pattern: fixed } }
  }
  if (minLength > SUBJECT_MATCH_CHARS) return { text: HINT_NEEDS_MORE, warn: true }
  if (matchesAll) {
    // `invoice|`, `.*`, all-optional parts: often a stray `|` or `?` that turns the rule on all mail.
    const empty = emptyChoiceAt(body)
    if (!empty) return { text: HINT_MATCHES_ALL, warn: true }
    const edge = empty === 'start' ? pattern.replace(/\|/, '') : empty === 'end' ? pattern.slice(0, -1) : null
    return { text: HINT_EMPTY_CHOICE, warn: true, ...(edge !== null ? { fix: { label: 'Remove the |', pattern: edge } } : {}) }
  }
  if (body !== pattern) return { text: HINT_INLINE_IGNORE_CASE, warn: false, fix: { label: 'Remove it', pattern: body } }
  return undefined
}

function compileUncached(pattern: string): SubjectPattern {
  if (pattern.length > MAX_PATTERN_LENGTH) {
    return { ok: false, reason: 'too-long', message: patternTooLong(pattern.length), detail: `${pattern.length} characters` }
  }
  const body = pattern.startsWith(INLINE_IGNORE_CASE) ? pattern.slice(INLINE_IGNORE_CASE.length) : pattern
  const compiled = compileLinear(body, { maxLength: SUBJECT_MATCH_CHARS })
  if (!compiled.ok) {
    const detail = compiled.detail
    switch (compiled.reason) {
      case 'invalid': return { ok: false, reason: 'invalid', message: invalidPatternSentence(detail), detail }
      case 'backreference': return { ok: false, reason: 'backreference', message: PATTERN_BACKREFERENCE, detail }
      case 'too-big': return { ok: false, reason: 'too-big', message: PATTERN_TOO_BIG, detail }
      case 'unsupported': return { ok: false, reason: 'unsupported', message: `Mail rules cannot check this pattern yet (${detail}). Write it another way.`, detail }
    }
  }
  const hint = hintOf(pattern, body, compiled.minLength, compiled.matchesAll)
  return {
    ok: true,
    ...(hint ? { hint } : {}),
    test: (subject) => subject.length > SUBJECT_MATCH_CHARS
      ? compiled.test(subject.slice(0, SUBJECT_MATCH_CHARS), { truncated: true, next: subject[SUBJECT_MATCH_CHARS] })
      : compiled.test(subject),
  }
}
