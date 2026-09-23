/**
 * Live connect status for ONE row of Settings: Remote Hosts, plus the button that
 * starts a connect on purpose.
 *
 * Its own component so the pushed status re-renders one row, not the whole section
 * (the section owns the auto-saving host editor; re-rendering it on every phase
 * push would fight the inputs the user is typing in).
 */
import { useEffect, useState } from 'react';
import { connectHost } from '@/api/hosts';
import { seedHostStatus, useHostStatus, useHostStatusHydration } from '@/hooks/useHostStatus';
import {
  elapsedNow, formatElapsed, hostIndicatorStatus, hostStatusText, isHostConnecting, isHostFailed,
} from '@/utils/host-connect';
import { StatusIndicator } from '../inputs/StatusIndicator';
import { SettingsButton } from '../inputs/SettingsButton';
import { SettingsNotice } from '../SettingsSection';

/** Shared status text uses a typographic ellipsis; settings copy uses `...`. */
const plain = (text: string) => text.replace(/\u2026/g, '...');

export function RemoteHostStatus({ alias }: { alias: string }) {
  const status = useHostStatus(alias);
  const hydration = useHostStatusHydration();
  const [now, setNow] = useState(() => Date.now());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const inProgress = isHostConnecting(status);
  const failed = isHostFailed(status);
  // A connected host offers no connect action (F25); the button returns when it drops.
  const connected = hostIndicatorStatus(status, hydration) === 'connected' && !busy;

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
        text={busy && !inProgress ? 'Connecting...' : plain(hostStatusText(status, hydration))}
      />
      {elapsed && <span className="rh-status-elapsed">{elapsed}</span>}
      {error && <span className="rh-status-error">{error}</span>}
      {!connected && <SettingsButton
        variant="text"
        className="rh-connect-btn"
        disabled={inProgress || busy}
        reserve={['Connect now', 'Retry']}
        onClick={(e) => { e.preventDefault(); e.stopPropagation(); void connect(); }}
        title={failed ? 'Try connecting to this host again' : 'Connect to this host now'}
      >
        {failed ? 'Retry' : 'Connect now'}
      </SettingsButton>}
    </span>
  );
}

/** `<host> isn't reachable right now.` while the last connect failed. */
export function RemoteHostUnreachable({ alias, name }: { alias: string; name: string }) {
  const status = useHostStatus(alias);
  if (!isHostFailed(status)) return null;
  return <SettingsNotice kind="warn">{`${name} isn't reachable right now.`}</SettingsNotice>;
}
