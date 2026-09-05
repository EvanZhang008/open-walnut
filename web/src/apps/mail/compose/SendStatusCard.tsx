/**
 * What the composer becomes once a human has been asked: one card, one honest sentence, and only
 * the controls that can truthfully do something.
 *
 * The rule the card exists to keep is that `unknown` gets NO retry button. An `unknown` send is one
 * where the transport had begun accepting the message when it failed, SMTP has no dedupe, and only
 * the Sent folder can settle it, so a Try again here is an invitation to send the same mail twice.
 * The server refuses that retry with a 409; this is the half that never offers it.
 */
import { DraftsIcon } from '../mail-icons';
import { selectMailbox } from '../mail-actions';
import type { MailComposer } from '../mail-store';
import {
  canRetry,
  clockOf,
  statusDetail,
  statusHeadline,
} from './send-status';
import { closeMailComposer, editMailComposerDraft } from './compose-actions';
import { retryMailComposerSend } from './compose-send';

interface Props {
  composer: MailComposer;
  /** The account's inbox, for the way out of a finished send. */
  inboxMailboxId: string | undefined;
  /** Throwing a draft away asks once, and the panel owns that dialog for both halves. */
  onDiscard: () => void;
}

export function SendStatusCard({ composer, inboxMailboxId, onDiscard }: Props) {
  const { status, busy } = composer;
  const backToInbox = () => {
    if (inboxMailboxId) selectMailbox(composer.accountId, inboxMailboxId);
    void closeMailComposer();
  };

  return (
    <div className="mail-send-status" data-testid="mail-send-status" data-phase={status.phase}>
      <div className="mail-send-status-icon" aria-hidden="true"><DraftsIcon size={22} /></div>
      <h3 className="mail-send-status-headline" data-testid="mail-send-headline">
        {statusHeadline(status)}
      </h3>
      <p className="mail-send-status-detail">{statusDetail(status)}</p>

      <dl className="mail-send-status-meta">
        <dt>To</dt>
        <dd data-testid="mail-send-to">
          {composer.draft?.to.map((one) => one.address).join(', ') || '(nobody)'}
        </dd>
        <dt>Subject</dt>
        <dd>{composer.draft?.subject || '(no subject)'}</dd>
        {status.letterId && (
          <>
            <dt>Letter</dt>
            <dd className="mail-send-letter-id" data-testid="mail-send-letter">{status.letterId}</dd>
          </>
        )}
        {status.settledAt && status.phase !== 'sent' && (
          <>
            <dt>Settled</dt>
            <dd>{clockOf(status.settledAt)}</dd>
          </>
        )}
      </dl>

      {composer.notice && <p className="mail-compose-notice" data-testid="mail-send-notice">{composer.notice}</p>}

      <div className="mail-send-status-actions">
        {status.phase === 'waiting' && (
          // There is no global per-letter URL (the only letter deep link is into a SESSION's inbox
          // tab, and a plugin letter has no session), so this opens the inbox where it is waiting.
          <button
            type="button"
            className="mail-compose-btn"
            data-testid="mail-send-show-letter"
            onClick={() => window.dispatchEvent(new CustomEvent('notification:open-center'))}
          >
            Show it in Notifications
          </button>
        )}
        {canRetry(status) && (
          <button
            type="button"
            className="mail-compose-btn primary"
            data-testid="mail-send-retry"
            disabled={busy}
            onClick={() => { void retryMailComposerSend(); }}
          >
            {busy ? 'Asking…' : 'Try again'}
          </button>
        )}
        {status.phase === 'sent' ? (
          <button
            type="button"
            className="mail-compose-btn primary"
            data-testid="mail-send-back"
            onClick={backToInbox}
          >
            Back to inbox
          </button>
        ) : status.phase === 'discarded' ? (
          <button type="button" className="mail-compose-btn" onClick={closeMailComposer}>Close</button>
        ) : (
          <>
            <button
              type="button"
              className="mail-compose-btn"
              data-testid="mail-send-edit"
              disabled={busy || status.phase === 'sending'}
              onClick={editMailComposerDraft}
            >
              Edit
            </button>
            <button
              type="button"
              className="mail-compose-btn danger"
              data-testid="mail-send-discard"
              disabled={busy || status.phase === 'sending'}
              onClick={onDiscard}
            >
              Discard
            </button>
          </>
        )}
      </div>
    </div>
  );
}
