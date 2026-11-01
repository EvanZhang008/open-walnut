/**
 * The quotes and comments waiting for the next send, right above the composer
 * (2026-11-01, the user's sketch: one row each, at most three in view, scroll for
 * more, each saying where it was left; the composer itself holds only what he
 * types). A row's click shows its passage in the timeline; × takes it out.
 */
import type { SessionPassageComment } from '@/types/session';
import { countLabel, snippetOf } from '@/utils/passage-comments';
import '@/styles/passage-comments.css';

interface Props {
  pending: SessionPassageComment[];
  onJump: (id: string) => void;
  onRemove: (id: string) => void;
}

export function PendingCommentsTray({ pending, onJump, onRemove }: Props) {
  if (pending.length === 0) return null;
  return (
    <div className="pending-comments" data-testid="pending-comments" aria-label="Quotes and comments for your next message">
      <div className="pending-comments-head">
        <span className="pending-comments-count" data-testid="pending-comments-count">{countLabel(pending)}</span>
        <span className="pending-comments-hint">Sent with your next message</span>
      </div>
      <ul className="pending-comments-list">
        {pending.map((c) => (
          <li key={c.id} className="pending-comments-row" data-testid="pending-comment-row" data-comment-id={c.id}>
            <button
              type="button"
              className="pending-comments-jump"
              onClick={() => onJump(c.id)}
              title="Show where it was left"
            >
              <span className="pending-comments-where" title={c.text}>❝ {snippetOf(c.text, 60)}</span>
              {c.comment
                ? <span className="pending-comments-text" title={c.comment}>{snippetOf(c.comment, 120)}</span>
                : <span className="pending-comments-text is-quote">Quote</span>}
            </button>
            <button
              type="button"
              className="pending-comments-remove"
              aria-label="Remove"
              title="Remove"
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
