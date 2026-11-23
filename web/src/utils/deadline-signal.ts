/**
 * A signal that aborts after `ms`, with a TimeoutError reason as AbortSignal.timeout gives.
 *
 * Every deadline in the page is this one, never AbortSignal.timeout (2026-11-22, live in the Mac
 * app's WKWebView: AbortSignal.timeout fired far later than a plain timer. A read with a 15 s
 * deadline held its connection 111 s while the 20 s queue timers of the reads behind it fired on
 * time and rejected them; a 2 s one ended after 44 s, an 8 s one after 43 s). A request's own
 * deadline and the connection queue's must run on the same clock, or the queue gives up on
 * requests before the one holding the connection does.
 */
export function deadlineSignal(ms: number): AbortSignal {
  const ctrl = new AbortController();
  setTimeout(() => ctrl.abort(new DOMException('The operation timed out.', 'TimeoutError')), ms);
  return ctrl.signal;
}
