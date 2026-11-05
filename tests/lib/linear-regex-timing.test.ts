/**
 * No pattern holds the thread: every hostile shape a backtracking engine takes seconds on (and the
 * shapes that leaked through three rounds of a static cost model, and two review rounds of the
 * native fast path) runs in under 20 ms on a 300-character subject, whole or cut, ASCII or
 * not (Greek, CJK, Cyrillic, accented Latin, emoji surrogate pairs, a mix), with the prefilter and
 * native fast path on (as shipped) and off (the NFA alone). Patterns at the native fast path's
 * limits (fast-path.ts) run natively in about a millisecond, and compiling any of these
 * shapes, the deepest nests of parts that only match the empty string included, is as quick: the
 * Settings editor compiles on every keystroke. The assertion's ceiling is generous for a loaded test
 * box; the measured worst is printed.
 */
import { describe, expect, it } from 'vitest'
import { DEFAULT_MAX_STATES, compileLinear, type LinearMatcher } from '../../src/lib/linear-regex/index.js'

const N = 300
const fill = (unit: string): string => unit.repeat(Math.ceil(N / unit.length)).slice(0, N)
const SUBJECTS = [
  'a'.repeat(N), '1'.repeat(N), 'ab'.repeat(N / 2), 'a b '.repeat(N / 4), 'A'.repeat(N),
  // Greek iota (folds with two other code units), CJK, Cyrillic, accented Latin, emoji surrogate pairs, a mix.
  '\u03b9'.repeat(N), fill('\u4e2d\u6587\u90ae\u4ef6'), fill('\u043f\u0438\u0441\u044c\u043c\u043e '), fill('caf\u00e9 d\u00e9j\u00e0 '),
  fill('\ud83d\udce7'), fill('Re: \u03b9\u4e2d\u043f\u00e9 \ud83d\ude00 a1 '),
]
/** 90 CJK code units, so a negated class of them answers yes for every other code unit. */
const CJK_SET = Array.from({ length: 90 }, (_, k) => String.fromCharCode(0x4e00 + 2 * k)).join('')
const CEILING_MS = 60

const HOSTILE = [
  '.*a.*b.*c.*d', '\\w*\\d*\\w*\\d*x', `${'a?'.repeat(24)}${'a'.repeat(24)}`, `${'(a?|)'.repeat(28)}\\d`,
  '\\w*\\w*(?:\\w){120}b', `${'a{0,8}'.repeat(5)}${'[a-z]'.repeat(30)}b`, '(a+)+$', '(a|aa)*b', '(.*a){3}', '(a*)*b', '((a+)+)+c',
  `.+.+${'(?!b)'.repeat(37)}b`, `.*.*${'\\B'.repeat(92)}b`, `${'(?:a?|)'.repeat(33)}\\d`, '(?=(a+)+$)', '(?!(a|a)*c)x',
  '(?<=(?=(a+)+b)a*)c', '(?=.*(?=.*(?=.*b)))', '(?<!(?<!a*)a)b', '.{0,300}x.{0,300}y.{0,300}z', '(?:.)+a(?:.)+b(?:.)+c',
  `${'a?'.repeat(10)}(?:.)+b`, `${'(?:a|a)'.repeat(10)}(?:.)+b`, `(?:a|a)(?:a|a)(?:.)+(?:.)+${'[^x]'.repeat(36)}b`,
  `${'a{0,3}'.repeat(9)}${'a'.repeat(27)}b`, `a?.*.*${'[a-z]'.repeat(37)}b`, `.+(?:${'(?!b)'.repeat(37)}.)+b`,
  `\\w*(?:${'(?<!b)'.repeat(31)}\\w)*x`, '^(\\w+\\s?)*$', '(\\d+)*x', '([a-z]+\\d*)+!',
  // Review round 2: a quantified nest of 92 groups the native engine took about 1 s on (fast path
  // before 2026-11-04), and a negated non-ASCII class repeated ~3,000 states deep on non-ASCII text.
  `(?:.?){4}${'('.repeat(92)}.${')'.repeat(92)}{236}!`, `(?:.?){4}${'(?:'.repeat(60)}a${')'.repeat(60)}{236}b`,
  `(?:(?:[^${CJK_SET}]?){5}){299}[#]`, `(?:[^${CJK_SET}]?){299}\\u4e01x`,
]

/**
 * Patterns at the fast path's limits (8 groups, 16 leaves, 256 steps, no repeated group): the worst
 * a backtracking engine may get there.
 */
const FAST_LIMIT = [
  `(?:a|a)(?:a|a)(?:a|a)(?:a|a)${'a'.repeat(240)}b`, '(?:a|aa)(?:a|aa)(?:a|aa)(?:a|aa)a{200}b', `a{0,15}${'a'.repeat(200)}b`,
  '(?:\\w|\\d)(?:\\w|\\d)(?:\\w|\\d)(?:\\w|\\d)\\w{240}x', 'a?a?a?a?a{240}b', '(?:.|\\s)(?:.|\\s)(?:.|\\s)(?:.|\\s).{200}$',
  `\\b(?:a|a)(?:a|a)(?:a|a)(?:a|a)\\b${'\\w'.repeat(200)}\\b!`, '(?:a|b|1|A)(?:a|b|1|A)[a-z ]{240}!',
  '(a|A)(a|1)(a|b)(a|c)((((a))))a{200}!', '(((((((([^x])))))))).?.{240}!', `.?.?.?.?${'\u03b9'.repeat(4)}.{230}!`,
]

/** Shapes the fast path must leave to the NFA, next to the plain rules it must keep. */
const NOT_FAST = [
  `(?:.?){4}${'('.repeat(92)}.${')'.repeat(92)}{236}!`, '(?:a?){4}a{240}b', '(?:a|b){2}c', '(a)+', '(?:ab)?c', 'a(b)*',
  '(a)(b)(c)(d)(e)(f)(g)(h)(i)', '(?=a)a', 'a+b', '.*x',
]
const FAST = ['(confirm|verify) your (email|account)', '\\b\\d{1,2}% off\\b', 'invoice', '^\\[(urgent|asap)\\]', '(a)(b)(c)(d)(e)(f)(g)(h)']

/** Nests of parts that only match the empty string: no states, so only simplify.ts keeps them cheap. */
const DEEP_EMPTY = [
  '(?:(?:(?:(?:(?:){999}){999}){999}){999}){999}', '(?:(?:(?:(?:a{0}){999}){999}){999}){999}', '(?:(?:(?:(?:\\b){999}){999}){999}){999}',
  '(?:(?:(?:(?:(?=a)){999}){999}){999}){999}a', '(?=(?:(?:(?:(?:){999}){999}){999}){999})',
]

/** The generated family (count x atom x quantifier, with prefixes) the earlier static cost model was judged on. */
function family(): string[] {
  const atoms = ['.', '\\w', '\\d', '[a-z]', 'a']
  const quants = ['*', '+', '{2,}', '?', '*?', '{0,400}']
  const out: string[] = []
  for (let count = 1; count <= 6; count += 1) {
    for (let k = 0; k < atoms.length; k += 1) {
      const run = Array.from({ length: count }, (_, at) => atoms[(k + at) % atoms.length]! + quants[(k + at) % quants.length]!).join('')
      out.push(`${run}x`, `(?:re: )?${run}x`, `(?:a|1)${run}x`, `\\b${run}\\bx`, `(?=${run}x)`)
    }
  }
  return out
}

/** Optional atoms chained to fill about 95% of `budget` states, every one live at every position. */
function chain(budget: number): string {
  const atoms = ['\\w?', '\\d?', '.?', '[a-z ]?', '\\S?', '\\D?']
  let out = ''
  let left = Math.floor(budget * 0.95)
  for (let k = 0; left >= 4; k += 1) {
    const copies = Math.min(N + 1, Math.floor(left / 2)) // each copy is a SPLIT and a CHAR; counts clamp to N + 1
    out += `(?:${atoms[k % atoms.length]}){${copies}}`
    left -= copies * 2
  }
  return out
}

/** Shapes near the state cap (lookaround bodies count twice, so they get half of it). */
function nearCap(): string[] {
  // `.{0,299}`: 300 or more would be no bound at all on 300 characters, a loop of two states.
  const dots = (budget: number, wrap: (one: string) => string): string =>
    Array.from({ length: Math.floor((budget * 0.95) / 600) }, (_, k) => wrap(`.{0,299}${'abcdefgh'[k]}`)).join('')
  return [
    `${chain(DEFAULT_MAX_STATES)}x`,
    `(?<=${chain(DEFAULT_MAX_STATES / 2)})x`,
    `(?=${chain(DEFAULT_MAX_STATES / 2)}x)`,
    `(?!${chain(DEFAULT_MAX_STATES / 2)}x)a`,
    dots(DEFAULT_MAX_STATES, (one) => one),
    `${dots(DEFAULT_MAX_STATES / 2, (one) => `(?=${one})`)}x`,
  ]
}

type Options = Parameters<typeof compileLinear>[1]

function timeOne(matcher: LinearMatcher, subject: string, cut: boolean): number {
  const started = performance.now()
  if (cut) matcher.test(subject, { truncated: true, next: subject[0] })
  else matcher.test(subject)
  return performance.now() - started
}

/**
 * The slowest test() over the subjects, whole and cut: one screening run each, then the median of
 * three for the slowest few, so one GC pause on a busy box is not read as a pattern's cost.
 */
function worstOf(patterns: string[], options: Options): { ms: number; source: string; refused: number } {
  const timings: Array<{ ms: number; source: string; subject: string; cut: boolean; matcher: LinearMatcher }> = []
  let refused = 0
  for (const source of patterns) {
    const matcher = compileLinear(source, { maxLength: N, ...options })
    if (!matcher.ok) { refused += 1; continue }
    matcher.test(SUBJECTS[0]!) // warm
    for (const subject of SUBJECTS) for (const cut of [false, true]) timings.push({ ms: timeOne(matcher, subject, cut), source, subject, cut, matcher })
  }
  timings.sort((a, b) => b.ms - a.ms)
  let worst = { ms: 0, source: '', refused }
  for (const slow of timings.slice(0, 4)) {
    const median = [0, 1, 2].map(() => timeOne(slow.matcher, slow.subject, slow.cut)).sort((a, b) => a - b)[1]!
    if (median > worst.ms) worst = { ms: median, source: slow.source, refused }
  }
  return worst
}

describe('linear-regex timing', () => {
  const NFA_ONLY: Options = { prefilter: false, nativeFastPath: false }
  const runs: Array<[string, string[], Options]> = [
    ['hostile, as shipped', HOSTILE, {}],
    ['hostile, NFA only', HOSTILE, NFA_ONLY],
    ['generated family, NFA only', family(), NFA_ONLY],
    ['near the state cap, NFA only', nearCap(), NFA_ONLY],
    ['at the fast path limits, as shipped', FAST_LIMIT, {}],
  ]

  for (const [name, patterns, options] of runs) {
    it(`${name}: every test() stays fast (${patterns.length} patterns)`, () => {
      const worst = worstOf(patterns, options)
      console.log(`[linear-regex timing] ${name}: worst ${worst.ms.toFixed(2)} ms ${worst.source.slice(0, 80)}; refused ${worst.refused}`)
      expect(worst.refused).toBe(0)
      expect(worst.ms).toBeLessThan(CEILING_MS)
    })
  }

  it('the fast-limit shapes really run natively, and the shapes outside its proof do not', () => {
    for (const source of [...FAST_LIMIT, ...FAST]) {
      const matcher = compileLinear(source, { maxLength: N })
      expect(matcher.ok && matcher.native, source).toBe(true)
    }
    for (const source of NOT_FAST) {
      const matcher = compileLinear(source, { maxLength: N })
      expect(matcher.ok && !matcher.native, source).toBe(true)
    }
  })

  it('compiling every shape above stays fast', () => {
    let worst = { ms: 0, source: '' }
    for (const source of [...HOSTILE, ...family(), ...nearCap(), ...FAST_LIMIT, ...DEEP_EMPTY]) {
      const ms = [0, 1, 2].map(() => {
        const started = performance.now()
        expect(compileLinear(source, { maxLength: N }).ok, source).toBe(true)
        return performance.now() - started
      }).sort((a, b) => a - b)[1]!
      if (ms > worst.ms) worst = { ms, source }
    }
    console.log(`[linear-regex timing] compile: worst ${worst.ms.toFixed(2)} ms ${worst.source.slice(0, 80)}`)
    expect(worst.ms).toBeLessThan(CEILING_MS)
  })

  it('the near-cap shapes really are near the cap', () => {
    for (const source of nearCap()) {
      const matcher = compileLinear(source, { maxLength: N })
      expect(matcher.ok, source).toBe(true)
      if (matcher.ok) expect(matcher.states).toBeGreaterThan(DEFAULT_MAX_STATES * 0.4)
    }
  })
})
