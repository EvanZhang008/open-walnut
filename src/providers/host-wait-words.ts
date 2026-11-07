/**
 * The words a person reads about a message waiting for its session's host: one that did not
 * answer in time, or one nothing reaches now. A leaf module (no runtime imports), so the
 * runner, the queue route and the tests share one source of these sentences.
 */

/**
 * What a message waiting on a host that did not answer in time says (the bubble's
 * note, the session's error line). Plain words: the message is kept and goes out by
 * itself; the bubble adds when the next try is and a Send now.
 */
export function slowHostReason(why: 'start' | 'send' | 'link', host?: string | null): string {
  if (why === 'link') return hostLinkReason(host)
  return why === 'start'
    ? 'Not sent yet: the computer running this session did not start it in time (it may be very busy). Your message is kept and Walnut tries again by itself.'
    // The line may already be in the CLI: the next try asks the host first, never sends it twice.
    : 'Not confirmed yet: the computer running this session did not say in time whether it got your message (it may be very busy). Your message is kept and Walnut asks again by itself.'
}

/** How a message waiting for a host whose link is down begins (hostLinkReason). */
export const HOST_LINK_REASON_PREFIX = 'Not sent yet: Walnut cannot reach '

/**
 * What a message to a session whose host nothing reaches now says (2026-11-06: a host's
 * sign-in expired, and a person's messages to its tasks read "Send failed: Not sent yet:
 * waiting for the connection to the session host" with no host and no word on when).
 * It names the host; the bubble adds the next try and Send now.
 */
export function hostLinkReason(hostName: string | null | undefined): string {
  const name = !hostName || hostName === '__local__' ? 'the session service on this computer' : hostName
  return `${HOST_LINK_REASON_PREFIX}${name} right now (the connection to it is down). Your message is kept and goes out by itself as soon as the connection is back.`
}

/** A held row's reason that Walnut sends again by itself (a slow host, or a host whose link is down). */
export function isHostWaitReason(reason: string | undefined): boolean {
  return !!reason && (reason === slowHostReason('start') || reason === slowHostReason('send') || reason.startsWith(HOST_LINK_REASON_PREFIX))
}
