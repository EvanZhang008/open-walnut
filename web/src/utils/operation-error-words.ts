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

export function operationErrorWords(message: string): string {
  return NETWORK_MESSAGES.test(message.trim()) ? UNREACHABLE_OPERATION_MESSAGE : message;
}
