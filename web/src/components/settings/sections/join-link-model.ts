/**
 * Settings > Remote Hosts, Add host > Join with a link: what a link that could not be made offers
 * (2026-11-04 review: "The host network is not running on this Mac" offered only Try again, which
 * failed the same way), and what a closed link that still works says. Pure, so vitest reads it.
 */

/** A link that could not be made: the server's sentence and its code (none from an older server). */
export interface JoinFailure { text: string; code: string | null }

/**
 * The one way forward for a failure:
 *   start       the host network did not start: start it (then the link is made)
 *   pair        no cloud companion where one is needed: Phones & Cloud pairs one
 *   companion   the companion is too old: Phones & Cloud updates it
 *   show-open   too many links open, and one of them is ours: show it
 *   none        nothing here can fix it (a test server)
 *   retry       try again (a timeout, a restart that updates Walnut, anything else)
 */
export type JoinFix = 'start' | 'pair' | 'companion' | 'show-open' | 'none' | 'retry';

// A host network still starting, or a link walnut-net did not take, is Try again: it runs, so
// starting it again would only repeat the call that failed (review).
const START = new Set(['net_unavailable', 'net_start_failed', 'no_identity']);

export function joinFix(code: string | null, liveLink: boolean): JoinFix {
  if (code && START.has(code)) return 'start';
  if (code === 'no_companion') return 'pair';
  if (code === 'companion_too_old') return 'companion';
  if (code === 'test_server') return 'none';
  if (code === 'too_many_invites' && liveLink) return 'show-open';
  return 'retry';
}

/** "9 min" left of a link (rounded up, so a link with 20 s left still reads 1 min). */
export function minutesLeft(ms: number): string {
  return `${Math.max(1, Math.ceil(ms / 60_000))} min`;
}

/** A link that is closed but still waiting for its machine: where it stands, in one line. */
export function closedLinkNote(expiresAt: number, now: number): string {
  return `Link still works for ${minutesLeft(expiresAt - now)}.`;
}
