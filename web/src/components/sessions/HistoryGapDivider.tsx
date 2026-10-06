/**
 * The mark where loaded history has a hole in it (history-gap.ts): one turn grew
 * past what the server reads in one go, so the rows before it and the fresh tail
 * after it are both shown, with this line between them until older pages fill it.
 */
import type { GapFillState } from '@/hooks/useSessionHistory';

export function HistoryGapDivider({ state, onLoad }: { state?: GapFillState; onLoad: () => void }) {
  return (
    <div className="session-gap-divider" data-testid="session-history-gap" data-state={state ?? 'idle'}>
      <span className="session-gap-divider-label">
        {state === 'loading' ? 'Loading the messages here…'
          : state === 'unavailable' ? 'The messages here are too large to load.'
            : state === 'failed' ? 'Could not load the messages here.'
              : 'Some messages here are not loaded.'}
      </span>
      {state !== 'loading' && state !== 'unavailable' && (
        <button type="button" className="session-gap-divider-btn" onClick={onLoad}>
          {state === 'failed' ? 'Try again' : 'Load them'}
        </button>
      )}
    </div>
  );
}
