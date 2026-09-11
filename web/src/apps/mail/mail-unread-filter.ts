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
 *
 * It is ALSO the flag the page reads carry (`unread=1`), which is why this file is what the actions
 * layer asks rather than the pane's own state: the filter is the server's now, over the whole
 * mailbox, and only `localStorage` is reachable from outside React.
 */
import type { MailMessageDto } from '@/api/mail';

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

/**
 * A fresh unread page, with the row the person is READING put back when the server has stopped
 * returning it.
 *
 * Opening an unread mail marks it read, so the very next `unread=1` answer does not contain it. The
 * page is reloaded by things the reader did not ask for (a sync event, turning the filter on while a
 * message is open), and letting one of those delete the row under the pointer is the one thing this
 * filter promised not to do: it takes the reply and make-a-task buttons with it and leaves nothing to
 * go back to. The row leaves when another row is selected, which the pane decides.
 *
 * Spliced at its own place in the sort order (newest first, message id breaking a tie) so nothing
 * appears to jump. A row older than the whole page lands at the end of it, which is the honest place
 * for it until "Load older" fills the gap.
 */
export function keepOpenRow(
  page: MailMessageDto[],
  held: MailMessageDto[],
  open: { accountId: string; messageId: string } | null,
): MailMessageDto[] {
  if (!open) return page;
  if (page.some((one) => one.accountId === open.accountId && one.messageId === open.messageId)) return page;
  const sticky = held.find((one) => one.accountId === open.accountId && one.messageId === open.messageId);
  // Never invented: a message opened from a deep link was never a row in this list, and adding one
  // would put a mail from another mailbox into this folder's column.
  if (!sticky) return page;
  const at = page.findIndex((one) => (
    one.sentAt < sticky.sentAt || (one.sentAt === sticky.sentAt && one.messageId < sticky.messageId)
  ));
  if (at < 0) return [...page, sticky];
  return [...page.slice(0, at), sticky, ...page.slice(at)];
}
