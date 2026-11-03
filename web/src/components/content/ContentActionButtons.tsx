/**
 * The two content actions as buttons (Talk to CEO, New task). Talk to CEO opens the box under the
 * button (CeoComposer) and reads Sent once the person sent it; New task opens the draft. Walnut's
 * own surfaces render it (the Mail reader, an Inbox letter's email item), and plugins get it as
 * `walnut.ui.views.ContentActions`.
 */
import { useState, type ReactElement } from 'react';
import { closeCeoComposer, contentActions, openCeoComposer, type ContentActionId, type ContentItem } from '@/utils/content-actions';
import '@/styles/content-actions.css';

const ICONS: Record<ContentActionId, ReactElement> = {
  // A speech bubble: a message to someone.
  talk_to_ceo: <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M2.5 3.5h11v7h-6l-3 2.5v-2.5h-2z"/></svg>,
  // A plus in a square: something new.
  new_task: <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" aria-hidden="true"><rect x="2.5" y="2.5" width="11" height="11" rx="2"/><path d="M8 5.5v5M5.5 8h5"/></svg>,
};

export function ContentActionButtons({ item, size = 'buttons', className, buttonClassName }: {
  item: ContentItem;
  size?: 'buttons' | 'compact';
  className?: string;
  /** The host's own button style (the Mail reader's round buttons); default content-action-btn. */
  buttonClassName?: string;
}) {
  const [busy, setBusy] = useState<ContentActionId | null>(null);
  const [done, setDone] = useState<ContentActionId | null>(null);
  const [writing, setWriting] = useState(false);
  return (
    <div className={`content-actions content-actions-${size}${className ? ` ${className}` : ''}`} role="group" aria-label="What to do with this">
      {contentActions(item).map((action) => (
        <button
          key={action.id}
          type="button"
          className={buttonClassName ?? 'content-action-btn'}
          data-testid={`content-action-${action.id}`}
          data-label={action.label}
          data-state={action.id === 'talk_to_ceo' && writing ? 'open' : busy === action.id ? 'busy' : done === action.id ? 'done' : undefined}
          disabled={busy !== null}
          title={done === action.id && action.id === 'talk_to_ceo' ? 'Sent to the CEO. Click to write to the CEO about it again.' : action.description}
          aria-label={`${action.label}: ${item.title}`}
          {...(action.id === 'talk_to_ceo' ? { 'aria-haspopup': 'dialog' as const, 'aria-expanded': writing } : {})}
          onClick={(e) => {
            if (action.id === 'talk_to_ceo') {
              // A second press closes the box; otherwise it opens under this button, and nothing
              // is sent until its Send.
              if (writing) { closeCeoComposer(); return; }
              const r = e.currentTarget.getBoundingClientRect();
              setWriting(true);
              void openCeoComposer(item, { x: r.left, y: r.bottom }, e.currentTarget)
                .then((sent) => { if (sent) setDone('talk_to_ceo'); }, () => { /* no app shell */ })
                .finally(() => setWriting(false));
              return;
            }
            setBusy(action.id);
            setDone(null);
            // The outcome is a toast (utils/content-actions.ts); a failure leaves the button ready again.
            void action.run().then(() => setDone(action.id), () => { /* toasted */ }).finally(() => setBusy(null));
          }}
        >
          {ICONS[action.id]}
          {size === 'buttons' && <span>{busy === action.id ? 'Opening…' : done === action.id && action.id === 'talk_to_ceo' ? 'Sent to CEO' : action.label}</span>}
        </button>
      ))}
    </div>
  );
}
