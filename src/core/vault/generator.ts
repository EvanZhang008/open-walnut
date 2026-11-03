/**
 * Password and passphrase generator. Pure: crypto.getRandomValues only (it works in
 * insecure contexts too), unbiased picks by rejection sampling. Shared by the
 * server (`walnut pass generate`), the web app and the browser extension.
 */
import { WORDLIST } from './wordlist.js'

export interface PasswordOptions {
  kind: 'random'
  length: number
  upper: boolean
  lower: boolean
  digits: boolean
  symbols: boolean
  /** Leave out characters that look alike (l 1 I | O 0 o). */
  avoidAmbiguous: boolean
}

export interface PassphraseOptions {
  kind: 'words'
  words: number
  separator: string
  capitalize: boolean
  /** Add one digit to one word. */
  number: boolean
}

export type GeneratorOptions = PasswordOptions | PassphraseOptions

export const DEFAULT_PASSWORD: PasswordOptions = {
  kind: 'random', length: 20, upper: true, lower: true, digits: true, symbols: true, avoidAmbiguous: true,
}
export const DEFAULT_PASSPHRASE: PassphraseOptions = {
  kind: 'words', words: 5, separator: '-', capitalize: true, number: true,
}

export const MIN_LENGTH = 8
export const MAX_LENGTH = 128
export const MIN_WORDS = 3
export const MAX_WORDS = 12

const SETS = {
  upper: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ',
  lower: 'abcdefghijklmnopqrstuvwxyz',
  digits: '0123456789',
  symbols: '!@#$%^&*-_=+?.:~',
}
const AMBIGUOUS = /[lI1|O0o]/g

/** A uniform integer in [0, n). */
export function randomInt(n: number): number {
  if (!Number.isInteger(n) || n <= 0 || n > 2 ** 32) throw new Error('randomInt: bad range')
  const limit = Math.floor(2 ** 32 / n) * n
  const buf = new Uint32Array(1)
  for (;;) {
    globalThis.crypto.getRandomValues(buf)
    if (buf[0] < limit) return buf[0] % n
  }
}

function pick(chars: string): string {
  return chars[randomInt(chars.length)]
}

function shuffle<T>(arr: T[]): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = randomInt(i + 1)
    ;[arr[i], arr[j]] = [arr[j], arr[i]]
  }
  return arr
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, Math.round(Number.isFinite(n) ? n : lo)))
}

/** The character sets a random password draws from (at least lower case). */
function sets(o: PasswordOptions): string[] {
  const chosen = (['upper', 'lower', 'digits', 'symbols'] as const).filter((k) => o[k]).map((k) => SETS[k])
  const out = (chosen.length ? chosen : [SETS.lower]).map((s) => (o.avoidAmbiguous ? s.replace(AMBIGUOUS, '') : s))
  return out.filter((s) => s.length > 0)
}

export function generatePassword(o: PasswordOptions): string {
  const length = clamp(o.length, MIN_LENGTH, MAX_LENGTH)
  const groups = sets(o)
  // One from each chosen set, so a site that demands "a digit and a symbol" accepts it.
  const chars = groups.map(pick)
  const all = groups.join('')
  while (chars.length < length) chars.push(pick(all))
  return shuffle(chars).join('')
}

export function generatePassphrase(o: PassphraseOptions): string {
  const n = clamp(o.words, MIN_WORDS, MAX_WORDS)
  const words = Array.from({ length: n }, () => {
    const w = WORDLIST[randomInt(WORDLIST.length)]
    return o.capitalize ? w[0].toUpperCase() + w.slice(1) : w
  })
  if (o.number) {
    const i = randomInt(n)
    words[i] = words[i] + String(randomInt(10))
  }
  return words.join(o.separator.slice(0, 3))
}

export function generate(o: GeneratorOptions): string {
  return o.kind === 'words' ? generatePassphrase(o) : generatePassword(o)
}

/** Bits of entropy of what the generator makes with these options (not of a typed password). */
export function generatorBits(o: GeneratorOptions): number {
  if (o.kind === 'words') {
    const n = clamp(o.words, MIN_WORDS, MAX_WORDS)
    return n * Math.log2(WORDLIST.length) + (o.number ? Math.log2(10 * n) : 0)
  }
  const length = clamp(o.length, MIN_LENGTH, MAX_LENGTH)
  return length * Math.log2(sets(o).join('').length)
}
