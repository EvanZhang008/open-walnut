/**
 * Pure list derivations for the notification panel's Inbox and Needs Action
 * sections — the Unread filter and the decision grace clock. Kept out of the
 * component so both rules are pinned by unit tests rather than read off JSX.
 */
import { decisionGraceEndsAt, type LetterEnvelope } from '@/api/human-inbox';

/**
 * The Inbox "Unread" toggle, remembered per browser. Deliberately NOT an
 * `open-walnut-` key: those mirror to the server through ui-prefs-sync, and a
 * filter one browser turned on must not narrow the inbox on every other device
 * (or on every later Playwright context against a shared fixture server).
 */
export const INBOX_UNREAD_ONLY_KEY = 'walnut-inbox-unread-only';

export function readUnreadOnlyPref(): boolean {
  try {
    return localStorage.getItem(INBOX_UNREAD_ONLY_KEY) === '1';
  } catch {
    return false;
  }
}

export function writeUnreadOnlyPref(on: boolean): void {
  try {
    if (on) localStorage.setItem(INBOX_UNREAD_ONLY_KEY, '1');
    else localStorage.removeItem(INBOX_UNREAD_ONLY_KEY);
  } catch {
    // Storage denied (private mode, quota): the toggle still works for this page.
  }
}

/**
 * The Inbox list under the Unread filter.
 *
 * `keep` holds the letters the human read WHILE the filter was on: they stay
 * listed until the filter is toggled or the panel closes, so opening a letter
 * does not make its row vanish from under the cursor the moment the reader
 * marks it read (the mail-client convention). Filter off = the list untouched.
 */
export function filterInboxLetters(
  letters: readonly LetterEnvelope[],
  unreadOnly: boolean,
  keep: ReadonlySet<string>,
): LetterEnvelope[] {
  if (!unreadOnly) return [...letters];
  return letters.filter(l => !l.read || keep.has(l.id));
}

/**
 * The next moment a read-but-unanswered decision leaves Needs Action, or null
 * when nothing is in its grace window. The panel arms ONE timer for it, instead
 * of polling, so the row disappears on time even with the panel left open.
 */
export function nextDecisionGraceExpiry(
  letters: readonly LetterEnvelope[],
  now: number,
): number | null {
  let next: number | null = null;
  for (const l of letters) {
    const endsAt = decisionGraceEndsAt(l);
    if (endsAt === null || endsAt <= now) continue;
    if (next === null || endsAt < next) next = endsAt;
  }
  return next;
}
