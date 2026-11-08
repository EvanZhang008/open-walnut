/**
 * The "still connecting" row of the folder picker, as a step chain.
 *
 * A first connect to a fresh host installs a runtime and uploads the daemon, which
 * can take a minute. The old row was one spinner and one sentence, so a long
 * install was indistinguishable from a hang. This shows the whole chain (SSH →
 * Probe → Install runtime → Upload daemon → Start daemon → Tunnel → Handshake),
 * marks where it is, and ticks the elapsed clock locally so the user can see it is
 * still moving between pushes.
 *
 * Keeps the outer `.sps-host-connecting` class, `role="status"` and `data-host` of
 * the row it replaces: those are the anchors the picker's browser tests use.
 */
import { useEffect, useState } from 'react';
import type { DirListingPending } from '@/api/sessions';
import { serverNow, useHostStatus } from '@/hooks/useHostStatus';
import { connectNote, connectSteps, elapsedNow, formatElapsed, hostStatusText, reconnectReasonOf } from '@/utils/host-connect';
import { SetupProgress } from '@/components/common/SetupProgress';

interface Props {
  /** Store key / config alias. */
  hostKey: string;
  /** Human label, for the fallback sentence. */
  label: string;
  /** The list-dirs answer, used when the pushed status has not arrived yet. */
  pending?: DirListingPending;
  /** 'Last attempt: {headline}' while a reconnect retries after a failure. Absent: read off the
   *  pushed status (reconnectReasonOf), so no surface shows a bare clock with no reason. */
  lastHeadline?: string;
  /** One progress line, no step list or note: a card with several hosts (FoundHostPrompts). */
  compact?: boolean;
}

/**
 * Elapsed times come from SERVER moments (`attemptStartedAt`, `at`) against the
 * server clock (serverNow), never the moment this row mounted: a laptop waking
 * from sleep, or a browser clock hours off, must not read 'SSH · 8h'.
 */
export function connectElapsed(
  status: { phaseElapsedMs: number; connectElapsedMs: number; at: number; attemptStartedAt?: number; reconnectSince?: number; phase: string } | undefined,
  now: number,
): { phase: number; total: number } {
  if (!status) return { phase: 0, total: 0 };
  const started = status.phase === 'reconnecting' ? (status.reconnectSince ?? status.attemptStartedAt) : status.attemptStartedAt;
  const total = typeof started === 'number' ? Math.max(0, now - started) : elapsedNow(status.connectElapsedMs, status.at, now);
  const phase = Math.min(elapsedNow(status.phaseElapsedMs, status.at, now), total || Number.POSITIVE_INFINITY);
  return { phase, total };
}

export function HostConnectSteps({ hostKey, label, pending, lastHeadline, compact }: Props) {
  const status = useHostStatus(hostKey);
  // 1s tick: the server stamps an elapsed value at `at` and then goes quiet until
  // the next phase, so without this the row freezes mid-install.
  const [now, setNow] = useState(() => serverNow());
  useEffect(() => {
    const timer = setInterval(() => setNow(serverNow()), 1000);
    return () => clearInterval(timer);
  }, []);

  const steps = connectSteps(status, pending?.phase);
  const completed = steps.filter((s) => s.status === 'done').length;
  const phaseText = status ? hostStatusText(status) : (pending?.label ?? `Connecting to ${label}`);
  const elapsed = connectElapsed(status, now);
  const phaseElapsed = status ? elapsed.phase : (pending?.elapsedMs ?? 0);
  const totalElapsed = elapsed.total;
  const note = connectNote(status, steps);
  // Every surface that draws the steps says why a reconnect is not back yet, not only the picker.
  const lastAttempt = lastHeadline ?? reconnectReasonOf(status);

  return (
    <div className="sps-host-connecting sps-host-steps" role="status" data-host={hostKey}>
      <div className="sps-host-step-phase">
        <SetupProgress label={phaseText} ariaLabel={`Connecting to ${label}: ${phaseText}`}
          percent={steps.length ? completed / steps.length * 100 : undefined}
          valueText={`${completed} of ${steps.length} steps complete`} />
      </div>

      {!compact && <ol className="sps-host-step-list">
        {steps.map((step) => (
          <li
            key={step.phase}
            className={`sps-host-step sps-host-step-${step.status}`}
            data-step={step.phase}
            data-status={step.status}
          >
            {step.status === 'active'
              ? <span className="sps-host-spinner" aria-hidden="true" />
              : <span className="sps-host-step-mark" aria-hidden="true">{step.status === 'done' ? '✓' : '○'}</span>}
            <span className="sps-host-step-label">{step.label}</span>
            {step.status === 'active' && (
              <span className="sps-host-step-elapsed">{` · ${formatElapsed(phaseElapsed)}`}</span>
            )}
          </li>
        ))}
      </ol>}

      {note && !compact && <div className="sps-host-step-note">{note}</div>}
      {lastAttempt && <div className="sps-host-step-last">{`Last attempt: ${lastAttempt}`}</div>}
      {totalElapsed > 0 && (
        <div className="sps-host-step-total">Connecting for {formatElapsed(totalElapsed)}</div>
      )}
    </div>
  );
}
