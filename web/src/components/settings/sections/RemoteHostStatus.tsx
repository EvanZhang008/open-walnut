/**
 * Live connect status for ONE row of Settings › Remote hosts, plus the button that
 * starts a connect on purpose.
 *
 * Its own component so the pushed status re-renders one row, not the whole section
 * (the section owns the auto-saving host editor — re-rendering it on every phase
 * push would fight the inputs the user is typing in).
 */
import { useEffect, useState } from 'react';
import { connectHost } from '@/api/hosts';
import { seedHostStatus, useHostStatus, useHostStatusHydration } from '@/hooks/useHostStatus';
import {
  elapsedNow, formatElapsed, hostIndicatorStatus, hostStatusText, isHostConnecting, isHostFailed,
} from '@/utils/host-connect';
import { StatusIndicator } from '../inputs/StatusIndicator';

export function RemoteHostStatus({ alias }: { alias: string }) {
  const status = useHostStatus(alias);
  const hydration = useHostStatusHydration();
  const [now, setNow] = useState(() => Date.now());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const inProgress = isHostConnecting(status);
  const failed = isHostFailed(status);

  // Tick only while something is actually running: a settled row must not keep a
  // timer alive per host for the whole time the Settings page is open.
  useEffect(() => {
    if (!inProgress) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [inProgress]);

  const connect = async () => {
    setBusy(true);
    setError(null);
    try {
      seedHostStatus(await connectHost(alias));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const elapsed = inProgress && status
    ? formatElapsed(elapsedNow(status.connectElapsedMs, status.at, now))
    : failed && status?.retryInMs
      ? `retry in ${formatElapsed(status.retryInMs)}`
      : '';

  return (
    <span className="rh-status" data-host={alias}>
      {/* While the POST is in flight the store has not moved yet, so the row would
          otherwise still read "Not connected" under a pulsing dot. */}
      <StatusIndicator
        status={busy && !inProgress ? 'testing' : hostIndicatorStatus(status, hydration)}
        text={busy && !inProgress ? 'Connecting…' : hostStatusText(status, hydration)}
      />
      {elapsed && <span className="rh-status-elapsed">{elapsed}</span>}
      {error && <span className="rh-status-error">{error}</span>}
      <button
        type="button"
        className="rh-connect-btn"
        disabled={inProgress || busy}
        // Inside a <summary>: without both of these, connecting also toggles the
        // host editor open/closed under the user's cursor.
        onClick={(e) => { e.preventDefault(); e.stopPropagation(); void connect(); }}
        title={failed ? 'Try connecting to this host again' : 'Connect to this host now'}
      >
        {failed ? 'Retry' : 'Connect now'}
      </button>
    </span>
  );
}
