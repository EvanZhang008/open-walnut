/**
 * Pure list derivations for the notification panel's Inbox section: the Unread
 * filter. Kept out of the component so the rule is pinned by unit tests rather
 * than read off JSX. (Letters never list in Needs Action: that section is only
 * what a session asks live.)
 */
import type { LetterEnvelope } from '@/api/human-inbox';

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
