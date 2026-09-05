/**
 * The right pane: one message.
 *
 * The body is the whole risk surface of this console, so the rules are strict and visible:
 *
 * - HTML renders inside a sandboxed iframe (no scripts, no same-origin) built by
 *   `buildMailBodyFrame`: hardened as a string, then DOMPurify, then wrapped in a document whose
 *   CSP allows no network subresource. Nothing in a body reaches this origin's storage or the
 *   rest of the page.
 * - REMOTE IMAGES ARE BLOCKED until the human asks, per message, and the ask is not remembered.
 *   A tracking pixel reports the moment and the IP of the read as soon as it renders, so the
 *   count is shown and the opt-in is one click for this one body.
 * - Plain text is never handed to a markdown renderer. A message that contains `# 1` or `*sale*`
 *   means those characters; only its URLs become links, and they carry `rel="noopener"`.
 *
 * Attachments are metadata in v1: names and sizes, no download.
 */
import { useMemo } from 'react';
import { LinkifiedText } from '@/components/common/LinkifiedText';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';
import type { MailAccountDto, MailProviderSummary } from '@/api/mail';
import { openMailReplyComposer } from './compose/compose-actions';
import { CANNOT_SEND_TITLE, canSendFrom } from './compose/send-status';
import {
  attachmentLabel,
  formatMailDate,
  recipientLabel,
  senderLabel,
  truncatedNotice,
} from './mail-format';
import { allowRemoteImagesForOpenMessage, closeMailMessage, retryOpenMessageBody } from './mail-actions';
import type { MailOpenMessage } from './mail-store';
import { buildMailBodyFrame } from './mail-sanitize';
import { MAIL_IFRAME_SANDBOX } from './mail-html';
import { AttachmentIcon, BackIcon, ReplyAllIcon, ReplyIcon } from './mail-icons';
import './mail-reader.css';

interface ReaderProps {
  open: MailOpenMessage | null;
  narrow: boolean;
  accounts: MailAccountDto[];
  providers: MailProviderSummary[];
}

export function MailReader({ open, narrow, accounts, providers }: ReaderProps) {
  if (!open) {
    return (
      <section className="mail-reader-pane mail-reader-blank" data-testid="mail-reader">
        <p className="mail-pane-empty" data-testid="mail-no-message">Pick a message to read it.</p>
      </section>
    );
  }

  const message = open.message;
  return (
    <section className="mail-reader-pane" data-testid="mail-reader" data-message-id={open.messageId}>
      {narrow && (
        <div className="mail-pane-head">
          <button type="button" className="mail-icon-btn" data-testid="mail-reader-back" onClick={closeMailMessage} aria-label="Back to the list">
            <BackIcon />
          </button>
        </div>
      )}

      {message && (
        <header className="mail-reader-head">
          <ReplyActions
            open={open}
            message={message}
            accounts={accounts}
            providers={providers}
          />
          <h2 className="mail-reader-subject" data-testid="mail-reader-subject">
            {message.subject || '(no subject)'}
          </h2>
          <div className="mail-reader-people">
            <span className="mail-reader-from" title={message.from?.address}>
              {senderLabel(message.from)}
            </span>
            {message.from?.address && (
              <span className="mail-reader-address">{message.from.address}</span>
            )}
            <time className="mail-reader-date" title={message.sentAtHeader ?? undefined}>
              {formatMailDate(message.sentAt)}
            </time>
          </div>
          {message.to.length > 0 && (
            <p className="mail-reader-to">To: {recipientLabel(message.to)}</p>
          )}
          {message.attachments.length > 0 && (
            <ul className="mail-attachments" data-testid="mail-attachments">
              {message.attachments.map((attachment, index) => (
                <li className="mail-attachment" key={attachment.id ?? `${attachment.filename ?? 'part'}-${index}`}>
                  <AttachmentIcon />
                  {attachmentLabel(attachment)}
                </li>
              ))}
            </ul>
          )}
        </header>
      )}

      <MailReaderBody open={open} />
    </section>
  );
}

/**
 * Reply and Reply all, gated exactly like the compose button.
 *
 * Disabled rather than hidden when the account cannot send: a missing button is a mystery, and the
 * fix (add SMTP settings) belongs next to the thing it unlocks. Reply all is offered even when the
 * arithmetic will add nobody, because `MailMessageDto` carries no `cc` today, so "there is nobody
 * else" is not a claim this console can make.
 */
function ReplyActions({ open, message, accounts, providers }: {
  open: MailOpenMessage;
  message: NonNullable<MailOpenMessage['message']>;
  accounts: MailAccountDto[];
  providers: MailProviderSummary[];
}) {
  const account = accounts.find((one) => one.accountId === open.accountId);
  const canSend = canSendFrom(providers, open.accountId);
  const start = (all: boolean) => { void openMailReplyComposer({
    accountId: open.accountId,
    accountAddress: account?.address ?? '',
    message,
    ...(open.body?.text ? { bodyText: open.body.text } : {}),
    all,
  }); };
  return (
    <div className="mail-reader-actions">
      <button
        type="button"
        className="mail-compose-btn"
        data-testid="mail-reply"
        disabled={!canSend}
        title={canSend ? 'Reply to the sender' : CANNOT_SEND_TITLE}
        onClick={() => start(false)}
      >
        <ReplyIcon />
        Reply
      </button>
      <button
        type="button"
        className="mail-compose-btn"
        data-testid="mail-reply-all"
        disabled={!canSend}
        title={canSend ? 'Reply to everyone' : CANNOT_SEND_TITLE}
        onClick={() => start(true)}
      >
        <ReplyAllIcon />
        Reply all
      </button>
    </div>
  );
}

function MailReaderBody({ open }: { open: MailOpenMessage }) {
  const body = open.body;
  const html = body?.html;
  const frame = useMemo(
    () => (html ? buildMailBodyFrame(html, open.allowRemoteImages) : null),
    [html, open.allowRemoteImages],
  );

  if (open.loading && !body) return <LoadingSpinner />;

  if (open.error) {
    return (
      <div className="mail-body-notice" data-testid="mail-reader-error">
        <p>{open.error}</p>
        <button type="button" className="mail-text-btn" onClick={() => { void retryOpenMessageBody(); }}>
          Try again
        </button>
      </div>
    );
  }

  if (open.bodyError) {
    return (
      <div className="mail-body-notice" data-testid="mail-body-error">
        <p>{bodyErrorSentence(open.bodyError)}</p>
        <button type="button" className="mail-text-btn" onClick={() => { void retryOpenMessageBody(); }}>
          Try again
        </button>
      </div>
    );
  }

  // Two different facts, and saying the wrong one sends the human looking for the wrong problem:
  // a message the provider says HAS a body, which is not here, is a fetch that has not happened;
  // a message with no body is just an empty message (a calendar invite, a bare attachment).
  if (!body) {
    return (
      <p className="mail-pane-empty" data-testid="mail-body-missing">
        {open.message?.hasBody
          ? 'Walnut has not fetched this body yet.'
          : 'This message has no body.'}
      </p>
    );
  }

  // A body can arrive with a format and no content: an `html` part that is empty, or a text part
  // that is whitespace. Rendering the frame anyway is a blank pane that reads as a broken reader.
  if (!hasBodyContent(body)) {
    return <p className="mail-pane-empty" data-testid="mail-body-empty">No text content.</p>;
  }

  return (
    <div className="mail-reader-body">
      {frame && frame.remoteImages > 0 && !open.allowRemoteImages && (
        <div className="mail-blocked-images" data-testid="mail-blocked-images">
          <span>
            {frame.remoteImages === 1
              ? '1 remote image blocked.'
              : `${frame.remoteImages} remote images blocked.`}
          </span>
          <button
            type="button"
            className="mail-text-btn"
            data-testid="mail-load-images"
            onClick={allowRemoteImagesForOpenMessage}
          >
            Load images
          </button>
        </div>
      )}

      {frame ? (
        <iframe
          className="mail-html-frame"
          data-testid="mail-html-frame"
          sandbox={MAIL_IFRAME_SANDBOX}
          referrerPolicy="no-referrer"
          srcDoc={frame.srcdoc}
          title={open.message?.subject || 'Message'}
        />
      ) : (
        <pre className="mail-body-text" data-testid="mail-body-text">
          <LinkifiedText text={body.text ?? ''} />
        </pre>
      )}

      {body.truncated && (
        <p className="mail-body-footnote" data-testid="mail-body-truncated">
          {truncatedNotice(body.bytes)}
        </p>
      )}
    </div>
  );
}

/** Whether there is anything to render, whatever the declared format says. */
function hasBodyContent(body: { html?: string; text?: string }): boolean {
  return !!(body.html?.trim() || body.text?.trim());
}

/** The plugin answers with a provider error CODE; a code is not an explanation. */
function bodyErrorSentence(code: string): string {
  if (code === 'too-large') return 'This message body is too big to cache, so Walnut did not fetch it.';
  if (code === 'auth') return 'The provider refused the credentials while fetching this body.';
  if (code === 'not-found') return 'The provider no longer has this message.';
  if (code === 'unreachable') return 'The provider did not answer in time. It may be offline.';
  return `Walnut could not fetch this body (${code}).`;
}
