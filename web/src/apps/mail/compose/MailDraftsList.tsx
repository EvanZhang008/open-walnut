/**
 * The middle pane when the virtual Drafts row is selected.
 *
 * Every row carries its STATE, because a drafts list where "waiting for approval on the phone" and
 * "the mail server refused this" look the same is a list that hides the two things a human has to
 * act on. A sent draft is not here at all: it is in Sent, which is the mailbox that means "gone".
 */
import type { MailDraftDto } from '@/api/mail';
import { formatMailTime } from '../mail-format';
import { openMailDraft } from './compose-actions';
import { DRAFT_STATE_LABEL } from './send-status';

interface Props {
  drafts: MailDraftDto[];
  openDraftId: string | null;
  loading: boolean;
}

export function MailDraftsList({ drafts, openDraftId, loading }: Props) {
  if (drafts.length === 0) {
    return (
      <p className="mail-pane-empty" data-testid="mail-drafts-empty">
        {loading ? 'Loading…' : 'No drafts. Start one with New message.'}
      </p>
    );
  }
  return (
    <>
      {drafts.map((draft) => (
        <button
          type="button"
          key={draft.draftId}
          className={`mail-row mail-draft-row${draft.draftId === openDraftId ? ' selected' : ''}`}
          data-testid="mail-draft-row"
          data-draft-id={draft.draftId}
          data-state={draft.state}
          onClick={() => { void openMailDraft(draft); }}
        >
          <span className="mail-row-top">
            <span className="mail-row-from">
              {draft.to.map((one) => one.name || one.address).join(', ') || 'No recipient yet'}
            </span>
            <span className="mail-row-time">{formatMailTime(draft.updatedAt)}</span>
          </span>
          <span className="mail-row-subject">
            {draft.subject || '(no subject)'}
            <span className={`mail-draft-pill state-${draft.state}`} data-testid="mail-draft-pill">
              {DRAFT_STATE_LABEL[draft.state]}
            </span>
          </span>
          <span className="mail-row-snippet">
            {draft.error || firstLine(draft.bodyMarkdown) || 'Nothing written yet'}
          </span>
        </button>
      ))}
    </>
  );
}

/** The first line that says something, so a row is not just the quote of a reply. */
function firstLine(body: string): string {
  for (const line of body.split('\n')) {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith('>')) return trimmed;
  }
  return '';
}
