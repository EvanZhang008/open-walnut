/**
 * The middle pane when the virtual Drafts row is selected.
 *
 * Every row carries its STATE, because a drafts list where "waiting for approval on the phone" and
 * "the mail server refused this" look the same is a list that hides the two things a human has to
 * act on. A sent draft is not here at all: it is in Sent, which is the mailbox that means "gone".
 */
import { ContextMenu, useContextMenu } from '@/components/common/ContextMenu';
import type { MailDraftDto } from '@/api/mail';
import { formatMailTime } from '../mail-format';
import { draftRowMenuItems } from '../mail-draft-context-items';
import { openMailDraft } from './compose-actions';
import { discardMailDraftRow } from './compose-drafts';
import { DRAFT_STATE_LABEL } from './send-status';

interface Props {
  drafts: MailDraftDto[];
  openDraftId: string | null;
  loading: boolean;
}

export function MailDraftsList({ drafts, openDraftId, loading }: Props) {
  // These rows carry `mail-row` and look exactly like message rows, so they owe the same gesture: the
  // shared primitive, the shared native-menu rules, and a heading naming the draft (the menu covers the
  // row it is about). See `mail-draft-context-items.ts` for why the items are not the message menu's.
  const menu = useContextMenu<MailDraftDto>();
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
          data-ctx-open={menu.state?.payload.draftId === draft.draftId ? 'true' : undefined}
          onClick={() => { void openMailDraft(draft); }}
          onContextMenu={(event) => { menu.open(event, draft); }}
        >
          <span className="mail-row-top">
            <span className="mail-row-from">
              {draft.to.map((one) => one.name || one.address).join(', ') || 'No recipient yet'}
            </span>
            <span className="mail-row-time">{formatMailTime(draft.updatedAt)}</span>
          </span>
          <span className="mail-row-subject">
            <span className="mail-row-subject-text">{draft.subject || '(no subject)'}</span>
            <span className={`mail-draft-pill state-${draft.state}`} data-testid="mail-draft-pill">
              {DRAFT_STATE_LABEL[draft.state]}
            </span>
          </span>
          <span className="mail-row-snippet">
            {draft.error || firstLine(draft.bodyMarkdown) || 'Nothing written yet'}
          </span>
        </button>
      ))}
      {menu.state && (
        <ContextMenu
          point={menu.state.point}
          ariaLabel="Draft actions"
          testId="mail-draft-ctx-menu"
          onClose={menu.close}
          items={draftRowMenuItems(
            {
              draftId: menu.state.payload.draftId,
              subject: menu.state.payload.subject || '',
              recipients: menu.state.payload.to
                .map((one) => one.name || one.address).join(', '),
              open: menu.state.payload.draftId === openDraftId,
            },
            {
              onEdit: () => { void openMailDraft(menu.state!.payload); },
              onDiscard: () => {
                const row = menu.state!.payload;
                void discardMailDraftRow(row.accountId, row.draftId);
              },
            },
          )}
        />
      )}
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
