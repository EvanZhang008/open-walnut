/**
 * A glob (`*` = any run of characters, line breaks included) as a test of a whole value, with the
 * same answer as `new RegExp('^' + escaped pieces joined by '.*' + '$', 'is')` but in linear time:
 * the pieces between stars must appear in order, the first at the start and the last at the end,
 * and taking each middle piece at its leftmost place is always right (a later place only leaves
 * less room for the rest). Each piece is found with KMP over canonical code units (case-fold.ts),
 * so one test costs O(value length + glob length) whatever the stars.
 */
import { canonical } from './case-fold.js'

type Codes = number[]

function codesOf(value: string, ignoreCase: boolean): Codes {
  const codes = new Array<number>(value.length)
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i)
    codes[i] = ignoreCase ? canonical(code) : code
  }
  return codes
}

function failureTable(piece: Codes): Int32Array {
  const fail = new Int32Array(piece.length)
  for (let i = 1, k = 0; i < piece.length; i += 1) {
    while (k > 0 && piece[i] !== piece[k]) k = fail[k - 1]!
    if (piece[i] === piece[k]) k += 1
    fail[i] = k
  }
  return fail
}

/** The first index >= from where `piece` fits wholly before `end`, or -1. */
function find(value: Codes, from: number, end: number, piece: Codes, fail: Int32Array): number {
  for (let i = from, k = 0; i < end; i += 1) {
    while (k > 0 && value[i] !== piece[k]) k = fail[k - 1]!
    if (value[i] === piece[k]) k += 1
    if (k === piece.length) return i - k + 1
  }
  return -1
}

function sameAt(value: Codes, at: number, piece: Codes): boolean {
  for (let k = 0; k < piece.length; k += 1) if (value[at + k] !== piece[k]) return false
  return true
}

export function compileGlob(glob: string, options: { ignoreCase?: boolean } = {}): (value: string) => boolean {
  const ignoreCase = options.ignoreCase ?? true
  const pieces = glob.split('*').map((piece) => codesOf(piece, ignoreCase))
  const first = pieces[0]!
  const last = pieces[pieces.length - 1]!
  const middle = pieces.slice(1, -1).filter((piece) => piece.length > 0).map((piece) => ({ piece, fail: failureTable(piece) }))
  return (raw) => {
    const value = codesOf(raw, ignoreCase)
    if (pieces.length === 1) return value.length === first.length && sameAt(value, 0, first)
    const end = value.length - last.length
    if (end < first.length || !sameAt(value, 0, first) || !sameAt(value, end, last)) return false
    let at = first.length
    for (const { piece, fail } of middle) {
      const found = find(value, at, end, piece, fail)
      if (found < 0) return false
      at = found + piece.length
    }
    return true
  }
}
