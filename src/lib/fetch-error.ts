/**
 * What a failed fetch() says, read the same way on Node and on bun.
 *
 * Node (undici) rejects with TypeError "fetch failed" and puts the socket or
 * TLS error on `cause` ({ code: 'ECONNREFUSED', message: 'connect ECONNREFUSED
 * 127.0.0.1:9' }). Bun rejects with the code on the error itself and no cause
 * (TypeError { code: 'ECONNREFUSED', message: 'ECONNREFUSED: Unable to connect.
 * Is the computer able to access the url?' }). A timeout or an abort is a
 * DOMException on both (name TimeoutError or AbortError) whose numeric `code`
 * is not a socket code, and whose message differs between the two.
 */

/** Bun's trailing hint on a socket error, which says nothing to a person. */
const BUN_VERBOSE_HINT = /\s*For more information, pass `verbose: true` in the second argument to fetch\(\)\.?\s*$/

/** The socket or TLS error code (ECONNREFUSED, ECONNRESET, UND_ERR_SOCKET, DEPTH_ZERO_SELF_SIGNED_CERT, ...), or '' for none. */
export function fetchErrorCode(err: unknown): string {
  let cur: unknown = err
  for (let depth = 0; cur && typeof cur === 'object' && depth < 4; depth++) {
    const code = (cur as { code?: unknown }).code
    if (typeof code === 'string' && code) return code
    cur = (cur as { cause?: unknown }).cause
  }
  return ''
}

/** A timeout or an abort (AbortSignal.timeout, AbortController.abort), not a network failure. */
export function isFetchAbort(err: unknown): boolean {
  const name = (err as { name?: unknown } | null)?.name
  return name === 'TimeoutError' || name === 'AbortError'
}

/** The socket error's own words: Node's cause message, else the error's message (bun's, which already names the code). */
export function fetchErrorDetail(err: unknown): string {
  const cause = (err as { cause?: { message?: unknown } } | null)?.cause
  if (cause && typeof cause === 'object' && typeof cause.message === 'string' && cause.message) return cause.message.replace(BUN_VERBOSE_HINT, '')
  if (err instanceof Error) return err.message.replace(BUN_VERBOSE_HINT, '')
  return String(err)
}

/**
 * The failure in one line for a log or a status, with the code it hides:
 * Node's "fetch failed (ECONNRESET)", bun's "ECONNRESET: The socket connection
 * was closed unexpectedly" (its message already names the code).
 */
export function fetchErrorText(err: unknown): string {
  if (!(err instanceof Error)) return String(err)
  const message = err.message.replace(BUN_VERBOSE_HINT, '')
  const cause = (err as Error & { cause?: { code?: unknown; message?: unknown } }).cause
  let detail = ''
  if (cause && typeof cause === 'object') detail = typeof cause.code === 'string' ? cause.code : typeof cause.message === 'string' ? cause.message : ''
  else detail = fetchErrorCode(err)
  return detail && !message.includes(detail) ? `${message} (${detail})` : message
}
