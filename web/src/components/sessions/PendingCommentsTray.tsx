/**
 * The quotes and comments waiting for the next send, right above the composer
 * (2026-11-01, the user's sketch: one row each, at most three in view, scroll for
 * more, each saying where it was left; the composer itself holds only what he
 * types). A row's click shows its passage in the timeline, or opens the doc a
 * doc comment is on; the pencil opens the passage's card with its words in the
 * editor (a doc comment is edited in its doc); × takes it out (a doc comment stays
 * in its doc, it just does not go to the AI).
 */
import type { SessionPassageComment } from '@/types/session';
import { countLabel, snippetOf } from '@/utils/passage-comments';
import '@/styles/passage-comments.css';

interface Props {
  pending: SessionPassageComment[];
  onJump: (id: string) => void;
  /** Edit its words in its card (not offered for a doc's: those are edited in the doc); `origin` = the row's top middle. */
  onEdit?: (id: string, origin: { x: number; y: number }) => void;
  onRemove: (id: string) => void;
}

/** Rows in view before the list scrolls (the user's rule: three in view). */
const IN_VIEW = 3;

export function PendingCommentsTray({ pending, onJump, onEdit, onRemove }: Props) {
  if (pending.length === 0) return null;
  return (
    <div className="pending-comments" data-testid="pending-comments" aria-label="Quotes and comments for your next message">
      <div className="pending-comments-head">
        <span className="pending-comments-count" data-testid="pending-comments-count">{countLabel(pending)}</span>
        <span className="pending-comments-hint">
          Sent with your next message{pending.length > IN_VIEW ? <><span aria-hidden="true"> · </span>scroll for all {pending.length}</> : null}
        </span>
      </div>
      <ul className="pending-comments-list" data-more={pending.length > IN_VIEW ? '' : undefined}>
        {pending.map((c) => (
          <li key={c.id} className="pending-comments-row" data-testid="pending-comment-row" data-comment-id={c.id}>
            <button
              type="button"
              className="pending-comments-jump"
              data-kind={c.comment ? 'comment' : 'quote'}
              onClick={() => onJump(c.id)}
              title="Show where it was left"
            >
              {/* Every row the same shape: what it is, the words it is on, then the comment. */}
              <span className="pending-comments-kind">{c.comment ? 'Comment' : 'Quote'}</span>
              {c.doc && (
                <span className="pending-comments-doc" title={c.doc.path}>
                  {c.doc.path.slice(c.doc.path.lastIndexOf('/') + 1)}{c.doc.reply ? ' · reply' : ''}
                </span>
              )}
              <span className="pending-comments-where" title={c.text}>❝ {snippetOf(c.text, 60)}</span>
              {c.comment && <><span className="pending-comments-sep" aria-hidden="true">→</span><span className="pending-comments-text" title={c.comment}>{snippetOf(c.comment, 120)}</span></>}
            </button>
            {onEdit && !c.doc && (
              <button
                type="button"
                className="pending-comments-edit"
                aria-label={c.comment ? 'Edit comment' : 'Add a comment'}
                title={c.comment ? 'Edit comment' : 'Add a comment'}
                data-testid="pending-comment-edit"
                onClick={(e) => {
                  const row = (e.currentTarget.closest('.pending-comments-row') ?? e.currentTarget).getBoundingClientRect();
                  onEdit(c.id, { x: Math.round(row.left + row.width / 2), y: Math.round(row.top) });
                }}
              >
                <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M11.2 2.3a1.6 1.6 0 012.3 2.3L5.3 12.8 2 13.9l1.1-3.3z" />
                </svg>
              </button>
            )}
            <button
              type="button"
              className="pending-comments-remove"
              aria-label={c.doc ? 'Do not send' : 'Remove'}
              title={c.doc ? 'Do not send it (it stays in the doc)' : 'Remove'}
              data-testid="pending-comment-remove"
              onClick={() => onRemove(c.id)}
            >
              ×
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
