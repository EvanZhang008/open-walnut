/**
 * Seeded random patterns and subjects for the linear-regex differential tests: the whole
 * non-unicode grammar the engine claims (Annex B escapes and literal braces, classes with ranges,
 * negation and class escapes, every quantifier with small counts and lazy forms, groups of every
 * kind including modifiers and named groups, anchors, word boundaries, nested lookarounds and
 * quantified lookaheads) over an alphabet with the case-folding special letters.
 */

export function seeded(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Letters that fold in surprising ways: micro sign, Greek mu and sigmas, long s, Kelvin sign, Turkish i's. */
export const SPECIALS = ['\u00b5', '\u039c', '\u03bc', '\u03c3', '\u03c2', '\u03a3', '\u017f', '\u212a', 'k', '\u0130', '\u0131']
export const LITERALS = ['a', 'b', 'A', ' ', '-', '0', '1', 's', 'S', 'K', 'i', 'I', ...SPECIALS]
export const SUBJECT_CHARS = [...LITERALS, 'B', 'c', 'x', '_', '\n', '\r', '\u2028', '\t', '{', '}', ']', '\\', '\u0001', 'A']

const ESCAPES = [
  '\\w', '\\W', '\\d', '\\D', '\\s', '\\S', '\\x41', '\\x61', '\\u03bc', '\\u00b5', '\\u212a', '\\u017f', '\\u03a3',
  '\\cA', '\\cj', '\\c', '\\0', '\\101', '\\141', '\\t', '\\n', '\\-', '\\/', '\\8', '\\_', '\\a', '\\.', '\\{', '\\}',
  '\\x4', '\\u12', '\\u{2}',
]
const CLASS_ITEMS = [
  'a', 'b', 'A', ' ', '0', 's', 'K', 'i', '\\w', '\\W', '\\d', '\\D', '\\s', '\\S', '\\b', '\\B', '\\-', '\\c1', '\\c_', '\\cA',
  '\\c', '\\0', '\\x61', '\\u039c', '\\1', '\\8', 'a-b', 'A-z', '0-1', '\u00b5-\u03c3', '\u0131-\u017f', 'a-\u212a', '\\d-z',
  'a-\\w', '\\]', '[', '.', ...SPECIALS,
]

export interface GeneratedPattern {
  source: string
  /** Unbounded quantifiers (cost of a backtracking engine grows with each). */
  unbounded: number
  /** A quantified group that repeats or alternates inside (exponential for backtracking). */
  nested: boolean
  lookahead: boolean
}

export interface GenOptions { depth?: number; maxCount?: number }

export function genPattern(rand: () => number, options: GenOptions = {}): GeneratedPattern {
  const maxDepth = options.depth ?? 3
  const maxCount = options.maxCount ?? 3
  const pick = <T,>(list: readonly T[]): T => list[Math.floor(rand() * list.length)]!
  const int = (lo: number, hi: number): number => lo + Math.floor(rand() * (hi - lo + 1))
  const meta = { unbounded: 0, nested: false, lookahead: false }
  let groupId = 0

  const quantifier = (): string => {
    const lazy = rand() < 0.2 ? '?' : ''
    const n = int(0, maxCount)
    const m = n + int(0, maxCount)
    const roll = rand()
    if (roll < 0.2) { meta.unbounded += 1; return '*' + lazy }
    if (roll < 0.4) { meta.unbounded += 1; return '+' + lazy }
    if (roll < 0.6) return '?' + lazy
    if (roll < 0.73) return `{${n}}` + lazy
    if (roll < 0.86) { meta.unbounded += 1; return `{${n},}` + lazy }
    return `{${n},${m}}` + lazy
  }

  // Returns [source, repeatsOrAlternatesInside].
  const disjunction = (depth: number): [string, boolean] => {
    const count = rand() < 0.25 ? int(2, 3) : 1
    const parts: string[] = []
    let inner = count > 1
    for (let k = 0; k < count; k += 1) {
      const [text, repeats] = alternative(depth)
      parts.push(text)
      inner ||= repeats
    }
    return [parts.join('|'), inner]
  }

  const alternative = (depth: number): [string, boolean] => {
    let out = ''
    let repeats = false
    for (let k = int(0, 4); k > 0; k -= 1) {
      const [text, inner] = term(depth)
      out += text
      repeats ||= inner
    }
    return [out, repeats]
  }

  const term = (depth: number): [string, boolean] => {
    const roll = rand()
    if (roll < 0.1) return [pick(['^', '$', '\\b', '\\B']), false]
    if (roll < 0.2 && depth > 0) {
      const kind = pick(['?=', '?!', '?<=', '?<!'])
      if (kind === '?=' || kind === '?!') meta.lookahead = true
      const [body] = disjunction(depth - 1)
      const look = `(${kind}${body})`
      if ((kind === '?=' || kind === '?!') && rand() < 0.2) return [look + quantifier(), false]
      return [look, false]
    }
    const [atomText, inner] = atom(depth)
    if (rand() < 0.4) {
      if (inner) meta.nested = true
      return [atomText + quantifier(), true]
    }
    return [atomText, inner]
  }

  const atom = (depth: number): [string, boolean] => {
    const roll = rand()
    if (roll < 0.35) return [pick(LITERALS), false]
    if (roll < 0.42) return ['.', false]
    if (roll < 0.57) return [pick(ESCAPES), false]
    if (roll < 0.62) return [pick(['{', '}', ']', '{a', 'x{', '{,2}']), false]
    if (roll < 0.78) {
      const items = Array.from({ length: int(0, 3) }, () => pick(CLASS_ITEMS)).join('')
      return [`[${rand() < 0.3 ? '^' : ''}${items}]`, false]
    }
    if (depth === 0) return [pick(LITERALS), false]
    const [body, inner] = disjunction(depth - 1)
    const open = pick(['(', '(?:', 'named', '(?i:', '(?-i:', '(?m:', '(?s:', '(?i-s:', '(?ms:'])
    if (open === 'named') return [`(?<g${(groupId += 1)}>${body})`, inner]
    return [`${open}${body})`, inner]
  }

  const [source] = disjunction(maxDepth)
  return { source, ...meta }
}

export function genSubject(rand: () => number, maxLength: number, chars: readonly string[] = SUBJECT_CHARS): string {
  let out = ''
  for (let k = Math.floor(rand() * (maxLength + 1)); k > 0; k -= 1) out += chars[Math.floor(rand() * chars.length)]!
  return out
}

/** The longest subject a pattern of this shape gets, so the NATIVE side stays fast enough to compare. */
export function subjectCap(pattern: GeneratedPattern, longest: number): number {
  if (pattern.nested) return Math.min(longest, 10)
  if (pattern.unbounded > 4) return Math.min(longest, 14)
  if (pattern.unbounded > 2) return Math.min(longest, 24)
  return longest
}
