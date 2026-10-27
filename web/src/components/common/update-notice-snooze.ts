/**
 * The update notice's ×: it stays away for SNOOZE_MS whatever lands meanwhile (2026-10-27,
 * the user: "if user press x it need to snooze for at least 30 min"; every deploy used to
 * bring it straight back). After that it comes back only for an update newer than the one
 * dismissed. Kept in localStorage, so a reload, another tab and a new window all honour it;
 * the `storage` event tells the windows already open.
 */
export const SNOOZE_KEY = 'open-walnut-update-notice-snooze';
export const SNOOZE_MS = 30 * 60_000;

export interface UpdateSnooze { identity: string; until: number }

export function parseSnooze(raw: string | null): UpdateSnooze | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Partial<UpdateSnooze>;
    return typeof v?.identity === 'string' && typeof v.until === 'number' && Number.isFinite(v.until)
      ? { identity: v.identity, until: v.until } : null;
  } catch { return null; }
}

export function readSnooze(): UpdateSnooze | null {
  try { return parseSnooze(window.localStorage.getItem(SNOOZE_KEY)); } catch { return null; }
}

export function writeSnooze(identity: string, now = Date.now()): UpdateSnooze {
  const snooze = { identity, until: now + SNOOZE_MS };
  try { window.localStorage.setItem(SNOOZE_KEY, JSON.stringify(snooze)); } catch { /* quota, private mode */ }
  return snooze;
}

/** Hidden while the 30 minutes run, and after them for the very update that was dismissed. */
export function isSnoozed(snooze: UpdateSnooze | null, identity: string, now: number): boolean {
  if (!snooze) return false;
  // A clock set back far past the snooze must not hide the notice for days.
  if (snooze.until - now > SNOOZE_MS) return snooze.identity === identity;
  return now < snooze.until || snooze.identity === identity;
}
