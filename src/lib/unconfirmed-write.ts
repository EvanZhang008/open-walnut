/**
 * Error codes a write is answered with when it may still apply on its own: the same call must be
 * answered again, never run again. A 5xx otherwise means "a retry may change it" (op-calls.ts,
 * middleware/op-id.ts), and a rerun of the call would apply it twice.
 *
 * - delivery_unconfirmed: a message's store into a session queue was still under way past its
 *   bound (lib/send-deadline.ts); the row may land, and a rerun would store a second one.
 */
export const UNCONFIRMED_WRITE_CODES: ReadonlySet<string> = new Set(['delivery_unconfirmed'])

/** The answer of a write that may still apply: settled, answered again to a copy, never rerun. */
export function unconfirmedWrite(code: unknown): boolean {
  return typeof code === 'string' && UNCONFIRMED_WRITE_CODES.has(code)
}

/** The error code of an API answer's JSON body ({ error: { code } } or { error, code }), if any. */
export function answerErrorCode(body: unknown): string | undefined {
  if (!body || typeof body !== 'object') return undefined
  const b = body as { error?: unknown; code?: unknown }
  if (b.error && typeof b.error === 'object' && typeof (b.error as { code?: unknown }).code === 'string') return (b.error as { code: string }).code
  return typeof b.code === 'string' ? b.code : undefined
}
