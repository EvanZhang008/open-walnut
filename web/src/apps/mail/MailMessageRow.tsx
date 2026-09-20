/**
 * One message row of the middle pane, and the two questions a caller asks about a row.
 *
 * Split out of `MailMessageList` when the right-click menu landed: the row is the surface that
 * carries the gesture, and the list that draws it is a different job (paging, filtering, headers).
 */
import type { MailAccountDto, MailMessageDto } from '@/api/mail';
import { formatMailTime, isUnread, rowRecipientLabel, senderLabel } from './mail-format';
import { openMailMessage } from './mail-actions';
import { pairKey, setMailRowNote, type MailSnapshot } from './mail-store';
import type { MailRowMenuHandle } from './MailRowContextMenu';
import { AlertCircleIcon, AttachmentIcon, TaskIcon } from './mail-icons';

/**
 * Does a click on this row belong to a text selection inside it?
 *
 * The subject and the snippet are selectable text (that is also what keeps the browser's own Copy /
 * Look Up menu available on them), and a drag that ends inside the row still fires its click. So
 * selecting a word to look it up would OPEN the message and mark it read, which is the one outcome
 * this whole menu exists to prevent.
 */
function selectingInside(row: Element): boolean {
  const selection = typeof window !== 'undefined' ? window.getSelection() : null;
  if (!selection || selection.isCollapsed || !selection.toString().trim()) return false;
  const anchor = selection.anchorNode;
  return !!anchor && row.contains(anchor);
}

/**
 * Whether this row is the message the reader is holding.
 *
 * The PAIR, never the id alone. A message's identity is (accountId, messageId), and the merged list
 * is the first place both halves are on screen at once: two providers hand out ids from their own
 * numbering, so the same id in two accounts is two different mails. Keyed on the id alone, opening
 * one of them highlighted both, and the filter kept both on screen.
 */
export function isOpenRow(snapshot: MailSnapshot, message: MailMessageDto): boolean {
  const open = snapshot.open;
  return !!open && open.accountId === message.accountId && open.messageId === message.messageId;
}

/**
 * One row. `accounts` non-null means this list mixes accounts, so the row says which one it is.
 *
 * That slot used to print the raw `mailboxId`, which on one provider here is a 90 character string:
 * a merged list would have been a column of noise, and the mailbox is not the question anyway (the
 * row is already under a header naming the role). It REPLACES the old slot rather than adding a line.
 */
export function MailRow({ message, selected, accounts, outbound, menu, flagFailed }: {
  message: MailMessageDto;
  selected: boolean;
  accounts: MailAccountDto[] | null;
  /** A sent or drafts scope: the first column is the RECIPIENT, which is what such a list is scanned for. */
  outbound?: boolean;
  menu: MailRowMenuHandle;
  /** The provider's own reason, per pair, for the last read flip it refused. */
  flagFailed: Record<string, string>;
}) {
  const unread = isUnread(message.flags);
  const pair = pairKey(message.accountId, message.messageId);
  const refused = flagFailed[pair];
  const account = accounts?.find((one) => one.accountId === message.accountId);
  const who = account ? account.displayName || account.address : '';
  // A MARK, not the name: measured on the same 50 rows at 1280x800, the name chip took 110px (more than
  // the 102px left to the sender) and was itself cut on 19 of them, mid domain for an account whose
  // display name is its address. One letter cannot truncate, costs the sender column nothing, and the
  // full identity is on the row's own title, in the reader head and in the composer head (spec 6.9).
  const mark = who.replace(/[^\p{L}\p{N}]/gu, '').slice(0, 1).toLocaleUpperCase() || '?';
  const recipient = outbound ? rowRecipientLabel(message.to) : '';
  return (
    /* A `div role="button"`, NOT a `<button>`, and the reason is WebKit: it refuses a text selection
       inside a form control whatever `user-select` says, so in the Mac app a row's subject could not be
       selected at all (measured: the same drag selected in Chromium and selected nothing in WebKit).
       Copy, Look Up and Translate were therefore gone from every mail row in the one engine the desktop
       app runs on, and the drag arrived as a plain click that OPENED the message and marked it read.
       The same span inside this element selects in both engines. `tabIndex` + the Enter/Space handler
       are what a real button gave for free. */
    <div
      role="button"
      tabIndex={0}
      className={`mail-row${unread ? ' unread' : ''}${selected ? ' selected' : ''}`}
      data-testid="mail-row"
      data-message-id={message.messageId}
      data-account-id={message.accountId}
      data-unread={unread}
      /* The task this row's message became, so a triage pass can see at a glance which rows it has
         already dealt with. A `<span>` glyph and an attribute, never an `<a href>`: a link inside the
         row hands a right-click back to the browser (`keepNativeContextMenu`, rule 3). */
      {...(message.taskId ? { 'data-task-id': message.taskId } : {})}
      {...(refused ? { 'data-flag-failed': '1', title: refused } : {})}
      /* A right-click NEVER opens the row, never moves the selection and never marks anything read:
         `useContextMenu` preventDefaults the browser menu, and a `contextmenu` event does not fire
         `onClick`, so the read flip this menu offers can never be a repair of its own side effect. */
      onContextMenu={(event) => {
        menu.open(event, { accountId: message.accountId, messageId: message.messageId });
      }}
      {...(menu.openPair === pair ? { 'data-ctx-open': 'true' } : {})}
      onClick={(event) => {
        if (selectingInside(event.currentTarget)) return;
        void openMailMessage(message.accountId, message.messageId);
      }}
      /* What the element used to do by itself. Space is prevented as well as answered, or the list
         scrolls a page under the message that just opened. */
      onKeyDown={(event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        void openMailMessage(message.accountId, message.messageId);
      }}
    >
      <span className="mail-row-top">
        {unread && <span className="mail-row-dot" aria-hidden="true" />}
        <span className="mail-row-from" data-field={outbound ? 'to' : 'from'}>
          {/* `To` only in front of somebody. A live sent folder does hold rows whose cached envelope never
              carried recipients (they live in the provider's payload, not in a column), and the stand-in
              has to say that WE do not know rather than that the mail had nobody: `No recipient` was a
              claim about the message, `Unknown recipient` is a claim about the cache, which is the true one
              and the same word `senderLabel` already uses for a missing sender. */}
          {outbound && recipient && <span className="mail-row-to">To </span>}
          {outbound ? recipient || 'Unknown recipient' : senderLabel(message.from)}
        </span>
        {account && (
          <span
            className="mail-row-account"
            data-testid="mail-row-account"
            data-account-id={account.accountId}
            /* A stable tone per account, so two accounts whose names start with the same letter are
               still two different marks. Index in the account list, not a hash: it is the order the
               sidebar draws them in, so the mark and the pane agree. */
            data-tone={String((accounts ?? []).findIndex((one) => one.accountId === account.accountId) % 4)}
            title={who === account.address ? who : `${who} (${account.address})`}
            aria-label={`Account ${who}`}
          >
            {mark}
          </span>
        )}
        <span className="mail-row-time">{formatMailTime(message.sentAt)}</span>
      </span>
      <span className="mail-row-subject">
        {/* Its own span, so the ellipsis has a block to happen in: the row's subject line is a flex
            container, and a bare text node there is an anonymous item that clips without one. */}
        <span className="mail-row-subject-text">{message.subject || '(no subject)'}</span>
        {message.attachments.length > 0 && (
          <span className="mail-row-clip" aria-label="has attachments"><AttachmentIcon /></span>
        )}
        {message.taskId && (
          <span className="mail-row-task" data-testid="mail-row-task" aria-label="has a task">
            <TaskIcon size={12} />
          </span>
        )}
        {/* The provider refused this row's last read flip and the row was put back. Rolled back it
            looks exactly like a row nobody touched, which somebody working down a list reads as a job
            done, so it keeps a mark and the row's title carries the provider's own words. */}
        {refused && (
          <button
            type="button"
            className="mail-row-flag-failed"
            data-testid="mail-row-flag-failed"
            title={refused}
            aria-label={`Read flag refused. ${refused}`}
            /* The provider's REASON is one press away from the row it is about, instead of only in a
               hover tooltip with the sentence itself at the far foot of the column. `stopPropagation`
               because the press is inside a row whose own click OPENS the message, which is the write
               this whole surface exists to avoid. */
            onClick={(event) => {
              event.stopPropagation();
              setMailRowNote(refused, pair, { sticky: true });
            }}
          >
            <AlertCircleIcon size={12} />
            {/* The STATE in words, drawn on the row: rolled back, the row looks exactly like one nobody
                touched, which somebody working down a list reads as a job done. Which word it is comes
                off the row's own flags, the same way the menu's toggle label does. */}
            <span className="mail-row-flag-failed-word">
              {unread ? 'still unread' : 'still read'}
            </span>
          </button>
        )}
      </span>
      <span className="mail-row-snippet">{message.snippet}</span>
    </div>
  );
}

