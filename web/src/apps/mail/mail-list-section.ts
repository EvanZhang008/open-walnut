/**
 * The middle pane's header numbers: which mailbox the column is, how big it is, how much of it is
 * unread, and which of those figures is the folder's own and which is only what has been loaded.
 *
 * Pure arithmetic over the snapshot, kept out of the list component so the rules that stop the three
 * places a folder's size appears (sidebar badge, header, chip) from disagreeing are readable at once.
 */
import type { MailMessageDto } from '@/api/mail';
import { isUnread } from './mail-format';
import { serverDraftsMailbox, type MailSnapshot } from './mail-store';
import {
  SMART_LABEL,
  draftsRowCount,
  draftsTotalCount,
  smartTotal,
  smartUnread,
  type SmartRole,
} from './mail-smart';

export interface Section {
  name: string;
  count: number;
  unread: number;
  /** Whether `count` is the mailbox's size or only what has been loaded. Said on screen, in a title. */
  countLoaded: boolean;
  /** The same question for `unread`, which can only be page-derived before any mailbox list lands. */
  unreadLoaded: boolean;
  /** What `count` counts, for its title. A merged list is not "this folder". */
  countTitle: string;
  /**
   * The one word that says, ON SCREEN, what the count is.
   *
   * `ALL INBOXES 62,972` is the sum of both inboxes as the provider declares them, while the cache this
   * list pages holds a 180 day window of about four thousand: Load older ended at a few percent of the
   * number in the header, and the only thing that said so was a title attribute, which never renders.
   */
  countWord: string;
}

/**
 * The folder header: which mailbox this column is, how big it is, and how much unread mail it holds.
 *
 * BOTH numbers are the MAILBOX ROW's, which is the same row the folder badge on the left is drawn
 * from, so the three figures a person sees for one folder cannot disagree. They used to be page
 * arithmetic, and the result was the report this header exists to answer: a folder row reading
 * "Inbox 99+" beside a header reading "INBOX 50" and "5 unread", none of which described the same
 * thing.
 *
 * The fallback to the loaded rows is for the FIRST PAINT, before any mailbox list has landed, and it
 * says so in a title rather than passing a page count off as the folder's size. The count falls back
 * one step further: a provider that declares fewer messages than this console is already holding has
 * told us something that cannot be true, and the honest number is then the one that can be counted on
 * screen. The unread figure has no such check on purpose, because it is what the badge shows and the
 * two have to stay the same number.
 *
 * Null when nothing is selected: there is no folder to name yet.
 */
export function sectionOf(
  snapshot: MailSnapshot,
  view: { draftsView: boolean; smart: SmartRole | null; filtering: boolean },
  rows: MailMessageDto[],
): Section | null {
  const selected = snapshot.selected;
  if (!selected) return null;
  const { draftsView, smart, filtering } = view;
  if (draftsView) {
    // Both halves, so the header counts the rows below it: with a server section the local count alone
    // would repeat "Written here" one line further up and describe a third of the list.
    //
    // The server half is the PAGE THIS VIEW HOLDS, not the folder size the mailbox row declares. That
    // size counts drafts outside the cache's retention window, which no section here can list: it is how
    // a header read 51 over a view whose sections added up to 8. The sidebar badge is the first section
    // (see `draftsRowCount`), this is every row under the header, and both are countable on screen.
    const written = smart
      ? draftsTotalCount(snapshot.drafts, snapshot.accounts)
      : draftsRowCount(snapshot.drafts[selected.accountId]);
    const onServer = smart
      ? snapshot.accounts.some((one) => !!serverDraftsMailbox(snapshot.mailboxes[one.accountId]))
      : !!serverDraftsMailbox(snapshot.mailboxes[selected.accountId]);
    return {
      name: smart ? SMART_LABEL.drafts : 'Drafts',
      count: written + rows.length,
      unread: 0,
      // A provider folder in the view means the second half is a page, so the word says `loaded`: the
      // folder can hold drafts older than the window this cache keeps, and calling that `total` claims a
      // number Load older can never reach.
      countLoaded: onServer,
      unreadLoaded: false,
      countTitle: 'drafts written here and in the Drafts folder',
      countWord: onServer ? 'loaded' : 'total',
    };
  }
  if (smart) {
    // The SUM of the same mailbox rows the sidebar badge adds up, so the two cannot disagree. The one
    // exception is while the filter is on: the rows on screen are then the answer to a different
    // question (what the cache holds unread) and the provider's own figure can be smaller, so the chip
    // counts what is under it and its title says where that number came from.
    const onScreen = rows.filter((one) => isUnread(one.flags)).length;
    return {
      name: SMART_LABEL[smart],
      count: smartTotal(snapshot.mailboxes, smart),
      countLoaded: false,
      unread: filtering ? onScreen : smartUnread(snapshot.mailboxes, smart),
      unreadLoaded: filtering,
      countTitle: 'messages in these folders',
      countWord: 'total',
    };
  }
  const mailbox = (snapshot.mailboxes[selected.accountId] ?? [])
    .find((one) => one.mailboxId === selected.mailboxId);
  const total = mailbox ? countOf(mailbox.total) : 0;
  const describesThePage = !!mailbox && total >= rows.length;
  return {
    name: mailbox?.name || selected.mailboxId,
    count: describesThePage ? total : rows.length,
    countLoaded: !describesThePage,
    unread: mailbox ? countOf(mailbox.unread) : rows.filter((one) => isUnread(one.flags)).length,
    unreadLoaded: !mailbox,
    countTitle: 'messages in this folder',
    countWord: describesThePage ? 'total' : 'loaded',
  };
}

/** A provider-declared count, made safe to compare: no fractions, no negatives, no NaN. */
function countOf(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0;
}
