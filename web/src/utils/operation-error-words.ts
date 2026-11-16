/**
 * N25: an operation that failed because Walnut could not be reached says so in
 * words. The browser's own message ("Load failed" in WebKit, "Failed to fetch"
 * in Chromium, "NetworkError when attempting to fetch resource." in Firefox)
 * reached a phone as "Action failed: Load failed", usually right after the
 * phone woke or switched networks. Any other message passes through as it was.
 */
const NETWORK_MESSAGES = /^(load failed|failed to fetch|networkerror when attempting to fetch resource\.?|the network connection was lost\.?)$/i;

export const UNREACHABLE_OPERATION_MESSAGE = 'Walnut did not answer, so this change may not be saved. Check the connection and try again.';

/** True for the browser's own words for a request that never reached Walnut. */
export function isBrowserNetworkMessage(message: string): boolean {
  return NETWORK_MESSAGES.test(message.trim());
}

/** What a status READ says while Walnut does not answer (a restart, a crash): it is asked again
 *  on its own, so there is nothing to press (2026-11-11 review: "Recovery status unavailable /
 *  Load failed" while the server was down). */
export const UNREACHABLE_READ_MESSAGE = 'Walnut is not reachable right now. It keeps trying, and this updates by itself.';

/** A read's failure in words: the browser's network message becomes UNREACHABLE_READ_MESSAGE. */
export function readErrorWords(message: string): string {
  return isBrowserNetworkMessage(message) ? UNREACHABLE_READ_MESSAGE : message;
}

/** What an action the person took says when the server failed on its side (its raw words stay in the log). */
export const SERVER_FAULT_OPERATION_MESSAGE = 'Walnut hit a problem on its side, so this did not go through. Try again.';

export function operationErrorWords(message: string): string {
  if (NETWORK_MESSAGES.test(message.trim())) return UNREACHABLE_OPERATION_MESSAGE;
  return looksInternal(message.trim()) ? SERVER_FAULT_OPERATION_MESSAGE : message;
}

/**
 * Why a message the person sent did not go out, in words (the failed bubble's badge, beside
 * its Retry). The browser's network message and a server's raw internals (a JSON body, a
 * stack, a file lock's path) never reach the person as they are: they stay in the log.
 */
export function sendFailureWords(message: string | undefined): string {
  const text = (message ?? '').trim();
  if (!text) return 'Your message is kept: press Retry to send it again.';
  if (isBrowserNetworkMessage(text)) return 'Walnut did not answer. Your message is kept: press Retry to send it again.';
  if (looksInternal(text)) return 'Walnut hit a problem on its side. Your message is kept: press Retry to send it again.';
  return text;
}

/** A server's internals rather than a sentence for a person: a JSON body, a stack, a lock timeout, a bare status text. */
function looksInternal(text: string): boolean {
  return /^[{[]/.test(text) || /\n\s+at\s/.test(text) || /^File lock timeout\b/i.test(text)
    || /^(Internal Server Error|Bad Gateway|Service Unavailable|Gateway Timeout)$/i.test(text);
}
