/**
 * src/lib/linear-regex: what it refuses, the grammar corners it must read exactly like the native
 * engine (Annex B escapes, literal braces, class ranges with class escapes, modifiers, quantified
 * lookaheads, the case-folding special letters), what a cut text may and may not answer, counted
 * repeats far past `maxLength` checked against every short subject, parts that only match the
 * empty string (folded before compiling, so nesting them costs nothing), and the linear glob.
 * The broad differential check is linear-regex-fuzz.test.ts.
 */
import { describe, expect, it } from 'vitest'
import { compilePattern } from '../../src/lib/linear-regex/compile.js'
import { compileGlob, compileLinear, type LinearMatcher } from '../../src/lib/linear-regex/index.js'
import { syntaxErrorReason } from '../../src/lib/linear-regex/syntax-error.js'
import { parsePattern } from '../../src/lib/linear-regex/parse.js'

function matcher(source: string, options: Parameters<typeof compileLinear>[1] = {}): LinearMatcher {
  const result = compileLinear(source, { maxLength: 300, ...options })
  if (!result.ok) throw new Error(`${source}: ${result.reason} ${result.detail}`)
  return result
}

/** Every subject over `alphabet` up to `length` characters. */
function allSubjects(alphabet: string[], length: number): string[] {
  let level = ['']
  const out = ['']
  for (let k = 0; k < length; k += 1) {
    level = level.flatMap((head) => alphabet.map((char) => head + char))
    out.push(...level)
  }
  return out
}

function expectNative(source: string, subjects: string[], options: Parameters<typeof compileLinear>[1] = {}): void {
  const native = new RegExp(source, options?.ignoreCase === false ? '' : 'i')
  for (const mode of [{}, { prefilter: false, nativeFastPath: false }]) {
    const linear = matcher(source, { ...options, ...mode })
    for (const subject of subjects) expect(linear.test(subject), `${source} on ${JSON.stringify(subject)}`).toBe(native.test(subject))
  }
}

describe('compileLinear refusals', () => {
  it('refuses what the native engine refuses, as invalid', () => {
    for (const source of ['(unclosed', '[z-a]', 'a**', '{1}', 'x{2,1}', '(?<a>x)\\k', '(?<=a)*']) {
      const result = compileLinear(source)
      expect(result.ok, source).toBe(false)
      if (!result.ok) expect(result.reason, source).toBe('invalid')
    }
  })

  it('names why a refused pattern is invalid in plain words, read from the pattern, never the engine prefix or echo', () => {
    const cases: Array<[string, string]> = [
      ['(?', '(? does not start a group; a plain group is (?:...).'],
      ['(?-:a)', '(?- does not start a group; a plain group is (?:...).'],
      // Inline flags as other engines write them.
      ['(?i)invoice', "(?i) belongs to other tools' patterns. Leave it out: patterns here already ignore case."],
      ['(?x)', "(?x) belongs to other tools' patterns. Leave it out."],
      ['(unclosed', 'a ( has no matching ). Close it, or write \\( to match a bracket.'],
      ['((a)', 'a ( has no matching ). Close it, or write \\( to match a bracket.'],
      ['a)', 'a ) has no matching (. Remove it, or write \\) to match a bracket.'],
      ['[a', 'a [ has no matching ]. Close it, or write \\[ to match a bracket.'],
      ['[a\\]', 'a [ has no matching ]. Close it, or write \\[ to match a bracket.'],
      ['\\', 'it ends with a lone \\. Remove it, or write \\\\ to match a backslash.'],
      // A glob's star, with the pattern written the regular-expression way as the example.
      ['*invoice*', '* has nothing before it to repeat. To match any text, use .* (for example .*invoice.*).'],
      ['*a', '* has nothing before it to repeat. To match any text, use .* (for example .*a).'],
      ['^*', '* has nothing before it to repeat. To match any text, use .* (for example ^.*).'],
      ['(*)', '* has nothing before it to repeat. To match any text, use .* (for example (.*)).'],
      ['a|+', '+ has nothing before it to repeat. Put what repeats before it, or write \\+ to match a plus sign.'],
      ['\\b?', '? has nothing before it to repeat. To match any one character, use . (a dot).'],
      ['?invoice', '? has nothing before it to repeat. To match any one character, use . (a dot).'],
      ['{1}', '{1} has nothing before it to repeat. Put what repeats before it.'],
      ['a**', '* comes right after another repeat. Remove one, or write \\* to match an asterisk.'],
      ['a++', '+ comes right after another repeat. Remove one, or write \\+ to match a plus sign.'],
      ['a{1}{2}', '{2} comes right after another repeat. Remove one of them.'],
      ['a+??', '? comes right after another repeat. Remove one, or write \\? to match a question mark.'],
      ['x{2,1}', 'in {2,1} the first number is bigger than the second. Write {1,2}.'],
      ['[z-a]', 'the range z-a in [ ] goes backwards. Write it as a-z.'],
      ['[\\x7a-\\x61]', 'the range \\x7a-\\x61 in [ ] goes backwards. Write it as \\x61-\\x7a.'],
      ['(?<=a)*', 'a lookbehind, (?<= or (?<!, cannot be repeated. Remove the repeat after it.'],
      ['(?<1a>x)', 'a group name must start with a letter, hold only letters, digits or _, and end with >.'],
      ['(?<a', 'a group name must start with a letter, hold only letters, digits or _, and end with >.'],
      ['(?<a>x)(?<a>y)', 'two groups are named a. Rename one of them.'],
      ['(?<a>x)\\k<b>', '\\k<b> names no group.'],
      ['(?<a>x)\\k', 'with named groups, \\k must be followed by <name>.'],
    ]
    for (const [source, reason] of cases) {
      const result = compileLinear(source)
      expect(() => new RegExp(source, 'i'), source).toThrow(SyntaxError)
      expect(result, source).toEqual({ ok: false, reason: 'invalid', detail: reason })
    }
    // Valid in the non-unicode grammar, so never named: literal braces and brackets, a repeated lookahead.
    for (const source of ['a{', '{', 'a{1', '}', ']', '(?=a)*', '[\\d-z]', '(?i:a)', 'a{1}?']) expect(compileLinear(source).ok, source).toBe(true)
    // An example that would not be valid itself is replaced by a plain one.
    expect(syntaxErrorReason('*(', 'x')).toBe('* has nothing before it to repeat. To match any text, use .* (for example .*invoice.*).')
    // A cause the scan does not know reads as the engine's words, without its prefix or its copy of the pattern.
    expect(syntaxErrorReason('q', 'Invalid regular expression: /q/i: Something new')).toBe('something new.')
    expect(syntaxErrorReason('q', 'Invalid regular expression: odd thing')).toBe('odd thing.')
  })

  it('refuses a back-reference, numbered or named, forward or not', () => {
    for (const source of ['(a)\\1', '(a)(b)\\2', '\\1(a)', '(?<n>a)\\k<n>', '(?:(a)|b)\\1+', '(?=(a))\\1', '(a)(b)(c)(d)(e)(f)(g)(h)(i)(j)\\10']) {
      const result = compileLinear(source)
      expect(result.ok, source).toBe(false)
      if (!result.ok) expect(result.reason, source).toBe('backreference')
    }
  })

  it('reads what only looks like a back-reference as the native engine does', () => {
    // No groups: \1 is octal; \8 is "8"; \k without named groups is "k"; with one group \12 and \10
    // name no group, so they are octal 012 (newline) and 010 (backspace).
    expectNative('\\1', ['\u0001', '1', 'a'])
    expectNative('\\8\\9', ['89', '\u0008'])
    expectNative('\\k<a>', ['k<a>', 'k'])
    expectNative('(a)\\12', ['a\n', 'a12', 'a'])
    expectNative('(a)\\10', ['a\u0008', 'a10', 'a'])
    expectNative('[\\1]', ['\u0001', '1'])
  })

  it('refuses a pattern whose expanded repeats exceed the state cap, lookaround bodies counted twice', () => {
    expect(compileLinear('(?:a{0,299}){0,300}', { maxLength: 300 })).toMatchObject({ ok: false, reason: 'too-big' })
    expect(compileLinear('(?:(?:(?:a{0,100}){0,100}){0,100}){0,100}', { maxLength: 1000 })).toMatchObject({ ok: false, reason: 'too-big' })
    // About 2,400 states: fine in the pattern, too many inside a lookaround.
    const body = '.{0,299}a.{0,299}b.{0,299}c.{0,299}d'
    expect(compileLinear(body, { maxLength: 300 }).ok).toBe(true)
    expect(compileLinear(`(?=${body})`, { maxLength: 300 })).toMatchObject({ ok: false, reason: 'too-big' })
  })

  it('reads an upper count at or past what fits in the longest text as no bound: a loop, a few states', () => {
    // On 300 characters `.{0,300}` and `.*` are the same; `.{0,299}` is not, and stays 299 copies.
    const states = (source: string): number => {
      const result = compileLinear(source, { maxLength: 300 })
      return result.ok ? result.states : Infinity
    }
    expect(states('.{0,300}a.{0,300}b.{0,300}c.{0,300}d.{0,300}e')).toBeLessThan(30)
    expect(states('(?=.{0,500}invoice)(?=.{0,500}paid)(?=.{0,500}due)')).toBeLessThan(80)
    expect(states('a{0,5000}b')).toBeLessThan(10)
    expect(states('(?:a?){301}b')).toBeLessThan(700)
    expect(states('.{0,299}a')).toBeGreaterThan(590)
    const subjects = ['', 'a', 'ba', 'a'.repeat(299), `${'a'.repeat(299)}b`, `${'b'.repeat(298)}ab`, 'b'.repeat(300)]
    for (const source of ['a{0,300}$', '^a{0,300}b', '^a{0,299}b', '(?=a{0,400}$)a', '(?<=a{0,300})b', '^a{300,}$', '^a{299,300}$']) {
      expectNative(source, subjects, { maxLength: 300 })
    }
    // The native engine backtracks for a long time on these: checked against what they equal.
    for (const [source, same] of [['^(?:a|){301}b', '^a*b'], ['^(?:a|){300}b', '^a*b'], ['^(?:a?){302}$', '^a*$']]) {
      for (const mode of [{}, { prefilter: false, nativeFastPath: false }]) {
        const linear = matcher(source!, { maxLength: 300, ...mode })
        for (const subject of subjects) expect(linear.test(subject), `${source} on ${subject.length}`).toBe(new RegExp(same!, 'i').test(subject))
      }
    }
  })

  it('refuses a text over maxLength rather than answering for part of it', () => {
    expect(() => matcher('a', { maxLength: 10 }).test('x'.repeat(11))).toThrow(RangeError)
  })

  it('accepts nested quantifiers: they are linear here', () => {
    for (const source of ['(a+)+$', '(a|a)+', '(a*)*b', '(.*a){3}', '((a+)+)+c']) expect(compileLinear(source).ok, source).toBe(true)
  })
})

describe('compileLinear grammar corners, against the native engine', () => {
  const SUBJECTS = ['', 'a', 'A', 'ab', 'aB', 'b', 'k', 'K', 'x', 'c', '\\', '\\c', '{', '}', ']', '{a', 'a{,5}', '-', '_', '0', '9', '\u0001',
    '\u0008', '\n', '\r', '\u2028', ' ', 'aaa', 'u', 'uu', 'x4', 'u12', '\u0000', '\u0000' + '8', 'A0', 'ab ab', 'a\nb', ' a ', 'z']

  it('Annex B escapes and literal braces', () => {
    for (const source of ['\\c', '\\cA', '\\cj', '\\c1', '[\\c1]', '[\\c_]', '[\\c]', '\\c*', '\\0', '\\08', '\\00', '\\101', '\\377',
      '\\400', '\\18', '\\x4', '\\x41', '\\u12', '\\u0041', '\\u{2}', '\\-', '\\/', '\\_', '\\a', '{', '}', ']', 'a{,5}', 'x{1,',
      '{a}', 'a{1}?', '[\\b]', '[\\B]', '[\\-]', '\\t\\n\\v\\f\\r']) {
      expectNative(source, SUBJECTS)
    }
  })

  it('classes: ranges, negation, class escapes, and Annex B ranges with a class escape at one end', () => {
    for (const source of ['[a-z]', '[^a]', '[^a-z]', '[A-z]', '[\\d-z]', '[a-\\d]', '[\\w-]', '[-a]', '[a-]', '[--a]', '[]', '[^]',
      '[\\W]', '[^\\W]', '[\\s\\S]', '[.]', '[[]', '[^\\]]', '[a-b-c]']) {
      expectNative(source, SUBJECTS)
    }
  })

  it('groups, alternation, modifiers, anchors and word boundaries', () => {
    for (const source of ['(?<g>a)|b', '(?:a|)b', '(?i:a)', '(?-i:a)', '(?-i:a)b', '(?-i:[a-z])', '(?m:^a)', '(?m:a$)', '(?s:a.b)',
      '(?i-s:a.b)', '(?ms:^.$)', '^a', 'a$', '\\ba', 'a\\b', '\\Ba', 'a\\B', '\\b', '\\B', '^$', '(?<a>x)|(?<a>a)']) {
      expectNative(source, SUBJECTS)
    }
  })

  it('lookarounds, nested and quantified (lookahead only, as Annex B allows)', () => {
    for (const source of ['(?=a)a', '(?!a)\\w', '(?<=a)b', '(?<!a)b', '(?=(?!b)a)', '(?<=(?<!a)b)', '(?=a)*b', '(?!a){2}b', '(?=a)+a',
      '(?=a){0}b', 'a(?=$)', '(?<=^)a', '(?<=\\b)b', '(?=.*b)a', '(?<!.*b)a', '(?=(?<=a)b)']) {
      expectNative(source, SUBJECTS)
    }
  })

  it('case folding special letters: micro sign and mu, sigmas, long s, Kelvin sign, Turkish i', () => {
    const subjects = ['\u00b5', '\u039c', '\u03bc', '\u03c3', '\u03c2', '\u03a3', '\u017f', 's', 'S', 'K', 'k', 'K', '\u0130', '\u0131', 'i', 'I', '\u00df', 'SS']
    for (const source of ['\u00b5', '\u03bc', '\u039c', '\u03c3', '\u03c2', '\u017f', 's', 'K', 'k', '\u0130', '\u0131', 'i', '[\u00b5]', '[^\u00b5]', '[a-z]', '[^a-z]', '[\u00b5-\u03c3]', '[\u0131-\u017f]',
      '[^\u0131-\u017f]', '\\w', '\\W', '[\\W]', '[^\\W]', '\u00df', '(?-i:\u00b5)', '\\u212a', '[\\u212a]', '\\u017f']) {
      expectNative(source, subjects)
    }
  })
})

describe('compileLinear on a cut text', () => {
  const cut = (source: string, text: string, next?: string): boolean => matcher(source).test(text, { truncated: true, next })

  it('$ never holds at the cut; under m it holds before a line break that comes next', () => {
    expect(matcher('a$').test('xa')).toBe(true)
    expect(cut('a$', 'xa', 'b')).toBe(false)
    expect(cut('a$', 'xa')).toBe(false)
    expect(cut('(?m:a$)', 'xa', '\n')).toBe(true)
    expect(cut('(?m:a$)', 'xa', 'b')).toBe(false)
    expect(cut('(?m:a$)', 'xa')).toBe(false)
  })

  it('\\b and \\B at the cut read the real next character, and hold for neither when it is unknown', () => {
    expect(cut('a\\b', 'xa', ' ')).toBe(true)
    expect(cut('a\\b', 'xa', 'b')).toBe(false)
    expect(cut('a\\B', 'xa', 'b')).toBe(true)
    expect(cut('a\\B', 'xa', ' ')).toBe(false)
    expect(cut('a\\b', 'xa')).toBe(false)
    expect(cut('a\\B', 'xa')).toBe(false)
  })

  it('a lookahead that needs characters past the cut fails; a negative one fails while its body could still match', () => {
    expect(cut('a(?=b)', 'xa', 'b')).toBe(false)
    expect(matcher('a(?=b)').test('xab')).toBe(true)
    expect(cut('a(?!bc)', 'xab', 'c')).toBe(false) // the body is still alive at the cut
    expect(cut('a(?!bc)', 'xax', 'c')).toBe(true) // the body died inside the cut
    expect(cut('a(?!b)', 'xa', 'b')).toBe(false)
    // A known next character that the body cannot take ends the body at the cut.
    expect(cut('a(?!b)', 'xa', 'c')).toBe(true)
    expect(cut('a(?!bc)', 'xab', 'd')).toBe(true)
    expect(cut('a(?!b)', 'xa')).toBe(false)
    expect(cut('a(?!b|c)', 'xa', 'c')).toBe(false)
    expect(cut('(?=a)a', 'xa')).toBe(true) // the lookahead is decided inside the cut
    expect(cut('(?<=a)b', 'ab')).toBe(true)
    // A lookahead nested in a lookbehind, asked at the cut, is unsure there.
    expect(matcher('b(?<=b(?=c))').test('abc')).toBe(true)
    expect(cut('b(?<=b(?=c))', 'ab', 'c')).toBe(false)
  })

  it('a match that ends inside the cut is found', () => {
    expect(cut('needle', 'hay needle hay', 'x')).toBe(true)
    expect(cut('needle', 'hay need', 'l')).toBe(false)
  })
})

describe('counted repeats past maxLength', () => {
  // maxLength 4: counts clamp to floor(4 / width) + 1 (consuming bodies) or 5 (bodies that may be
  // empty), and an upper count of floor(4 / width) (or 5) or more is a loop.
  const subjects = allSubjects(['a', 'b', ' '], 4)

  it('give the native answer on every subject up to maxLength', () => {
    for (const source of ['a{5}', 'a{4}', 'a{0,9}b', 'a{2,9}$', '(?:a|){9}b', '(?:a|\\b){7}', '(?:a|\\b){7}b', '(?:a?){20}a{3}',
      '(?:ab|a){3,40}', '(?:a{0,3}){6}b', '(?:(?=a)|b){9}', '(?:a|(?!b)){6}$', '(?: ?a){5,}', '(?:\\b|a){0,40}b', '(?:a{2}){3}',
      '(?:a|b{2}){4,}', '(?=a{0,9}$)a', '(?!(?:a|){9}b)', '(?<=a{5})b', '(?<=(?:a|){9})b']) {
      expectNative(source, subjects, { maxLength: 4 })
    }
  })

  it('keep a cut text sound: a lookahead body clamped mid-repeat still may match past the cut', () => {
    // `a{0,400}$` from 0 on 4 a's of a longer text: the body is alive at the cut, so (?!...) is unsure.
    const linear = matcher('^(?!a{0,400}$)', { maxLength: 4 })
    expect(linear.test('aaaa', { truncated: true, next: 'a' })).toBe(false)
    expect(new RegExp('^(?!a{0,400}$)').test('aaaaa')).toBe(false)
    expect(linear.test('aaab', { truncated: true, next: 'a' })).toBe(true)
  })
})

describe('parts that only match the empty string', () => {
  const SUBJECTS = ['', 'a', 'b', 'ab', 'ba', 'x', 'xa', 'a b', 'aa', 'bab']

  it('give the native answer: a pass after min that moves nothing fails, so they run min passes at one place', () => {
    for (const source of ['(?:)', 'a(?:){5}b', '(?:a{0}){4}b', '(?:(?=a)){0,3}b', '(?:(?=a)){2,3}a', '(?:\\b|(?=x)){3}x', '(?:(?!a)){1}b',
      '(?:(?:)|a){3}b', '(?:$){2}', '(?:^)*a', '(?:^){2}a', '(?<=(?:(?=a)){2})a', '(?=(?:(?:){9}){9})a', '(?:(?:\\b){9}){9}a', '((?:))+b',
      '(?:(?!b)){0}b', '(?:(?=b)|(?:)){4}b', '(?:a{0}|(?=a)){2,}a', '((((a){1}){1}){1})+b', '(?:(?:a{0}){0}a){3}']) {
      expectNative(source, SUBJECTS)
    }
  })

  it('compile in time bounded by the states they make, however deep they nest', () => {
    const DEEP = [
      '(?:(?:(?:(?:(?:){999}){999}){999}){999}){999}', '(?:(?:(?:(?:a{0}){999}){999}){999}){999}', '(?:(?:(?:(?:\\b){999}){999}){999}){999}',
      '(?:(?:(?:(?:(?=a)){999}){999}){999}){999}a', '(?:(?:(?:(?:(?:)|(?:)){999}){999}){999}){999}', '(?=(?:(?:(?:(?:){999}){999}){999}){999})',
      `${'('.repeat(40)}a${')'.repeat(40)}{300}`, `(?:${'(?:a{1}){1}'.repeat(8)}){30}`, '(?:a(?:)(?:)(?:)(?:)(?:)(?:)(?:)b){100}',
    ]
    for (const maxLength of [300, 1000]) {
      for (const source of DEEP) {
        const started = performance.now()
        const result = compileLinear(source, { maxLength })
        expect(performance.now() - started, source).toBeLessThan(60)
        expect(result.ok, source).toBe(true)
        const compiled = compilePattern(parsePattern(source, true), maxLength, 3000)
        expect(compiled.work, source).toBeLessThanOrEqual(4 * compiled.states + 4)
      }
    }
    // The native engine may itself take long on these deep nests: check them against what they equal.
    for (const [source, same] of [[DEEP[0]!, ''], [DEEP[3]!, '(?=a)a'], [DEEP[2]!, '\\b']]) {
      const linear = matcher(source!)
      for (const subject of SUBJECTS) expect(linear.test(subject), `${source} on ${subject}`).toBe(new RegExp(same!, 'i').test(subject))
    }
  })
})

describe('compileGlob', () => {
  it('is anchored, escapes regex characters, and lets * cross line breaks', () => {
    expect(compileGlob('a.b*')('a.bcd')).toBe(true)
    expect(compileGlob('a.b*')('axbcd')).toBe(false)
    expect(compileGlob('(x)')('(x)')).toBe(true)
    expect(compileGlob('*@example.invalid')('Someone@EXAMPLE.invalid')).toBe(true)
    expect(compileGlob('a*b')('a\n\nb')).toBe(true)
    expect(compileGlob('a*a')('a')).toBe(false)
    expect(compileGlob('*')('')).toBe(true)
    expect(compileGlob('')('x')).toBe(false)
  })

  it('folds case like a RegExp i flag (the Kelvin sign and long s stay apart)', () => {
    expect(compileGlob('k*')('Kx')).toBe(true)
    expect(compileGlob('k*')('\u212ax')).toBe(false)
    expect(compileGlob('s')('\u017f')).toBe(false)
    expect(compileGlob('\u00b5')('\u039c')).toBe(true)
    expect(compileGlob('a', { ignoreCase: false })('A')).toBe(false)
  })

  it('is linear: many stars on a long address', () => {
    const glob = '*a*b*c*d*e*f*g*h*'
    const value = `${'a'.repeat(320)}@example.invalid`
    const started = performance.now()
    expect(compileGlob(glob)(value)).toBe(false)
    expect(performance.now() - started).toBeLessThan(50)
  })
})

describe('minLength', () => {
  it('is the fewest characters a match consumes, with counts as written, before any clamp', () => {
    const cases: Array<[string, number]> = [
      ['', 0], ['a', 1], ['abc', 3], ['a*', 0], ['a+', 1], ['a{1000}', 1000], ['(?:ab){3,}', 6],
      ['ab|c', 1], ['(?:ab|c)d', 2], ['(?=x{500})y', 1], ['(?<!a)b', 1], ['^$', 0], ['\\bword\\b', 4],
      ['(?:a{100}){100}', 10_000], ['[^]', 1], ['a?b?c?', 0],
    ]
    for (const [source, least] of cases) {
      const compiled = compileLinear(source, { maxLength: 300 })
      expect(compiled.ok, source).toBe(true)
      if (compiled.ok) expect(compiled.minLength, source).toBe(least)
    }
  })
})
