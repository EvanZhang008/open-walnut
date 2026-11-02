/**
 * The two content actions as buttons (Talk to CEO, New task), each showing its own progress.
 * Walnut's own surfaces render it (the Mail reader, an Inbox letter's email item), and plugins
 * get it as `walnut.ui.views.ContentActions`.
 */
import { useState, type ReactElement } from 'react';
import { contentActions, type ContentActionId, type ContentItem } from '@/utils/content-actions';
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
  return (
    <div className={`content-actions content-actions-${size}${className ? ` ${className}` : ''}`} role="group" aria-label="What to do with this">
      {contentActions(item).map((action) => (
        <button
          key={action.id}
          type="button"
          className={buttonClassName ?? 'content-action-btn'}
          data-testid={`content-action-${action.id}`}
          data-label={action.label}
          data-state={busy === action.id ? 'busy' : done === action.id ? 'done' : undefined}
          disabled={busy !== null}
          title={done === action.id && action.id === 'talk_to_ceo' ? 'Sent to the CEO. Send again to hand it over once more.' : action.description}
          aria-label={`${action.label}: ${item.title}`}
          onClick={() => {
            setBusy(action.id);
            setDone(null);
            // The outcome is a toast (utils/content-actions.ts); a failure leaves the button ready again.
            void action.run().then(() => setDone(action.id), () => { /* toasted */ }).finally(() => setBusy(null));
          }}
        >
          {ICONS[action.id]}
          {size === 'buttons' && <span>{busy === action.id ? (action.id === 'talk_to_ceo' ? 'Sending…' : 'Opening…') : done === action.id && action.id === 'talk_to_ceo' ? 'Sent to CEO' : action.label}</span>}
        </button>
      ))}
    </div>
  );
}
