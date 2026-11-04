/**
 * wait_for's rules (host-exec-wait.ts): what a `wait_for` may say, checked the same way by the
 * server before anything runs and by the host's daemon. A pattern is any JavaScript regular
 * expression up to WAIT_PATTERN_MAX characters: it is run in the killable matcher
 * (host-exec-matcher.ts), so its cost is bounded there, not guessed here (2026-11-04 review: a
 * static cost check let 3 to 6 s patterns through and refused ordinary ones such as
 * `ready in \d+(\.\d+)? ?ms`). Only the textbook exponential shapes are refused at once, so the
 * caller hears it before a run instead of after a stopped line. Matching is per line, so a line
 * break in the pattern, or the m and s flags, are refused with that reason. A pattern written as a
 * JavaScript literal, `/ready/i`, is read as its body with those flags, and `read` says so
 * (2026-11-04 real-use review: `/ready/i` was taken as the text "/ready/i", with no word).
 */

export const WAIT_PATTERN_MAX = 200
const FILE_PATH_MAX = 4096

export type WaitKind = 'output' | 'port' | 'file'
/** A wait_for as checked: `flags` holds `i`, `u`, both or nothing; `partial` also tests the line still being written. */
export interface WaitFor { output?: string; flags?: string; partial?: boolean; port?: number; file?: string }
/**
 * The pattern a line is tested with, as source and flags, and its variant for a line cut at the cap;
 * `resume`: both with the trailing repeat kept, for a line a wait resumed inside of, where the end
 * of a match counts (host-exec-wait.ts resumedAsk).
 */
export interface LinePattern { source: string; flags: string; cut: string; resume?: { source: string; cut: string } }

const KEYS = ['output', 'flags', 'partial', 'port', 'file']

// One atom (`.`, \d \s \w and their capitals, a [...] class) with its quantifier, lazy or not.
const ATOM = String.raw`(?:\\[dDsSwW]|\.|\[(?:\\.|[^\\\]])+\])`
const QUANTIFIER = String.raw`(?:[*+?]|\{\d+(?:,\d*)?\})\??`
const LEADING = new RegExp(`^(${ATOM})(${QUANTIFIER})`)
const TRAILING = new RegExp(`(${ATOM})(${QUANTIFIER})$`)

/** The least of a repeat that a yes-or-no line test needs: none for `*`, `?`, `{0,n}`; else `{n}` (the atom alone for 1). */
function leastOf(atom: string, quantifier: string): string {
  const least = /^[*?]/.test(quantifier) ? 0 : quantifier.startsWith('+') ? 1 : Number(/^\{(\d+)/.exec(quantifier)![1])
  return least === 0 ? '' : least === 1 ? atom : `${atom}{${least}}`
}

/** Whether the character at `index` is escaped (an odd run of backslashes before it). */
function escapedAt(src: string, index: number): boolean {
  let n = 0
  for (let i = index - 1; i >= 0 && src[i] === '\\'; i--) n++
  return n % 2 === 1
}

/**
 * The regex that tests one line for `output`, with the repeats at either end that cannot change
 * whether a line matches cut to the least they need: a leading `.*` (after `^` too), a leading
 * `\s*` or `\d+` of an unanchored pattern (it matches where the rest does), a trailing `.*`
 * (before `$` too: a line has no line end inside), and a trailing `\S+` or `[0-9]{2,}` with no
 * `$` after it. `\.*` and `\\d+` stay what they are. On a 64 KB line a leading `.*` alone costs
 * the line's length squared.
 *
 * `.` matches every character of a line (the s flag): a line holds no \n or \r, so the flag only
 * makes U+2028 and U+2029, which the splitter leaves inside a line, ordinary characters, and the
 * cuts above say exactly what the pattern does (2026-11-04 review: `^.*ready` and `build.*$` were
 * false on `build: x\u2028ready in 3s` as written, true as tested).
 */
export function linePattern(output: string, flags = '', keepTail = false): RegExp {
  let src = output.replace(/^\^?\.\*\??/, '')
  const dotTail = /\.\*\??\$?$/.exec(src)
  if (dotTail && !escapedAt(src, dotTail.index)) src = src.slice(0, dotTail.index)
  const lead = src.startsWith('^') ? null : LEADING.exec(src)
  if (lead) src = leastOf(lead[1]!, lead[2]!) + src.slice(lead[0].length)
  // `keepTail` (a resumed line, where the end of a match counts): a trailing class repeat that must
  // take a character keeps its whole run (`port \d+` takes in the `00` after `port 30`: a token that
  // grew); one that can take none (`.*`, `\s*`, `\w*`) or of any character (`.+`, `.{2,}`: the rest of
  // the line) is cut to its least all the same, so a prompt seen before is not seen again once a
  // byte lands after it (2026-11-05 code reviews 11 and 12: `Password:.*` and `Password:.+`).
  const tail = TRAILING.exec(src)
  if (tail && !escapedAt(src, tail.index)) {
    const least = leastOf(tail[1]!, tail[2]!)
    if (!keepTail || least === '' || tail[1] === '.') src = src.slice(0, tail.index) + least
  }
  return new RegExp(src, flags.includes('s') ? flags : `${flags}s`)
}

/**
 * The test for a line cut at the cap: its end there is not the line's end, so nothing may hold
 * because the text stops. `$` never holds (the line's end is past the cut; 2026-11-04 review: it
 * held before a U+2028 inside the line), `\b` and `\B` only before a character, and a negative
 * lookahead never holds (it could only because the text stopped): a pattern that needs one there
 * misses that long line rather than matching it wrongly.
 */
export function cutPattern(regex: RegExp): RegExp {
  const src = regex.source
  let out = ''
  let inClass = false
  for (let i = 0; i < src.length; i += 1) {
    const c = src[i]!
    if (c === '\\') {
      const next = src[i + 1] ?? ''
      i += 1
      // A named back-reference's name (`\k<a$>`) is copied as it is.
      const named = !inClass && next === 'k' ? /^<[^>]*>/.exec(src.slice(i + 1)) : null
      if (named) { out += `\\k${named[0]}`; i += named[0].length; continue }
      out += !inClass && (next === 'b' || next === 'B') ? `(?:\\${next}(?=[^]))` : c + next
      continue
    }
    if (inClass) { if (c === ']') inClass = false; out += c; continue }
    if (c === '[') { inClass = true; out += c; continue }
    // A group's name (`(?<a$>`) is copied as it is; `(?<=` and `(?<!` are lookbehinds.
    const name = c === '(' && src[i + 1] === '?' && src[i + 2] === '<' && src[i + 3] !== '=' && src[i + 3] !== '!' ? /^\(\?<[^>]*>/.exec(src.slice(i)) : null
    if (name) { out += name[0]; i += name[0].length - 1; continue }
    if (c === '$') { out += '(?!)'; continue }
    if (c === '(' && src[i + 1] === '?' && src[i + 2] === '!') { out += '(?!|'; i += 2; continue }
    out += c
  }
  return new RegExp(out, regex.flags)
}

/**
 * Why a wait_for.file would be looked for as written and never found, or null: only a leading `~`
 * (a leading $HOME is read as one) and a leading $WALNUT_TASK_DIR are expanded, and it is one path, never a pattern (2026-11-04
 * review: `$HOME/x` and `/tmp/*.txt` were taken and waited on to the end, the file there all along).
 * `[` and `]` are part of a name (`app/[slug]/page.tsx`, 2026-11-05 review); `*` and `?` almost
 * never are, so a path with them is refused as the pattern it was meant to be.
 */
function unexpandedFile(file: string): string | null {
  const rest = file.replace(/^\$\{?WALNUT_TASK_DIR\}?(?=\/|$)/, '')
  const v = /\$\{?([A-Za-z_]\w*)/.exec(rest)
  if (v) {
    return `wait_for.file \`${file}\` names a variable ($${v[1]}), which is not expanded: only a leading ~, $HOME and $WALNUT_TASK_DIR are; write the path out`
  }
  if (/^~[^/]/.test(file)) return `wait_for.file \`${file}\` starts with ~name, which is not expanded: only ~ and ~/ are (the user's own home there); write the path out`
  const glob = /[*?]/.exec(file)
  if (glob) return `wait_for.file \`${file}\` has ${glob[0]} in it, but it is one path, never a pattern: wait for one file by its name, or for a line the job prints once it has written them`
  return null
}

/** An escape for a line break after a backslash: n, r, x0a, u000a, u{a}, cJ, the octal 012 (and their \r twins). */
const LINE_BREAK_ESCAPE = /^(?:[nr]|x0[aAdD]|u000[aAdD]|u\{0*[aAdD]\}|c[jJmM]|01[25])/
/**
 * \12 and \15 without the 0: octal for a line break unless the pattern has that many groups (then a
 * back reference); an octal escape takes at most three digits, so \128 is \12 then 8, \123 is S.
 */
const SHORT_OCTAL = /^1([25])(?![0-7])/

/** How many capturing groups the pattern has (an unescaped `(` not followed by `?`, or a named one). */
function groupsIn(pattern: string): number {
  let n = 0
  for (let i = 0; i < pattern.length; i += 1) {
    if (pattern[i] === '\\') { i += 1; continue }
    if (pattern[i] === '(' && (pattern[i + 1] !== '?' || (pattern[i + 2] === '<' && pattern[i + 3] !== '=' && pattern[i + 3] !== '!'))) n += 1
  }
  return n
}

/** At a backslash's next character, the length of an escape for a line break there, else 0 (`groups`: the pattern's capturing groups). */
function lineBreakEscape(rest: string, groups: number): number {
  const m = LINE_BREAK_ESCAPE.exec(rest)
  if (m) return m[0].length
  const short = SHORT_OCTAL.exec(rest)
  return short !== null && groups < (short[1] === '2' ? 12 : 15) ? short[0].length : 0
}

/** A quantifier at `p[i]` that lets what it follows match nothing (`?`, `*`, `{0`): an optional line break never has to be on the line. */
function optionalAt(p: string, i: number): boolean {
  return p[i] === '?' || p[i] === '*' || /^\{0+(?:,\d*)?\}/.test(p.slice(i, i + 12))
}

/**
 * A line break written into the pattern: a literal one, an escape for one outside a [...] class,
 * or a class of nothing but line breaks (`[\r\n]`). Each can never match, as no line holds one.
 * 2026-11-05 reviews: \x0a, \u000a, \cJ, then \012 and [\r\n] were taken.
 */
function lineBreakIn(pattern: string): boolean {
  if (/[\n\r]/.test(pattern)) return true
  const groups = groupsIn(pattern)
  for (let i = 0; i < pattern.length; i += 1) {
    const c = pattern[i]
    if (c === '\\') {
      const n = lineBreakEscape(pattern.slice(i + 1, i + 9), groups)
      // `ready\r?$` matches `ready`: only a line break the line must hold is one it never can.
      if (n > 0 && !optionalAt(pattern, i + 1 + n)) return true
      i += 1
      continue
    }
    if (c !== '[') continue
    // A class: skipped to its end; one that is not negated and holds only line-break escapes is a line break.
    const negated = pattern[i + 1] === '^'
    let only = !negated
    let any = false
    let j = negated ? i + 2 : i + 1
    for (; j < pattern.length && pattern[j] !== ']'; j += 1) {
      if (pattern[j] === '\\') {
        const n = lineBreakEscape(pattern.slice(j + 1, j + 9), groups)
        if (n > 0) { any = true; j += n } else { only = false; j += 1 }
      } else only = false
    }
    if (only && any && !optionalAt(pattern, j + 1)) return true
    i = j
  }
  return false
}

/** A \p{...} or \P{...} (a Unicode property) in the pattern: one without the u flag is the letter p. */
function propertyEscapeIn(pattern: string): boolean {
  for (let i = 0; i < pattern.length; i += 1) {
    if (pattern[i] !== '\\') continue
    if ((pattern[i + 1] === 'p' || pattern[i + 1] === 'P') && pattern[i + 2] === '{') return true
    i += 1
  }
  return false
}

const POSIX_CLASS = { alpha: '[A-Za-z]', digit: '\\d', alnum: '[A-Za-z0-9]', upper: '[A-Z]', lower: '[a-z]', space: '\\s', blank: '[ \\t]', punct: '[!-/:-@[-`{-~]', xdigit: '[0-9A-Fa-f]', word: '\\w', print: '[ -~]', graph: '[!-~]', cntrl: '[\\x00-\\x1f]' } as const
const ESCAPE_INSTEAD: Record<string, string> = {
  '<': 'grep\'s start of a word: write \\b', '>': 'grep\'s end of a word: write \\b', h: 'a horizontal space in PCRE: write [ \\t]',
  Q: 'PCRE\'s quoting: escape each special character with a backslash instead', E: 'PCRE\'s end of quoting: escape each special character instead',
  K: 'PCRE\'s match reset: match the part you want, or use a lookbehind (?<=...)', e: 'the escape character in PCRE: leave it out, as colour codes are removed before a line is tested',
  G: 'PCRE\'s last-match anchor: there is none here', R: 'PCRE\'s any line break: no line holds one here', X: 'PCRE\'s grapheme: write . with flags "u"',
}

/**
 * Syntax of another regex flavour that JavaScript reads as something else, or null: \A, \Z and \z
 * (anchors elsewhere, letters here), grep's \< \> and [[:digit:]], PCRE's \h \Q \E \K \e, any other
 * escaped letter JavaScript has no escape for (it is the letter itself), and \x{..} or \u{..}
 * without the u flag. 2026-11-05 reviews: `^ready\Z` waited for "readyZ", `[[:digit:]]+ passed`
 * matched nothing, `\e` matched the letter e.
 */
function foreignSyntaxIn(pattern: string, unicode: boolean): string | null {
  const named = /\(\?<[A-Za-z_]/.test(pattern)
  let inClass = false
  for (let i = 0; i < pattern.length; i += 1) {
    const c = pattern[i]
    if (c === '\\') {
      const e = pattern[i + 1] ?? ''
      if (!inClass && (e === 'A' || e === 'Z' || e === 'z')) return `has \\${e}, the start or end of the text in other regex flavours, which JavaScript reads as the letter ${e}: use ^ for the line's start and $ for its end`
      // In a class, \< and \> are the characters themselves, as meant.
      if (ESCAPE_INSTEAD[e] && !(inClass && (e === '<' || e === '>'))) return `has \\${e}, ${ESCAPE_INSTEAD[e]} (JavaScript reads \\${e} as ${/[A-Za-z]/.test(e) ? `the letter ${e}` : `a plain ${e}`})`
      if ((e === 'x' && !/^[0-9A-Fa-f]{2}/.test(pattern.slice(i + 2))) || (e === 'u' && !unicode && !/^[0-9A-Fa-f]{4}/.test(pattern.slice(i + 2)))) {
        return `has \\${e} without ${e === 'x' ? 'two' : 'four'} hex digits after it${pattern[i + 2] === '{' ? ` (\\${e}{...} needs the u flag${e === 'x' ? ' and is written \\u{...}' : ''})` : ''}, which JavaScript reads as the letter ${e}`
      }
      if (e === 'k' && !named) return 'has \\k, a named back reference, but no named group (?<name>...): JavaScript reads it as the letter k'
      // In a class other flavours read most such letters as the letter too (\A in [\A-Z]); the ones they do not are named above.
      if (!inClass && /[a-zA-Z]/.test(e) && !/[dDwWsSbBnrtvfcxuk0pP]/.test(e)) return `has \\${e}, which JavaScript has no escape for, so it reads as the letter ${e}: write the letter itself, or the escape JavaScript has (\\d, \\w, \\s, \\b, \\n, \\t, \\xHH)`
      i += 1
    } else if (c === '[') {
      const posix = !inClass ? null : /^\[:([a-z]+):\]/.exec(pattern.slice(i))
      if (posix) {
        const js = (POSIX_CLASS as Record<string, string>)[posix[1]!]
        return `has [:${posix[1]}:], grep's character class, which JavaScript reads as the characters of that name: write ${js ?? 'the characters themselves'} instead${js ? ` (so [[:${posix[1]}:]] is ${js})` : ''}`
      }
      inClass = true
    } else if (c === ']') inClass = false
  }
  return null
}

/** At `i`, a quantifier: its length and its least and most counts (Infinity: no bound); null when none. */
function quantifierAt(p: string, i: number): { len: number; min: number; max: number } | null {
  const c = p[i]
  let q: { len: number; min: number; max: number } | null = null
  if (c === '*') q = { len: 1, min: 0, max: Infinity }
  else if (c === '+') q = { len: 1, min: 1, max: Infinity }
  else if (c === '?') q = { len: 1, min: 0, max: 1 }
  else if (c === '{') {
    const m = /^\{(\d+)(,(\d*))?\}/.exec(p.slice(i))
    if (m) q = { len: m[0].length, min: Number(m[1]), max: m[2] === undefined ? Number(m[1]) : m[3] === '' ? Infinity : Number(m[3]) }
  }
  if (q && p[i + q.len] === '?') q.len += 1 // lazy: the same repeat
  return q
}

// The pattern as the check reads it: `atom` is one character from a set (the id of its source),
// `none` a place no path goes through here (an anchor, \b, a lookaround, a back-reference).
type Shape = { t: 'atom'; id: number } | { t: 'none' } | { t: 'seq'; items: Shape[] } | { t: 'alt'; branches: Shape[]; twins?: true }
  | { t: 'rep'; body: Shape; min: number; max: number }
const NONE: Shape = { t: 'none' }
const ESCAPE = /^\\(?:x[\da-fA-F]{2}|u[\da-fA-F]{4}|c[A-Za-z]|0[0-7]{0,2}|[^])/
const ESCAPE_U = /^\\(?:x[\da-fA-F]{2}|u[\da-fA-F]{4}|u\{[\da-fA-F]+\}|c[A-Za-z]|[pP]\{[^}]*\}|0[0-7]{0,2}|[^])/

/** Every group of the pattern that repeats without bound (`*`, `+`, `{n,}`), lookarounds' included. */
function unboundedGroups(p: string, unicode: boolean, atom: (src: string) => Shape): Shape[] {
  const found: Shape[] = []
  let i = 0
  const alt = (): Shape => {
    const from = i
    const branches = [seq()]
    const texts = [p.slice(from, i)]
    while (p[i] === '|') { i += 1; const at = i; branches.push(seq()); texts.push(p.slice(at, i)) }
    if (branches.length === 1) return branches[0]!
    // Two branches written the same (`a|b|a`): found by their text, before any path is followed
    // (2026-11-04 review: with 60 of them the path search spent its budget and let the pattern by).
    const twins = branches.some((b, k) => readsChar(b) && texts.indexOf(texts[k]!) !== k)
    return twins ? { t: 'alt', branches, twins: true } : { t: 'alt', branches }
  }
  const seq = (): Shape => {
    const items: Shape[] = []
    while (i < p.length && p[i] !== '|' && p[i] !== ')') {
      const [shape, group] = term()
      const q = quantifierAt(p, i)
      if (!q) { items.push(shape); continue }
      i += q.len
      const rep: Shape = { t: 'rep', body: shape, min: q.min, max: Math.max(q.max, q.min) }
      if (group && q.max === Infinity) found.push(rep)
      items.push(rep)
    }
    return { t: 'seq', items }
  }
  const term = (): [Shape, boolean] => {
    const c = p[i]!
    if (c === '(') {
      // (?: (?= (?! (?<= (?<! (?<name> (?i:
      const open = /^\(\?(?::|=|!|<=|<!|<[A-Za-z_$][\w$]*>|[a-z-]+:)/.exec(p.slice(i))?.[0] ?? (p[i + 1] === '?' ? '(?' : '(')
      i += open.length
      const body = alt()
      if (p[i] === ')') i += 1
      return /^\(\?<?[=!]/.test(open) ? [NONE, false] : [body, true]
    }
    if (c === '[') {
      let j = i + 1
      if (p[j] === '^') j += 1
      while (j < p.length && p[j] !== ']') j += p[j] === '\\' ? 2 : 1
      const src = p.slice(i, j + 1)
      i = j + 1
      return [atom(src), false]
    }
    if (c === '\\') {
      const rest = p.slice(i)
      const none = /^\\(?:[1-9]\d*|k<[^>]*>|[bB])/.exec(rest)
      const esc = none ?? (unicode ? ESCAPE_U : ESCAPE).exec(rest)
      i += esc ? esc[0].length : 1
      return [none || !esc ? NONE : atom(esc[0]), false]
    }
    i += 1
    if (c === '^' || c === '$') return [NONE, false]
    return [atom(c === '.' || !/[\\^$*+?()[\]{}|/]/.test(c) ? c : `\\${c}`), false]
  }
  while (i < p.length) { alt(); i += 1 } // past a `)` that closes nothing
  return found
}

class TooLarge extends Error {}
const MAX_STATES = 200
const MAX_STEPS = 150_000
interface Ends { first: number[]; last: number[]; empty: boolean }
const NOTHING: Ends = { first: [], last: [], empty: true }

/**
 * Can this repeat match one text in more than one way? Its automaton has one state per character
 * its body matches (Glushkov's construction, counting the ways to step from one state to the next).
 * It is ambiguous when two different paths leave a state and meet at it again on the same
 * characters: they part at two next states that can read one character (`(a|a)*`, `(\w+\w*)+`,
 * `(\w+\s?)*` across iterations) or at two ways to the same one (`(a+)+`, `(a*)*`), and then
 * follow pairs of states that keep reading one character. A failing line then has 2^n paths.
 * Parts that never read the same character leave one path (`(\S+\s+)*`, `(\d+\.)+`, `(foo|bar)+`).
 * A count past `cap` is cut (a fixed one stays fixed, a range stays a range), to keep the check small.
 */
function manyWays(rep: Shape, cap: number, meet: (a: number, b: number) => boolean, apart: (ids: number[]) => boolean, step: () => void): boolean {
  const atom: number[] = [] // per state: the id of the character set it reads
  const next: Map<number, number>[] = [] // per state: each next state, and the ways to step there
  const link = (from: number[], to: number[]): void => {
    for (const a of from) for (const b of to) { step(); next[a]!.set(b, (next[a]!.get(b) ?? 0) + 1) }
  }
  const then = (x: Ends, y: Ends): Ends => {
    link(x.last, y.first)
    return { first: x.empty ? [...x.first, ...y.first] : x.first, last: y.empty ? [...y.last, ...x.last] : y.last, empty: x.empty && y.empty }
  }
  const build = (s: Shape): Ends => {
    // Every node built is a step, so the check's work is bounded whatever the shape (2026-11-04
    // review: counting copies alone let `((?:()()...){999999999})*`, a body of 60 empty groups
    // built 150 000 times, hold the loop 1.5 s).
    step()
    if (s.t === 'none') return { first: [], last: [], empty: false }
    if (s.t === 'atom') {
      if (atom.length >= MAX_STATES) throw new TooLarge()
      atom.push(s.id)
      next.push(new Map())
      return { first: [atom.length - 1], last: [atom.length - 1], empty: false }
    }
    if (s.t === 'seq') return s.items.reduce((acc, item) => then(acc, build(item)), NOTHING)
    if (s.t === 'alt') {
      const b = s.branches.map(build)
      return { first: b.flatMap((e) => e.first), last: b.flatMap((e) => e.last), empty: b.some((e) => e.empty) }
    }
    // A body that reads no character (`()`, `\b`, `(?:^|$)`) adds no state and no link however
    // often it repeats: one copy is all of them.
    if (!readsChar(s.body)) { const once = build(s.body); return s.min > 0 ? once : { ...once, empty: true } }
    // {n,m}: n copies, then m-n more, each only after the one before (one path per count); {n,} ends in a loop.
    const loop = s.max === Infinity
    const least = Math.min(s.min, cap)
    let out = NOTHING
    // Every copy is a step: a body that reads no character (`()`, `\b`) adds no state and no link,
    // so without it `(){99999999,}` would loop that many times.
    for (let k = loop && least > 0 ? 1 : 0; k < least; k += 1) { step(); out = then(out, build(s.body)) }
    if (loop) {
      const body = build(s.body)
      link(body.last, body.first)
      return then(out, least > 0 ? body : { ...body, empty: true })
    }
    let more = NOTHING
    for (let k = Math.min(s.max - s.min, cap); k > 0; k -= 1) { step(); more = { ...then(build(s.body), more), empty: true } }
    return then(out, more)
  }
  const start = build(rep)
  const n = atom.length
  const reached = new Uint8Array(n)
  const todo: number[] = []
  const reach = (s: number): void => { if (!reached[s]) { reached[s] = 1; todo.push(s) } }
  start.first.forEach(reach)
  while (todo.length) for (const t of next[todo.pop()!]!.keys()) reach(t)
  // Both paths stay on cycles through s, so only pairs of states in s's component are followed.
  const comp = components(next)
  const seen = new Int32Array(n * n)
  const key = (a: number, b: number): number => (a < b ? a * n + b : b * n + a)
  for (let s = 0; s < n; s += 1) {
    if (!reached[s]) continue
    const c = comp[s]
    const out = [...next[s]!].filter(([t]) => comp[t] === c)
    // The usual case, read in one pass: next states that share no character keep one path.
    if (out.every(([, ways]) => ways === 1) && apart(out.map(([t]) => atom[t]!))) continue
    const front: number[] = []
    for (let x = 0; x < out.length; x += 1) {
      const [a, ways] = out[x]!
      if (ways > 1 && meet(atom[a]!, atom[a]!)) front.push(key(a, a))
      for (let y = x + 1; y < out.length; y += 1) { step(); if (meet(atom[a]!, atom[out[y]![0]]!)) front.push(key(a, out[y]![0])) }
    }
    for (const k of front) seen[k] = s + 1
    while (front.length) {
      const k = front.pop()!
      const p = Math.floor(k / n)
      const r = k % n
      if (p === s && r === s) return true
      for (const a of next[p]!.keys()) {
        if (comp[a] !== c) continue
        for (const b of next[r]!.keys()) {
          step()
          if (comp[b] !== c || seen[key(a, b)] === s + 1 || !meet(atom[a]!, atom[b]!)) continue
          seen[key(a, b)] = s + 1
          front.push(key(a, b))
        }
      }
    }
  }
  return false
}

/** Whether the shape reads a character anywhere (an atom in it). */
const readsMemo = new WeakMap<Shape, boolean>()
function readsChar(s: Shape): boolean {
  if (s.t === 'atom') return true
  if (s.t === 'none') return false
  const known = readsMemo.get(s)
  if (known !== undefined) return known
  const r = s.t === 'seq' ? s.items.some(readsChar) : s.t === 'alt' ? s.branches.some(readsChar) : readsChar(s.body)
  readsMemo.set(s, r)
  return r
}

/** An alternation with two branches written the same, which read a character: inside a repeat, two ways to read one text. */
function twinBranches(s: Shape): boolean {
  if (s.t === 'seq') return s.items.some(twinBranches)
  if (s.t === 'rep') return twinBranches(s.body)
  if (s.t !== 'alt') return false
  return s.twins === true || s.branches.some(twinBranches)
}

/** The largest count the shape writes (`{9}`, `{2,5}` is 3 more past 2): past it, a smaller cap changes nothing. */
function largestCount(s: Shape): number {
  if (s.t === 'seq') return Math.max(0, ...s.items.map(largestCount))
  if (s.t === 'alt') return Math.max(0, ...s.branches.map(largestCount))
  if (s.t !== 'rep') return 0
  return Math.max(s.min, s.max === Infinity ? 0 : s.max - s.min, largestCount(s.body))
}

/** Each state's strongly connected component (Tarjan's algorithm): the states of one cycle share a number. */
function components(next: Map<number, number>[]): number[] {
  const index = next.map(() => -1)
  const low = next.map(() => 0)
  const comp = next.map(() => -1)
  const stack: number[] = []
  let counter = 0
  let count = 0
  const visit = (v: number): void => {
    index[v] = low[v] = counter++
    stack.push(v)
    for (const w of next[v]!.keys()) {
      if (index[w] === -1) { visit(w); low[v] = Math.min(low[v]!, low[w]!) } else if (comp[w] === -1) low[v] = Math.min(low[v]!, index[w]!)
    }
    if (low[v] !== index[v]) return
    let w: number
    do { w = stack.pop()!; comp[w] = count } while (w !== v)
    count += 1
  }
  next.forEach((_, v) => { if (index[v] === -1) visit(v) })
  return comp
}

/**
 * Characters that stand for every set the pattern can name, so two sets meet exactly when one of
 * them is in both: ASCII, the spaces and case pairs past it that \s, \w and the i flag reach, and
 * each character the pattern writes past ASCII with its two neighbours (a range's ends).
 */
function samples(pattern: string): string[] {
  const codes = new Set<number>(Array.from({ length: 128 }, (_, c) => c))
  for (const c of [0xa0, 0xc9, 0xe9, 0x130, 0x131, 0x17f, 0x1680, 0x2000, 0x200a, 0x2028, 0x2029, 0x202f, 0x205f, 0x212a, 0x3000, 0x4e00, 0xfeff, 0xffff]) codes.add(c)
  const written = [...pattern].map((ch) => ch.codePointAt(0)!)
  for (const m of pattern.matchAll(/\\(?:x([\da-fA-F]{2})|u([\da-fA-F]{4})|u\{([\da-fA-F]{1,6})\})/g)) written.push(parseInt(m[1] ?? m[2] ?? m[3]!, 16))
  for (const c of written) if (c >= 128) for (const d of [c - 1, c, c + 1]) codes.add(d)
  return [...codes].filter((c) => c <= 0x10ffff).map((c) => String.fromCodePoint(c))
}

/**
 * The textbook exponential shapes, refused before anything runs: a group that repeats without
 * bound (`*`, `+`, `{n,}`) and can match one text in more than one way (see manyWays): branches
 * that match the same text (`(a|a)*`, `((\d|\w)-)*`), an unbounded part followed by one that can
 * read its characters (`(a+)+`, `(\w+\w*)+`), an optional part between two that then meet across
 * iterations (`(\w+\s?)*`), a body that matches nothing (`(a*)*`). A repeated group of parts that
 * cannot read the same character (`(\S+\s+)*`, `(\w+,)*`, `(foo|bar)+`) and every bounded repeat
 * are left to the matcher's limit. An anchor, a lookaround or a back-reference ends the paths
 * through it, so only what is ambiguous without them is refused, and a repeat too large to read
 * here is left to the matcher too. Only single atoms are compiled, to read their sets (2026-11-04
 * review: compiling whole branches let a counted repeat of an optional atom run for seconds here).
 */
export function exponentialShape(pattern: string, flags = ''): boolean {
  const srcs: string[] = []
  const ids = new Map<string, number>()
  const atom = (src: string): Shape => {
    if (!ids.has(src)) { ids.set(src, srcs.length); srcs.push(src) }
    return { t: 'atom', id: ids.get(src)! }
  }
  const groups = unboundedGroups(pattern, flags.includes('u'), atom)
  if (!groups.length) return false
  const ci = flags.includes('i') || /\(\?[a-z]*i[a-z]*(?:-[a-z]*)?:/.test(pattern)
  const setFlags = `${ci ? 'i' : ''}${flags.includes('u') ? 'u' : ''}`
  const chars = samples(pattern)
  const startOf = new Map<number, number>() // a sample's offset in `text` -> its index
  let text = ''
  for (const [k, ch] of chars.entries()) { startOf.set(text.length, k); text += ch }
  const words = (chars.length + 31) >> 5
  const bits: Uint32Array[] = []
  const bitsOf = (id: number): Uint32Array => {
    if (bits[id]) return bits[id]!
    const out = (bits[id] = new Uint32Array(words))
    try {
      // One pass over the samples: an atom reads one character, so a match that is a whole sample marks it.
      for (const m of text.matchAll(new RegExp(srcs[id]!, `g${setFlags}`))) {
        const k = startOf.get(m.index!)
        if (k !== undefined && m[0] === chars[k]) out[k >> 5] = out[k >> 5]! | (1 << (k & 31))
      }
    } catch { /* a set the check cannot read meets nothing */ }
    return out
  }
  const k = srcs.length
  const met = new Uint8Array(k * k) // 0: not read yet, 1: the two sets share no character, 2: they share one
  const meet = (a: number, b: number): boolean => {
    if (!met[a * k + b]) met[a * k + b] = met[b * k + a] = bitsOf(a).some((w, i) => (w & bitsOf(b)[i]!) !== 0) ? 2 : 1
    return met[a * k + b] === 2
  }
  const union = new Uint32Array(words)
  const apart = (list: number[]): boolean => {
    union.fill(0)
    for (const id of list) {
      const b = bitsOf(id)
      for (let i = 0; i < words; i += 1) { if ((b[i]! & union[i]!) !== 0) return false; union[i] = union[i]! | b[i]! }
    }
    return true
  }
  let total = 0
  return groups.some((rep) => {
    if (twinBranches(rep)) return true
    const largest = largestCount(rep)
    // Cut the counts only when the full repeat is too large, and only to a cap that changes something.
    for (const cap of [Infinity, 3, 1].filter((c) => c === Infinity || c < largest)) {
      let spent = 0
      const step = (): void => { if ((spent += 1) > MAX_STEPS || (total += 1) > 4 * MAX_STEPS) throw new TooLarge() }
      try { return manyWays(rep, cap, meet, apart, step) } catch (err) { if (!(err instanceof TooLarge)) throw err }
    }
    return false
  })
}

/**
 * `/body/flags`, a JavaScript regex literal with one or more distinct flags (any of JavaScript's
 * own, [dgimsuvy]) and a closing slash that is not escaped: its body and flags; null for anything
 * else (`/tmp/`, with no flags, is an ordinary pattern for the text "/tmp/").
 */
export function regexLiteral(output: string): { body: string; flags: string } | null {
  const m = /^\/([^]+)\/([dgimsuvy]+)$/.exec(output)
  if (!m || new Set(m[2]).size !== m[2]!.length || escapedAt(output, output.length - m[2]!.length - 1)) return null
  return { body: m[1]!, flags: m[2]! }
}

/**
 * A wait_for as given, checked: the condition and the pattern its lines are tested with, or the
 * refusal. `read`: how a pattern written as a regex literal was read, for the answer to say.
 */
export function parseWaitFor(raw: unknown): { ok: true; waitFor: WaitFor; pattern: LinePattern | null; read?: string } | { ok: false; error: string } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, error: 'wait_for must be an object: { output?, flags?, partial?, port?, file? }' }
  const o = raw as Record<string, unknown>
  const extra = Object.keys(o).filter((k) => !KEYS.includes(k))
  if (extra.length) return { ok: false, error: `wait_for takes output, flags, partial, port and file, not ${extra.join(', ')}` }
  const waitFor: WaitFor = {}
  let pattern: LinePattern | null = null
  let read: string | undefined
  if (o.output !== undefined) {
    if (typeof o.output !== 'string' || !o.output) return { ok: false, error: 'wait_for.output must be a regular expression (a non-empty string)' }
    if (o.output.length > WAIT_PATTERN_MAX) return { ok: false, error: `wait_for.output is too long: keep it under ${WAIT_PATTERN_MAX} characters` }
    let source = o.output
    let ignoreCase = false
    let unicode = false
    let sticky = false
    // `/ready/i`, as JavaScript writes it: its body, with its flags.
    // g and d mean nothing for one test of each line (2026-11-04 review: `/ready/g` was read as the
    // text "/ready/g"); v (Unicode sets) is refused, as wait_for's pattern checks do not read its syntax.
    const literal = regexLiteral(source)
    if (literal) {
      if (/[ms]/.test(literal.flags)) return { ok: false, error: `wait_for.output ${o.output} is a regex literal with the flags "${literal.flags}": each line is matched on its own, so the m and s flags change nothing; leave them out` }
      if (literal.flags.includes('v')) return { ok: false, error: `wait_for.output ${o.output} is a regex literal with the v flag (Unicode sets), which wait_for does not take: write it for the u flag and use "u"` }
      source = literal.body
      ignoreCase = literal.flags.includes('i')
      unicode = literal.flags.includes('u')
      sticky = literal.flags.includes('y')
      const kept = literal.flags.replace(/[dg]/g, '')
      const dropped = literal.flags.includes('d') && literal.flags.includes('g') ? 'd and g dropped: each line is tested on its own, once, and the match is the whole line'
        : literal.flags.includes('g') ? 'g dropped: each line is tested on its own, once'
          : literal.flags.includes('d') ? 'd dropped: the match is the whole line' : ''
      read = `wait_for.output "${o.output}" is written as a JavaScript regex literal, so it was read as /${literal.body}/${kept ? ` with the flags ${kept}` : ''}${sticky ? ' (y: from the start of the line)' : ''}${dropped ? ` (${dropped})` : ''}`
    }
    if (o.flags !== undefined) {
      if (typeof o.flags !== 'string' || !/^[a-z]*$/.test(o.flags)) return { ok: false, error: 'wait_for.flags takes lowercase letters: "i" for case-insensitive, "u" for Unicode mode' }
      if (/[ms]/.test(o.flags)) return { ok: false, error: `wait_for.flags "${o.flags}": each line is matched on its own, so the m and s flags change nothing${/[gdy]/.test(o.flags) ? ', nor do g, d and y, as each line is tested once' : ''}; leave them out ("i" is the flag wait_for takes, and "u")` }
      if (/[^iu]/.test(o.flags)) return { ok: false, error: `wait_for.flags "${o.flags}": wait_for takes "i" (case-insensitive) and "u" (Unicode) only` }
      if (o.flags.includes('i')) ignoreCase = true
      if (o.flags.includes('u')) unicode = true
    }
    // (?i) at the start, as other regex flavours write it: the i flag.
    if (source.startsWith('(?i)')) { source = source.slice(4); ignoreCase = true }
    if (!source) return { ok: false, error: 'wait_for.output must be a regular expression (a non-empty string)' }
    // The y flag holds a match to where the test starts, a line's start: an anchor, so no state rides from line to line.
    if (sticky) source = `^(?:${source})`
    // A pattern that would read as a literal now (`//x/i/i` unwrapped, `(?i)/x/i` stripped) is
    // grouped, so the daemon, which parses what the server sends, reads the same pattern again.
    else if (regexLiteral(source)) source = `(?:${source})`
    if (source.length > WAIT_PATTERN_MAX) return { ok: false, error: `wait_for.output is too long: keep it under ${WAIT_PATTERN_MAX} characters` }
    const flags = `${ignoreCase ? 'i' : ''}${unicode ? 'u' : ''}`
    if (lineBreakIn(source)) return { ok: false, error: `wait_for.output /${o.output}/ has a line break in it, but each line is matched on its own (a line ends at a newline or \\r): wait for one line, the last one you expect` }
    // 2026-11-05 review: `\p{L}+` without u was taken, and only ever matched the letters p, L, {, }.
    if (!unicode && propertyEscapeIn(source)) return { ok: false, error: `wait_for.output /${o.output}/ has \\p{...}, a Unicode property, which needs the u flag (without it \\p is the letter p): add "flags": "u"` }
    const foreign = foreignSyntaxIn(source, unicode)
    if (foreign) return { ok: false, error: `wait_for.output /${o.output}/ ${foreign}` }
    if (exponentialShape(source, flags)) {
      return { ok: false, error: `wait_for.output /${o.output}/ could take too long to run: a repeated group holds another repeat, or branches that can match the same text. Match a plainer piece of the line (a fixed word or a single \\d+)` }
    }
    try {
      void new RegExp(source, flags) // the pattern as given must compile, not only its line test
      const regex = linePattern(source, flags)
      const whole = linePattern(source, flags, true)
      pattern = { source: regex.source, flags: regex.flags, cut: cutPattern(regex).source, resume: { source: whole.source, cut: cutPattern(whole).source } }
    } catch (err) {
      // (?m), (?s), (?x), as other regex flavours write a flag: the engine's own words name none of
      // that (2026-11-05 review: `(?m)^ready$` got "unrecognized character after (?").
      if (/\(\?-?[A-Za-z]+(?:-[A-Za-z]+)?[):]/.test(source)) {
        return { ok: false, error: `wait_for.output /${o.output}/ has an inline flag such as (?m) or (?s), which JavaScript regular expressions do not read here: only a leading (?i) is taken. Put "i" or "u" in wait_for.flags; m and s change nothing, since each line is matched on its own` }
      }
      return { ok: false, error: `wait_for.output is not a valid regular expression: ${err instanceof Error ? err.message : String(err)}` }
    }
    waitFor.output = source
    if (flags) waitFor.flags = flags
  } else if (o.flags !== undefined) {
    return { ok: false, error: 'wait_for.flags goes with wait_for.output' }
  }
  if (o.partial !== undefined) {
    if (typeof o.partial !== 'boolean') return { ok: false, error: 'wait_for.partial must be true or false' }
    if (waitFor.output === undefined) return { ok: false, error: 'wait_for.partial goes with wait_for.output' }
    if (o.partial) waitFor.partial = true
  }
  if (o.port !== undefined) {
    if (typeof o.port !== 'number' || !Number.isInteger(o.port) || o.port < 1 || o.port > 65535) return { ok: false, error: 'wait_for.port must be a TCP port (1 to 65535)' }
    waitFor.port = o.port
  }
  if (o.file !== undefined) {
    if (typeof o.file !== 'string' || !o.file.trim() || o.file.length > FILE_PATH_MAX || o.file.includes('\0')) return { ok: false, error: 'wait_for.file must be a path' }
    // A leading $HOME is the home there, written as ~ before anything else reads it, so a daemon
    // that predates this reads it too (2026-11-05 review: `$HOME/x` was refused for ~).
    const file = o.file.trim().replace(/^(?:\$HOME|\$\{HOME\})(?=\/|$)/, '~')
    const why = unexpandedFile(file)
    if (why) return { ok: false, error: why }
    waitFor.file = file
  }
  if (waitFor.output === undefined && waitFor.port === undefined && waitFor.file === undefined) return { ok: false, error: 'wait_for needs output, port or file' }
  return { ok: true, waitFor, pattern, ...(read ? { read } : {}) }
}
