/**
 * Small readers of the phone app's Swift source for the tests/web/ios-*-guard tests: a function's
 * body and the calls it awaits.
 */

/** The body of the first `func <name>(...)` in `src`, braces matched; null when there is none. */
export function body(src: string, name: string): string | null {
  const m = new RegExp(`func\\s+${name}\\s*\\(`).exec(src)
  if (!m) return null
  const open = src.indexOf('{', m.index)
  let depth = 0
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++
    else if (src[i] === '}' && --depth === 0) return src.slice(open + 1, i)
  }
  return src.slice(open + 1)
}

/** The awaited calls of a body, in order (`await x.y()` gives `x.y`). */
export function awaits(src: string): string[] {
  return [...src.matchAll(/\bawait\s+([\w.]+)\s*\(/g)].map((m) => m[1])
}
