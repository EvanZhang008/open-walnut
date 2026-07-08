/**
 * Device-token storage for cloud-mode deployments.
 *
 * On a trusted LAN (the default Mac deployment) no token exists and every
 * helper here is a no-op — requests go out exactly as before. Against a
 * cloud instance (WALNUT_CLOUD_MODE=1 server), the SPA stores the device
 * token from pairing (walnut device add / setup claim) in localStorage and:
 *   - HTTP: client.ts attaches `Authorization: Bearer <token>`
 *   - WS:   ws.ts appends `?token=<token>` (browser WebSocket API cannot set
 *           an Authorization header — query param chosen as the least-change
 *           mechanism; see src/web/ws/handler.ts)
 */

const STORAGE_KEY = 'walnut.deviceToken';

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
}

export function clearDeviceToken(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // ignore
  }
}
