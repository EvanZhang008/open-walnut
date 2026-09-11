/**
 * The composer, which takes the reader's place while it is open.
 *
 * The pane is the reader's slot rather than a modal on purpose: writing a mail is a task you look
 * things up during, so the mailbox and the message list have to stay clickable next to it. On a
 * narrow viewport it is the whole screen with a back control, which is the same drill the reader
 * uses.
 *
 * It is ONE CARD, on the same desk and the same 760px measure as the message it answers, so a reply
 * visibly belongs to what is on screen behind it. Inside the card: a titled head, a stacked form of
 * hairline rows with no boxed inputs, the body as the rest of the card, and a footer whose primary
 * control is Send. The head and the footer hold their edges; only the form and the body scroll,
 * so a long mail can never push the send button out of reach.
 *
 * The body is a plain `<textarea>` holding markdown, and the server renders the html. No rich
 * editor in v1: a WYSIWYG surface would have to agree with the server's renderer about what it
 * produced, and two renderers disagreeing is how a mail loses half its formatting.
 *
 * The reply QUOTE is read-only and sits under the textarea. It is real body text (it is appended
 * when the draft is saved), so showing it is honest; making it editable would mean the human could
 * silently rewrite what somebody else wrote and send it back to them as a quote.
 */
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import { ConfirmDialog } from '@/components/common/ConfirmDialog';
import type { MailDraftDto, MailboxDto } from '@/api/mail';
import { BackIcon, ClipIcon, SentIcon, TrashIcon } from '../mail-icons';
import { selectMailbox } from '../mail-actions';
import { DRAFTS_MAILBOX, type MailComposer } from '../mail-store';
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
import { isOpenDraft } from './send-status';

interface Props {
  composer: MailComposer;
  mailboxes: MailboxDto[];
  /** This account's drafts, for the count chip that leads back to them. */
  drafts: MailDraftDto[];
  narrow: boolean;
  /** False when the account's provider declares no send. The card is still reachable. */
  canSend: boolean;
  cannotSendTitle: string;
}

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

function titleOf(composer: MailComposer): string {
  if (composer.intent === 'forward') return 'Forward';
  return composer.replyTo ? 'Reply' : 'New message';
}

/**
 * Whether throwing this draft away is worth asking about.
 *
 * The BODY is the human's own writing, so any of it means ask. For a reply or a forward, nothing
 * else counts: the recipients, the subject and the quote were written by this console, and asking
 * "are you sure" about text nobody typed trains people to click through the dialog that matters.
 */
function needsDiscardConfirm(composer: MailComposer): boolean {
  const { fields } = composer;
  if (fields.body.trim()) return true;
  if (composer.replyTo || composer.intent === 'forward') return false;
  return !!fields.subject.trim()
    || fields.to.length + fields.cc.length + fields.bcc.length > 0;
}

export function ComposerPanel({ composer, mailboxes, drafts, narrow, canSend, cannotSendTitle }: Props) {
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const inbox = mailboxes.find((one) => one.role === 'inbox')?.mailboxId;
  const showing = composer.mode === 'status' ? 'status' : 'edit';
  // Other drafts, not this one: a chip that counts the draft you are looking at is a number that
  // never means anything.
  const others = drafts.filter((one) => isOpenDraft(one) && one.draftId !== composer.draftId).length;

  const askDiscard = () => {
    if (needsDiscardConfirm(composer)) setConfirmDiscard(true);
    else void discardMailComposerDraft();
  };

  return (
    <section className="mail-composer-pane" data-testid="mail-composer" data-mode={showing}>
      {narrow && (
        <div className="mail-pane-head mail-composer-back-bar">
          <button
            type="button"
            className="mail-icon-btn"
            data-testid="mail-composer-back"
            aria-label="Back to the list"
            onClick={() => { void closeMailComposer(); }}
          >
            <BackIcon />
          </button>
        </div>
      )}

      <div className="mail-compose-shell">
        <div className="mail-compose-card">
          <div className="mail-compose-card-head">
            <span className="mail-compose-title">{titleOf(composer)}</span>
            {others > 0 && (
              <button
                type="button"
                className="mail-compose-drafts-chip"
                data-testid="mail-compose-drafts-chip"
                title="Open the drafts waiting on this account"
                onClick={() => selectMailbox(composer.accountId, DRAFTS_MAILBOX)}
              >
                {others === 1 ? '1 draft' : `${others} drafts`}
              </button>
            )}
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
            {showing === 'edit' && (
              <button
                type="button"
                className="mail-round-btn danger"
                data-testid="mail-compose-discard"
                disabled={composer.busy}
                title="Discard this draft"
                aria-label="Discard this draft"
                onClick={askDiscard}
              >
                <TrashIcon size={15} />
              </button>
            )}
            <button
              type="button"
              className="mail-round-btn"
              data-testid="mail-composer-close"
              title="Close the composer, keeping the draft"
              aria-label="Close the composer"
              onClick={() => { void closeMailComposer(); }}
            >
              <span className="mail-compose-close-glyph" aria-hidden="true">&times;</span>
            </button>
          </div>

          {showing === 'status' ? (
            <SendStatusCard
              composer={composer}
              inboxMailboxId={inbox}
              onDiscard={askDiscard}
            />
          ) : (
            <ComposerForm
              composer={composer}
              canSend={canSend}
              cannotSendTitle={cannotSendTitle}
            />
          )}
        </div>
      </div>

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

function ComposerForm({ composer, canSend, cannotSendTitle }: {
  composer: MailComposer;
  canSend: boolean;
  cannotSendTitle: string;
}) {
  const { fields } = composer;
  const invalid = hasInvalidAddress([...fields.to, ...fields.cc, ...fields.bcc]);
  const sendable = canSend && !invalid && !composer.busy && !NO_SEND_PHASES.includes(composer.status.phase);
  const sendTitle = canSend
    ? (invalid ? 'Fix the addresses in red first' : 'Send this message now (⌘↩)')
    : cannotSendTitle;

  // ⌘↩ from anywhere in the form, which is what the Send button's title promises. A shortcut
  // advertised in a tooltip and implemented nowhere is the confident wrong answer this repo bans.
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'Enter' || !(event.metaKey || event.ctrlKey)) return;
    if (!sendable) return;
    event.preventDefault();
    void sendMailNow();
  };

  return (
    <div className="mail-compose-form" onKeyDown={onKeyDown}>
      <div className="mail-compose-scroll">
        <div className="mail-compose-rows">
          {/* A new message needs a recipient first; a reply already has one, so its caret goes to
              the body. Two fields racing for focus would decide it by mount order. */}
          <AddressChipsField
            label="To"
            name="to"
            chips={fields.to}
            autoFocus={!composer.replyTo}
            onChange={(to) => setMailComposerFields({ to })}
            trailing={(!composer.showCc || !composer.showBcc) ? (
              <span className="mail-compose-reveals">
                {!composer.showCc && (
                  <button type="button" className="mail-text-btn" data-testid="mail-compose-add-cc" onClick={() => toggleMailComposerField('showCc')}>
                    Cc
                  </button>
                )}
                {!composer.showBcc && (
                  <button type="button" className="mail-text-btn" data-testid="mail-compose-add-bcc" onClick={() => toggleMailComposerField('showBcc')}>
                    Bcc
                  </button>
                )}
              </span>
            ) : undefined}
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

          <div className="mail-compose-field">
            <label className="mail-compose-label" htmlFor="mail-compose-subject">Subject</label>
            <input
              id="mail-compose-subject"
              className="mail-compose-input mail-compose-subject"
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
            <span className="mail-compose-quote-label">
              {composer.intent === 'forward' ? 'Forwarded below your note' : 'Quoted below your reply'}
            </span>
            <pre className="mail-compose-quote-text">{composer.quote}</pre>
          </div>
        )}

        {composer.notice && (
          <p className="mail-compose-notice" data-testid="mail-compose-notice">{composer.notice}</p>
        )}
      </div>

      <div className="mail-compose-footer">
        <span className="mail-compose-status">
          <span className="mail-compose-save" data-testid="mail-compose-save" data-state={composer.save}>
            {SAVE_TEXT[composer.save]}
          </span>
          <span className="mail-compose-hint">Markdown is rendered on send</span>
        </span>
        {!NO_SEND_PHASES.includes(composer.status.phase) && (
          <>
            {/* Drawn and disabled: the send contract carries no attachment part yet, and a control
                that cannot do what it appears to offer is worse than a control that says so. */}
            <button
              type="button"
              className="mail-round-btn"
              data-testid="mail-compose-attachments"
              disabled
              title="Attachments are coming"
            >
              <ClipIcon size={15} />
              <span className="mail-visually-hidden">Attachments are not supported yet</span>
            </button>
            <button
              type="button"
              className="mail-compose-btn"
              data-testid="mail-compose-ask"
              disabled={!sendable}
              title={canSend ? 'Ask for approval on the phone before this goes out' : cannotSendTitle}
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
              <SentIcon size={14} />
              {composer.busy ? 'Sending…' : 'Send'}
            </button>
          </>
        )}
      </div>
    </div>
  );
}

/**
 * The body: the rest of the card, growing with what is in it.
 *
 * `useLayoutEffect` rather than an effect, because a height applied after paint is a visible jump on
 * every keystroke. There is no max height any more: the card's own scroll area holds it, so a long
 * mail scrolls the form rather than growing a second scrollbar inside the field.
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
      value={value}
      placeholder="Write your message"
      onChange={(event) => onChange(event.target.value)}
    />
  );
}
