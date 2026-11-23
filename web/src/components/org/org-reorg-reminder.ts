/**
 * The Org page's reorg reminder, pure (2026-11-12, the user: "if the VP more than 6 remind them to
 * do reorg, if they select close we keep remind each one more vp created, like remind in 6, 7, 8
 * but if they close, we at least don't remind in current load, they can also choose never remind").
 *
 *   - From REORG_REMIND_AT VPs (vpCount: every project row), one line suggests
 *     merging some.
 *   - Close hides it until the count passes the one it was closed at: one more VP brings it back.
 *     The count is kept (REORG_CLOSED_KEY, a ui-prefs key the server mirrors), so a reload, a
 *     restart or another device keeps it closed at that count (2026-11-23, the user: "我已经close
 *     了 ... 他至少在六个VP，他就不要再提醒我了").
 *   - "Never remind me" turns it off for good: the ui-prefs key REORG_NEVER_KEY, which
 *     ui-prefs-sync mirrors to the server (`PUT /api/ui-prefs`, kept apart for a test run by
 *     src/core/test-run-prefs.ts). An agent sets it the same way, through the `api` op:
 *     `{"method":"PUT","path":"/api/ui-prefs","body":{"prefs":{"open-walnut-org-reorg-reminder":{"v":"never","ts":<ms>}}}}`;
 *     a window takes it at its next load. Any other value, or none, means remind.
 */

export const REORG_REMIND_AT = 6;
export const REORG_NEVER_KEY = 'open-walnut-org-reorg-reminder';
export const REORG_NEVER_VALUE = 'never';
/** The VP count the reminder was last closed at, kept like the never choice. */
export const REORG_CLOSED_KEY = 'open-walnut-org-reorg-closed-at';

/** The kept close count, or null when none (or not a count). */
export function reorgClosedFrom(raw: string | null | undefined): number | null {
  const n = raw ? Number(raw) : NaN;
  return Number.isInteger(n) && n > 0 ? n : null;
}

/** Whether the reminder shows: enough VPs, not turned off, and more VPs than when it was last closed. */
export function showReorgReminder(vps: number, never: boolean, closedAt: number | null): boolean {
  if (never || vps < REORG_REMIND_AT) return false;
  return closedAt === null || vps > closedAt;
}

/** The reminder's line, plain and short. */
export function reorgLine(vps: number): string {
  return `You have ${vps} VPs. Merging some keeps the org easy to follow.`;
}

/** Whether a stored value turns the reminder off. */
export function reorgNeverFrom(raw: string | null | undefined): boolean {
  return raw === REORG_NEVER_VALUE;
}

// The count it was closed at: kept in the ui-prefs key, and in memory for when storage is off. The Org
// page unmounts on every navigation, so component state alone would bring it back on the next visit.
let closedAtThisLoad: number | null = null;

function storedClosedAt(): number | null {
  try { return reorgClosedFrom(globalThis.localStorage?.getItem(REORG_CLOSED_KEY)); } catch { return null; }
}

export function reorgClosedAt(): number | null {
  const kept = storedClosedAt();
  if (kept === null) return closedAtThisLoad;
  return Math.max(kept, closedAtThisLoad ?? 0);
}

/** Close it at `vps` VPs and keep that count; the higher of two closes counts. */
export function closeReorgReminder(vps: number): number {
  closedAtThisLoad = Math.max(reorgClosedAt() ?? 0, vps);
  // An `open-walnut-` key: ui-prefs-sync mirrors it to the server, so it holds on every device.
  try { globalThis.localStorage?.setItem(REORG_CLOSED_KEY, String(closedAtThisLoad)); } catch { /* storage off: this load only */ }
  return closedAtThisLoad;
}

/** Tests: a fresh page load. */
export function _resetReorgReminderForTests(): void {
  closedAtThisLoad = null;
}
