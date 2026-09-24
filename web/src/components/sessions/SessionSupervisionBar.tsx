import { useCallback, useSyncExternalStore } from 'react';
import { useEvent } from '@/hooks/useWebSocket';
import { useActiveSessionCron } from '@/hooks/useSessionStatus';
import {
  changeSessionSupervision, getSessionSupervision, refreshSessionSupervision,
  subscribeSessionSupervision, type SupervisionSnapshot,
} from '@/stores/session-supervision-store';
import '@/styles/session-supervision.css';

const STATE_LABELS = {
  watching: 'Cron recovery active',
  restarting: 'Restarting session',
  checking: 'Checking cron recovery',
  disabled: 'Automatic recovery off',
  inactive: 'No recoverable cron',
  blocked: 'Automatic recovery blocked',
};

const STARTUP_LABELS = {
  boot: 'Host starts daemon at boot',
  login: 'Host starts daemon at login',
  'on-demand': 'Daemon starts on demand',
  service: 'Service running; startup not verified',
  unavailable: 'Host unavailable',
};

const REASONS: Record<string, string> = {
  'scheduler-unconfirmed': 'Process is alive; automatic recovery readiness is not confirmed.',
  'unknown-evidence': 'Process or cron state could not be confirmed. No extra process will be started.',
  'missing-launch-spec': 'Original launch settings are missing. Start the session manually before enabling recovery.',
  'retry-budget-exhausted': 'The automatic restart limit was reached. Check the host before retrying.',
  'unsupported-cli-version': 'This CLI version has not been verified for automatic cron recovery.',
  'recovery-input-missing': 'The CLI, working directory, or session transcript is missing.',
  'cwd-unavailable': 'The original working directory is unavailable.',
  'hooks-unavailable': 'The original hook policy is unavailable. Recovery will not start with different permissions.',
  'unsupported-launch-arguments': 'The original launch options cannot be restored automatically.',
  'retry-backoff': 'Waiting before the next restart attempt.',
  'launch-failed': 'The last start attempt failed. Recovery will retry within its limit.',
  'no-active-cron': 'No unexpired session-only cron can be restored.',
  'user-disabled': 'Running CLI processes are left alone. Use Terminate to end the session.',
};

export function useSessionSupervision(sid: string): SupervisionSnapshot {
  const subscribe = useCallback((listener: () => void) => subscribeSessionSupervision(sid, listener), [sid]);
  const read = useCallback(() => getSessionSupervision(sid), [sid]);
  const snapshot = useSyncExternalStore(subscribe, read, read);
  useEvent('session:status-changed', (data) => {
    const event = data as { sessionId?: string };
    if (event.sessionId === sid) void refreshSessionSupervision(sid);
  });
  useEvent('_ws:reconnected', () => { void refreshSessionSupervision(sid); });
  return snapshot;
}

/**
 * Renders only when recovery needs a human: a stop in flight, an error, a
 * blocked or failed restart, a host that went unavailable, or recovery running
 * for a session whose cron badge is gone. The calm case lives in CronJobsCard.
 */
export function SessionSupervisionBar({ sid, snapshot, onRetryStop, archived }: {
  sid: string;
  snapshot: SupervisionSnapshot;
  onRetryStop: () => void;
  archived?: boolean;
}) {
  const { value, error, unavailable, writing, stopping, stopPending, requestedEnabled } = snapshot;
  const supervision = value?.supervision;
  const activeCron = useActiveSessionCron(sid);
  const recovering = supervision?.enabled && ['watching', 'checking', 'restarting'].includes(supervision.state);
  const forced = stopPending || stopping || !!error || supervision?.state === 'blocked'
    || supervision?.reason === 'launch-failed' || (supervision && (unavailable || value?.available === false))
    || (recovering && !activeCron);
  if (!forced) return null;
  const enabled = requestedEnabled ?? supervision?.enabled ?? false;
  const stale = unavailable || value?.available === false;
  const title = stopping ? 'Requesting stop'
    : stopPending ? 'Stop pending host confirmation'
    : stale ? 'Recovery status unavailable'
    : supervision ? STATE_LABELS[supervision.state] : 'Automatic recovery';
  const detail = stopping || stopPending
    ? 'The session may still run until its host confirms the stop. Automatic recovery will also be disabled.'
    : supervision?.reason ? REASONS[supervision.reason] ?? supervision.reason : '';
  const change = (next: boolean) => { void changeSessionSupervision(sid, next); };
  return (
    <section className="session-supervision" aria-label="Cron recovery" data-state={stopPending ? 'stop-pending' : supervision?.state ?? 'unknown'}>
      <div className="session-supervision-heading">
        <strong role="status">{title}</strong>
        {supervision && !archived && (
          <label className="session-supervision-toggle" title="Only changes automatic recovery; it does not stop a running session">
            <input type="checkbox" role="switch" aria-label="Automatic cron recovery" checked={enabled}
              disabled={writing || stopPending || stale} onChange={(event) => change(event.target.checked)} />
            Auto-recover
          </label>
        )}
      </div>
      {detail && <p>{detail}</p>}
      {error && <p role="alert">{error}</p>}
      <div className="session-supervision-footer">
        <span>{STARTUP_LABELS[value?.startup ?? 'unavailable']}</span>
        {requestedEnabled !== null && <span role="status">Saving…</span>}
        {supervision?.retryAt && !stopPending && <span>Retry after {new Date(supervision.retryAt).toLocaleTimeString()}</span>}
        {stopPending ? (
          <button type="button" disabled={writing} onClick={onRetryStop}>Retry stop</button>
        ) : supervision?.state === 'blocked' && value?.available && !unavailable && !archived ? (
          <button type="button" disabled={writing} onClick={() => change(true)}>Retry recovery</button>
        ) : error ? (
          <button type="button" disabled={writing} onClick={() => { void refreshSessionSupervision(sid); }}>Check again</button>
        ) : null}
      </div>
    </section>
  );
}
