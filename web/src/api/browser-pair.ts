/**
 * Signing this browser in with a code (docs/plan/walnut-servers-everywhere.md,
 * "Signing in a browser").
 *
 * The person at the computer Walnut runs on makes a code (Settings > Phones &
 * Cloud). This browser trades it once at POST /api/v1/browser-pair for a device
 * token (an access token that renews itself, and the refresh cookie beside it),
 * stores it (device-token.ts), and reloads so every request and the WebSocket
 * start over with it. A link `<address>/#pair=<code>` does the same on
 * open: the code rides the fragment, which a browser never sends to a server, and
 * it leaves the address bar and is traded before the console mounts.
 *
 * Raw fetch on purpose: client.ts would attach a stale token and report the 401
 * this browser expects.
 */

import { getDeviceToken, setDeviceToken } from './device-token';
import { noteSignedIn } from './unpaired';
import { log } from '@/utils/log';

/** `unanswered`: no answer about the code came back (no response, or a server or tunnel error); `usedUp`: refused as wrong, used or expired. */
export type PairResult = { ok: true } | { ok: false; message: string; unanswered?: true; usedUp?: true };

export type FragmentPairState =
  | { phase: 'idle' }
  | { phase: 'pending'; code: string }
  | { phase: 'failed'; code: string; message: string };

const FRAGMENT = /^#pair=([0-9A-Za-z-]{4,20})$/;

export async function exchangeBrowserCode(code: string): Promise<PairResult> {
  let res: Response;
  try {
    // `secure=1`: an https page (a tunnel ends TLS before the server) gets a Secure refresh cookie.
    res = await fetch(window.location.protocol === 'https:' ? '/api/v1/browser-pair?secure=1' : '/api/v1/browser-pair', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // A Home Screen app says so: Settings names it "iPhone Home Screen", apart from a Safari tab (D6).
      body: JSON.stringify({ code, ...(isStandaloneDisplay() ? { standalone: true } : {}) }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    return { ok: false, unanswered: true, message: 'Walnut did not answer. Check the connection, then try again.' };
  }
  const body = await res.json().catch(() => null) as { token?: unknown; name?: unknown; accessUntil?: unknown; accessMs?: unknown; error?: { message?: unknown } } | null;
  const unanswered = res.status >= 500;
  // An answer about a code (this one or one typed after it): no kept code is traded again.
  if (!unanswered) keepPendingCode(null);
  if (res.ok && typeof body?.token === 'string') {
    // A sign-in that renews says when its token runs out (device-token.ts); an older server's never does.
    const renews = typeof body.accessUntil === 'number';
    setDeviceToken(body.token, renews
      ? { until: body.accessUntil as number, ...(typeof body.accessMs === 'number' ? { lifetimeMs: body.accessMs } : {}) }
      : { until: 'never' });
    // Signed in afresh: why the sign-in before it ended no longer applies.
    noteSignedIn();
    // The reload that follows shows "Opening Walnut..." under its logo (index.html).
    try { sessionStorage.setItem(OPENING_AFTER_SIGN_IN, '1'); } catch { /* storage refused: the logo alone */ }
    log.info('pairing', 'browser signed in with a code', { name: typeof body.name === 'string' ? body.name : undefined });
    return { ok: true };
  }
  const message = typeof body?.error?.message === 'string' ? body.error.message : `Walnut refused the code (${res.status}).`;
  log.warn('pairing', 'browser code refused', { status: res.status });
  // 400: the code itself is wrong, used or expired (src/web/routes/browser-pair.ts).
  return { ok: false, message, ...(unanswered ? { unanswered: true as const } : {}), ...(res.status === 400 ? { usedUp: true as const } : {}) };
}

function isStandaloneDisplay(): boolean {
  try {
    return window.matchMedia('(display-mode: standalone)').matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;
  } catch {
    return false;
  }
}

let fragmentState: FragmentPairState = { phase: 'idle' };
const listeners = new Set<() => void>();

function setFragmentState(next: FragmentPairState): void {
  fragmentState = next;
  for (const l of listeners) l();
}

/**
 * Called once, before anything else at boot (sign-in-gate.ts): take a `#pair=`
 * code out of the address bar and trade it. Resolves true when this browser now
 * holds a token; the gate then reloads, and the console never mounted without
 * it (2026-10-13: it used to mount beside the exchange, and every request it
 * made in that window came back 401). False on failure: UnpairedNotice shows
 * why, with the code filled in. Null when the address carries no code.
 */
export function consumePairFragment(): Promise<boolean> | null {
  const match = FRAGMENT.exec(window.location.hash);
  // A code taken out of the address whose trade got no answer yet (a slow network, a
  // reload mid sign-in): kept for this tab, so the reload trades it again instead of
  // landing on a sign-in screen with the link gone.
  const kept = match ? null : keptPendingCode();
  if (!match && !kept) return null;
  // Signed in meanwhile (another tab's code, a reload after it): the kept code would only
  // make a second sign-in for this browser, and hold its boot on a slow network.
  if (!match && getDeviceToken()) {
    keepPendingCode(null);
    return null;
  }
  const code = match ? match[1]! : kept!;
  if (match) {
    keepPendingCode(code);
    try {
      history.replaceState(history.state, '', `${window.location.pathname}${window.location.search}`);
    } catch {
      // A sandboxed frame may refuse; the code is one use either way.
    }
  }
  setFragmentState({ phase: 'pending', code });
  return exchangeBrowserCode(code).then((result) => {
    // A right code stays 'pending' (the sign-in screen keeps saying so) until
    // the gate's reload replaces the page.
    if (result.ok) return true;
    // No answer: kept (exchangeBrowserCode drops it on any answer), so a reload trades it
    // once more. Traded again after a reload and refused: most likely the first trade did reach
    // Walnut and its answer was lost, so the link is used up.
    const message = kept && result.usedUp ? KEPT_CODE_REFUSED : result.message;
    setFragmentState({ phase: 'failed', code, message });
    return false;
  });
}

/** Whether the gate is about to trade a code (main.tsx shows the pending sign-in screen meanwhile). */
export function hasPendingPairCode(): boolean {
  return FRAGMENT.test(window.location.hash) || (keptPendingCode() !== null && !getDeviceToken());
}

const PENDING_CODE_KEY = 'walnut.pendingPairCode';
/** Read once by index.html's boot splash. */
const OPENING_AFTER_SIGN_IN = 'walnut.openingAfterSignIn';
const PENDING_CODE_MS = 10 * 60_000;
export const KEPT_CODE_REFUSED = 'This link was already used, probably by this phone just before the page reloaded. Show a new link on your computer and open it here.';

function keptPendingCode(): string | null {
  try {
    const raw = sessionStorage.getItem(PENDING_CODE_KEY);
    if (!raw) return null;
    const kept = JSON.parse(raw) as { code?: unknown; at?: unknown };
    if (typeof kept.code === 'string' && typeof kept.at === 'number' && Date.now() - kept.at < PENDING_CODE_MS) return kept.code;
    sessionStorage.removeItem(PENDING_CODE_KEY);
  } catch { /* storage refused: the code lasts this page only */ }
  return null;
}

function keepPendingCode(code: string | null): void {
  try {
    if (code) sessionStorage.setItem(PENDING_CODE_KEY, JSON.stringify({ code, at: Date.now() }));
    else sessionStorage.removeItem(PENDING_CODE_KEY);
  } catch { /* storage refused */ }
}

export function getFragmentPairState(): FragmentPairState {
  return fragmentState;
}

export function subscribeFragmentPair(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
