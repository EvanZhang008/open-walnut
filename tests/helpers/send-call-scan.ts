/**
 * Finds the calls of a send function in TypeScript source by parsing each call, for the
 * dictation-ids guard (tests/web/dictation-ids-send-guard.test.ts): comments are blanked (strings
 * kept), a call is the name followed by `(` however it is reached (`x.name(`,
 * `(await import('...')).name(`, a destructured name), and its arguments are split at the top
 * level. A function's own declaration is no call.
 */

export interface SendCall {
  file: string
  line: number
  /** The call's whole text, `name(` to its closing paren. */
  text: string
  /** Its arguments, split at the top level. */
  args: string[]
  /** The function the call is written in (nearest declaration before it), when one is named. */
  inside?: string
}

/** A `/` here starts a regular expression, not a division (judged by what comes before it). */
function regexAt(src: string, i: number): boolean {
  let k = i - 1
  while (k >= 0 && /\s/.test(src[k]!)) k--
  if (k < 0) return true
  if (/[(,=:[!&|?{};+\-*%>~^]/.test(src[k]!)) return true
  return /\b(?:return|typeof|case|in|of|void|delete|throw|yield|await)$/.test(src.slice(Math.max(0, k - 7), k + 1))
}

/**
 * The end (exclusive) of the string, template or regular expression starting at `i`, or -1 when
 * none starts there. A template's `${...}` is skipped whole, literals inside it included.
 */
function literalEnd(src: string, i: number): number {
  const c = src[i]
  if (c === '"' || c === "'") {
    let j = i + 1
    while (j < src.length && src[j] !== c && src[j] !== '\n') j += src[j] === '\\' ? 2 : 1
    return j + 1
  }
  if (c === '`') {
    let j = i + 1
    while (j < src.length && src[j] !== '`') {
      if (src[j] === '\\') { j += 2; continue }
      if (src[j] === '$' && src[j + 1] === '{') { j = closing(src, j + 1) + 1; continue }
      j++
    }
    return j + 1
  }
  if (c === '/' && src[i + 1] !== '/' && src[i + 1] !== '*' && regexAt(src, i)) {
    let j = i + 1
    let inClass = false
    while (j < src.length && src[j] !== '\n') {
      const d = src[j]!
      if (d === '\\') { j += 2; continue }
      if (inClass) { if (d === ']') inClass = false }
      else if (d === '[') inClass = true
      else if (d === '/') break
      j++
    }
    return j + 1
  }
  return -1
}

/** Comments become spaces, so every index still points at the same place; strings and patterns stay. */
export function blankComments(src: string): string {
  const out: string[] = []
  let i = 0
  while (i < src.length) {
    const c = src[i]!
    const n = src[i + 1]
    if (c === '/' && n === '/') {
      const end = src.indexOf('\n', i)
      const stop = end < 0 ? src.length : end
      out.push(' '.repeat(stop - i))
      i = stop
      continue
    }
    if (c === '/' && n === '*') {
      const end = src.indexOf('*/', i + 2)
      const stop = end < 0 ? src.length : end + 2
      out.push(src.slice(i, stop).replace(/[^\n]/g, ' '))
      i = stop
      continue
    }
    const lit = literalEnd(src, i)
    if (lit > 0) { out.push(src.slice(i, lit)); i = lit; continue }
    out.push(c)
    i++
  }
  return out.join('')
}

/** The index of the bracket that closes the one at `open`, literals skipped. */
function closing(src: string, open: number): number {
  let depth = 0
  for (let i = open; i < src.length; i++) {
    const lit = literalEnd(src, i)
    if (lit > 0) { i = lit - 1; continue }
    const c = src[i]!
    if (c === '(' || c === '[' || c === '{') depth++
    else if (c === ')' || c === ']' || c === '}') { if (--depth === 0) return i }
  }
  return src.length
}

/** Split `s` at its top-level commas (inside no bracket and no literal). */
export function topLevel(s: string): string[] {
  const out: string[] = []
  let depth = 0
  let start = 0
  for (let i = 0; i < s.length; i++) {
    const lit = literalEnd(s, i)
    if (lit > 0) { i = lit - 1; continue }
    const c = s[i]!
    if (c === '(' || c === '[' || c === '{') depth++
    else if (c === ')' || c === ']' || c === '}') depth--
    else if (c === ',' && depth === 0) { out.push(s.slice(start, i).trim()); start = i + 1 }
  }
  const last = s.slice(start).trim()
  if (last) out.push(last)
  return out
}

const DECL = /(?:^|\n)\s*(?:export\s+)?(?:async\s+)?function\s*\*?\s*(\w+)\s*[(<]/g

const blanked = new Map<string, string>()

export function sendCalls(file: string, source: string, name: string): SendCall[] {
  // Read only where the name is written at all.
  if (!source.includes(name.replace(/\\/g, ''))) return []
  let src = blanked.get(source)
  if (src === undefined) { src = blankComments(source); blanked.set(source, src) }
  const decls = [...src.matchAll(DECL)].map((m) => ({ at: m.index!, name: m[1]! }))
  const out: SendCall[] = []
  for (const m of src.matchAll(new RegExp(`\\b${name}\\s*\\(`, 'g'))) {
    // Its own declaration (`function name(`, `async name(` as a method) is no call.
    if (/(?:function\s*\*?|async)\s*$/.test(src.slice(Math.max(0, m.index! - 20), m.index!))) continue
    const open = m.index! + m[0].length - 1
    const end = closing(src, open)
    const inside = decls.filter((d) => d.at < m.index!).at(-1)?.name
    out.push({
      file, line: src.slice(0, m.index!).split('\n').length, text: src.slice(m.index!, end + 1),
      args: topLevel(src.slice(open + 1, end)), ...(inside ? { inside } : {}),
    })
  }
  return out
}

/** The value of a top-level property `key` of an object literal `obj` (shorthand: the key itself); undefined when absent. */
export function propOf(obj: string, key: string): string | undefined {
  const t = obj.trim()
  if (!t.startsWith('{')) return undefined
  for (const entry of topLevel(t.slice(1, t.lastIndexOf('}')))) {
    if (entry === key) return key
    const m = entry.match(new RegExp(`^${key}\\s*:\\s*([\\s\\S]+)$`))
    if (m) return m[1]!.trim()
  }
  return undefined
}

/** Does the object literal spread another value in (which may hold any property)? */
export function spreads(obj: string): boolean {
  const t = obj.trim()
  return t.startsWith('{') && topLevel(t.slice(1, t.lastIndexOf('}'))).some((e) => e.startsWith('...'))
}
