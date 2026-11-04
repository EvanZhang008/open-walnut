/**
 * `subject: { re }` runs synchronously on the one event loop (ingest, recompute, preview), so it
 * runs in the linear matcher (C67): no pattern can hold the loop, so nested repeats and the rules
 * people actually write are allowed, and only what the matcher cannot run is refused, each with its
 * own sentence: an invalid pattern, one over 200 characters, a back-reference, and repeat counts too
 * big to check quickly. Matching sees the first 300 characters and never gains a match from the cut.
 */
import { describe, expect, it } from 'vitest'
import {
  HINT_EMPTY_CHOICE, HINT_INLINE_IGNORE_CASE, HINT_MATCHES_ALL, HINT_NEEDS_MORE, HINT_SLASHES, HINT_SLASHES_FLAGS, MAX_PATTERN_LENGTH, PATTERN_BACKREFERENCE,
  PATTERN_TOO_BIG, RULE_OFF_BACKREFERENCE, RULE_OFF_TOO_BIG, SUBJECT_MATCH_CHARS, compileSubjectPattern, heldPatternLine, patternTooLong,
  ruleOffInvalid, ruleOffReason, ruleOffTooLong, spacesHint, type PatternHint,
} from '../../src/integrations/mail/sort-regex-safety.js'
import { whenProblems } from '../../src/integrations/mail/sort-rules-schema.js'
import { compileLinear } from '../../src/lib/linear-regex/index.js'

function compiled(pattern: string): (subject: string) => boolean {
  const result = compileSubjectPattern(pattern)
  if (!result.ok) throw new Error(`${pattern}: ${result.message}`)
  return result.test
}

const WORST = ['a'.repeat(300), '1'.repeat(300), 'ab'.repeat(150), 'a b '.repeat(75), 'A'.repeat(300), `${'a'.repeat(299)}!`]

describe('refused patterns', () => {
  it('an invalid pattern says why in plain words, once (no engine prefix, no copy of the pattern)', () => {
    const unclosed = 'a ( has no matching ). Close it, or write \\( to match a bracket.'
    expect(compileSubjectPattern('(unclosed')).toEqual({
      ok: false, reason: 'invalid', message: `This pattern is not a valid regular expression: ${unclosed}`, detail: unclosed,
    })
    expect(compileSubjectPattern('[a-')).toMatchObject({ message: 'This pattern is not a valid regular expression: a [ has no matching ]. Close it, or write \\[ to match a bracket.' })
    // The common mistakes say how to fix them.
    expect(compileSubjectPattern('*invoice*')).toMatchObject({
      message: 'This pattern is not a valid regular expression: * has nothing before it to repeat. To match any text, use .* (for example .*invoice.*).',
    })
    // An inline flag other tools write is named as theirs; a leading (?i) is run without it (below).
    expect(compileSubjectPattern('(?m)invoice')).toMatchObject({
      message: "This pattern is not a valid regular expression: (?m) belongs to other tools' patterns. Leave it out.",
    })
    expect(compileSubjectPattern('invoice(?i)')).toMatchObject({
      message: "This pattern is not a valid regular expression: (?i) belongs to other tools' patterns. Leave it out: patterns here already ignore case.",
    })
    for (const pattern of ['(?', '[a', '\\', '*x', 'x{3,1}', '[z-a]']) {
      const result = compileSubjectPattern(pattern)
      expect(result.ok, pattern).toBe(false)
      if (!result.ok) {
        expect(result.message, pattern).not.toMatch(/Invalid regular expression/i)
        expect(result.message, pattern).not.toContain(`/${pattern}/`)
      }
    }
  })

  it('a pattern over 200 characters is refused, naming its length; 200 is fine', () => {
    expect(patternTooLong(218)).toBe('This pattern is 218 characters; the limit is 200. Shorten it, or split it into two rules.')
    expect(compileSubjectPattern('a'.repeat(MAX_PATTERN_LENGTH + 1))).toEqual({
      ok: false, reason: 'too-long', message: patternTooLong(MAX_PATTERN_LENGTH + 1), detail: '201 characters',
    })
    expect(compileSubjectPattern('a'.repeat(MAX_PATTERN_LENGTH)).ok).toBe(true)
  })

  it.each(['(a)\\1', '(?<x>a)\\k<x>', '(\\w+) \\1', '\\1(a)'])('back-reference %s is refused with its sentence', (pattern) => {
    expect(compileSubjectPattern(pattern)).toMatchObject({ ok: false, reason: 'backreference', message: PATTERN_BACKREFERENCE })
  })

  it.each(['(?:a{0,100}){0,100}', '(?:.{0,299}){20}', '(?=(?:\\w{0,299}x){5})'])('%s is too big to check quickly', (pattern) => {
    expect(compileSubjectPattern(pattern)).toMatchObject({ ok: false, reason: 'too-big', message: PATTERN_TOO_BIG })
  })

  it('a rule whose pattern Walnut will not run is off with one line saying the way back on; every other rule is on', () => {
    expect(RULE_OFF_TOO_BIG).toBe('This rule is off: its pattern repeats too many times to check quickly. Edit it with smaller numbers in {n,m} to turn it on.')
    expect(ruleOffReason({ subject: { re: '(?:.{0,299}){20}' } })).toBe(RULE_OFF_TOO_BIG)
    expect(ruleOffReason({ subject: { re: '(a)\\1' } })).toBe(RULE_OFF_BACKREFERENCE)
    // An invalid one names its cause on the row, as its editor does.
    expect(ruleOffReason({ subject: { re: '(unclosed' } })).toBe(ruleOffInvalid('a ( has no matching ). Close it, or write \\( to match a bracket.'))
    expect(ruleOffInvalid('x')).toBe('This rule is off until its pattern is fixed: x')
    expect(ruleOffReason({ subject: { re: 'a'.repeat(218) } })).toBe(ruleOffTooLong(218))
    expect(ruleOffTooLong(218)).toBe('This rule is off: its pattern is 218 characters; the limit is 200. Shorten it, or split it into two rules, to turn it on.')
    for (const when of [{ subject: { re: '(a+)+$' } }, { subject: 'plain text' }, { from: 'a@*' }, null]) {
      expect(ruleOffReason(when), JSON.stringify(when)).toBeUndefined()
    }
  })

  it('the editor says why a rule stays off under its own pattern, with the exact cause, and nothing for one that runs', () => {
    expect(heldPatternLine('(?:.{0,299}){20}')).toBe('This rule stays off until this pattern is made smaller. Use smaller numbers in {n,m}.')
    expect(heldPatternLine('(unclosed')).toBe('This rule stays off until this pattern is fixed: a ( has no matching ). Close it, or write \\( to match a bracket.')
    expect(heldPatternLine('a'.repeat(218))).toBe('This rule stays off until this pattern is 200 characters or fewer; it is 218. Shorten it, or split it into two rules.')
    expect(heldPatternLine('(a)\\1')).toBe('This rule stays off until this pattern no longer refers to a group by number or name (\\1, \\k<name>).')
    expect(heldPatternLine('invoice')).toBeUndefined()
  })

  it('the schema reports each refusal on the subject field', () => {
    expect(whenProblems({ subject: { re: '(a)\\1' } })).toEqual([['when.subject', PATTERN_BACKREFERENCE]])
    expect(whenProblems({ subject: { re: '(?:.{0,299}){20}' } })).toEqual([['when.subject', PATTERN_TOO_BIG]])
    expect(whenProblems({ subject: { re: '(a+)+$' } })).toEqual([])
  })
})

describe('hints: patterns that run but would not match as they seem meant to', () => {
  const hintOf = (pattern: string): PatternHint | undefined => {
    const result = compileSubjectPattern(pattern)
    expect(result.ok, pattern).toBe(true)
    return result.ok ? result.hint : undefined
  }
  const warn = (text: string, fix?: { label: string; pattern: string }): PatternHint => ({ text, warn: true, ...(fix ? { fix } : {}) })

  it('names pasted slashes and flags, spaces at an end, a match longer than what is checked and one of every subject; none is refused', () => {
    const cases: Array<[string, PatternHint | undefined]> = [
      ['/invoice/i', warn(HINT_SLASHES_FLAGS, { label: 'Remove them', pattern: 'invoice' })],
      ['/invoice/gi', warn(HINT_SLASHES_FLAGS, { label: 'Remove them', pattern: 'invoice' })],
      ['/invoice/', warn(HINT_SLASHES, { label: 'Remove them', pattern: 'invoice' })],
      ['invoice  ', warn(spacesHint('end', 2, 'invoice'), { label: 'Remove them', pattern: 'invoice' })],
      [' invoice', warn(spacesHint('start', 1, 'invoice'), { label: 'Remove it', pattern: 'invoice' })],
      [' invoice ', warn(spacesHint('both', 2, 'invoice'), { label: 'Remove them', pattern: 'invoice' })],
      ['invoice\\ ', undefined], // an escaped space is meant
      ['a{1000}', warn(HINT_NEEDS_MORE)], ['.{301}', warn(HINT_NEEDS_MORE)], ['.{300}', undefined], ['(?=.{0,500}paid)', undefined],
      ['invoice', undefined], ['a/b', undefined], ['/', undefined],
      // Matches every subject: said, never refused; a stray | at an end is named and removed in one click.
      ['.*', warn(HINT_MATCHES_ALL)], ['(a)?(b)?(c)?', warn(HINT_MATCHES_ALL)], ['x*', warn(HINT_MATCHES_ALL)], ['(?:)', warn(HINT_MATCHES_ALL)],
      ['invoice|', warn(HINT_EMPTY_CHOICE, { label: 'Remove the |', pattern: 'invoice' })],
      ['|invoice', warn(HINT_EMPTY_CHOICE, { label: 'Remove the |', pattern: 'invoice' })],
      ['(invoice||receipt)', warn(HINT_EMPTY_CHOICE)],
      ['(re: |)invoice', undefined], ['invoice\\|', undefined], ['[|]', undefined],
      ['^$', undefined], ['\\b', undefined], ['(?=x)|(?!x)', undefined], ['^.*', undefined],
      // A leading (?i) runs without it; the hint is calm, with its fix.
      ['(?i)invoice', { text: HINT_INLINE_IGNORE_CASE, warn: false, fix: { label: 'Remove it', pattern: 'invoice' } }],
      // A Unicode property runs as one: no hint at all.
      ['\\p{L}+', undefined], ['[\\P{Lu}]', undefined], ['\\\\p{L}', undefined],
    ]
    for (const [pattern, hint] of cases) expect(hintOf(pattern), pattern).toEqual(hint)
    expect(spacesHint('end', 2, 'invoice')).toBe('This pattern ends with 2 spaces, so it matches only where 2 spaces follow "invoice".')
    expect(spacesHint('start', 1, 'invoice')).toBe('This pattern starts with a space, so it matches only where a space comes before "invoice".')
    expect(spacesHint('end', 1, 'x'.repeat(31))).toBe('This pattern ends with a space, so it matches only where a space follows the rest of the pattern.')
    expect(HINT_NEEDS_MORE).toBe('This pattern needs more than 300 characters, but only the first 300 of a subject are checked, so it never matches. Make it need 300 or fewer.')
    // Each hint is true: a matches-every-subject pattern matches any text, a leading (?i) changes nothing,
    // trailing spaces are matched as typed, and every fix is a pattern that runs without the hint.
    for (const subject of ['', 'x', 'Invoice 42', ' '.repeat(5)]) {
      expect(compiled('invoice|')(subject), subject).toBe(true)
      expect(compiled('(a)?(b)?(c)?')(subject), subject).toBe(true)
    }
    expect(compiled('(?i)invoice')('INVOICE 42')).toBe(true)
    expect(compiled('(?i)invoice')('receipt')).toBe(false)
    expect(compiled('invoice  ')('Invoice 42')).toBe(false)
    expect(compiled('invoice  ')('Invoice  42')).toBe(true)
    for (const [pattern, hint] of cases) if (hint?.fix) expect(hintOf(hint.fix.pattern), pattern).toBeUndefined()
    // The hint is true: such a pattern never matches the longest subject Walnut checks.
    expect(compiled('a{1000}')('a'.repeat(SUBJECT_MATCH_CHARS + 700))).toBe(false)
  })
})

describe('Unicode properties', () => {
  it('\\p{…} matches as the unicode mode reads it: letters of any script, CJK, a bare script name', () => {
    const cases: Array<[string, string[], string[]]> = [
      ['\\p{L}+ invoice', ['Fuel dock invoice', 'Caf\u00e9 invoice', '\u6e2f\u53e3 invoice'], ['42 invoice', '- invoice']],
      ['^\\p{Lu}', ['Invoice', 'invoice'], ['42 invoice']], // case is ignored, as with the unicode mode's i flag
      ['\\p{Han}{2}', ['\u6e2f\u53e3 fees'], ['harbour fees', '\u6e2f fees']],
      ['\\p{Script=Greek}', ['\u03a9 meter'], ['ohm meter']],
      ['[\\p{L}\\d]+-\\d+', ['OPS-1234', '\u00c9t\u00e91-2'], ['-12']],
      ['^\\P{L}', ['42 invoices', '[ops] down'], ['Invoice']],
      ['[^\\p{L}\\s]', ['a1'], ['abc def']],
    ]
    for (const [pattern, yes, no] of cases) {
      const test = compiled(pattern)
      // The unicode mode spells a script `Script=Han`; the bare name is the RE2 and PCRE spelling.
      const native = new RegExp(pattern.replace(/\\p\{Han\}/g, '\\p{Script=Han}'), 'iu')
      for (const subject of yes) expect(test(subject), `${pattern} on ${subject}`).toBe(true)
      for (const subject of no) expect(test(subject), `${pattern} on ${subject}`).toBe(false)
      for (const subject of [...yes, ...no]) expect(test(subject), `${pattern} vs native on ${subject}`).toBe(native.test(subject))
    }
    // Escaped, the backslash is text: `\\p{L}` is the characters \p{L}.
    expect(compiled('\\\\p\\{L\\}')('a \\p{L} b')).toBe(true)
  })

  it('a name that is no property, or a \\p with no braces, is refused with a way forward', () => {
    expect(compileSubjectPattern('\\p{Foo} invoice')).toMatchObject({
      ok: false, reason: 'invalid',
      message: 'This pattern is not a valid regular expression: \\p{Foo} is not a Unicode property. Use one such as \\p{L} (any letter) or \\p{Han}.',
    })
    for (const pattern of ['\\p invoice', '\\pL', '\\p{L', '[\\P]']) {
      expect(compileSubjectPattern(pattern), pattern).toMatchObject({ ok: false, reason: 'invalid' })
    }
    expect(compileSubjectPattern('\\P')).toMatchObject({
      message: 'This pattern is not a valid regular expression: \\P needs a property name in braces, such as \\P{L} for any letter.',
    })
  })

  it('a property is read once, quickly, and the pattern stays in the linear matcher', () => {
    const started = performance.now()
    const first = compileLinear('\\p{Ll}x', { maxLength: SUBJECT_MATCH_CHARS })
    const ms = performance.now() - started
    console.log(`[mail subject pattern] first \\p{Ll}: ${ms.toFixed(1)} ms`)
    expect(ms).toBeLessThan(250)
    expect(first).toMatchObject({ ok: true, native: false })
    const again = performance.now()
    compileLinear('\\p{Ll}y', { maxLength: SUBJECT_MATCH_CHARS })
    expect(performance.now() - again).toBeLessThan(20)
  })
})

describe('allowed patterns', () => {
  // Refused as too big before an upper count at or past the 300 characters read became a loop.
  it.each([
    ['(?=.{0,500}invoice)(?=.{0,500}paid)(?=.{0,500}due)', 'Invoice 42: paid, nothing due', 'Invoice 42: paid'],
    ['.{0,300}a.{0,300}b.{0,300}c.{0,300}d.{0,300}e', 'a, b, c, d and e', 'a, b, c and d'],
  ])('%s compiles small and quick and matches like the native engine', (pattern, yes, no) => {
    const started = performance.now()
    const test = compiled(pattern)
    const ms = performance.now() - started
    const linear = compileLinear(pattern, { maxLength: SUBJECT_MATCH_CHARS })
    const states = linear.ok ? linear.states : Infinity
    console.log(`[mail subject pattern] ${pattern}: ${states} states, compiled in ${ms.toFixed(2)} ms`)
    expect(states).toBeLessThan(100)
    expect(ms).toBeLessThan(60)
    const native = new RegExp(pattern, 'i')
    for (const subject of [yes, no, `${'x'.repeat(250)} ${yes}`, `${yes} ${'x'.repeat(280)}`]) expect(test(subject), subject).toBe(native.test(subject.slice(0, SUBJECT_MATCH_CHARS)) && native.test(subject))
    expect(test(yes)).toBe(true)
    expect(test(no)).toBe(false)
  })

  // 2026-11-04 review: a shared check in the wait_for work refused these real sort rules (a
  // repeated group around an alternation of distinct words), so a saved rule stopped loading.
  it.each([
    '^(?:(?:re|fw):\\s)+', '(?:(?:re|fwd):)+', '^\\[(?:(?:jira|github))\\]+', '(?:x(?:a|b))+',
  ])('%s, a rule that loaded before wait_for, still loads', (pattern) => {
    expect(compileSubjectPattern(pattern).ok).toBe(true)
  })

  it.each([
    ['\\[[A-Z]+-\\d+\\] .*(resolved|closed)', '[OPS-1234] Disk alert was resolved', '[ops] resolved'],
    ['ticket #?\\d+ .*(updated|commented)', 'Ticket #4521 was updated by the desk', 'ticket updated'],
    ['(invoice|receipt|statement) .*\\$\\d+', 'Your receipt from Acme: $42.10', 'Your receipt from Acme'],
    ['^(\\[[^\\]]+\\] )?(re|fwd): ', '[team] Re: lunch', 'More: lunch'],
    ['(\\.\\d{2})?', 'anything', ''],
    ['window \\d+', 'Maintenance window 3 tonight', 'window tonight'],
    ['^\\[Action Required\\]', '[ACTION REQUIRED] sign the form', 'Re: [Action Required]'],
    ['\\b(urgent|asap)\\b', 'URGENT: reply', 'insurgents'],
  ])('the realistic rule %s compiles and matches like the native engine', (pattern, yes, no) => {
    const test = compiled(pattern)
    const native = new RegExp(pattern, 'i')
    expect(test(yes)).toBe(native.test(yes))
    expect(test(no)).toBe(native.test(no))
    if (pattern !== '(\\.\\d{2})?') expect(test(no)).toBe(false)
    expect(test(yes)).toBe(true)
  })

  it.each([
    '(a+)+$', '(a*)*', '(a|a)+', '(a|aa)*b', '(?:x+)+y', '(\\d+)*', '([a-z]+)+', '((ab)+)+', '(a{2,})+', '(.*a){3}',
    '.*a.*b.*c.*d', '\\w*\\d*\\w*\\d*x', `${'a?'.repeat(24)}${'a'.repeat(24)}`, `${'(a?|)'.repeat(28)}\\d`,
    '\\w*\\w*(?:\\w){120}b', `${'a{0,8}'.repeat(5)}${'[a-z]'.repeat(30)}b`,
  ])('%s, which backtracks for seconds natively, is allowed and stays fast on every worst subject', (pattern) => {
    const test = compiled(pattern)
    let worst = 0
    for (const subject of [...WORST, ...WORST.map((one) => one + one)]) {
      const started = performance.now()
      test(subject)
      worst = Math.max(worst, performance.now() - started)
    }
    expect(worst).toBeLessThan(60)
  })

  // The native engine may itself take long on these, so each is checked against what it equals.
  it.each([
    ['(?:(?:(?:(?:(?:){999}){999}){999}){999}){999}', ''], ['(?:(?:(?:(?:a{0}){999}){999}){999}){999}x', 'x'],
    ['(?:(?:(?:(?:\\b){999}){999}){999}){999}x', '\\bx'],
  ])('%s, a nest of parts that match only the empty string, compiles at once (it once took an hour)', (pattern, same) => {
    expect(pattern.length).toBeLessThanOrEqual(MAX_PATTERN_LENGTH)
    const started = performance.now()
    const test = compiled(pattern)
    expect(whenProblems({ subject: { re: pattern } })).toEqual([])
    expect(performance.now() - started).toBeLessThan(60)
    const native = new RegExp(same, 'i')
    for (const subject of ['', 'x', 'a x', 'xa']) expect(test(subject), subject).toBe(native.test(subject))
  })
})

describe('the 300-character contract', () => {
  it('matches inside the first 300 characters only', () => {
    const test = compiled('needle')
    expect(SUBJECT_MATCH_CHARS).toBe(300)
    expect(test(`${'x'.repeat(SUBJECT_MATCH_CHARS - 6)}needle`)).toBe(true)
    expect(test(`${'x'.repeat(SUBJECT_MATCH_CHARS)}needle`)).toBe(false)
    expect(test(`${'x'.repeat(SUBJECT_MATCH_CHARS - 3)}needle`)).toBe(false) // runs over the cut
    expect(compiled('ACTION')('action required')).toBe(true)
  })

  it('a longer subject never gains a match from the cut: $, \\b and lookaheads see that it goes on', () => {
    const head = 'x'.repeat(SUBJECT_MATCH_CHARS - 5)
    expect(compiled('word$')(`${head}word`)).toBe(true)
    expect(compiled('word$')(`${head} word and more`)).toBe(false)
    expect(compiled('word\\b')(`${head} words`)).toBe(false)
    expect(compiled('word\\b')(`${head} word more`)).toBe(true)
    expect(compiled('word(?= now)')(`${head} word now`)).toBe(false)
    expect(compiled('word(?!s)')(`${head} words`)).toBe(false)
    expect(compiled('word(?!s)')(`${'x'.repeat(10)} word now`)).toBe(true)
  })
})
