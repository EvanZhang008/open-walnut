/**
 * An ECMAScript pattern (non-unicode mode, Annex B leniencies included) as a tree of the parts a
 * boolean `test` depends on. Groups keep only their body: without back-references a capture changes
 * no answer. The caller has already compiled the pattern natively, so this parser never has to
 * judge validity; it throws `PatternRefusal` for a back-reference, for syntax it cannot map, and for
 * a property escape that names nothing. The one unicode-mode reading: `\p{…}` and `\P{…}` are
 * Unicode properties (unicode-property.ts), not the text `p{…}`.
 */
import { DIGIT, EVERYTHING, LINE_TERMINATORS, SPACE, WORD, complement, normalize, type Ranges } from './charset.js'
import { badPropertySentence, propertyRanges } from './unicode-property.js'

export type AssertKind = 'start' | 'start-m' | 'end' | 'end-m' | 'word' | 'nonword'

export type Node =
  | { type: 'empty' }
  | { type: 'char'; code: number; ci: boolean }
  | { type: 'set'; ranges: Ranges; negate: boolean; ci: boolean }
  | { type: 'seq'; items: Node[] }
  | { type: 'alt'; items: Node[] }
  | { type: 'repeat'; body: Node; min: number; max: number }
  | { type: 'assert'; kind: AssertKind }
  | { type: 'look'; behind: boolean; negate: boolean; body: Node }

export class PatternRefusal extends Error {
  constructor(readonly reason: 'backreference' | 'unsupported' | 'invalid', message: string) {
    super(message)
  }
}

interface Flags { i: boolean; m: boolean; s: boolean }
type ClassAtom = { code: number } | { set: Ranges }

const NOT_LINE_TERMINATOR = complement(LINE_TERMINATORS)
const ESCAPE_SETS: Record<string, Ranges> = {
  d: DIGIT, D: complement(DIGIT), w: WORD, W: complement(WORD), s: SPACE, S: complement(SPACE),
}
const CONTROL_ESCAPES: Record<string, number> = { f: 0x0c, n: 0x0a, r: 0x0d, t: 0x09, v: 0x0b }

const isDigit = (c: string | undefined): boolean => c !== undefined && c >= '0' && c <= '9'
const isOctal = (c: string | undefined): boolean => c !== undefined && c >= '0' && c <= '7'
const isAsciiLetter = (c: string | undefined): boolean => c !== undefined && /^[A-Za-z]$/.test(c)
const isHex = (c: string | undefined): boolean => c !== undefined && /^[0-9A-Fa-f]$/.test(c)

/** `{n}`, `{n,}` or `{n,m}` starting at `at`, or null when the brace is a plain character. */
function braceAt(src: string, at: number): { min: number; max: number; end: number } | null {
  let i = at + 1
  const digits = (): string => {
    const start = i
    while (isDigit(src[i])) i += 1
    return src.slice(start, i)
  }
  const low = digits()
  if (!low) return null
  let max = Number(low)
  if (src[i] === ',') {
    i += 1
    const high = digits()
    max = high ? Number(high) : Infinity
  }
  return src[i] === '}' ? { min: Number(low), max, end: i + 1 } : null
}

/** Capturing groups in the whole pattern (a `\N` names one only up to this count) and whether any is named. */
function countGroups(source: string): { groups: number; named: boolean } {
  let groups = 0
  let named = false
  let inClass = false
  for (let i = 0; i < source.length; i += 1) {
    const c = source[i]
    if (c === '\\') { i += 1; continue }
    if (inClass) { if (c === ']') inClass = false; continue }
    if (c === '[') { inClass = true; continue }
    if (c !== '(') continue
    if (source[i + 1] !== '?') groups += 1
    else if (source[i + 2] === '<' && source[i + 3] !== '=' && source[i + 3] !== '!') { groups += 1; named = true }
  }
  return { groups, named }
}

class Parser {
  private i = 0
  private readonly groups: number
  private readonly named: boolean

  constructor(private readonly src: string) {
    ;({ groups: this.groups, named: this.named } = countGroups(src))
  }

  pattern(ignoreCase: boolean): Node {
    const node = this.disjunction({ i: ignoreCase, m: false, s: false })
    if (this.i < this.src.length) this.unsupported(`unexpected "${this.src[this.i]}"`)
    return node
  }

  private unsupported(what: string): never {
    throw new PatternRefusal('unsupported', `${what} at position ${this.i}`)
  }

  private expect(char: string): void {
    if (this.src[this.i] !== char) this.unsupported(`expected "${char}"`)
    this.i += 1
  }

  private disjunction(flags: Flags): Node {
    const items = [this.alternative(flags)]
    while (this.src[this.i] === '|') {
      this.i += 1
      items.push(this.alternative(flags))
    }
    return items.length === 1 ? items[0]! : { type: 'alt', items }
  }

  private alternative(flags: Flags): Node {
    const items: Node[] = []
    while (this.i < this.src.length && this.src[this.i] !== '|' && this.src[this.i] !== ')') items.push(this.term(flags))
    if (items.length === 0) return { type: 'empty' }
    return items.length === 1 ? items[0]! : { type: 'seq', items }
  }

  private term(flags: Flags): Node {
    const { src } = this
    const c = src[this.i]
    if (c === '^') { this.i += 1; return { type: 'assert', kind: flags.m ? 'start-m' : 'start' } }
    if (c === '$') { this.i += 1; return { type: 'assert', kind: flags.m ? 'end-m' : 'end' } }
    if (c === '\\' && (src[this.i + 1] === 'b' || src[this.i + 1] === 'B')) {
      this.i += 2
      return { type: 'assert', kind: src[this.i - 1] === 'b' ? 'word' : 'nonword' }
    }
    if (src.startsWith('(?=', this.i) || src.startsWith('(?!', this.i)) {
      const negate = src[this.i + 2] === '!'
      this.i += 3
      const body = this.disjunction(flags)
      this.expect(')')
      // Annex B: a lookahead may carry a quantifier.
      return this.quantified({ type: 'look', behind: false, negate, body })
    }
    if (src.startsWith('(?<=', this.i) || src.startsWith('(?<!', this.i)) {
      const negate = src[this.i + 3] === '!'
      this.i += 4
      const body = this.disjunction(flags)
      this.expect(')')
      return { type: 'look', behind: true, negate, body }
    }
    return this.quantified(this.atom(flags))
  }

  private quantified(atom: Node): Node {
    const { src } = this
    let min: number
    let max: number
    const c = src[this.i]
    if (c === '*') { min = 0; max = Infinity; this.i += 1 }
    else if (c === '+') { min = 1; max = Infinity; this.i += 1 }
    else if (c === '?') { min = 0; max = 1; this.i += 1 }
    else if (c === '{') {
      const brace = braceAt(src, this.i)
      if (!brace) return atom
      ;({ min, max } = brace)
      this.i = brace.end
    } else {
      return atom
    }
    if (src[this.i] === '?') this.i += 1 // lazy: the same yes or no
    return { type: 'repeat', body: atom, min, max }
  }

  private atom(flags: Flags): Node {
    const { src } = this
    const c = src[this.i]!
    if (c === '.') {
      this.i += 1
      return { type: 'set', ranges: flags.s ? EVERYTHING : NOT_LINE_TERMINATOR, negate: false, ci: false }
    }
    if (c === '(') return this.group(flags)
    if (c === '[') return this.characterClass(flags)
    if (c === '\\') return this.atomEscape(flags)
    if (c === '*' || c === '+' || c === '?') this.unsupported('nothing to repeat')
    if (c === '{' && braceAt(src, this.i)) this.unsupported('nothing to repeat')
    this.i += 1
    return { type: 'char', code: c.charCodeAt(0), ci: flags.i }
  }

  private group(flags: Flags): Node {
    const { src } = this
    let inner = flags
    if (src[this.i + 1] !== '?') {
      this.i += 1
    } else if (src[this.i + 2] === ':') {
      this.i += 3
    } else if (src[this.i + 2] === '<') {
      const close = src.indexOf('>', this.i + 3)
      if (close < 0) this.unsupported('unterminated group name')
      this.i = close + 1
    } else {
      const modifiers = /^\(\?([ims]*)(?:-([ims]*))?:/.exec(src.slice(this.i, this.i + 12))
      if (!modifiers) this.unsupported('unknown group')
      const on = modifiers[1] ?? ''
      const off = modifiers[2] ?? ''
      const pick = (flag: 'i' | 'm' | 's'): boolean => (on.includes(flag) ? true : off.includes(flag) ? false : flags[flag])
      inner = { i: pick('i'), m: pick('m'), s: pick('s') }
      this.i += modifiers[0].length
    }
    const body = this.disjunction(inner)
    this.expect(')')
    return body
  }

  private atomEscape(flags: Flags): Node {
    const { src } = this
    const c = src[this.i + 1]
    if (c === undefined) this.unsupported('"\\" at the end')
    if (c === 'p' || c === 'P') return { type: 'set', ranges: this.property(), negate: false, ci: flags.i }
    const set = ESCAPE_SETS[c]
    if (set) { this.i += 2; return { type: 'set', ranges: set, negate: false, ci: false } }
    if (c === 'k' && this.named) throw new PatternRefusal('backreference', `\\k<name> at position ${this.i}`)
    if (c >= '1' && c <= '9') {
      let end = this.i + 1
      while (isDigit(src[end])) end += 1
      if (Number(src.slice(this.i + 1, end)) <= this.groups) {
        throw new PatternRefusal('backreference', `${src.slice(this.i, end)} at position ${this.i}`)
      }
    }
    return { type: 'char', code: this.characterEscape(false), ci: flags.i }
  }

  /** `\p{name}` or `\P{name}` at `this.i`: the property's code units (or all others). Advances past it. */
  private property(): Ranges {
    const { src } = this
    const letter = src[this.i + 1] as 'p' | 'P'
    const close = src[this.i + 2] === '{' ? src.indexOf('}', this.i + 3) : -1
    if (close < 0) throw new PatternRefusal('invalid', badPropertySentence(letter, null))
    const name = src.slice(this.i + 3, close)
    const ranges = propertyRanges(name)
    if (!ranges) throw new PatternRefusal('invalid', badPropertySentence(letter, name))
    this.i = close + 1
    return letter === 'P' ? complement(ranges) : ranges
  }

  /** One escape that stands for one code unit (the `\` at `this.i`). Advances past it. */
  private characterEscape(inClass: boolean): number {
    const { src } = this
    const c = src[this.i + 1]!
    if (CONTROL_ESCAPES[c] !== undefined) { this.i += 2; return CONTROL_ESCAPES[c]! }
    if (c === 'c') {
      const letter = src[this.i + 2]
      if (isAsciiLetter(letter) || (inClass && (isDigit(letter) || letter === '_'))) {
        this.i += 3
        return letter!.charCodeAt(0) % 32
      }
      this.i += 1 // Annex B: the backslash stands for itself and `c` is read next
      return 0x5c
    }
    if (c === 'x' && isHex(src[this.i + 2]) && isHex(src[this.i + 3])) {
      this.i += 4
      return parseInt(src.slice(this.i - 2, this.i), 16)
    }
    if (c === 'u' && [2, 3, 4, 5].every((k) => isHex(src[this.i + k]))) {
      this.i += 6
      return parseInt(src.slice(this.i - 4, this.i), 16)
    }
    if (isOctal(c)) {
      // Legacy octal: up to three digits from 0-3, up to two from 4-7 (`\0` alone is NUL).
      let value = Number(c)
      let end = this.i + 2
      if (isOctal(src[end])) {
        value = value * 8 + Number(src[end]); end += 1
        if (c <= '3' && isOctal(src[end])) { value = value * 8 + Number(src[end]); end += 1 }
      }
      this.i = end
      return value
    }
    // Identity escape (`\8`, `\-`, `\k` without named groups, `\u12`, ...): the character itself.
    this.i += 2
    return c.charCodeAt(0)
  }

  private characterClass(flags: Flags): Node {
    const { src } = this
    this.i += 1
    const negate = src[this.i] === '^'
    if (negate) this.i += 1
    const pairs: number[] = []
    const add = (atom: ClassAtom): void => {
      if ('code' in atom) pairs.push(atom.code, atom.code)
      else pairs.push(...atom.set)
    }
    for (;;) {
      if (this.i >= src.length) this.unsupported('unterminated class')
      if (src[this.i] === ']') { this.i += 1; break }
      const first = this.classAtom()
      if (src[this.i] === '-' && this.i + 1 < src.length && src[this.i + 1] !== ']') {
        this.i += 1
        const second = this.classAtom()
        if ('code' in first && 'code' in second) {
          if (first.code > second.code) this.unsupported('range out of order')
          pairs.push(first.code, second.code)
        } else {
          // Annex B: a range with a class escape at either end is the union of both and `-`.
          add(first); add(second); pairs.push(0x2d, 0x2d)
        }
      } else {
        add(first)
      }
    }
    return { type: 'set', ranges: normalize(pairs), negate, ci: flags.i }
  }

  private classAtom(): ClassAtom {
    const { src } = this
    const c = src[this.i]!
    if (c !== '\\') { this.i += 1; return { code: c.charCodeAt(0) } }
    const next = src[this.i + 1]
    if (next === undefined) this.unsupported('"\\" at the end')
    if (next === 'p' || next === 'P') return { set: this.property() }
    const set = ESCAPE_SETS[next]
    if (set) { this.i += 2; return { set } }
    if (next === 'b') { this.i += 2; return { code: 0x08 } }
    return { code: this.characterEscape(true) }
  }
}

/** The pattern's tree. Throws `PatternRefusal`. */
export function parsePattern(source: string, ignoreCase: boolean): Node {
  return new Parser(source).pattern(ignoreCase)
}
