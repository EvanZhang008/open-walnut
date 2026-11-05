/**
 * `\p{…}` and `\P{…}`: a Unicode property as a set of code units, so a pattern such as `\p{L}+`
 * (any letter, accented and CJK ones included) runs in the linear matcher. The non-unicode grammar
 * the rest of this library reads has no property escapes (there `\p{L}` is the text `p{L}`), so this
 * is the one place it follows the unicode mode: the name is whatever `new RegExp('\\p{…}', 'u')`
 * accepts (`L`, `Letter`, `Lu`, `Script=Greek`, `Alphabetic`, …), and a bare script name (`Han`,
 * `Greek`) is read as `Script=…`, as RE2 and PCRE do. The set is read from the native engine one
 * code unit at a time over the Basic Multilingual Plane (about 65,000 tests, a few milliseconds),
 * once per name: matching walks UTF-16 code units, so a character outside it (an emoji, a rare CJK
 * extension) never matches a property.
 */
import { normalize, type Ranges } from './charset.js'

const NAME = /^[A-Za-z0-9_]+(?:=[A-Za-z0-9_]+)?$/
const cache = new Map<string, Ranges | null>()

function nativeProperty(name: string): RegExp | null {
  try {
    return new RegExp(`^\\p{${name}}$`, 'u')
  } catch {
    return null
  }
}

/** The code units with property `name`, or null when no Unicode property has that name. */
export function propertyRanges(name: string): Ranges | null {
  if (cache.has(name)) return cache.get(name)!
  let ranges: Ranges | null = null
  if (NAME.test(name)) {
    const native = nativeProperty(name) ?? (name.includes('=') ? null : nativeProperty(`Script=${name}`))
    if (native) {
      const pairs: number[] = []
      let start = -1
      for (let code = 0; code <= 0xffff; code += 1) {
        const inSet = native.test(String.fromCharCode(code))
        if (inSet && start < 0) start = code
        if (!inSet && start >= 0) { pairs.push(start, code - 1); start = -1 }
      }
      if (start >= 0) pairs.push(start, 0xffff)
      ranges = normalize(pairs)
    }
  }
  cache.set(name, ranges)
  return ranges
}

/** Whether `source` holds a property escape (`\p` or `\P` after an unescaped backslash). */
export function hasPropertyEscape(source: string): boolean {
  for (let i = 0; i < source.length; i += 1) {
    if (source[i] !== '\\') continue
    if (source[i + 1] === 'p' || source[i + 1] === 'P') return true
    i += 1
  }
  return false
}

/** The sentence for a property escape that names nothing (`\p{Foo}`, `\p` with no braces). */
export function badPropertySentence(letter: 'p' | 'P', name: string | null): string {
  return name === null
    ? `\\${letter} needs a property name in braces, such as \\${letter}{L} for any letter.`
    : `\\${letter}{${name}} is not a Unicode property. Use one such as \\p{L} (any letter) or \\p{Han}.`
}
