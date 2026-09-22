/**
 * One message's header: what it is, who sent it, and what can be done about it.
 *
 * The hierarchy is deliberate, because the old header was four grey lines of the same weight and
 * the sender's address was as loud as the subject: SUBJECT, then the person (a coloured initial, a
 * name, an address, a date), then everything else behind one "Details" disclosure. To, Cc and the
 * raw `Date` header are facts a reader wants twice a month, and the address arithmetic of a
 * fourteen-recipient mail pushed the body off the screen when they were always on.
 *
 * The actions are an ICON TOOLBAR, and each one is either live or disabled with a title that says
 * why: an action that is missing is a mystery, and an action that fails on the click is worse.
 */
import { useState } from 'react';
import type { MailAccountDto, MailProviderSummary } from '@/api/mail';
import { formatSize } from '@/utils/format';
import { openMailForwardComposer, openMailReplyComposer } from './compose/compose-actions';
import { CANNOT_SEND_TITLE, canSendFrom } from './compose/send-status';
import { attachmentLabel, formatMailDate, isUnread, recipientLabel, senderLabel } from './mail-format';
import { mayOfferMarkRead } from './mail-providers';
import { bodyQuoteText } from './mail-quote-text';
import { attachmentKind, senderMark, type AttachmentKind } from './mail-reader-format';
import { setOpenMessageRead } from './mail-read-flag';
import { MailTaskButton } from './MailTaskButton';
import type { MailOpenMessage } from './mail-store';
import { openFinishUnsubscribeAsk, unsubscribeFromMessage } from './mail-unsubscribe-actions';
import {
  unsubscribeHandsOverToAsk,
  unsubscribeRowState,
  unsubscribeStatusLine,
} from './mail-unsubscribe-state';
import {
  ArchiveBoxIcon,
  ChevronIcon,
  DocumentIcon,
  EnvelopeIcon,
  EnvelopeOffIcon,
  EnvelopeOpenIcon,
  ForwardIcon,
  ImageIcon,
  ReplyAllIcon,
  ReplyIcon,
  SheetIcon,
} from './mail-icons';

type Message = NonNullable<MailOpenMessage['message']>;

interface Props {
  open: MailOpenMessage;
  message: Message;
  accounts: MailAccountDto[];
  providers: MailProviderSummary[];
}

export function MailReaderHead({ open, message, accounts, providers }: Props) {
  const [details, setDetails] = useState(false);
  const mark = senderMark(message.from);
  const extras = detailRows(message);
  // WHICH ACCOUNT this mail is in, and therefore which identity the reply buttons above would send
  // as. Only with more than one account, because with one it is noise. It was never on screen: the
  // reply is already correct (it uses `open.accountId`), but a merged list is the first place a
  // person reads two accounts' mail in one column and cannot tell which one they are answering from.
  const account = accounts.length > 1
    ? accounts.find((one) => one.accountId === open.accountId)
    : undefined;
  // The SAME pure answer the row menu reads, so the header and the menu can never disagree about where
  // one message stands (they were the two places that could, and this is the one function they share).
  const statusLine = unsubscribeStatusLine(message);

  return (
    <header className="mail-reader-head mail-reader-column">
      <div className="mail-reader-title-row">
        <h2 className="mail-reader-subject" data-testid="mail-reader-subject">
          {message.subject || '(no subject)'}
        </h2>
        <ReaderActions open={open} message={message} accounts={accounts} providers={providers} />
      </div>

      <div className="mail-reader-sender">
        <span
          className="mail-avatar"
          aria-hidden="true"
          style={{ background: `hsl(${mark.hue} 58% 44%)` }}
        >
          {mark.initial}
        </span>
        <span className="mail-reader-identity">
          <span className="mail-reader-from" title={message.from?.address}>
            {senderLabel(message.from)}
          </span>
          {message.from?.address && message.from.address !== senderLabel(message.from) && (
            <span className="mail-reader-address">{message.from.address}</span>
          )}
        </span>
        {account && (
          <span
            className="mail-reader-account"
            data-testid="mail-reader-account"
            data-account-id={account.accountId}
            title={account.address}
            aria-label={`This message is in ${account.displayName || account.address}`}
          >
            {account.displayName || account.address}
          </span>
        )}
        <span className="mail-reader-when">
          <time className="mail-reader-date" title={message.sentAtHeader ?? undefined}>
            {formatMailDate(message.sentAt)}
          </time>
          {extras.length > 0 && (
            <button
              type="button"
              className={`mail-reader-details-btn${details ? ' open' : ''}`}
              data-testid="mail-reader-details"
              aria-expanded={details}
              onClick={() => setDetails((was) => !was)}
            >
              Details
              <ChevronIcon />
            </button>
          )}
        </span>
      </div>

      {/* Where the message is up to with its mailing list, when it is up to anything.
          A LINE rather than a badge next to the button, because it is a fact about the past ("you left
          this list on Sep 21") and the button is about the future; and under the sender rather than in
          the title row, because the title row clips and the subject is what must survive. It draws
          nothing at all in the two states that have nothing to report (see `unsubscribeStatusLine`). */}
      {statusLine && (
        <p
          className="mail-reader-unsub"
          data-testid="mail-reader-unsub"
          data-state={statusLine.status}
          role="status"
        >
          {statusLine.text}
        </p>
      )}

      {details && extras.length > 0 && (
        <dl className="mail-reader-detail-rows" data-testid="mail-reader-detail-rows">
          {extras.map((row) => (
            <div className="mail-reader-detail-row" key={row.label} data-testid={row.testId}>
              <dt>{row.label}</dt>
              <dd>{row.value}</dd>
            </div>
          ))}
        </dl>
      )}

      {message.attachments.length > 0 && (
        <ul className="mail-attachments" data-testid="mail-attachments">
          {message.attachments.map((attachment, index) => (
            <li
              className="mail-attachment"
              key={attachment.id ?? `${attachment.filename ?? 'part'}-${index}`}
              title={attachmentLabel(attachment)}
            >
              <span className="mail-attachment-glyph" aria-hidden="true">
                <KindGlyph kind={attachmentKind(attachment)} />
              </span>
              <span className="mail-attachment-name">{attachment.filename?.trim() || 'Attachment'}</span>
              <span className="mail-attachment-size">{sizeOf(attachment.bytes)}</span>
            </li>
          ))}
        </ul>
      )}
    </header>
  );
}

/**
 * The size on its own, so the card can clip the NAME and keep the number.
 *
 * `formatSize` is the shared one, the same function `attachmentLabel` uses, so a card and the
 * truncation note can never print the same number two ways.
 */
function sizeOf(bytes: number | undefined): string {
  return bytes && bytes > 0 ? formatSize(bytes) : '';
}

function KindGlyph({ kind }: { kind: AttachmentKind }) {
  if (kind === 'image') return <ImageIcon size={14} />;
  if (kind === 'sheet') return <SheetIcon size={14} />;
  if (kind === 'archive') return <ArchiveBoxIcon size={14} />;
  return <DocumentIcon size={14} />;
}

interface DetailRow { label: string; value: string; testId?: string }

/** The lines the disclosure holds. Absent facts get no row rather than an empty one. */
function detailRows(message: Message): DetailRow[] {
  const rows: DetailRow[] = [];
  if (message.to.length > 0) rows.push({ label: 'To', value: recipientLabel(message.to) });
  if (message.cc && message.cc.length > 0) {
    rows.push({ label: 'Cc', value: recipientLabel(message.cc), testId: 'mail-reader-cc' });
  }
  if (message.replyTo && message.replyTo.length > 0) {
    rows.push({ label: 'Reply to', value: recipientLabel(message.replyTo) });
  }
  const raw = rawDate(message);
  if (raw) rows.push({ label: 'Date', value: raw });
  return rows;
}

/** The `Date` header verbatim when the message kept one; the local stamp is already on screen. */
function rawDate(message: Message): string {
  const header = message.sentAtHeader?.trim();
  if (header) return header;
  if (!Number.isFinite(message.sentAt) || message.sentAt <= 0) return '';
  return new Date(message.sentAt).toISOString();
}

/**
 * Reply, Reply all, Forward, Make a task, and the read flag.
 *
 * The three send actions are disabled rather than hidden when the account cannot send: a missing
 * button is a mystery, and the fix (add SMTP settings) belongs next to the thing it unlocks.
 * Reply all is offered even when the arithmetic will add nobody, because "there is nobody else" is
 * not a claim this header is able to make.
 *
 * Make a task is NOT gated on anything: it writes a Walnut task and touches no mail server. The
 * read flag follows the provider's declared capability, which is data, never a guess: a provider
 * that cannot move the flag would answer 409 and the mailbox would drift from what every other mail
 * client shows. An answer nobody has YET is not a no (see mayOfferMarkRead).
 */
function ReaderActions({ open, message, accounts, providers }: Props) {
  const account = accounts.find((one) => one.accountId === open.accountId);
  const canSend = canSendFrom(providers, open.accountId, accounts);
  const canMark = mayOfferMarkRead(providers, open.accountId);
  const unread = isUnread(message.flags);
  const sendTitle = (live: string) => (canSend ? live : CANNOT_SEND_TITLE);
  // One pure answer for the label, the title, the disabled state and what the click does. The reader
  // draws it as an icon button and the row menu draws it as a row; neither decides anything itself.
  const unsubscribe = unsubscribeRowState({ message, canSend });

  const reply = (all: boolean) => {
    void openMailReplyComposer({
      accountId: open.accountId,
      accountAddress: account?.address ?? '',
      message,
      // The HTML half when there is no text half, the same rule the row menu's reply keeps
      // (`bodyQuoteText`): an HTML-only message quoted as nothing at all.
      ...(bodyQuoteText(open.body) ? { bodyText: bodyQuoteText(open.body) } : {}),
      all,
    });
  };

  return (
    <div className="mail-reader-actions">
      <button
        type="button"
        className="mail-round-btn"
        data-testid="mail-reply"
        disabled={!canSend}
        title={sendTitle('Reply to the sender')}
        aria-label="Reply"
        onClick={() => reply(false)}
      >
        <ReplyIcon size={15} />
      </button>
      <button
        type="button"
        className="mail-round-btn"
        data-testid="mail-reply-all"
        disabled={!canSend}
        title={sendTitle('Reply to everyone')}
        aria-label="Reply all"
        onClick={() => reply(true)}
      >
        <ReplyAllIcon size={15} />
      </button>
      <button
        type="button"
        className="mail-round-btn"
        data-testid="mail-forward"
        disabled={!canSend}
        title={sendTitle('Forward this message')}
        aria-label="Forward"
        onClick={() => {
          void openMailForwardComposer({
            accountId: open.accountId,
            message,
            // The HTML half when there is no text half, the same rule the row menu's reply keeps
      // (`bodyQuoteText`): an HTML-only message quoted as nothing at all.
      ...(bodyQuoteText(open.body) ? { bodyText: bodyQuoteText(open.body) } : {}),
          });
        }}
      >
        <ForwardIcon size={15} />
      </button>
      <MailTaskButton open={open} />
      {/* Leaving the list, from the open message. The reader has NO context menu (its body is a
          sandboxed iframe, see MailReaderBody), so this button is the only way to reach the ladder
          from here. `data-unsub-state` is how a spec asserts the state without reading the title. */}
      <button
        type="button"
        className="mail-round-btn"
        data-testid="mail-unsubscribe"
        data-unsub-state={unsubscribe.status}
        disabled={unsubscribe.disabled}
        title={unsubscribe.title || unsubscribe.label}
        aria-label={unsubscribe.label}
        onClick={() => {
          if (unsubscribe.action === 'ask') {
            openFinishUnsubscribeAsk(open.accountId, open.messageId, unsubscribe.reason);
            return;
          }
          if (unsubscribe.action === 'run') {
            // A `needs-human` verdict carries straight on into the drawer, exactly as the row menu's
            // own Unsubscribe does. Two reasons it is not left as "the note tells them to click again":
            // the two surfaces must not behave differently about one verdict, and the url the page was
            // at is on the wire ONCE — the ledger keeps the reason, not the page, so a later click can
            // only ask the model to go and find the way out again.
            void unsubscribeFromMessage(open.accountId, open.messageId).then((answered) => {
              if (!unsubscribeHandsOverToAsk(answered)) return;
              openFinishUnsubscribeAsk(open.accountId, open.messageId, answered?.reason, answered?.url);
            });
          }
        }}
      >
        <EnvelopeOffIcon size={15} />
      </button>
      <button
        type="button"
        className="mail-round-btn"
        data-testid="mail-mark-read"
        disabled={!canMark}
        title={canMark
          ? (unread ? 'Mark as read' : 'Mark as unread')
          : 'This provider cannot change the read flag'}
        aria-label={unread ? 'Mark as read' : 'Mark as unread'}
        onClick={() => { void setOpenMessageRead(unread); }}
      >
        {unread ? <EnvelopeOpenIcon size={15} /> : <EnvelopeIcon size={15} />}
      </button>
    </div>
  );
}
