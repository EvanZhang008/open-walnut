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
import { pairKey, type MailSnapshot } from './mail-store';

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
  announce();
}

/**
 * ONE preference, read by two controls: the header chip and the folder row's menu item.
 *
 * The chip used to hold its own `useState`, resynced only when the selection changed, so the sidebar
 * menu's switch filtered the list (the actions layer reloads the page from this file) while the chip
 * stayed in the off state, and the pane's filtered-empty state never appeared: the pane still believed
 * it was showing everything, so a folder with no unread mail blamed the cache for messages it was only
 * hiding, and the next chip click "did nothing" because it was the click that turned the filter ON.
 *
 * A version counter rather than a value, because the question is per (account, mailbox) and every
 * reader asks it for its own pair. `storage` events are NOT the channel: they only fire in OTHER tabs.
 */
let version = 0;
const listeners = new Set<() => void>();

function announce(): void {
  version += 1;
  for (const one of listeners) one();
}

/** Subscribe to every write of this preference, in the shape `useSyncExternalStore` takes. */
export function subscribeUnreadOnly(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

/** The current version, so a subscriber can be compared without reading `localStorage` again. */
export function unreadOnlyVersion(): number {
  return version;
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
 * Spliced at its own place in the sort order so nothing appears to jump. THREE segments, the same
 * ones the server pages by (`sent_at DESC, message_id DESC, account_id DESC`): a merged list holds two
 * accounts whose ids tie, and a two-segment comparison here would put the held row where the server
 * would never have returned it. A row older than the whole page lands at the end of it, which is the
 * honest place for it until "Load older" fills the gap.
 *
 * `sticky` is every OTHER row this console has just acted on (`pendingSeen`, by `pairKey`), and it is
 * the same promise for a row nobody opened: the row menu's read toggle takes a row off an unread page
 * by definition, so a list somebody is right-clicking down would delete each row as they touched it
 * and renumber everything below the pointer. One merge pass for both kinds, because two splices in a
 * row put the second row at an index the first one had already moved.
 */
export function keepOpenRow(
  page: MailMessageDto[],
  held: MailMessageDto[],
  open: { accountId: string; messageId: string } | null,
  sticky: Iterable<string> = [],
): MailMessageDto[] {
  const wanted = new Set<string>(sticky);
  if (open) wanted.add(pairKey(open.accountId, open.messageId));
  if (wanted.size === 0) return page;
  for (const one of page) wanted.delete(pairKey(one.accountId, one.messageId));
  // Never invented: a message opened from a deep link was never a row in this list, and adding one
  // would put a mail from another mailbox into this folder's column.
  const extras = held
    .filter((one) => wanted.has(pairKey(one.accountId, one.messageId)))
    .sort((a, b) => (newer(a, b) ? -1 : 1));
  if (extras.length === 0) return page;
  const out: MailMessageDto[] = [];
  let at = 0;
  for (const row of page) {
    while (at < extras.length && newer(extras[at]!, row)) out.push(extras[at++]!);
    out.push(row);
  }
  // Rows older than the whole page land at the end of it, which is the honest place for them until
  // "Load older" fills the gap.
  while (at < extras.length) out.push(extras[at++]!);
  return out;
}

/** The server's own order: `sent_at DESC, message_id DESC, account_id DESC`. */
function newer(one: MailMessageDto, other: MailMessageDto): boolean {
  if (one.sentAt !== other.sentAt) return one.sentAt > other.sentAt;
  if (one.messageId !== other.messageId) return one.messageId > other.messageId;
  return one.accountId > other.accountId;
}

/**
 * Does this row stay on an unread page even though it is read now?
 *
 * ONE rule, asked by the page assembly above and by the pane's own client-side filter: a row the
 * pane hid while the server was still being asked would flash out and back in, and a row the pane
 * kept that the next page dropped would jump. The two questions are the same question.
 */
export function isStickyRow(snapshot: MailSnapshot, message: MailMessageDto): boolean {
  const pair = pairKey(message.accountId, message.messageId);
  if (pair in snapshot.pendingSeen) return true;
  const open = snapshot.open;
  return !!open && pairKey(open.accountId, open.messageId) === pair;
}

/**
 * The header chip's own words.
 *
 * It used to read `{n} unread · showing`, a sentence that stopped mid-phrase, and it read it over a list
 * whose row count could honestly differ from `n` (the chip counts the MAILBOX, the list holds one page,
 * and a row just read is held on screen). So the filter state is said in full, and the disagreement gets
 * its own sentence (`heldRowsSentence`) rather than being argued out of the number.
 */
export function unreadChipLabel(countText: string, on: boolean): string {
  return on ? `${countText} unread · showing unread only` : `${countText} unread`;
}

/**
 * Why a list filtered to unread is showing a row that is not unread, or '' when it is not.
 *
 * The rows a triage pass has just dealt with are deliberately kept (`keepWhileFiltering`): one that
 * vanished from under the pointer would take its reply and its make-a-task with it. Kept silently, the
 * count above and the rows below simply contradicted each other.
 */
export function heldRowsSentence(held: number): string {
  if (held <= 0) return '';
  return held === 1
    ? 'One message you just dealt with is still listed.'
    : `${held} messages you just dealt with are still listed.`;
}
