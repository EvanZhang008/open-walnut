/**
 * Conversation Mode: the ONE line above a question's turn that says which
 * question it is (its number, its title, its status). The bubble and the answer
 * below it carry nothing else; a grey rule down the turn's left edge groups
 * them (`.session-msg--threaded`). A click makes the question the composer's
 * target (the next message is a follow-up on it) without leaving the view.
 */
import { memo } from 'react';
import { ThreadStatusWord } from '@/components/sessions/ThreadStatusWord';
import type { ThreadViewStatus } from '@/utils/thread-meta';
import '@/styles/thread-stack.css';

export interface ThreadTurnLabelProps {
  threadKey: string;
  number: number | undefined;
  title: string;
  naming?: boolean;
  status: ThreadViewStatus | undefined;
  unread?: boolean;
  current: boolean;
  /** The turn was filed by send order, not by the reply's own tag. */
  byOrder?: boolean;
  onSelect: (key: string) => void;
}

export const ThreadTurnLabel = memo(function ThreadTurnLabel(p: ThreadTurnLabelProps) {
  return (
    <button
      type="button"
      className="thread-turn-label"
      data-current={p.current ? 'true' : undefined}
      title={p.current ? `Replying in “${p.title}”` : `Reply in “${p.title}”`}
      onClick={() => p.onSelect(p.threadKey)}
    >
      {p.number !== undefined && <span className="thread-map-num" aria-hidden="true">{p.number}</span>}
      <span className="thread-turn-label-title">{p.title}</span>
      {p.naming && <span className="thread-naming">Naming…</span>}
      <ThreadStatusWord status={p.status} unread={!!p.unread} className="thread-turn-label-status" />
      {p.byOrder && <span className="thread-turn-label-by" title="Filed by send order: the reply carried no question tag">by order</span>}
    </button>
  );
});
