/**
 * The kind of a warn or error line: its subsystem plus its message with the
 * parts that differ per occurrence (ids, numbers, paths, quoted values) folded
 * away, so "GET /api/sessions/<uuid>/supervision FAILED after 30ms" and the same
 * line for another session are one kind the health monitor can count.
 *
 * Pure. The key must stay stable across versions for a line whose wording did
 * not change, or every deploy would restart every baseline.
 */

const MAX_MESSAGE = 120

const FOLDS: Array<[RegExp, string | ((match: string) => string)]> = [
  // ids first, before their digits fold into numbers
  [/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '<id>'],
  [/\b(?:rq|qm|hx|tm|th|sn|wf)-[A-Za-z0-9_-]{4,}\b/g, '<id>'],
  // short task ids ("muudy83e-d669"); a digit must be in it, or "snapshot-pull" would fold
  [/\b(?=[a-z]*\d)[a-z0-9]{8}-[a-z0-9]{4}\b/g, '<id>'],
  [/\b[0-9a-f]{12,}\b/gi, '<hex>'],
  [/\d{4}-\d{2}-\d{2}T[\d:.]+Z?/g, '<time>'],
  // paths: anything with two or more slashes that is not an API route
  [/(?:~|\.{0,2})?\/(?:[\w.@+-]+\/){2,}[\w.@+-]*/g, (m) => (m.startsWith('/api/') ? m : '<path>')],
  [/"[^"]{1,200}"/g, '"…"'],
  [/'[^']{1,200}'/g, "'…'"],
  // every run of digits, also inside a word ("30ms", "v2"): a count or a size differs per line;
  // except an HTTP status ("→ 403"), which tells two kinds apart
  [/(?<!(?:→|status) ?)(?<![\d.])\d+(?:\.\d+)?/g, '#'],
]

/** Fold a message to its kind. */
export function foldMessage(message: string): string {
  let out = String(message ?? '').replace(/\s+/g, ' ').trim()
  for (const [re, to] of FOLDS) out = typeof to === 'string' ? out.replace(re, to) : out.replace(re, to)
  if (out.length > MAX_MESSAGE) out = out.slice(0, MAX_MESSAGE) + '…'
  return out
}

/** The signature key a line counts under. */
export function signatureKey(subsystem: string, message: string): string {
  return `${String(subsystem || '?').slice(0, 40)}: ${foldMessage(message)}`
}
