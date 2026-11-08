/**
 * The desktop's line when the console cannot talk to its Walnut server (the phone has
 * PhoneStatusRow under its top bar). After 5 s with no socket it says so plainly, and it
 * goes away by itself when the server answers again: the page is never reloaded, and every
 * store refetches on `_ws:reconnected`. D13: the Walnut Demo server was stopped and the page
 * went on as if nothing had happened; after `walnut demo` brought it back, Files still said
 * "Load failed".
 */
import { useResyncState, runPhoneResync } from '@/hooks/usePhoneResync';
import { isDemoOrigin } from '@/utils/demo-generation';
import '@/styles/away-line.css';

export const OFFLINE_LINE = 'Walnut is not answering. This page reconnects on its own when it is back.';
export const DEMO_OFFLINE_LINE = 'Walnut Demo is not running. To start it again, run walnut demo in a terminal; this page reconnects on its own.';

/** Which sentence the line shows (pure, unit tested). A host server answering alone is AwayLine's to say. */
export function connectionLineText(state: { offline: boolean; macAway: boolean }, demo: boolean): string | null {
  if (state.macAway || !state.offline) return null;
  return demo ? DEMO_OFFLINE_LINE : OFFLINE_LINE;
}

export function ConnectionLine() {
  const state = useResyncState();
  const text = connectionLineText(state, isDemoOrigin());
  if (!text) return null;
  return (
    <div className="away-line connection-line" role="status" aria-live="polite" data-testid="connection-line">
      <span className="away-line-text">{text}</span>
      <button
        type="button"
        className="connection-line-btn"
        disabled={state.syncing}
        onClick={() => { void runPhoneResync('retry'); }}
      >
        Try now
      </button>
    </div>
  );
}
