/**
 * Case folding for the `i` flag outside unicode mode, as the spec's Canonicalize: a code unit
 * becomes its toUppercase, unless that is not one code unit, or the code unit is 128 or more and the
 * result is under 128 (so the long s U+017F stays apart from `s`, and the Kelvin sign from `k`). Under `i` a
 * character matches a class when some member of the class has the same canonical form.
 *
 * `String.prototype.toUpperCase` can follow a newer Unicode version than the RegExp engine's own
 * case tables (bun 1.4.4: 8 BMP letters gained an uppercase in Unicode 16 that its RegExp does not
 * fold), so every candidate pair is confirmed once against the native engine, in blocks. Built
 * lazily, once per process (a few ms).
 */

export interface CaseTable {
  /** Canonical form of every code unit, 0 meaning "itself" (no code unit folds to NUL). */
  canon: Uint16Array
  /** 1 + where a code unit's class starts in `members` (`[count, m1, m2, ...]`), or 0 when it is alone. */
  classAt: Int32Array
  members: Uint16Array
}

let table: CaseTable | null = null
export let caseTableBuildMs = 0

/** `a`..`z` to `A`..`Z`; every other ASCII code unit is its own canonical form. */
export function asciiCanon(code: number): number {
  return code >= 0x61 && code <= 0x7a ? code - 32 : code
}

function hex4(code: number): string {
  return '\\u' + code.toString(16).padStart(4, '0')
}

/** `[code, upper]` for every code unit whose toUppercase is another single code unit (Canonicalize's candidates). */
function upperPairs(): number[] {
  const pairs: number[] = []
  const codes = new Array<number>(256)
  const add = (code: number, upper: number): void => {
    if (upper !== code && !(code >= 128 && upper < 128)) pairs.push(code, upper)
  }
  for (let base = 0; base < 0x10000; base += 256) {
    if (base >= 0xd800 && base < 0xe000) continue // lone surrogates have no case
    for (let i = 0; i < 256; i += 1) codes[i] = base + i
    const chunk = String.fromCharCode.apply(null, codes)
    const upper = chunk.toUpperCase()
    if (upper === chunk) continue // most blocks have no case at all
    // Same length means every code unit became exactly one (toUpperCase never drops one).
    if (upper.length === 256) {
      for (let i = 0; i < 256; i += 1) add(base + i, upper.charCodeAt(i))
    } else {
      for (let i = 0; i < 256; i += 1) {
        const one = String.fromCharCode(base + i).toUpperCase()
        if (one.length === 1) add(base + i, one.charCodeAt(0))
      }
    }
  }
  return pairs
}

/**
 * The pairs the native engine agrees with (`code` matches `upper` under `i`): one anchored regex of
 * escaped codes per block of pairs against the text of their uppers, split in halves only where a
 * block fails (a few blocks hold one of the handful of pairs the engine does not fold).
 */
function confirmed(pairs: number[]): number[] {
  const kept: number[] = []
  const check = (start: number, end: number): void => {
    let source = '^'
    let subject = ''
    for (let k = start; k < end; k += 1) {
      source += hex4(pairs[k * 2]!)
      subject += String.fromCharCode(pairs[k * 2 + 1]!)
    }
    if (new RegExp(source, 'i').test(subject)) {
      for (let k = start; k < end; k += 1) kept.push(pairs[k * 2]!, pairs[k * 2 + 1]!)
    } else if (end - start > 1) {
      const mid = (start + end) >> 1
      check(start, mid)
      check(mid, end)
    }
  }
  const count = pairs.length / 2
  for (let start = 0; start < count; start += 64) check(start, Math.min(count, start + 64))
  return kept
}

export function caseTable(): CaseTable {
  if (table) return table
  const started = performance.now()
  const canon = new Uint16Array(0x10000)
  const pairs = confirmed(upperPairs())
  for (let k = 0; k < pairs.length; k += 2) canon[pairs[k]!] = pairs[k + 1]!
  // A class is every code unit sharing one canonical form.
  const groups = new Map<number, number[]>()
  for (let k = 0; k < pairs.length; k += 2) {
    const key = pairs[k + 1]!
    let group = groups.get(key)
    if (!group) groups.set(key, (group = canon[key] === 0 ? [key] : []))
    group.push(pairs[k]!)
  }
  const classAt = new Int32Array(0x10000)
  const flat: number[] = []
  for (const group of groups.values()) {
    if (group.length < 2) continue
    for (const code of group) classAt[code] = flat.length + 1
    flat.push(group.length)
    for (const code of group) flat.push(code)
  }
  table = { canon, classAt, members: Uint16Array.from(flat) }
  caseTableBuildMs = performance.now() - started
  return table
}

/** The canonical form of one code unit under `i`. */
export function canonical(code: number): number {
  return code < 128 ? asciiCanon(code) : caseTable().canon[code] || code
}
