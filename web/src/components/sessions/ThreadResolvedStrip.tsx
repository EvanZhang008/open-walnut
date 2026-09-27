/**
 * The strip after a question's turns (spec 4 item 5, 5.7, 7.6):
 *  - resolved: `Takeaway` + the text; clicking the text edits it inline on one
 *    line (<= 280 chars, Enter saves, Esc cancels, `title="Edit takeaway"`),
 *    saved as the user's (the AI never overwrites it after that, C46). While
 *    Done waits for a streaming answer: `Summarizing when the answer finishes`.
 *  - suggested: nothing here. The page header already carries `Looks answered`
 *    + `Mark done` / `Not yet`: one set of verdict buttons per page (N30).
 *  - failed: `No answer` + the failed-turn hint + `Retry` (spec 5.10, the in-page
 *    twin of the Asked-from row's Retry); when the last message is a parked
 *    follow-up, `Not sent yet` and no button (its row has Retry, N41).
 * Anything else renders nothing.
 */
import { useState } from 'react';
import type { ThreadResolvedStripProps } from '@/components/sessions/thread-ui-contract';
import { ThreadInlineRename } from '@/components/sessions/ThreadInlineRename';
import { TAKEAWAY_MAX } from '@/utils/thread-meta';
import '@/styles/thread-stack.css';

export const TAKEAWAY_WAITING = 'Summarizing when the answer finishes';
export const FAILED_TURN_HINT = 'The last turn ended before an answer arrived.';
export const PARKED_LABEL = 'Not sent yet';
export const PARKED_HINT = 'Retry or discard the follow-up below.';

export function ThreadResolvedStrip({ threadKey, meta, viewStatus, takeawayWaiting, actions, onRetry, parked }: ThreadResolvedStripProps) {
  const [editing, setEditing] = useState(false);

  // A parked follow-up was never sent: no turn ended, and the row has the one
  // Retry (N41).
  if (viewStatus === 'failed' && parked) {
    return (
      <div className="thread-strip thread-strip--failed" data-thread-strip="parked" role="status">
        <span className="thread-strip-label">{PARKED_LABEL}</span>
        <span className="thread-strip-waiting">{PARKED_HINT}</span>
      </div>
    );
  }

  if (viewStatus === 'failed') {
    return (
      <div className="thread-strip thread-strip--failed" data-thread-strip="failed" role="status">
        <span className="thread-strip-label">No answer</span>
        <span className="thread-strip-waiting">{FAILED_TURN_HINT}</span>
        {onRetry && (
          <button type="button" className="thread-strip-btn thread-strip-btn--primary" onClick={onRetry}>Retry</button>
        )}
      </div>
    );
  }

  if (viewStatus !== 'resolved') return null;
  const text = meta?.takeaway?.trim() ?? '';
  const waiting = takeawayWaiting || (meta?.takeawayState === 'pending' && !text);
  if (!waiting && !text) return null;

  return (
    <div className="thread-strip thread-strip--resolved" data-thread-strip="resolved">
      <span className="thread-strip-label">Takeaway</span>
      {waiting ? (
        <span className="thread-strip-waiting">{TAKEAWAY_WAITING}</span>
      ) : editing ? (
        <ThreadInlineRename
          initial={text}
          max={TAKEAWAY_MAX}
          ariaLabel="Edit takeaway"
          className="thread-strip-input"
          onSave={(t) => { setEditing(false); if (t) void actions.editTakeaway(threadKey, t); }}
          onCancel={() => setEditing(false)}
        />
      ) : (
        <button type="button" className="thread-strip-text" title="Edit takeaway" onClick={() => setEditing(true)}>
          {text}
        </button>
      )}
    </div>
  );
}
