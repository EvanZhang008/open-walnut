/**
 * Why the native engine refused a pattern, in a few plain words that are the same in every engine.
 *
 * Each engine words its refusal its own way, and some repeat the pattern back: V8 says `Invalid
 * regular expression: /(?/i: Invalid group`, JavaScriptCore `Invalid regular expression:
 * unrecognized character after (?`. Shown after "This pattern is not a valid regular expression:",
 * both read as noise, and the Settings editor (the browser's engine) and the server (another one)
 * would disagree. So the reason is read from the pattern itself, scanning it the way the non-unicode
 * grammar does (Annex B: a lone `{`, `}` or `]` is a literal, a lookahead may be repeated, a
 * lookbehind may not), and the first problem found is named, with how to fix it for the common
 * mistakes (a glob's `*`, an inline `(?i)`, a bracket meant literally). Only when the scan finds none
 * (a cause it does not know, such as syntax only a newer engine accepts) does the engine's own text
 * show, without its prefix and its copy of the pattern. Called only for a pattern the engine refused.
 */

const NAME_START = /[A-Za-z_$]/
const NAME_PART = /[A-Za-z0-9_$]/
const CLASS_ESCAPES = 'dDsSwW'
const CONTROL_ESCAPES: Record<string, number> = { n: 10, r: 13, t: 9, f: 12, v: 11, b: 8, '0': 0 }
const CHARACTER_NAMES: Record<string, string> = { '*': 'an asterisk', '+': 'a plus sign', '?': 'a question mark' }

/** The pattern with a glob's `*` written as `.*`, when that is a short valid pattern. */
function anyTextExample(source: string): string {
  const example = source.replace(/\.?\*/g, '.*')
  try {
    new RegExp(example, 'i')
    return example.length <= 40 ? example : '.*invoice.*'
  } catch {
    return '.*invoice.*'
  }
}

/** What to say about a repeat with nothing before it. */
function nothingToRepeat(token: string, source: string): string {
  if (token === '*') return `* has nothing before it to repeat. To match any text, use .* (for example ${anyTextExample(source)}).`
  if (token === '?') return '? has nothing before it to repeat. To match any one character, use . (a dot).'
  if (token === '+') return '+ has nothing before it to repeat. Put what repeats before it, or write \\+ to match a plus sign.'
  return `${token} has nothing before it to repeat. Put what repeats before it.`
}

/** The engine's words without its prefix and its copy of the pattern, as a sentence. */
function cleaned(source: string, detail: string): string {
  let rest = detail.replace(/^Invalid regular expression:\s*/i, '')
  const echo = `/${source}/`
  if (rest.startsWith(echo)) rest = rest.slice(echo.length).replace(/^[a-z]*:\s*/, '')
  rest = rest.trim().replace(/\.$/, '')
  if (!rest) return 'the engine could not read it.'
  return `${rest[0]!.toLowerCase()}${rest.slice(1)}.`
}

/** The code unit a class item stands for, or null for a class escape such as \d (no range end). */
function classItem(source: string, at: number): { code: number | null; end: number } {
  const c = source[at]!
  if (c !== '\\') return { code: source.charCodeAt(at), end: at + 1 }
  const e = source[at + 1]
  if (e === undefined) return { code: null, end: at + 1 }
  if (CLASS_ESCAPES.includes(e)) return { code: null, end: at + 2 }
  const hex = (len: number): number | null => {
    const digits = source.slice(at + 2, at + 2 + len)
    return digits.length === len && /^[0-9a-fA-F]+$/.test(digits) ? parseInt(digits, 16) : null
  }
  if (e === 'x' && hex(2) !== null) return { code: hex(2), end: at + 4 }
  if (e === 'u' && hex(4) !== null) return { code: hex(4), end: at + 6 }
  if (e === 'c' && /[A-Za-z0-9_]/.test(source[at + 2] ?? '')) return { code: source.charCodeAt(at + 2) % 32, end: at + 3 }
  if (/[0-7]/.test(e)) {
    const octal = /^[0-7]{1,3}/.exec(source.slice(at + 1))![0]
    const value = parseInt(octal, 8)
    const used = value > 0o377 ? octal.slice(0, 2) : octal
    return { code: parseInt(used, 8), end: at + 1 + used.length }
  }
  return { code: CONTROL_ESCAPES[e] ?? source.charCodeAt(at + 1), end: at + 2 }
}

/** The first problem in a class starting at `at` (its `[`), and where it ends. */
function scanClass(source: string, at: number): { problem?: string; end: number } {
  let i = at + 1
  if (source[i] === '^') i += 1
  while (i < source.length && source[i] !== ']') {
    const first = classItem(source, i)
    if (source[first.end] === '-' && first.end + 1 < source.length && source[first.end + 1] !== ']') {
      const second = classItem(source, first.end + 1)
      if (first.code !== null && second.code !== null && first.code > second.code) {
        const low = source.slice(first.end + 1, second.end)
        const high = source.slice(i, first.end)
        return { problem: `the range ${source.slice(i, second.end)} in [ ] goes backwards. Write it as ${low}-${high}.`, end: second.end }
      }
      i = second.end
    } else {
      i = first.end
    }
  }
  if (i >= source.length) return { problem: 'a [ has no matching ]. Close it, or write \\[ to match a bracket.', end: i }
  return { end: i + 1 }
}

/** The plain reason a refused pattern is not valid (see the header). */
export function syntaxErrorReason(source: string, engineDetail: string): string {
  const named = new Set<string>()
  const refs: string[] = []
  const groups: Array<{ behind: boolean }> = []
  // What a quantifier here would repeat: nothing, an atom, a lookbehind, or another quantifier.
  let before: 'nothing' | 'atom' | 'lookbehind' | 'repeat' | 'lazy' = 'nothing'
  const repeat = (token: string): string | undefined => {
    if (before === 'repeat' && token === '?') { before = 'lazy'; return undefined }
    if (before === 'repeat' || before === 'lazy') {
      const name = CHARACTER_NAMES[token]
      return name
        ? `${token} comes right after another repeat. Remove one, or write \\${token} to match ${name}.`
        : `${token} comes right after another repeat. Remove one of them.`
    }
    if (before === 'lookbehind') return 'a lookbehind, (?<= or (?<!, cannot be repeated. Remove the repeat after it.'
    if (before === 'nothing') return nothingToRepeat(token, source)
    before = 'repeat'
    return undefined
  }
  for (let i = 0; i < source.length;) {
    const c = source[i]!
    if (c === '\\') {
      const e = source[i + 1]
      if (e === undefined) return 'it ends with a lone \\. Remove it, or write \\\\ to match a backslash.'
      if (e === 'k' && source[i + 2] === '<') {
        const close = source.indexOf('>', i + 3)
        if (close > i + 3) refs.push(source.slice(i + 3, close))
      }
      before = e === 'b' || e === 'B' ? 'nothing' : 'atom'
      i += 2
      continue
    }
    if (c === '[') {
      const scanned = scanClass(source, i)
      if (scanned.problem) return scanned.problem
      before = 'atom'
      i = scanned.end
      continue
    }
    if (c === '(') {
      let behind = false
      let open = 1
      if (source[i + 1] === '?') {
        const rest = source.slice(i + 2)
        if (rest.startsWith(':') || rest.startsWith('=') || rest.startsWith('!')) open = 3
        else if (rest.startsWith('<=') || rest.startsWith('<!')) { open = 4; behind = true }
        else if (rest.startsWith('<')) {
          const name = /^<([^>]*)>/.exec(rest)?.[1]
          if (name === undefined || !NAME_START.test(name[0] ?? '') || ![...name].every((ch) => NAME_PART.test(ch))) {
            return 'a group name must start with a letter, hold only letters, digits or _, and end with >.'
          }
          if (named.has(name)) return `two groups are named ${name}. Rename one of them.`
          named.add(name)
          open = 3 + name.length + 1
        } else {
          // An inline flag group as other engines write it: `(?i)` at the front, say.
          const inline = /^([a-zA-Z]+)\)/.exec(rest)
          if (inline) {
            const token = `(?${inline[1]})`
            return inline[1] === 'i'
              ? `${token} belongs to other tools' patterns. Leave it out: patterns here already ignore case.`
              : `${token} belongs to other tools' patterns. Leave it out.`
          }
          const flags = /^([ims]*)(?:-([ims]*))?:/.exec(rest)
          const letters = flags ? `${flags[1]}${flags[2] ?? ''}` : ''
          if (!flags || !letters || new Set(letters).size !== letters.length) {
            return `${source.slice(i, i + 3)} does not start a group; a plain group is (?:...).`
          }
          open = 2 + flags[0].length
        }
      }
      groups.push({ behind })
      before = 'nothing'
      i += open
      continue
    }
    if (c === ')') {
      const group = groups.pop()
      if (!group) return 'a ) has no matching (. Remove it, or write \\) to match a bracket.'
      before = group.behind ? 'lookbehind' : 'atom'
      i += 1
      continue
    }
    if (c === '|' || c === '^' || c === '$') { before = 'nothing'; i += 1; continue }
    if (c === '*' || c === '+' || c === '?') {
      const problem = repeat(c)
      if (problem) return problem
      i += 1
      continue
    }
    if (c === '{') {
      const count = /^\{(\d+)(,(\d*))?\}/.exec(source.slice(i))
      if (count) {
        const problem = repeat(count[0])
        if (problem) return problem
        if (count[3] && Number(count[3]) < Number(count[1])) {
          return `in ${count[0]} the first number is bigger than the second. Write {${count[3]},${count[1]}}.`
        }
        i += count[0].length
        continue
      }
    }
    before = 'atom'
    i += 1
  }
  if (groups.length > 0) return 'a ( has no matching ). Close it, or write \\( to match a bracket.'
  if (named.size > 0) {
    const missing = refs.find((name) => !named.has(name))
    if (missing !== undefined) return `\\k<${missing}> names no group.`
    if (/\\k(?!<)/.test(source)) return 'with named groups, \\k must be followed by <name>.'
  }
  return cleaned(source, engineDetail)
}
