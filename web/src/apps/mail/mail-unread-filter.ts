/**
 * "Show only unread", remembered per account and per mailbox.
 *
 * In `localStorage` rather than in the mail store, because it is a preference about how a person
 * reads their own mail and not part of any server's answer: leaving Mail and coming back has to
 * keep it, and a filter that silently resets on the next visit is one nobody leans on. Per MAILBOX
 * as well as per account, because "only unread" is an honest way to work through an inbox and a
 * strange way to look at Sent.
 *
 * ONE key per account holding the mailbox ids that are filtered, so an account's whole preference
 * is a single small read and no key is ever left behind for a mailbox that stopped existing.
 *
 * Every access is guarded. `localStorage` throws outright in some private windows and when the
 * origin's quota is full, and a reading preference is never worth taking the console down for.
 */

const PREFIX = 'walnut.mail.unreadOnly.';

function keyOf(accountId: string): string {
  return `${PREFIX}${accountId}`;
}

/** The filtered mailbox ids of one account. Anything unparseable reads as "none". */
function readList(accountId: string): string[] {
  if (!accountId) return [];
  try {
    const raw = window.localStorage.getItem(keyOf(accountId));
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((one): one is string => typeof one === 'string');
  } catch {
    return [];
  }
}

export function readUnreadOnly(accountId: string, mailboxId: string): boolean {
  if (!accountId || !mailboxId) return false;
  return readList(accountId).includes(mailboxId);
}

export function writeUnreadOnly(accountId: string, mailboxId: string, on: boolean): void {
  if (!accountId || !mailboxId) return;
  const held = readList(accountId).filter((one) => one !== mailboxId);
  if (on) held.push(mailboxId);
  try {
    if (held.length === 0) window.localStorage.removeItem(keyOf(accountId));
    else window.localStorage.setItem(keyOf(accountId), JSON.stringify(held));
  } catch {
    // A preference the browser refuses to keep is still applied to the pane on screen.
  }
}
