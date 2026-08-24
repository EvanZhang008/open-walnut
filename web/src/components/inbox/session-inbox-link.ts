/**
 * Deep-linking INTO a session's Inbox tab: `/sessions?id=<sid>&tab=inbox&letter=<id>`.
 *
 * The two lenses on one letter store (the notification-center rail and the
 * session panel's Inbox tab) are one click apart, and this module is the whole
 * hop. A URL is the transport because it survives a paste, a reload and the
 * `/sessions` redirect shim.
 *
 * The arrival needs a MAILBOX rather than a plain event, for the same reason the
 * iOS push path does: the panel that must react does not exist yet when the link
 * is followed (opening the column is what mounts it), so an event fired now has
 * no listener. `armSessionInboxLink` both parks the request and fires the event,
 * and the panel consumes whichever arrives — already-mounted panels hear the
 * event, a freshly mounted one finds the parked request. Pure + injectable clock
 * so the routing rules are unit-testable.
 */

/** A parked request expires: a link followed ten minutes ago is not a request. */
export const SESSION_INBOX_LINK_TTL_MS = 60_000;

/** Fired for panels that are ALREADY mounted when the link is followed. */
export const SESSION_INBOX_LINK_EVENT = 'session:open-inbox';

export interface SessionInboxLink {
  sessionId: string;
  /** Absent = open the tab on its list. */
  letterId?: string;
  at: number;
}

let parked: SessionInboxLink | null = null;

/** The href a cross-session surface navigates to. */
export function sessionInboxLetterHref(sessionId: string, letterId?: string): string {
  const base = `/sessions?id=${encodeURIComponent(sessionId)}&tab=inbox`;
  return letterId ? `${base}&letter=${encodeURIComponent(letterId)}` : base;
}

/**
 * Read the tab/letter half of a session deep link. Returns null when the target
 * is not the Inbox tab, so a plain `/sessions?id=…` keeps behaving exactly as it
 * did (open the column, touch no view).
 */
export function parseSessionInboxTarget(
  search: string | URLSearchParams,
): { letterId?: string } | null {
  const params = typeof search === 'string'
    ? new URLSearchParams(search.startsWith('?') ? search.slice(1) : search)
    : search;
  if ((params.get('tab') ?? '').toLowerCase() !== 'inbox') return null;
  const letterId = (params.get('letter') ?? '').trim();
  return letterId ? { letterId } : {};
}

/** Park a request for the target session and notify any live panel. */
export function armSessionInboxLink(
  sessionId: string,
  letterId?: string,
  now: number = Date.now(),
): void {
  parked = { sessionId, ...(letterId ? { letterId } : {}), at: now };
  window.dispatchEvent(new CustomEvent(SESSION_INBOX_LINK_EVENT, {
    detail: { sessionId, ...(letterId ? { letterId } : {}) },
  }));
}

/**
 * Claim a parked request, if it is for this session and still fresh. Claiming
 * CLEARS it: two panels for the same session must not both pop the letter, and a
 * remount minutes later must not resurrect it.
 */
export function consumeSessionInboxLink(
  sessionId: string,
  now: number = Date.now(),
): { letterId?: string } | null {
  const link = parked;
  if (!link || link.sessionId !== sessionId) return null;
  parked = null;
  // A negative delta means the clock moved backwards; treat it as fresh rather
  // than swallowing a request the user just made.
  if (now - link.at > SESSION_INBOX_LINK_TTL_MS) return null;
  return link.letterId ? { letterId: link.letterId } : {};
}

/** Tests only: drop any parked request. */
export function clearSessionInboxLink(): void {
  parked = null;
}

/**
 * How long after a deep link opens a view the panel will re-assert fullscreen
 * ONCE. Long enough for a router commit, far too short to swallow a real Escape.
 */
export const DEEP_LINK_SETTLE_MS = 2_500;

/**
 * How close to a pathname change a fullscreen exit must be to be BLAMED on that
 * change. The exit and the change happen in one commit chain, so this is slack for
 * a busy scheduler, not a behaviour window.
 */
export const ROUTE_EXIT_WINDOW_MS = 1_200;

/** The one route the session columns live on (App.tsx keeps MainPage mounted). */
export const SESSION_SURFACE_PATH = '/';

export interface DeepLinkFullscreenInput {
  /** The claim the panel is holding for a deep link (null = none). */
  claim: { sid: string; at: number } | null;
  sessionId: string;
  /** The claim key this panel has ALREADY re-asserted once ('' = none). */
  settledKey: string;
  /** When the pathname last CHANGED; 0 = not since mount. */
  routeChangedAt: number;
  /** The pathname now. */
  path: string;
  now: number;
}

/**
 * "Fullscreen just dropped while a deep-linked view is open — put it back?"
 *
 * Returns the claim key to record when the answer is yes, else null. Pure and
 * exported because getting it wrong is expensive in BOTH directions, and it has
 * been wrong in both:
 *  - too strict (no re-assert): a link followed from another route opens the view
 *    and loses it a frame later, because React Router's `useLocation()` reports
 *    the OLD pathname when the column opens and the catching-up pathname change is
 *    useFullscreen's "you navigated away" exit;
 *  - too loose (re-assert on any exit in the window): useFullscreen's backdrop is
 *    portalled to document.body, so re-entering fullscreen after a REAL navigation
 *    strands a fixed, blurred, click-blocking sheet over the page the user just
 *    opened, with the panel it belongs to hidden (the 2026-08-09 incident).
 *
 * So all four must hold: the exit coincides with a route change, we landed ON the
 * session surface, the claim is this session's and still young, and it has not
 * been re-asserted yet — the router settles once, so a second exit is the user.
 */
export function deepLinkFullscreenReassert(input: DeepLinkFullscreenInput): string | null {
  const { claim, sessionId, settledKey, routeChangedAt, path, now } = input;
  if (!claim || claim.sid !== sessionId) return null;
  if (path !== SESSION_SURFACE_PATH) return null;
  if (routeChangedAt <= 0 || now - routeChangedAt >= ROUTE_EXIT_WINDOW_MS) return null;
  if (now - claim.at >= DEEP_LINK_SETTLE_MS) return null;
  const key = `${claim.sid}:${claim.at}`;
  return settledKey === key ? null : key;
}
