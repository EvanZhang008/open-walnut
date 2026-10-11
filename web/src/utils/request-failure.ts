/**
 * A request the browser gave up on, in plain words. The browser's own text is
 * "signal timed out" (Chromium) or "Fetch is aborted" (WebKit), which says
 * nothing to a person reading Settings. A request whose deadline fired is a
 * TimeoutError, or an AbortError in WebKit: both read as the deadline it had.
 * Anything else is the server's answer (an ApiError carries its sentence) and
 * is left to the caller.
 */
export function browserGaveUp(err: unknown): boolean {
  const name = (err as { name?: unknown } | null)?.name
  return name === 'TimeoutError' || name === 'AbortError'
}

/**
 * Did `signal` end because a deadline fired? An AbortSignal.timeout aborts with
 * a TimeoutError reason in every engine, and AbortSignal.any keeps the reason of
 * the signal that fired first, so a caller's own cancel (an AbortError reason)
 * is never read as a deadline.
 */
export function deadlineFired(signal: AbortSignal | null | undefined): boolean {
  return !!signal?.aborted && (signal.reason as { name?: unknown } | undefined)?.name === 'TimeoutError'
}

/**
 * `err` from a fetch made with `signal`, named for what ended it. Chromium
 * rejects a fetch whose deadline fired with a TimeoutError; WebKit (the Mac app)
 * rejects it with an AbortError, "Fetch is aborted", which every
 * `name === 'TimeoutError'` check then missed and the raw words reached the
 * user. A deadline is a TimeoutError here in both; anything else is unchanged.
 */
export function asDeadlineError(err: unknown, signal: AbortSignal | null | undefined): unknown {
  if ((err as { name?: unknown } | null)?.name !== 'AbortError' || !deadlineFired(signal)) return err
  return new DOMException('The operation timed out.', 'TimeoutError')
}

/** The sentence for a request this browser stopped waiting on after `timeoutMs`. */
export function gaveUpSentence(timeoutMs: number): string {
  return `Walnut did not answer in ${Math.round(timeoutMs / 1000)}s.`
}

/** `err` as a row or a notice says it: the server's words, or the deadline in plain words. */
export function requestFailureText(err: unknown, timeoutMs: number): string {
  if (browserGaveUp(err)) return gaveUpSentence(timeoutMs)
  if (err instanceof Error && err.message) return err.message
  return typeof err === 'string' && err ? err : 'Unknown error'
}
