/**
 * The linear matcher gives the native answer: seeded random patterns over the whole non-unicode
 * grammar (tests/lib/linear-regex-gen.ts) against `new RegExp(pattern, 'i').test(subject)`, as
 * shipped (prefilter and native fast path on) and as the NFA alone, on short subjects and on ones
 * of 100 to 300 characters. Also: what a cut text promises, counted repeats far past `maxLength`,
 * `ignoreCase: false`, compile work per state, the case table against the native engine's own
 * folding over the whole BMP, `\s`, and the linear glob.
 *
 * What a cut text promises: with `{ truncated: true, next }` on `full.slice(0, cut)`, a true answer
 * means the full text has a match that ends within the cut; for a pattern without lookahead the
 * answer is exactly that (`$`, `\b` and lookbehinds all decide from the cut and `next`).
 */
import { describe, expect, it } from 'vitest'
import { compilePattern } from '../../src/lib/linear-regex/compile.js'
import { caseTable, compileGlob, compileLinear, type LinearMatcher } from '../../src/lib/linear-regex/index.js'
import { parsePattern } from '../../src/lib/linear-regex/parse.js'
import { LINE_TERMINATORS, SPACE, contains } from '../../src/lib/linear-regex/charset.js'
import { genPattern, genSubject, seeded, subjectCap, type GeneratedPattern } from './linear-regex-gen.js'

/** A case is skipped only when the native engine itself takes this long on it. */
const NATIVE_SLOW_MS = 20
const NFA_ONLY = { prefilter: false, nativeFastPath: false } as const

interface Corpus { pattern: GeneratedPattern; shipped: LinearMatcher; nfa: LinearMatcher }

function corpus(seed: number, count: number, options: { maxLength: number; maxCount?: number; ignoreCase?: boolean; depth?: number }) {
  const rand = seeded(seed)
  const out: Corpus[] = []
  const refused: string[] = []
  let invalid = 0
  for (let k = 0; k < count; k += 1) {
    const pattern = genPattern(rand, { maxCount: options.maxCount, depth: options.depth })
    const common = { maxLength: options.maxLength, ignoreCase: options.ignoreCase }
    const shipped = compileLinear(pattern.source, common)
    const nfa = compileLinear(pattern.source, { ...common, ...NFA_ONLY })
    if (!shipped.ok || !nfa.ok) {
      const failure = !shipped.ok ? shipped : nfa.ok ? null : nfa
      if (failure?.reason === 'invalid') invalid += 1
      else refused.push(`${JSON.stringify(pattern.source)}: ${failure?.reason} ${failure?.detail}`)
      continue
    }
    out.push({ pattern, shipped, nfa })
  }
  return { rand, patterns: out, refused, invalid }
}

/** The native answer, or null when the native engine is too slow on this case to wait for. */
function nativeTest(regex: RegExp, subject: string): boolean | null {
  const started = performance.now()
  const answer = regex.test(subject)
  return performance.now() - started > NATIVE_SLOW_MS ? null : answer
}

describe('linear-regex differential fuzz', () => {
  it('agrees with native RegExp on seeded random patterns, as shipped and as the NFA alone', () => {
    const mismatches: string[] = []
    const refused: string[] = []
    let cases = 0
    let trues = 0
    let skipped = 0
    for (const seed of [11, 12, 13, 14]) {
      const { rand, patterns, refused: none } = corpus(seed, 700, { maxLength: 300 })
      refused.push(...none)
      for (const { pattern, shipped, nfa } of patterns) {
        const native = new RegExp(pattern.source, 'i')
        for (let k = 0; k < 5; k += 1) {
          const subject = genSubject(rand, subjectCap(pattern, 40))
          const want = nativeTest(native, subject)
          if (want === null) { skipped += 1; continue }
          cases += 1
          if (want) trues += 1
          for (const [mode, matcher] of [['shipped', shipped], ['nfa', nfa]] as const) {
            if (matcher.test(subject) !== want) mismatches.push(`${mode} ${JSON.stringify(pattern.source)} on ${JSON.stringify(subject)}: native ${want}`)
          }
        }
      }
    }
    expect(refused).toEqual([])
    expect(mismatches.slice(0, 20)).toEqual([])
    expect(cases).toBeGreaterThan(12_000)
    // Both answers are well represented, so agreement means something.
    expect(trues).toBeGreaterThan(cases / 4)
    expect(cases - trues).toBeGreaterThan(cases / 4)
    expect(skipped).toBeLessThan(cases / 100)
  })

  it('agrees on subjects of 100 to 300 characters, the length mail checks', () => {
    const mismatches: string[] = []
    let cases = 0
    let trues = 0
    let skipped = 0
    const { rand, patterns } = corpus(15, 900, { maxLength: 300 })
    for (const { pattern, shipped, nfa } of patterns) {
      // Patterns a backtracking engine is slow on at this length cannot be checked against it.
      if (pattern.nested || pattern.unbounded > 2) continue
      const native = new RegExp(pattern.source, 'i')
      for (let k = 0; k < 2; k += 1) {
        const length = 100 + Math.floor(rand() * 201)
        let subject = ''
        while (subject.length < length) subject += genSubject(rand, 12)
        subject = subject.slice(0, length)
        const want = nativeTest(native, subject)
        if (want === null) { skipped += 1; continue }
        cases += 1
        if (want) trues += 1
        for (const [mode, matcher] of [['shipped', shipped], ['nfa', nfa]] as const) {
          if (matcher.test(subject) !== want) mismatches.push(`${mode} ${JSON.stringify(pattern.source)} on ${JSON.stringify(subject)}: native ${want}`)
        }
      }
    }
    expect(mismatches.slice(0, 20)).toEqual([])
    expect(cases).toBeGreaterThan(800)
    expect(trues).toBeGreaterThan(cases / 10)
    expect(cases - trues).toBeGreaterThan(cases / 10)
    expect(skipped).toBeLessThan(cases / 50)
  })

  it('compiling visits each part a few times per state it makes, on every corpus pattern', () => {
    let worst = 0
    let checked = 0
    for (const seed of [11, 12, 31]) {
      const rand = seeded(seed)
      for (let k = 0; k < 700; k += 1) {
        const { source } = genPattern(rand, { maxCount: seed === 31 ? 9 : 3 })
        let compiled: ReturnType<typeof compilePattern>
        try {
          new RegExp(source, 'i')
          compiled = compilePattern(parsePattern(source, true), seed === 31 ? 5 : 300, 3000)
        } catch {
          continue
        }
        checked += 1
        worst = Math.max(worst, compiled.work / compiled.states)
      }
    }
    expect(checked).toBeGreaterThan(1_500)
    expect(worst).toBeLessThanOrEqual(4)
  })

  it('a cut text never gains a match, and without lookahead gives exactly the full text\'s answer', () => {
    const unsound: string[] = []
    const inexact: string[] = []
    let cases = 0
    let exactCases = 0
    const { rand, patterns } = corpus(21, 900, { maxLength: 300 })
    for (const { pattern, shipped } of patterns) {
      for (let k = 0; k < 4; k += 1) {
        const full = genSubject(rand, subjectCap(pattern, 40))
        if (!full) continue
        const cut = Math.floor(rand() * full.length)
        const head = full.slice(0, cut)
        const bounded = new RegExp(`(?:${pattern.source})(?<=^[^]{0,${cut}})`, 'i')
        const want = nativeTest(bounded, full)
        if (want === null) continue
        cases += 1
        const got = shipped.test(head, { truncated: true, next: full[cut] })
        const blind = shipped.test(head, { truncated: true })
        const label = `${JSON.stringify(pattern.source)} cut ${JSON.stringify(head)} of ${JSON.stringify(full)}`
        if ((got && !want) || (blind && !want) || (blind && !got)) unsound.push(`${label}: next ${got}, no next ${blind}, full ${want}`)
        if (!pattern.lookahead) {
          exactCases += 1
          if (got !== want) inexact.push(`${label}: ${got}, full ${want}`)
        }
      }
    }
    expect(unsound.slice(0, 20)).toEqual([])
    expect(inexact.slice(0, 20)).toEqual([])
    expect(cases).toBeGreaterThan(2_500)
    expect(exactCases).toBeGreaterThan(1_500)
  })

  it('counted repeats far past maxLength are clamped without changing an answer, whole or cut', () => {
    // maxLength 5 with counts up to 9 (and up to 18 per repeat): every clamp rule in compile.ts is hit.
    const mismatches: string[] = []
    let cases = 0
    const { rand, patterns, refused } = corpus(31, 1200, { maxLength: 5, maxCount: 9 })
    expect(refused).toEqual([])
    for (const { pattern, shipped, nfa } of patterns) {
      const native = new RegExp(pattern.source, 'i')
      for (let k = 0; k < 4; k += 1) {
        const subject = genSubject(rand, 5)
        const want = nativeTest(native, subject)
        if (want !== null) {
          cases += 1
          if (shipped.test(subject) !== want || nfa.test(subject) !== want) mismatches.push(`${JSON.stringify(pattern.source)} on ${JSON.stringify(subject)}: native ${want}`)
        }
        // A cut of a longer text: the clamp keeps every "could still match" path (match.ts).
        const full = genSubject(rand, 10)
        if (full.length > 5) {
          const head = full.slice(0, 5)
          const bounded = nativeTest(new RegExp(`(?:${pattern.source})(?<=^[^]{0,5})`, 'i'), full)
          if (bounded === false && nfa.test(head, { truncated: true, next: full[5] })) mismatches.push(`cut ${JSON.stringify(pattern.source)} on ${JSON.stringify(full)}`)
        }
      }
    }
    expect(mismatches.slice(0, 20)).toEqual([])
    expect(cases).toBeGreaterThan(3_000)
  })

  it('an upper count at or past what fits in the text is read as none: whole texts exact, cut ones sound', () => {
    // maxLength 6 with counts up to 9: most counted repeats reach floor(6 / width), or 7 for a body
    // that may be empty, and so compile as loops (compile.ts). Without lookahead a cut stays exact.
    const mismatches: string[] = []
    let whole = 0
    let cuts = 0
    const { rand, patterns, refused } = corpus(61, 1200, { maxLength: 6, maxCount: 9 })
    expect(refused).toEqual([])
    for (const { pattern, shipped, nfa } of patterns) {
      const native = new RegExp(pattern.source, 'i')
      for (let k = 0; k < 4; k += 1) {
        const subject = genSubject(rand, 6)
        const want = nativeTest(native, subject)
        if (want !== null) {
          whole += 1
          if (shipped.test(subject) !== want || nfa.test(subject) !== want) mismatches.push(`${JSON.stringify(pattern.source)} on ${JSON.stringify(subject)}: native ${want}`)
        }
        const full = genSubject(rand, 12)
        if (full.length <= 6) continue
        const head = full.slice(0, 6)
        const bounded = nativeTest(new RegExp(`(?:${pattern.source})(?<=^[^]{0,6})`, 'i'), full)
        if (bounded === null) continue
        cuts += 1
        const got = nfa.test(head, { truncated: true, next: full[6] })
        if ((got && !bounded) || (!pattern.lookahead && got !== bounded)) {
          mismatches.push(`cut ${JSON.stringify(pattern.source)} on ${JSON.stringify(full)}: ${got}, full ${bounded}`)
        }
      }
    }
    expect(mismatches.slice(0, 20)).toEqual([])
    expect(whole).toBeGreaterThan(3_000)
    expect(cuts).toBeGreaterThan(1_000)
  })

  it('every pattern the native engine refuses gets one plain reason: no engine prefix, no copy of the pattern', () => {
    const rand = seeded(71)
    const bad: string[] = []
    let refused = 0
    let fellBack = 0
    for (let k = 0; k < 4000; k += 1) {
      // Cut a generated pattern short or splice a stray character in: most such patterns are invalid.
      const { source: whole } = genPattern(rand, { maxCount: 3 })
      const at = Math.floor(rand() * (whole.length + 1))
      const source = rand() < 0.5 ? whole.slice(0, at) : `${whole.slice(0, at)}${'()[]{}*+?\\|'[Math.floor(rand() * 11)]}${whole.slice(at)}`
      try { new RegExp(source, 'i'); continue } catch { refused += 1 }
      const result = compileLinear(source)
      const detail = result.ok ? '' : result.detail
      if (result.ok || result.reason !== 'invalid' || /invalid regular expression/i.test(detail) || detail.includes(`/${source}/`) || !detail.endsWith('.')) {
        bad.push(`${JSON.stringify(source)}: ${JSON.stringify(result)}`)
      }
      if (/^[a-z]/.test(detail) && !/^(a |it |in |the |two |with )/.test(detail)) fellBack += 1
    }
    console.log(`[linear-regex syntax] ${refused} refused patterns, ${fellBack} named by the engine's own words`)
    expect(bad.slice(0, 20)).toEqual([])
    expect(refused).toBeGreaterThan(1_000)
    expect(fellBack).toBeLessThan(refused / 20)
  })

  it('ignoreCase: false agrees with native RegExp without the i flag', () => {
    const mismatches: string[] = []
    let cases = 0
    const { rand, patterns, refused } = corpus(41, 600, { maxLength: 300, ignoreCase: false })
    expect(refused).toEqual([])
    for (const { pattern, shipped, nfa } of patterns) {
      const native = new RegExp(pattern.source)
      for (let k = 0; k < 4; k += 1) {
        const subject = genSubject(rand, subjectCap(pattern, 40))
        const want = nativeTest(native, subject)
        if (want === null) continue
        cases += 1
        if (shipped.test(subject) !== want || nfa.test(subject) !== want) mismatches.push(`${JSON.stringify(pattern.source)} on ${JSON.stringify(subject)}: native ${want}`)
      }
    }
    expect(mismatches.slice(0, 20)).toEqual([])
    expect(cases).toBeGreaterThan(2_000)
  })

  it('every fast-path pattern in the corpus gives the NFA\'s answer', () => {
    const mismatches: string[] = []
    let fast = 0
    let cases = 0
    for (const seed of [51, 52]) {
      const { rand, patterns } = corpus(seed, 700, { maxLength: 300 })
      for (const { pattern, shipped, nfa } of patterns) {
        if (!shipped.native) continue
        fast += 1
        for (let k = 0; k < 6; k += 1) {
          const subject = genSubject(rand, 40)
          cases += 1
          if (shipped.test(subject) !== nfa.test(subject)) mismatches.push(`${JSON.stringify(pattern.source)} on ${JSON.stringify(subject)}`)
        }
      }
    }
    expect(mismatches.slice(0, 20)).toEqual([])
    expect(fast).toBeGreaterThan(150)
    expect(cases).toBeGreaterThan(900)
  })
})

describe('linear-regex case folding and fixed sets', () => {
  it('the case table folds every BMP code unit exactly as the native engine does', () => {
    const { canon, classAt, members } = caseTable()
    const all: number[] = []
    for (let code = 0; code < 0x10000; code += 1) if (code < 0xd800 || code > 0xdfff) all.push(code)
    let bmp = ''
    for (let k = 0; k < all.length; k += 4096) bmp += String.fromCharCode(...all.slice(k, k + 4096))
    const index = new Map(all.map((code, k) => [k, code]))
    const wrong: string[] = []
    let checked = 0
    for (const code of all) {
      const char = String.fromCharCode(code)
      const cased = char.toUpperCase() !== char || char.toLowerCase() !== char || classAt[code] !== 0
      if (!cased) {
        // Caseless: the engine folds it to nothing else.
        if (canon[code] !== 0) wrong.push(`U+${code.toString(16)} has a canonical form`)
        continue
      }
      checked += 1
      const native = new Set<number>()
      for (const hit of bmp.matchAll(new RegExp('\\u' + code.toString(16).padStart(4, '0'), 'gi'))) native.add(index.get(hit.index!)!)
      const at = classAt[code]! - 1
      const engine = at < 0 ? new Set([code]) : new Set(Array.from(members.subarray(at + 1, at + 1 + members[at]!)))
      const same = native.size === engine.size && [...native].every((one) => engine.has(one))
      if (!same) wrong.push(`U+${code.toString(16)}: native ${[...native].map((one) => one.toString(16))} engine ${[...engine].map((one) => one.toString(16))}`)
    }
    expect(wrong.slice(0, 20)).toEqual([])
    expect(checked).toBeGreaterThan(2_000)
  })

  it('\\s, \\S, . and line terminators are the native sets over the BMP', () => {
    const wrong: number[] = []
    for (let code = 0; code < 0x10000; code += 1) {
      const char = String.fromCharCode(code)
      if (/\s/.test(char) !== contains(SPACE, code)) wrong.push(code)
      if (/./.test(char) === contains(LINE_TERMINATORS, code)) wrong.push(code)
    }
    expect(wrong).toEqual([])
  })
})

describe('linear glob', () => {
  const escape = (text: string): string => text.replace(/[.+?^${}()|[\]\\]/g, '\\$&')
  const PIECES = ['a', 'b', 'ab', 'ba', '.', '@', 'K', 'k', '\u017f', 's', '\u00b5', '\u039c', '\n', '(x)', '[', '+', 'aa']

  it('gives the answer of the anchored `is` regex the glob used to compile to', () => {
    const rand = seeded(61)
    const mismatches: string[] = []
    for (let k = 0; k < 4000; k += 1) {
      let glob = ''
      for (let p = Math.floor(rand() * 6); p > 0; p -= 1) glob += rand() < 0.4 ? '*' : PIECES[Math.floor(rand() * PIECES.length)]!
      const native = new RegExp(`^${glob.split('*').map(escape).join('.*')}$`, 'is')
      const linear = compileGlob(glob)
      for (let s = 0; s < 4; s += 1) {
        let value = ''
        for (let p = Math.floor(rand() * 7); p > 0; p -= 1) value += PIECES[Math.floor(rand() * PIECES.length)]!
        if (linear(value) !== native.test(value)) mismatches.push(`${JSON.stringify(glob)} on ${JSON.stringify(value)}`)
      }
    }
    expect(mismatches.slice(0, 20)).toEqual([])
  })
})
