/**
 * `subject: { re }` runs synchronously on the event loop (ingest, recompute, live preview), so a
 * catastrophically backtracking pattern would freeze every route. Two refusals keep it bounded:
 * no quantifier on a group that already repeats or alternates (`(a+)+`, `(a*)*`, `(a|a)+`), and no
 * back-references. Matching only ever sees the first 300 characters of a subject.
 */

export const MAX_PATTERN_LENGTH = 200
export const SUBJECT_MATCH_CHARS = 300

export const PATTERN_TOO_SLOW = 'This pattern could take too long to run. Remove the repeated group.'
export const PATTERN_TOO_LONG = `This pattern is too long. Keep it under ${MAX_PATTERN_LENGTH} characters.`

interface Frame {
  repeats: boolean
  alternates: boolean
}

/** Is the text at `index` a quantifier (`*`, `+`, `?`, `{n}`, `{n,}`, `{n,m}`)? */
function quantifierAt(pattern: string, index: number): boolean {
  const char = pattern[index]
  if (char === '*' || char === '+' || char === '?') return true
  return char === '{' && /^\{\d+(,\d*)?\}/.test(pattern.slice(index))
}

/** The refusal sentence for an unsafe pattern, or null when it is safe to compile. */
export function unsafePatternReason(pattern: string): string | null {
  if (pattern.length > MAX_PATTERN_LENGTH) return PATTERN_TOO_LONG
  const stack: Frame[] = [{ repeats: false, alternates: false }]
  let inClass = false
  for (let i = 0; i < pattern.length; i += 1) {
    const char = pattern[i]!
    if (char === '\\') {
      const next = pattern[i + 1] ?? ''
      if (!inClass && (/[1-9]/.test(next) || next === 'k')) return PATTERN_TOO_SLOW
      i += 1
      if (!inClass && quantifierAt(pattern, i + 1)) stack[stack.length - 1]!.repeats = true
      continue
    }
    if (inClass) {
      if (char === ']') {
        inClass = false
        if (quantifierAt(pattern, i + 1)) stack[stack.length - 1]!.repeats = true
      }
      continue
    }
    if (char === '[') { inClass = true; continue }
    if (char === '(') { stack.push({ repeats: false, alternates: false }); continue }
    if (char === '|') { stack[stack.length - 1]!.alternates = true; continue }
    if (char === ')') {
      const frame = stack.length > 1 ? stack.pop()! : { repeats: false, alternates: false }
      const quantified = quantifierAt(pattern, i + 1)
      if (quantified && (frame.repeats || frame.alternates)) return PATTERN_TOO_SLOW
      const parent = stack[stack.length - 1]!
      if (frame.repeats || quantified) parent.repeats = true
      continue
    }
    // A `?` straight after `(` is a group modifier (`(?:`, `(?=`, `(?<name>`), not a quantifier.
    if (quantifierAt(pattern, i) && pattern[i - 1] !== '(') stack[stack.length - 1]!.repeats = true
  }
  return null
}

/** A compiled, safe, case-insensitive matcher, or the sentence explaining why not. */
export function compileSubjectPattern(pattern: string): { ok: true; test: (subject: string) => boolean } | { ok: false; message: string } {
  const unsafe = unsafePatternReason(pattern)
  if (unsafe) return { ok: false, message: unsafe }
  let regex: RegExp
  try {
    regex = new RegExp(pattern, 'i')
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    return { ok: false, message: `This pattern is not a valid regular expression: ${detail}` }
  }
  return { ok: true, test: (subject) => regex.test(subject.slice(0, SUBJECT_MATCH_CHARS)) }
}
