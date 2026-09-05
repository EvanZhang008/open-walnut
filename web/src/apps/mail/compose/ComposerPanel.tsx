/**
 * The composer, which takes the reader's place while it is open.
 *
 * The pane is the reader's slot rather than a modal on purpose: writing a mail is a task you look
 * things up during, so the mailbox and the message list have to stay clickable next to it. On a
 * narrow viewport it is the whole screen with a back control, which is the same drill the reader
 * uses.
 *
 * The body is a plain `<textarea>` holding markdown, and the server renders the html. No rich
 * editor in v1: a WYSIWYG surface would have to agree with the server's renderer about what it
 * produced, and two renderers disagreeing is how a mail loses half its formatting.
 *
 * The reply QUOTE is read-only and sits under the textarea. It is real body text (it is appended
 * when the draft is saved), so showing it is honest; making it editable would mean the human could
 * silently rewrite what somebody else wrote and send it back to them as a quote.
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ConfirmDialog } from '@/components/common/ConfirmDialog';
import type { MailboxDto } from '@/api/mail';
import { BackIcon } from '../mail-icons';
import type { MailComposer } from '../mail-store';
import { AddressChipsField } from './AddressChipsField';
import { SendStatusCard } from './SendStatusCard';
import {
  closeMailComposer,
  setMailComposerFields,
  showMailComposerStatus,
  toggleMailComposerField,
} from './compose-actions';
import { askMailOnPhone, discardMailComposerDraft, sendMailNow } from './compose-send';
import { hasInvalidAddress } from './mail-address';

interface Props {
  composer: MailComposer;
  mailboxes: MailboxDto[];
  narrow: boolean;
  /** False when the account's provider declares no send. The card is still reachable. */
  canSend: boolean;
  cannotSendTitle: string;
}

/** The body starts at eight rows, which is a short mail rather than a comment box. */
const MIN_BODY_ROWS = 8;

const SAVE_TEXT: Record<MailComposer['save'], string> = {
  clean: '',
  saving: 'Saving',
  saved: 'Saved',
  retrying: 'Could not save, retrying',
  failed: 'Not saved',
  // The notice above the footer carries which address, because "not saved" without the reason is a
  // state the human cannot act on.
  blocked: 'Not saved',
};

/** A draft that is on its way or gone is never offered a send button again. */
const NO_SEND_PHASES = ['sending', 'sent', 'discarded'];

export function ComposerPanel({ composer, mailboxes, narrow, canSend, cannotSendTitle }: Props) {
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const inbox = mailboxes.find((one) => one.role === 'inbox')?.mailboxId;
  const showing = composer.mode === 'status' ? 'status' : 'edit';

  return (
    <section className="mail-composer-pane" data-testid="mail-composer" data-mode={showing}>
      <div className="mail-pane-head">
        {narrow && (
          <button
            type="button"
            className="mail-icon-btn"
            data-testid="mail-composer-back"
            aria-label="Back to the list"
            onClick={() => { void closeMailComposer(); }}
          >
            <BackIcon />
          </button>
        )}
        <span className="mail-pane-title">
          {composer.replyTo ? 'Reply' : 'New message'}
        </span>
        {showing === 'edit' && composer.draftId && (
          <button
            type="button"
            className="mail-text-btn"
            data-testid="mail-composer-show-status"
            onClick={showMailComposerStatus}
          >
            Status
          </button>
        )}
        <button
          type="button"
          className="mail-text-btn"
          data-testid="mail-composer-close"
          onClick={() => { void closeMailComposer(); }}
        >
          Close
        </button>
      </div>

      {showing === 'status' ? (
        <SendStatusCard
          composer={composer}
          inboxMailboxId={inbox}
          onDiscard={() => setConfirmDiscard(true)}
        />
      ) : (
        <ComposerForm
          composer={composer}
          canSend={canSend}
          cannotSendTitle={cannotSendTitle}
          onDiscard={() => setConfirmDiscard(true)}
        />
      )}

      {confirmDiscard && (
        <ConfirmDialog
          title="Discard this draft?"
          message="Nothing has been sent. The draft and its text are deleted."
          confirmLabel="Discard"
          cancelLabel="Keep it"
          danger
          onConfirm={() => { setConfirmDiscard(false); void discardMailComposerDraft(); }}
          onCancel={() => setConfirmDiscard(false)}
        />
      )}
    </section>
  );
}

function ComposerForm({ composer, canSend, cannotSendTitle, onDiscard }: {
  composer: MailComposer;
  canSend: boolean;
  cannotSendTitle: string;
  onDiscard: () => void;
}) {
  const { fields } = composer;
  const invalid = hasInvalidAddress([...fields.to, ...fields.cc, ...fields.bcc]);
  const sendable = canSend && !invalid && !composer.busy && !NO_SEND_PHASES.includes(composer.status.phase);
  const sendTitle = canSend
    ? (invalid ? 'Fix the addresses in red first' : undefined)
    : cannotSendTitle;

  return (
    <>
      <div className="mail-compose-fields">
        {/* A new message needs a recipient first; a reply already has one, so its caret goes to
            the body. Two fields racing for focus would decide it by mount order. */}
        <AddressChipsField
          label="To"
          name="to"
          chips={fields.to}
          autoFocus={!composer.replyTo}
          onChange={(to) => setMailComposerFields({ to })}
        />
        {composer.showCc && (
          <AddressChipsField
            label="Cc"
            name="cc"
            chips={fields.cc}
            onChange={(cc) => setMailComposerFields({ cc })}
          />
        )}
        {composer.showBcc && (
          <AddressChipsField
            label="Bcc"
            name="bcc"
            chips={fields.bcc}
            onChange={(bcc) => setMailComposerFields({ bcc })}
          />
        )}
        <div className="mail-compose-toggles">
          {!composer.showCc && (
            <button type="button" className="mail-text-btn" data-testid="mail-compose-add-cc" onClick={() => toggleMailComposerField('showCc')}>
              Add Cc
            </button>
          )}
          {!composer.showBcc && (
            <button type="button" className="mail-text-btn" data-testid="mail-compose-add-bcc" onClick={() => toggleMailComposerField('showBcc')}>
              Add Bcc
            </button>
          )}
        </div>

        <div className="mail-compose-field">
          <label className="mail-compose-label" htmlFor="mail-compose-subject">Subject</label>
          <input
            id="mail-compose-subject"
            className="mail-compose-input"
            data-testid="mail-compose-subject"
            type="text"
            value={fields.subject}
            onChange={(event) => setMailComposerFields({ subject: event.target.value })}
          />
        </div>
      </div>

      <BodyArea
        value={fields.body}
        autoFocus={!!composer.replyTo}
        onChange={(body) => setMailComposerFields({ body })}
      />

      {composer.quote && (
        <div className="mail-compose-quote" data-testid="mail-compose-quote">
          <span className="mail-compose-quote-label">Quoted below your reply</span>
          <pre className="mail-compose-quote-text">{composer.quote}</pre>
        </div>
      )}

      <p className="mail-compose-attachments" data-testid="mail-compose-attachments">
        Attachments are not supported yet
      </p>

      {composer.notice && (
        <p className="mail-compose-notice" data-testid="mail-compose-notice">{composer.notice}</p>
      )}

      <div className="mail-compose-footer">
        <span className="mail-compose-save" data-testid="mail-compose-save" data-state={composer.save}>
          {SAVE_TEXT[composer.save]}
        </span>
        <button
          type="button"
          className="mail-compose-btn danger"
          data-testid="mail-compose-discard"
          disabled={composer.busy}
          onClick={onDiscard}
        >
          Discard
        </button>
        {!NO_SEND_PHASES.includes(composer.status.phase) && (
          <>
            <button
              type="button"
              className="mail-compose-btn"
              data-testid="mail-compose-ask"
              disabled={!sendable}
              title={sendTitle}
              onClick={() => { void askMailOnPhone(); }}
            >
              Ask on phone
            </button>
            <button
              type="button"
              className="mail-compose-btn primary"
              data-testid="mail-compose-send"
              disabled={!sendable}
              title={sendTitle}
              onClick={() => { void sendMailNow(); }}
            >
              {composer.busy ? 'Sending…' : 'Send now'}
            </button>
          </>
        )}
      </div>
    </>
  );
}

/**
 * The body: eight rows to start, growing with what is in it.
 *
 * `useLayoutEffect` rather than an effect, because a height applied after paint is a visible jump on
 * every keystroke. The max height lives in the css, so a long mail scrolls inside the field instead
 * of pushing the footer off the pane.
 */
function BodyArea({ value, autoFocus, onChange }: {
  value: string;
  autoFocus: boolean;
  onChange: (next: string) => void;
}) {
  const ref = useRef<HTMLTextAreaElement | null>(null);
  useLayoutEffect(() => {
    const node = ref.current;
    if (!node) return;
    node.style.height = 'auto';
    node.style.height = `${node.scrollHeight}px`;
  }, [value]);
  // The caret belongs in the body for a reply: the recipients and the subject are already right.
  useEffect(() => { if (autoFocus) ref.current?.focus(); }, [autoFocus]);
  return (
    <textarea
      ref={ref}
      className="mail-compose-body"
      data-testid="mail-compose-body"
      rows={MIN_BODY_ROWS}
      value={value}
      placeholder="Write your message. Markdown works."
      onChange={(event) => onChange(event.target.value)}
    />
  );
}
