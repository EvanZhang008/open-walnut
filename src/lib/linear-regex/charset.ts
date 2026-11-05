/**
 * Sets of UTF-16 code units as sorted, merged, inclusive `[lo, hi]` pairs in one flat array, plus
 * the fixed sets the ECMAScript grammar names (`\d`, `\w`, `\s`, line terminators).
 */

export type Ranges = readonly number[]

export const MAX_CODE = 0xffff

export const DIGIT: Ranges = [0x30, 0x39]
export const WORD: Ranges = [0x30, 0x39, 0x41, 0x5a, 0x5f, 0x5f, 0x61, 0x7a]
/** LineTerminator: what `.` refuses and what `^`/`$` see under `m`. */
export const LINE_TERMINATORS: Ranges = [0x0a, 0x0a, 0x0d, 0x0d, 0x2028, 0x2029]
/** WhiteSpace plus LineTerminator (tab, LF, VT, FF, CR, the Zs space separators, BOM). */
export const SPACE: Ranges = [
  0x09, 0x0d, 0x20, 0x20, 0xa0, 0xa0, 0x1680, 0x1680, 0x2000, 0x200a, 0x2028, 0x2029,
  0x202f, 0x202f, 0x205f, 0x205f, 0x3000, 0x3000, 0xfeff, 0xfeff,
]
export const EVERYTHING: Ranges = [0, MAX_CODE]
export const NOTHING: Ranges = []

/** Sort and merge any list of pairs (overlapping or adjacent pairs become one). */
export function normalize(pairs: readonly number[]): number[] {
  const list: Array<[number, number]> = []
  for (let i = 0; i < pairs.length; i += 2) list.push([pairs[i]!, pairs[i + 1]!])
  list.sort((a, b) => a[0] - b[0])
  const out: number[] = []
  for (const [lo, hi] of list) {
    const last = out.length - 1
    if (last > 0 && lo <= out[last]! + 1) out[last] = Math.max(out[last]!, hi)
    else out.push(lo, hi)
  }
  return out
}

export function union(...sets: Ranges[]): number[] {
  return normalize(sets.flat())
}

export function complement(set: Ranges): number[] {
  const out: number[] = []
  let next = 0
  for (let i = 0; i < set.length; i += 2) {
    if (set[i]! > next) out.push(next, set[i]! - 1)
    next = set[i + 1]! + 1
  }
  if (next <= MAX_CODE) out.push(next, MAX_CODE)
  return out
}

export function contains(set: Ranges, code: number): boolean {
  let lo = 0
  let hi = (set.length >> 1) - 1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (code < set[mid * 2]!) hi = mid - 1
    else if (code > set[mid * 2 + 1]!) lo = mid + 1
    else return true
  }
  return false
}

export function isWordCode(code: number): boolean {
  return (code >= 0x61 && code <= 0x7a) || (code >= 0x41 && code <= 0x5a) || (code >= 0x30 && code <= 0x39) || code === 0x5f
}

export function isLineTerminator(code: number): boolean {
  return code === 0x0a || code === 0x0d || code === 0x2028 || code === 0x2029
}
