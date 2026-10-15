/**
 * Device-token storage.
 *
 * On the machine Walnut runs on no token is needed, none exists, and every
 * helper here is a no-op. A browser anywhere else (a phone signed in with a
 * code, a cloud instance, another device on the LAN) holds the device token in
 * localStorage, and then:
 *   - HTTP: client.ts attaches `Authorization: Bearer <token>`, and so does
 *           every other same-origin `/api/` fetch (auth-fetch.ts)
 *   - WS:   ws.ts appends `?token=<token>` (browser WebSocket API cannot set
 *           an Authorization header; see src/web/ws/handler.ts)
 *   - media: an `<img src="/api/...">`, an HTML preview frame or a download
 *           cannot carry a header either, so the token is mirrored into the
 *           `walnut_device` cookie, which the server accepts for GET and HEAD
 *           only (src/web/middleware/auth.ts). SameSite=Strict, so no other
 *           site's page can make this browser send it.
 */

const STORAGE_KEY = 'walnut.deviceToken';
export const DEVICE_COOKIE = 'walnut_device';

export function getDeviceToken(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

export function setDeviceToken(token: string): void {
  try {
    localStorage.setItem(STORAGE_KEY, token);
  } catch {
    // Storage unavailable (private mode) — session works until reload.
  }
  writeDeviceCookie(token);
}

export function clearDeviceToken(): void {
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

/**
 * Called once at boot: re-write the cookie from storage. A browser signed in
 * before the cookie existed gets it now, and a script-written cookie that the
 * browser expired early (Safari caps those at 7 days) comes back.
 */
export function syncDeviceCookie(): void {
  const token = getDeviceToken();
  if (token) writeDeviceCookie(token);
}
