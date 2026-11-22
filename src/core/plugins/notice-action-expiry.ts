/**
 * A notice button's moment, checked by the server when the button runs. A plugin can give a
 * button an `expiresAt` (plugin-notifications.ts: a break's "End break" at the break's end); the
 * console leaves it out once the moment passed, and the console's op call carries it in this
 * header so the op route refuses a click that raced the moment, or came from a page that missed
 * its redraw (2026-11-22 review). The value is the server's own (it came from the record), and it
 * is compared with the server's clock, never the browser's.
 *
 * The web client's twin of the header name is ACTION_EXPIRES_HEADER in
 * web/src/contexts/notifications/notification-actions.ts (tests/web/notice-action-expiry.test.ts
 * keeps them equal).
 */
export const ACTION_EXPIRES_HEADER = 'x-walnut-action-expires-at'

/**
 * Why an op call is refused for its button's expiry, or null when it may run: no header (a call
 * that is not a notice button, or an older console), a value that is not a moment, or a moment
 * still ahead.
 */
export function expiredActionRefusal(header: string | string[] | undefined, now: number = Date.now()): string | null {
  if (typeof header !== 'string' || !/^\d{1,16}$/.test(header.trim())) return null
  const at = Number(header.trim())
  if (!Number.isFinite(at) || at <= 0 || at > now) return null
  return 'This button is no longer available: the moment it was for has passed'
}
