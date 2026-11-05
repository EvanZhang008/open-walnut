/**
 * Device-token storage, and the renewing sign-in of a browser.
 *
 * On the machine Walnut runs on no token is needed, none exists, and every
 * helper here is a no-op. A browser anywhere else (a phone signed in with a
 * code, a cloud instance, another device on the LAN) holds a token in
 * localStorage, and then:
 *   - HTTP: client.ts attaches `Authorization: Bearer <token>`, and so does
 *           every other same-origin `/api/` fetch (auth-fetch.ts)
 *   - WS:   ws.ts offers the token as a `walnut.bearer.<base64url>`
 *           subprotocol beside `walnut.v1` (the browser WebSocket API cannot set
 *           an Authorization header, and a `?token=` URL would land in every
 *           tunnel's and proxy's access log; src/lib/ws-bearer-protocol.ts)
 *   - media: an `<img src="/api/...">`, an HTML preview frame or a download
 *           cannot carry a header either, so the token is mirrored into the
 *           `walnut_device` cookie, which the server accepts for GET and HEAD
 *           only (src/web/middleware/auth.ts). SameSite=Strict, so no other
 *           site's page can make this browser send it.
 *
 * A browser signed in with a code renews its sign-in (src/core/browser-sign-in.ts):
 * the token here is an access token that lasts hours (`walnut.deviceTokenUntil`),
 * and the server keeps a refresh token in an HttpOnly cookie sent only to POST
 * /api/auth/browser/refresh. Before the access token runs out the page trades the
 * cookie for a new pair (renewSignIn, startSignInRenewal); a request refused as
 * `token_expired` renews and goes again (client.ts, auth-fetch.ts). Safari's
 * 7-day rules (2026-11-04, the user: "if cookie is cleared need another code")
 * remove this page's storage and the script's cookie, never a cookie the server
 * set: a page that finds no token renews from the cookie before it shows the
 * sign-in screen (sign-in-gate.ts). A browser signed in before renewing existed
 * holds a token with no time: its first renewal sends it and starts the pair, so
 * it never needs a new code. One that does not renew (an older server, a token
 * the server never renews) keeps working as before.
 */

import { getSignedOutReason, getUnpairedState, noteAuthRefusal, noteSignedIn, subscribeUnpaired } from './unpaired';

export const STORAGE_KEY = 'walnut.deviceToken';
/** Epoch ms the access token runs out at; 'never' = the server said it does not renew. Absent: not known yet. */
const UNTIL_KEY = 'walnut.deviceTokenUntil';
/** The access token's lifetime, ms (renewal starts once a quarter of it is left). */
const LIFETIME_KEY = 'walnut.deviceTokenLifetime';
export const DEVICE_COOKIE = 'walnut_device';

/** The token while storage refuses it (a private window): this page keeps it until reload. */
let heldToken: string | null = null;
let heldUntil: string | null = null;
let heldLifetime: string | null = null;

function read(key: string, held: string | null): string | null {
  try {
    return localStorage.getItem(key) ?? held;
  } catch {
    return held;
  }
}

export function getDeviceToken(): string | null {
  return read(STORAGE_KEY, heldToken);
}

/** When the token runs out (epoch ms), 'never', or null when not known (a token from before renewing). */
export function getDeviceTokenUntil(): number | 'never' | null {
  const raw = read(UNTIL_KEY, heldUntil);
  if (raw === 'never') return 'never';
  const n = raw === null ? NaN : Number(raw);
  return Number.isFinite(n) ? n : null;
}

/** What renewal knows about the token, beside it: when it runs out and how long it lasts. */
export interface TokenTerms {
  /** Epoch ms, or 'never' (the server does not renew this one). */
  until?: number | 'never';
  lifetimeMs?: number;
}

/** Store the token; true when storage kept it (a reload still has it). */
export function setDeviceToken(token: string, terms: TokenTerms = {}): boolean {
  const until = terms.until === undefined ? null : String(terms.until);
  const lifetime = terms.lifetimeMs === undefined ? null : String(terms.lifetimeMs);
  let kept = false;
  try {
    localStorage.setItem(STORAGE_KEY, token);
    if (until === null) localStorage.removeItem(UNTIL_KEY); else localStorage.setItem(UNTIL_KEY, until);
    if (lifetime === null) localStorage.removeItem(LIFETIME_KEY); else localStorage.setItem(LIFETIME_KEY, lifetime);
    kept = localStorage.getItem(STORAGE_KEY) === token;
  } catch {
    // Storage unavailable (private mode) — session works until reload.
  }
  heldToken = kept ? null : token;
  heldUntil = kept ? null : until;
  heldLifetime = kept ? null : lifetime;
  writeDeviceCookie(token);
  return kept;
}

/** Record that the server does not renew the token held now (asked once, not at every open). */
function markNeverRenews(token: string): void {
  if (getDeviceToken() !== token) return;
  try { localStorage.setItem(UNTIL_KEY, 'never'); } catch { /* the next open asks again */ }
  if (heldToken === token) heldUntil = 'never';
}

export function clearDeviceToken(): void {
  heldToken = null;
  heldUntil = null;
  heldLifetime = null;
  try {
    localStorage.removeItem(STORAGE_KEY);
    localStorage.removeItem(UNTIL_KEY);
    localStorage.removeItem(LIFETIME_KEY);
  } catch {
    // ignore
  }
  writeDeviceCookie(null);
}

/** The cookie line for a token (null = expire it). Pure, for tests. */
export function deviceCookieLine(token: string | null, secure: boolean): string {
  const attrs = `Path=/api; SameSite=Strict${secure ? '; Secure' : ''}`;
  return token
    ? `${DEVICE_COOKIE}=${encodeURIComponent(token)}; ${attrs}; Max-Age=34560000`
    : `${DEVICE_COOKIE}=; ${attrs}; Max-Age=0`;
}

function writeDeviceCookie(token: string | null): void {
  try {
    document.cookie = deviceCookieLine(token, window.location.protocol === 'https:');
  } catch {
    // A sandboxed document may refuse cookies; headers still work.
  }
}

/** Called once at boot: re-write the media cookie from storage (a sign-in from before it existed gets it now). */
export function syncDeviceCookie(): void {
  const token = getDeviceToken();
  if (token) writeDeviceCookie(token);
}

// ── Renewing ────────────────────────────────────────────────────────────────

/** The server's renewal route (src/web/routes/browser-sign-in.ts). */
export const REFRESH_URL = '/api/auth/browser/refresh';
/** The codes of that route's own refusals: anything else is not this route speaking (an older server, a companion). */
const SIGNED_OUT_CODES = new Set(['refresh_refused', 'refresh_reused', 'refresh_expired', 'refresh_missing', 'device_removed']);
const DEFAULT_LIFETIME_MS = 20 * 60 * 60 * 1000;
/** Renew this long before the token runs out, at most (a quarter of its lifetime when shorter). */
const RENEW_AHEAD_MAX_MS = 5 * 60 * 60 * 1000;

function refreshUrl(): string {
  return window.location.protocol === 'https:' ? `${REFRESH_URL}?secure=1` : REFRESH_URL;
}

export type RenewResult =
  /** A new pair, stored (a reload has it). */
  | { kind: 'renewed' }
  /** A new pair, but storage refused it (a private window): this page holds it until reload. */
  | { kind: 'held' }
  /** The route's own 401: this browser is signed out (cookie unknown, replayed, or a year unused). */
  | { kind: 'refused'; body: unknown }
  /** Nothing to renew here: no cookie and no token that renews, an older server, a server that is not the Mac. */
  | { kind: 'unknown' }
  /** No answer, a rate limit or a server error (the Mac away behind a host): keep the token, ask later. */
  | { kind: 'no-answer' };

/** When renewal is due for the token held now (epoch ms), or null when it never is. */
export function renewalDueAt(): number | null {
  if (!getDeviceToken()) return null;
  const until = getDeviceTokenUntil();
  if (until === 'never') return null;
  // A token from before renewing: due now, which starts its pair.
  if (until === null) return 0;
  const lifetime = Number(read(LIFETIME_KEY, heldLifetime)) || DEFAULT_LIFETIME_MS;
  return until - Math.min(RENEW_AHEAD_MAX_MS, lifetime / 4);
}

/** The token held now ran out (a time it has passed); false for one that never does or whose time is not known. */
export function tokenExpired(now: number = Date.now()): boolean {
  const until = getDeviceTokenUntil();
  return !!getDeviceToken() && typeof until === 'number' && until <= now;
}

export function renewalDue(now: number = Date.now()): boolean {
  const due = renewalDueAt();
  return due !== null && due <= now;
}

let inFlight: Promise<RenewResult> | null = null;

/**
 * Trade the refresh cookie for a new pair, once at a time in this page and, where
 * the browser has Web Locks, across its tabs: a tab that waited finds the token
 * another tab just stored and asks nothing. Never throws.
 */
export function renewSignIn(timeoutMs = 10_000): Promise<RenewResult> {
  inFlight ??= (async () => {
    try {
      const asked = getDeviceToken();
      const run = () => {
        // Another tab renewed while this one waited for the lock.
        const now = getDeviceToken();
        if (now && now !== asked && !renewalDue()) return Promise.resolve<RenewResult>({ kind: 'renewed' });
        return renewOnce(timeoutMs);
      };
      const result = await underTabLock(run, timeoutMs);
      // Signed in for sure: a refusal a request heard a moment before (its token was the one replaced) no longer stands.
      if (result.kind === 'renewed' || result.kind === 'held') noteSignedIn();
      return result;
    } catch {
      return { kind: 'no-answer' };
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}

type TabLocks = { request: (name: string, options: { signal: AbortSignal }, cb: () => Promise<RenewResult>) => Promise<RenewResult> };

/**
 * `run` under the browser's cross-tab lock, where it has Web Locks. A tab that holds
 * the lock and stops (frozen in the background) is waited for `timeoutMs` at most,
 * then this one asks anyway: the server answers a second ask within a minute with
 * the same pair.
 */
async function underTabLock(run: () => Promise<RenewResult>, timeoutMs: number): Promise<RenewResult> {
  const locks = (navigator as Navigator & { locks?: TabLocks }).locks;
  if (!locks) return run();
  const waited = new AbortController();
  const timer = setTimeout(() => waited.abort(), timeoutMs);
  try {
    return await locks.request('walnut-sign-in-renewal', { signal: waited.signal }, () => { clearTimeout(timer); return run(); });
  } catch (err) {
    if (waited.signal.aborted) return run();
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

async function renewOnce(timeoutMs: number): Promise<RenewResult> {
  for (let attempt = 0; attempt < 4; attempt++) {
    const token = getDeviceToken();
    let res: Response;
    try {
      res = await fetch(refreshUrl(), {
        method: 'POST',
        // The token rides only to start the pair of a browser from before renewing.
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        cache: 'no-store',
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      return { kind: 'no-answer' };
    }
    if (res.status === 409) {
      // Renewed a moment ago (another tab, a retry): the browser holds the new cookie by now.
      await new Promise((r) => setTimeout(r, 1_000));
      continue;
    }
    if (res.status === 401) {
      const body = await res.json().catch(() => null) as { code?: unknown } | null;
      return typeof body?.code === 'string' && SIGNED_OUT_CODES.has(body.code) ? { kind: 'refused', body } : { kind: 'unknown' };
    }
    if (res.status === 429 || res.status >= 500) return { kind: 'no-answer' };
    if (res.status === 204) {
      // This server does not renew the token held: do not ask at every open.
      if (token) markNeverRenews(token);
      return { kind: 'unknown' };
    }
    if (res.status !== 200) return { kind: 'unknown' };
    const body = await res.json().catch(() => null) as { token?: unknown; accessUntil?: unknown; accessMs?: unknown } | null;
    if (typeof body?.token !== 'string' || !body.token) return { kind: 'unknown' };
    const until = typeof body.accessUntil === 'number' ? body.accessUntil : undefined;
    const lifetimeMs = typeof body.accessMs === 'number' ? body.accessMs : undefined;
    return { kind: setDeviceToken(body.token, { until, lifetimeMs }) ? 'renewed' : 'held' };
  }
  return { kind: 'no-answer' };
}

let started = false;
let timer: ReturnType<typeof setTimeout> | null = null;
/** After a renewal with no use (no answer, a server that does not renew): the scheduler waits this long, doubling. */
let backoffMs = 0;
let notBefore = 0;
const BACKOFF_FIRST_MS = 30_000;
const BACKOFF_MAX_MS = 30 * 60_000;

/**
 * While the console runs: renew when it is due, by a timer and whenever the page
 * comes back (a phone's timers stop while Safari is in the background).
 */
export function startSignInRenewal(): void {
  if (started || typeof window === 'undefined') return;
  started = true;
  const check = () => {
    // Signed out, and the page knows why: nothing renews any more (it asked every 30 s).
    // A new code reloads the page, which starts over.
    if (getSignedOutReason()) return;
    // Not due, or asked a moment ago with no use: a request refused as expired still renews at once (client.ts).
    if (!renewalDue() || Date.now() < notBefore) { schedule(); return; }
    void renewSignIn().then((r) => {
      // Signed out meanwhile (removed in Settings, its sign-in used elsewhere): say so now.
      if (r.kind === 'refused') noteAuthRefusal(r.body);
      if (r.kind === 'renewed' || r.kind === 'held') backoffMs = 0;
      else backoffMs = Math.min(backoffMs ? backoffMs * 2 : BACKOFF_FIRST_MS, BACKOFF_MAX_MS);
      notBefore = backoffMs ? Date.now() + backoffMs : 0;
      schedule();
    });
  };
  const schedule = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    const due = renewalDueAt();
    if (due === null) return;
    // At least 30 s apart, and after the backoff, within setTimeout's range.
    const wait = Math.min(Math.max(due - Date.now(), notBefore - Date.now(), 30_000), 2 ** 31 - 1);
    timer = setTimeout(check, wait);
  };
  // Refused with no word on why (a request's plain token_refused once its device went, the
  // page reloaded before the socket said so): a renewing sign-in asks the renewal route once.
  // It knows a browser removed on the computer (device_removed), a replay or a lost cookie,
  // and renews a sign-in refused by mistake (a restart).
  let askedWhy = false;
  subscribeUnpaired(() => {
    if (askedWhy || getUnpairedState() !== 'revoked' || getSignedOutReason()) return;
    if (typeof getDeviceTokenUntil() !== 'number') return;
    askedWhy = true;
    void renewSignIn().then((r) => { if (r.kind === 'refused') noteAuthRefusal(r.body); });
  });
  window.addEventListener('focus', check);
  window.addEventListener('online', check);
  window.addEventListener('pageshow', check);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') check(); });
  // Another tab renewed: its token is this page's too (both read the same storage).
  window.addEventListener('storage', (e) => { if (e.key === UNTIL_KEY || e.key === STORAGE_KEY) schedule(); });
  check();
}
