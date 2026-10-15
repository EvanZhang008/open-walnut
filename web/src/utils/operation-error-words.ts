/**
 * N25: an operation that failed because Walnut could not be reached says so in
 * words. The browser's own message ("Load failed" in WebKit, "Failed to fetch"
 * in Chromium, "NetworkError when attempting to fetch resource." in Firefox)
 * reached a phone as "Action failed: Load failed", usually right after the
 * phone woke or switched networks. Any other message passes through as it was.
 */
const NETWORK_MESSAGES = /^(load failed|failed to fetch|networkerror when attempting to fetch resource\.?|the network connection was lost\.?)$/i;

export const UNREACHABLE_OPERATION_MESSAGE = 'Walnut did not answer, so this change may not be saved. Check the connection and try again.';

export function operationErrorWords(message: string): string {
  return NETWORK_MESSAGES.test(message.trim()) ? UNREACHABLE_OPERATION_MESSAGE : message;
}
