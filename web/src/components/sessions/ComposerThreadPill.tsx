/**
 * The composer's question chip (Conversation Mode): where the next send goes,
 * said in the box like a quote, with a × to let go of it. One timeline shows
 * every question, so a placeholder alone ("Reply in …") hid the choice; the
 * user asked to see it and to take it back (2026-10-03). The title reopens the
 * question's card; × sends the composer (and what is typed) to the main
 * conversation, and an Ask not sent yet goes with it.
 */
import { memo } from 'react';
import type { ComposerTarget } from '@/hooks/useSessionThreads';
import '@/styles/thread-map.css';
import '@/styles/thread-card.css';

export interface ComposerThreadPillProps {
  target: ComposerTarget;
  onOpen: (key: string) => void;
  onClear: () => void;
}

export const ComposerThreadPill = memo(function ComposerThreadPill({ target, onOpen, onClear }: ComposerThreadPillProps) {
  const verb = target.pending ? 'Asking about' : 'Replying in';
  return (
    <div className="chat-input-task-pill chat-input-thread-pill" data-testid="composer-thread-target" data-pending={target.pending ? 'true' : undefined}>
      <button
        type="button"
        className="pill-close"
        onClick={onClear}
        title="Send to the main conversation instead"
        aria-label="Send to the main conversation instead"
        data-testid="composer-thread-target-clear"
      >
        &times;
      </button>
      <span className="pill-verb">{verb}</span>
      <button
        type="button"
        className="pill-target"
        onClick={() => onOpen(target.key)}
        title={`${verb} “${target.title}”: open its card`}
      >
        {target.number !== undefined && <span className="thread-map-num" aria-hidden="true">{target.number}</span>}
        <span className="pill-title">{target.pending ? `“${target.title}”` : target.title}</span>
      </button>
    </div>
  );
});
