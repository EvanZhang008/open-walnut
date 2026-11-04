/**
 * Device-token storage.
 *
 * On the machine Walnut runs on no token is needed, none exists, and every
 * helper here is a no-op. A browser anywhere else (a phone signed in with a
 * code, a cloud instance, another device on the LAN) holds the device token in
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
 * Kept across Safari's rules (2026-11-04, the user: "if cookie is cleared need
 * another code"): Safari removes a site's localStorage after 7 days of browsing
 * without a visit to it, and keeps a cookie written here 7 days at most. So every
 * open asks GET /api/devices/browser-session with the token, and the server sets
 * it in a cookie of its own, `walnut_signin`, HttpOnly, for 400 days, which
 * neither rule touches (src/web/routes/browser-session.ts). A page that finds no
 * token in storage asks the same route before it shows the sign-in screen
 * (sign-in-gate.ts): the cookie rides, and the token comes back and is stored
 * again. The page's own `walnut_device` stays: it follows a new token at once
 * (a page cannot write an HttpOnly cookie), and a server older than the route
 * reads only it.
 */

const STORAGE_KEY = 'walnut.deviceToken';
export const DEVICE_COOKIE = 'walnut_device';

/** The token while storage refuses it (a private window): this page keeps it until reload. */
let heldToken: string | null = null;

export function getDeviceToken(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY) ?? heldToken;
  } catch {
    return heldToken;
  }
}

/** Store the token; true when storage kept it (a reload still has it). */
export function setDeviceToken(token: string): boolean {
  let kept = false;
  try {
    localStorage.setItem(STORAGE_KEY, token);
    kept = localStorage.getItem(STORAGE_KEY) === token;
  } catch {
    // Storage unavailable (private mode) — session works until reload.
  }
  heldToken = kept ? null : token;
  writeDeviceCookie(token);
  return kept;
}

export function clearDeviceToken(): void {
  heldToken = null;
  try {
    localStorage.removeItem(STORAGE_KEY);
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

/** The server's sign-in cookie route (src/web/routes/browser-session.ts). */
export const BROWSER_SESSION_URL = '/api/devices/browser-session';

function browserSessionUrl(): string {
  return window.location.protocol === 'https:' ? `${BROWSER_SESSION_URL}?secure=1` : BROWSER_SESSION_URL;
}

/**
 * Called once at boot: re-write the cookie from storage, and have the server
 * renew its HttpOnly copy for another 400 days. A browser signed in before
 * either cookie existed gets them now. Nothing waits on the answer: a refused
 * token shows its notice through the console's own first requests.
 */
export function syncDeviceCookie(): void {
  const token = getDeviceToken();
  if (!token) return;
  writeDeviceCookie(token);
  try {
    void fetch(browserSessionUrl(), { headers: { Authorization: `Bearer ${token}` }, cache: 'no-store' }).catch(() => undefined);
  } catch {
    // No fetch (a test page): the cookie written above still serves.
  }
}

export type RestoreResult =
  /** Stored again: a reload has it. */
  | { kind: 'restored' }
  /** Storage refused it (a private window): this page holds it until reload. */
  | { kind: 'held' }
  /** 401 with the server's refusal (no cookie, or one it no longer accepts). */
  | { kind: 'refused'; body: unknown }
  /**
   * 204 (no cookie, and this server let the call in without a token: the computer
   * Walnut runs on), or an older server without the route. The usual probe decides.
   */
  | { kind: 'unknown' }
  /**
   * No answer, a rate limit or a server error: a probe now would carry the same
   * cookie and boot a console with no token, so the page waits and asks again.
   */
  | { kind: 'no-answer' };

/**
 * A page with no token in storage: ask the server for the token its HttpOnly
 * cookie holds (Safari removed the page's storage, the cookie stayed).
 */
export async function restoreDeviceToken(timeoutMs: number): Promise<RestoreResult> {
  let res: Response;
  try {
    res = await fetch(browserSessionUrl(), { cache: 'no-store', signal: AbortSignal.timeout(timeoutMs) });
  } catch {
    return { kind: 'no-answer' };
  }
  if (res.status === 401) return { kind: 'refused', body: await res.json().catch(() => null) };
  if (res.status === 429 || res.status >= 500) return { kind: 'no-answer' };
  if (res.status !== 200) return { kind: 'unknown' };
  const body = await res.json().catch(() => null) as { token?: unknown } | null;
  if (typeof body?.token !== 'string' || !body.token) return { kind: 'unknown' };
  return { kind: setDeviceToken(body.token) ? 'restored' : 'held' };
}
