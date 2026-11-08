/**
 * The Org page's reorg reminder, pure (2026-11-12, the user: "if the VP more than 6 remind them to
 * do reorg, if they select close we keep remind each one more vp created, like remind in 6, 7, 8
 * but if they close, we at least don't remind in current load, they can also choose never remind").
 *
 *   - From REORG_REMIND_AT VPs (vpCount: every project row but the Inbox's), one line suggests
 *     merging some.
 *   - Close hides it for this page load, until the count passes the one it was closed at: one more
 *     VP brings it back, in the same load too. A reload shows it again.
 *   - "Never remind me" turns it off for good: the ui-prefs key REORG_NEVER_KEY, which
 *     ui-prefs-sync mirrors to the server (`PUT /api/ui-prefs`, kept apart for a test run by
 *     src/core/test-run-prefs.ts). An agent sets it the same way, through the `api` op:
 *     `{"method":"PUT","path":"/api/ui-prefs","body":{"prefs":{"open-walnut-org-reorg-reminder":{"v":"never","ts":<ms>}}}}`;
 *     a window takes it at its next load. Any other value, or none, means remind.
 */

export const REORG_REMIND_AT = 6;
export const REORG_NEVER_KEY = 'open-walnut-org-reorg-reminder';
export const REORG_NEVER_VALUE = 'never';

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

// The count it was closed at, for this page load only: the Org page unmounts on every navigation,
// so component state would bring it back on the next visit to the page.
let closedAtThisLoad: number | null = null;

export function reorgClosedAt(): number | null {
  return closedAtThisLoad;
}

/** Close it at `vps` VPs; the higher of two closes counts. */
export function closeReorgReminder(vps: number): number {
  closedAtThisLoad = Math.max(closedAtThisLoad ?? 0, vps);
  return closedAtThisLoad;
}

/** Tests: a fresh page load. */
export function _resetReorgReminderForTests(): void {
  closedAtThisLoad = null;
}
