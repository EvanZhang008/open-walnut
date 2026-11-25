/**
 * A route whose answer must never be kept for a resend or an `op_result` read (src/ops/op-calls.ts):
 * it carries text the person released for a window the route checks on every call (a locked note's
 * text, docs/reference/locked-notes.md). The route says so on its answer with this header, and every
 * op call that reached it keeps nothing: a named op, `api`, a handler's self-call, an op run inside
 * another op's handler. Decided by the route the call reached, never by the op, so no op (and no
 * future one) can forget it.
 *
 * Zero imports: the executor and the routes both load this.
 */

export const ANSWER_NOT_KEPT_HEADER = 'x-walnut-answer-not-kept'

/** Mark this answer never kept, with why in plain words (the header's value, shown as op_result's `not_kept`). */
export function markAnswerNotKept(res: { setHeader(name: string, value: string): unknown }, why: string): void {
  res.setHeader(ANSWER_NOT_KEPT_HEADER, why)
}

/** Why a fetched answer says it is never kept, or undefined when it does not say so. */
export function answerNotKeptOf(headers: { get(name: string): string | null }): string | undefined {
  const raw = headers.get(ANSWER_NOT_KEPT_HEADER)
  if (raw === null) return undefined
  // Any value counts (a mangled one too): it only keeps less.
  const why = raw.replace(/[^\x20-\x7e]/g, '').trim().slice(0, 200)
  return `its route never lets its answer be kept${why ? ` (${why})` : ''}`
}
