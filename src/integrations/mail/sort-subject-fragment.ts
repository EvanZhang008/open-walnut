/**
 * The "key fragment" of a subject, for the `sender-subject` draft (spec 6.4): the words that stay the
 * same from one mail of a series to the next.
 *
 * Rules, in order:
 * 1. Strip reply and forward prefixes (`Re:`, `RE:`, `Fwd:`, `FW:`, repeated).
 * 2. A subject that starts with a bracketed tag (`[Action Required] ...`) answers the tag's text.
 * 3. Otherwise drop every token that carries a digit (numbers, dates, ticket ids) and split at
 *    punctuation that separates phrases; the longest remaining run of 2 to 5 words wins (the first
 *    five words of a longer run). A subject with no such run has no fragment.
 *
 * The answer is always a verbatim slice of the subject, so the rule's case-insensitive "contains"
 * test matches the mail it was drafted from.
 */

const PREFIX = /^\s*(?:re|fwd?|fw|aw|wg)\s*(?:\[\d+\])?\s*:\s*/i
const TAG = /^\s*\[([^\]]{2,60})\]/
/** Characters that end a phrase: a run never crosses them. */
const SEPARATOR = /[,;:|()!?]|\s-\s|\s\/\s/
const MAX_WORDS = 5
const MIN_WORDS = 2

export function stripReplyPrefixes(subject: string): string {
  let out = subject
  for (let i = 0; i < 10; i += 1) {
    const next = out.replace(PREFIX, '')
    if (next === out) break
    out = next
  }
  return out
}

interface Token { text: string; start: number; end: number; noise: boolean }

function tokensOf(text: string, offset: number): Token[] {
  const out: Token[] = []
  const word = /\S+/g
  for (let match = word.exec(text); match; match = word.exec(text)) {
    const raw = match[0]
    // Trailing sentence punctuation is not part of the word ("approval." is "approval").
    const trimmed = raw.replace(/[.'"]+$/, '')
    const start = offset + match.index
    out.push({ text: trimmed, start, end: start + trimmed.length, noise: /\d/.test(raw) || !/[\p{L}]/u.test(raw) })
  }
  return out
}

/** The key fragment, or `undefined` when the subject has none. */
export function subjectFragment(subject: string | undefined | null): string | undefined {
  if (!subject) return undefined
  const stripped = stripReplyPrefixes(subject)
  const tag = TAG.exec(stripped)
  if (tag) {
    const inside = tag[1]!.trim().replace(/\s+/g, ' ')
    if (/[\p{L}]{2}/u.test(inside) && subject.includes(tag[1]!.trim())) return tag[1]!.trim()
  }
  const base = subject.length - stripped.length
  let best: Token[] = []
  let bestLength = 0
  let cursor = 0
  // Phrases: the text between separators, with its offset kept so the slice stays verbatim.
  for (const phrase of stripped.split(SEPARATOR)) {
    const at = stripped.indexOf(phrase, cursor)
    cursor = at + phrase.length
    let run: Token[] = []
    const flush = () => {
      if (run.length > bestLength) { best = run.slice(0, MAX_WORDS); bestLength = run.length }
      run = []
    }
    for (const token of tokensOf(phrase, base + at)) {
      if (token.noise) flush()
      else run.push(token)
    }
    flush()
  }
  if (best.length < MIN_WORDS) return undefined
  return subject.slice(best[0]!.start, best[best.length - 1]!.end)
}
