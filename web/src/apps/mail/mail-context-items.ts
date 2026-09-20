/**
 * A message row's right-click menu, as DATA.
 *
 * Every label, every `when` and every disabled reason of the row menu lives here so the rules can be
 * graded without a browser: the interesting half of this menu is which rows exist, and that answer has
 * five dimensions (can the provider move the read flag, can the account send, does the message already
 * have a task, does this list mix accounts, and is the row mail this person WROTE). The React half
 * (`MailRowContextMenu.tsx`) only binds the actions.
 *
 * Three rules it encodes, each one a rejection if it drifts:
 *
 * - NO DEAD CONTROLS. An item whose route does not exist is not drawn, and the read toggle is dropped
 *   outright (never disabled) when the provider declares it cannot move the flag: drawing the menu's
 *   headline greyed out presents the whole menu as "nothing works here", and a 409 the human asked for
 *   is the same bad outcome one click later. The send items are the deliberate other way round: SMTP
 *   settings are something they can fix, so those are disabled with the reason.
 * - THE READ TOGGLE STATES WHAT THE CLICK WILL DO, read from THIS row's own flags. Never a fixed word,
 *   and never the reader's open message: this menu exists so a row can be flipped without opening it.
 * - EVERY ACTION TAKES THE PAIR OFF THE ROW. `(message.accountId, message.messageId)`, never the
 *   selection: in a merged list the row's account and the pane's first account are different accounts.
 */
import type { MailAccountDto, MailMessageDto, MailProviderSummary } from '@/api/mail';
import { normalizeContextMenuItems, type ContextMenuItem } from '@/utils/context-menu';
import { isUnread, rowRecipientLabel, senderLabel } from './mail-format';
import { mayOfferMarkRead } from './mail-providers';
import { CANNOT_SEND_TITLE, canSendFrom } from './compose/send-status';

/** What the menu's items call. The row is passed back so a handler never has to find it again. */
export interface MessageMenuActions {
  onSetRead: (message: MailMessageDto, read: boolean) => void;
  onOpen: (message: MailMessageDto) => void;
  /** `all` is reply-all. Forward is its own handler: it is not a reply and carries no `replyTo`. */
  onReply: (message: MailMessageDto, all: boolean) => void;
  onForward: (message: MailMessageDto) => void;
  onMakeTask: (message: MailMessageDto) => void;
  onOpenTask: (taskId: string) => void;
  onSearchSender: (address: string) => void;
  onCopyLink: (message: MailMessageDto) => void;
}

export interface MessageMenuInput {
  /**
   * The row as the snapshot holds it NOW, not the payload the right-click stored.
   *
   * The label's direction and the task item's wording are both read off it, and a menu can be open
   * across a sync: built from the frozen payload, `Mark as read` stays on screen for a row another
   * device has already read.
   */
  message: MailMessageDto;
  providers: MailProviderSummary[];
  accounts: MailAccountDto[];
  /** A sent or drafts scope: mail this person wrote, which is not a mail to reply to. */
  outbound: boolean;
  /** The provider's Drafts folder (or the merged Drafts row): unsent mail, so most items go. */
  draftsView: boolean;
  /** This list mixes accounts (a merged list or a search), so the title says which one. */
  merged: boolean;
  /**
   * Is the reader holding a message right now?
   *
   * The three composer items take the pane the reader is using (`handOver`), which is worth saying,
   * and is a lie when there is nothing open: with the pane empty both Reply rows still warned about
   * closing the message being read.
   */
  readerOpen: boolean;
  /**
   * Is the reader holding THIS row's message?
   *
   * Then `Open message` is dropped: it is a no-op on the row the pane already shows, and NO DEAD
   * CONTROLS covers an item that does nothing as much as it covers one that 409s. The three composer
   * items stay, because on that row they are the only way to answer it from the list.
   */
  readerHasRow: boolean;
  actions: MessageMenuActions;
}

/** Said under `Reply`, because the composer takes the pane the reader is using (`handOver`). */
export const REPLY_CLOSES_TITLE = 'Replying closes the message you are reading';

/** Said under `Open message`, because that is the write this whole menu exists to avoid. */
export const OPEN_MARKS_READ_TITLE = 'Opening a message marks it read';

/** Said under `Copy Walnut link`: the origin is THIS console, never a provider permalink. */
export const COPY_LINK_TITLE = 'A link back to this copy of Walnut, not a link your mail provider knows';

/**
 * The heading's SANITY cap, far above what the box holds, because the BOX does the truncating.
 *
 * `.wn-context-menu-label` already carries `nowrap` + `text-overflow: ellipsis` and the full text rides
 * in `title`, and the mail menu is drawn at ONE width for every row (`wn-context-menu-titled`, so the panel edge
 * does not jump between two right-clicks in one pass). Capping by character count on top of
 * that measured 254px of used label inside a 254px box: CSS clipped nothing, the JS cap had already
 * ellipsed both fields, and about ten characters of subject were dropped with 60px of the menu's own
 * width going unused. So these numbers only exist to stop a pathological header (a subject that is a
 * whole paragraph) from being handed to the DOM; the person and the account keep a proportional share
 * of the line so a long name cannot take the subject's room.
 */
const TITLE_LINE = 120;

/** A person's name cannot take the whole line: the subject is what tells two mails apart. */
const TITLE_PERSON = 48;

/** The account line's own cap, so a display name that is a long address cannot grow unboundedly. */
const TITLE_ACCOUNT = 96;

/** The shortest subject worth printing: below this the field says nothing, so the cap floors here. */
const TITLE_SUBJECT_MIN = 14;

/**
 * One line of the menu's title, shortened.
 *
 * Whitespace is collapsed first: a subject carrying a newline (a folded header, a pasted line break)
 * would otherwise make the title line two lines tall and move every item under it.
 */
export function truncateForMenu(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/**
 * Who the menu's title names: the sender, or in an outbound list the RECIPIENT.
 *
 * The same answer the row's own first column gives (see `MailRow`), and for the same reason: every row
 * of a sent folder is from this account, so naming the sender would print the human's own name over a
 * menu that is about one particular message.
 */
export function menuPersonLabel(message: MailMessageDto, outbound: boolean): string {
  if (!outbound) return senderLabel(message.from);
  // `To `, the row's own word (see `MailRow`). Without it the heading of a SENT row read exactly like
  // the heading of an inbound row from that person, one line away from it in All Sent.
  const recipient = rowRecipientLabel(message.to);
  return recipient ? `To ${recipient}` : 'Unknown recipient';
}

/**
 * The heading, as the one or two lines it is drawn as: `person · subject`, then the account.
 *
 * TWO lines rather than three fields, because the third field is the one that must survive: the line
 * clips from the right, so on real mail the account was the first thing lost. Both lines are capped
 * against `TITLE_LINE`, and the subject takes whatever the person left, never less than
 * `TITLE_SUBJECT_MIN`.
 */
export function menuHeadingLines(
  person: string,
  subject: string,
  accountName: string,
): { label: string, title: string }[] {
  const who = truncateForMenu(person, TITLE_PERSON);
  const room = Math.max(TITLE_SUBJECT_MIN, TITLE_LINE - who.length - 3);
  const first = {
    label: `${who} · ${truncateForMenu(subject, room)}`,
    title: `${person} · ${subject}`,
  };
  if (!accountName) return [first];
  return [first, { label: truncateForMenu(accountName, TITLE_ACCOUNT), title: accountName }];
}

/**
 * The address `Find mail from this sender` searches for, or '' when there is nothing to search with.
 *
 * '' ON AN OUTBOUND ROW, which is a route fact and not a taste: the search index the cache answers from
 * holds `subject, from_addr, snippet, body_text` and NO recipient column (`messages_fts` in
 * src/integrations/mail/store.ts), so searching a sent row's recipient reliably answered `0 results`.
 * The item is dropped there the same way the read toggle is dropped when the provider cannot move the
 * flag: a control that always answers nothing is a dead control. It comes back the day the server
 * gains a recipient-searchable field, and its label will have to say "to" rather than "from".
 */
export function menuSearchAddress(message: MailMessageDto, outbound: boolean): string {
  if (outbound) return '';
  return (message.from?.address ?? '').trim();
}

/**
 * The deep link `Copy Walnut link` writes: `<origin>/mail?account=&message=`.
 *
 * `URLSearchParams` does the encoding, which is not a style choice: a provider message id is an opaque
 * string and base64-shaped ids carry `+` `/` `=` freely, so a hand-joined query hands `MailApp`'s own
 * `URLSearchParams` parse a `+` that decodes to a space and the link opens nothing.
 */
export function mailRowLink(accountId: string, messageId: string, origin: string): string {
  const query = new URLSearchParams({ account: accountId, message: messageId });
  return new URL(`/mail?${query.toString()}`, origin).toString();
}

/**
 * The message row's menu, top to bottom.
 *
 * Order (spec 4.1): the read toggle first, because it is the one thing a list cannot do any other way
 * and the reason this menu exists; `Open message` next and alone, because a menu that refuses to open
 * the row has to say where opening lives; the three send items together, because they share one
 * capability gate and splitting them makes a disabled state look random; the task row after them; and
 * the two that are about neither this message's state nor its thread at the bottom.
 *
 * Already normalized, so a hidden item is genuinely absent from the returned list and the dividers
 * around it have collapsed: "not drawn at all" is the promise, and a test that has to filter first
 * cannot tell a dropped row from a disabled one.
 */
export function messageMenuItems(input: MessageMenuInput): ContextMenuItem[] {
  const {
    message, providers, accounts, outbound, draftsView, merged, readerOpen, readerHasRow, actions,
  } = input;
  const account = accounts.find((one) => one.accountId === message.accountId);
  const unread = isUnread(message.flags);
  const canSend = canSendFrom(providers, message.accountId, accounts);
  // The cost is only worth saying when it is real: with nothing in the reader these three close
  // nothing, and all three pay it equally (`handOver`), Forward included.
  const closesTitle = readerOpen ? REPLY_CLOSES_TITLE : undefined;
  const sendTitle = canSend ? closesTitle : CANNOT_SEND_TITLE;
  const person = menuPersonLabel(message, outbound);
  const subject = message.subject || '(no subject)';
  const accountName = account ? (account.displayName || account.address) : '';
  // The account is only worth its own line where two accounts are on screen at once; in a
  // single-account window it is the only account there is.
  const sayAccount = merged && accounts.length > 1 && !!accountName;
  const heading = menuHeadingLines(person, subject, sayAccount ? accountName : '');
  const address = menuSearchAddress(message, outbound);
  const taskId = message.taskId;
  const canMarkRead = mayOfferMarkRead(providers, message.accountId);
  const offerRead = !draftsView && canMarkRead;
  return normalizeContextMenuItems([
    // `info`, not `section`: the section row neither truncates nor carries a title, and it
    // UPPERCASES, which shouts an account whose display name is its own address.
    ...heading.map((line, at) => ({
      key: at === 0 ? 'target' : 'target-account',
      info: true,
      label: line.label,
      title: line.title,
    })),
    {
      key: 'read',
      // Dropped, never disabled, and dropped for a draft as well: a draft usually carries no `\Seen`,
      // so the row draws an unread dot, and "marking it read" is a real provider write against mail
      // this person wrote and never sent.
      when: offerRead,
      label: unread ? 'Mark as read' : 'Mark as unread',
      onSelect: () => actions.onSetRead(message, unread),
    },
    // Tied to the toggle, not left to `normalizeContextMenuItems`: it only collapses a divider that
    // ended up FIRST, and the title above is a row, so a dropped toggle would leave a rule sitting
    // directly under the title with nothing above it to separate.
    { divider: true, when: offerRead },
    {
      key: 'open',
      // Dropped on the row the reader already holds: clicking it there opened nothing, and a draft is
      // the same question (`Continue editing` on the draft already in the composer).
      when: !readerHasRow,
      label: draftsView ? 'Continue editing' : 'Open message',
      // Only where opening would actually MOVE the flag: on an account whose provider cannot move it,
      // and on a row that is already read, the one warning in this menu was not true. Read from the
      // same capability the toggle above is.
      ...(draftsView || !canMarkRead || !unread ? {} : { title: OPEN_MARKS_READ_TITLE }),
      onSelect: () => actions.onOpen(message),
    },
    { divider: true },
    {
      key: 'reply',
      when: !outbound,
      label: 'Reply',
      disabled: !canSend,
      ...(sendTitle ? { title: sendTitle } : {}),
      onSelect: () => actions.onReply(message, false),
    },
    {
      key: 'reply-all',
      when: !outbound,
      label: 'Reply all',
      disabled: !canSend,
      ...(sendTitle ? { title: sendTitle } : {}),
      onSelect: () => actions.onReply(message, true),
    },
    {
      // A sent message can be forwarded; a draft cannot, because nobody has received it.
      key: 'forward',
      when: !draftsView,
      label: 'Forward',
      disabled: !canSend,
      // The same sentence the two replies carry: this opener hands the reader's pane over too.
      ...(sendTitle ? { title: sendTitle } : {}),
      onSelect: () => actions.onForward(message),
    },
    { divider: true },
    {
      key: 'task',
      label: taskId ? 'Open task' : 'Make a task',
      onSelect: () => { if (taskId) actions.onOpenTask(taskId); else actions.onMakeTask(message); },
    },
    { divider: true },
    {
      key: 'sender',
      when: !draftsView && !!address,
      label: 'Find mail from this sender',
      onSelect: () => actions.onSearchSender(address),
    },
    {
      key: 'copy-link',
      label: 'Copy Walnut link',
      title: COPY_LINK_TITLE,
      onSelect: () => actions.onCopyLink(message),
    },
  ]);
}
