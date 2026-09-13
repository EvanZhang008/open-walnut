/**
 * Boundary-safe cuts for text that leaves the box.
 *
 * Every excerpt this codebase ships is made with `slice(0, N)` on a JS string, and
 * N is a UTF-16 CODE UNIT index. An astral character (any emoji, many CJK extension
 * characters) occupies TWO of those units, so a cut can land between the halves of
 * one and leave the string ending in a lone surrogate. That is not cosmetic:
 * `JSON.stringify` renders a lone surrogate as a `\udXXX` escape, a strict decoder
 * (Swift's `JSONDecoder`) rejects the WHOLE response, and the phone then draws an
 * empty conversation with no error to explain it. One emoji sitting on a cap poisons
 * a page of a hundred rows.
 *
 * The counting unit deliberately does NOT change: the API contract counts in UTF-16
 * code units and clients compare in the same unit. Only the POSITION moves, by at
 * most one unit, so the delivered text stays a valid prefix (or suffix) of the source.
 */

// The two halves of a surrogate pair, as UTF-16 code units.
const HIGH_FIRST = 0xd800
const HIGH_LAST = 0xdbff
const LOW_FIRST = 0xdc00
const LOW_LAST = 0xdfff

const clamp = (text: string, index: number): number =>
  Math.min(Math.max(0, Math.trunc(index)), text.length)

/**
 * Does a cut at `index` fall BETWEEN the two halves of one character?
 *
 * Only that case is a defect. A lone surrogate already present in the source (broken
 * data) stays exactly as it was: this fixes cuts, it does not launder input.
 */
function splitsPair(text: string, index: number): boolean {
  if (index <= 0 || index >= text.length) return false
  const prev = text.charCodeAt(index - 1)
  if (prev < HIGH_FIRST || prev > HIGH_LAST) return false
  const at = text.charCodeAt(index)
  return at >= LOW_FIRST && at <= LOW_LAST
}

/**
 * The nearest code-point boundary AT OR BEFORE `index` — the end of a cut, i.e.
 * `text.slice(0, cutEnd(text, max))`.
 *
 * Moving backwards drops the split character rather than half of it, which keeps the
 * result a valid prefix of the source and keeps it inside the cap (a client that
 * budgeted `max` never gets `max + 1`).
 */
export function cutEnd(text: string, index: number): number {
  const i = clamp(text, index)
  return splitsPair(text, i) ? i - 1 : i
}

/**
 * The nearest code-point boundary AT OR AFTER `index` — the start of a cut, i.e. a
 * paging `offset` a client supplied.
 *
 * Moving forwards is what makes a cursor chase monotonic: a page's own end offset is
 * already a boundary ({@link cutEnd}), so a client that follows `nextOffset` is never
 * adjusted at all. Only a client that invents an offset mid-character is, and it
 * loses that one character instead of receiving a lone low surrogate.
 */
export function cutStart(text: string, index: number): number {
  const i = clamp(text, index)
  return splitsPair(text, i) ? i + 1 : i
}
