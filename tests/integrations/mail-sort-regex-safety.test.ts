/**
 * `subject: { re }` runs synchronously on the one event loop (ingest, recompute, preview), so a
 * catastrophically backtracking pattern must be refused before it ever runs (C67).
 */
import { describe, expect, it } from 'vitest'
import {
  MAX_PATTERN_LENGTH, PATTERN_TOO_LONG, PATTERN_TOO_SLOW, SUBJECT_MATCH_CHARS, compileSubjectPattern, unsafePatternReason,
} from '../../src/integrations/mail/sort-regex-safety.js'
import { whenProblems } from '../../src/integrations/mail/sort-rules-schema.js'

describe('refused patterns', () => {
  it.each([
    '(a+)+$', '(a*)*', '(a|a)+', '(a|aa)*b', '(?:x+)+y', '(\\d+)*', '([a-z]+)+', '((ab)+)+', '(a{2,})+', '(.*a){3}',
  ])('%s is refused with the exact sentence', (pattern) => {
    expect(unsafePatternReason(pattern)).toBe(PATTERN_TOO_SLOW)
  })
  it.each(['(a)\\1', '(?<x>a)\\k<x>'])('back-reference %s is refused', (pattern) => {
    expect(unsafePatternReason(pattern)).toBe(PATTERN_TOO_SLOW)
  })
  it('a pattern over 200 characters is refused', () => {
    expect(unsafePatternReason('a'.repeat(MAX_PATTERN_LENGTH + 1))).toBe(PATTERN_TOO_LONG)
  })
  it('the schema reports it on the subject field', () => {
    expect(whenProblems({ subject: { re: '(a+)+$' } })).toEqual([['when.subject', PATTERN_TOO_SLOW]])
  })
})

describe('allowed patterns', () => {
  it.each([
    'window \\d+', '^\\[Action Required\\]', '(invoice|receipt) #\\d+', 'a+b+c*', '[(+)]+', '\\(a+\\)+', '(?:ab)c+', 'x{2,3}',
  ])('%s compiles and matches case-insensitively', (pattern) => {
    expect(unsafePatternReason(pattern)).toBeNull()
    expect(compileSubjectPattern(pattern).ok).toBe(true)
  })
  it('an invalid pattern gets its own sentence', () => {
    const result = compileSubjectPattern('(unclosed')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.message).toMatch(/^This pattern is not a valid regular expression: /)
  })
  it('matches only the first 300 characters of a subject', () => {
    const compiled = compileSubjectPattern('needle')
    if (!compiled.ok) throw new Error('should compile')
    expect(compiled.test(`${'x'.repeat(SUBJECT_MATCH_CHARS - 6)}needle`)).toBe(true)
    expect(compiled.test(`${'x'.repeat(SUBJECT_MATCH_CHARS)}needle`)).toBe(false)
    expect(compileSubjectPattern('ACTION').ok && (compileSubjectPattern('ACTION') as { test(s: string): boolean }).test('action required')).toBe(true)
  })
  it('the catastrophic shape never runs: refusing it takes well under 50 ms on a 30-character subject', () => {
    const started = performance.now()
    const result = compileSubjectPattern('(a+)+$')
    expect(result.ok).toBe(false)
    // What a naive engine would do with it: never reached, because the pattern is refused.
    const safe = compileSubjectPattern('a+$')
    if (!safe.ok) throw new Error('should compile')
    safe.test(`${'a'.repeat(29)}!`)
    expect(performance.now() - started).toBeLessThan(50)
  })
})
