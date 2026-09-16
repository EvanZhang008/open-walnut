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
import { useHostStatus } from '@/hooks/useHostStatus';
import { connectNote, connectSteps, elapsedNow, formatElapsed, hostStatusText } from '@/utils/host-connect';

interface Props {
  /** Store key / config alias. */
  hostKey: string;
  /** Human label, for the fallback sentence. */
  label: string;
  /** The list-dirs answer, used when the pushed status has not arrived yet. */
  pending?: DirListingPending;
}

export function HostConnectSteps({ hostKey, label, pending }: Props) {
  const status = useHostStatus(hostKey);
  // Local 1s tick: the server stamps an elapsed value at `at` and then goes quiet
  // until the next phase, so without this the row freezes mid-install.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  const steps = connectSteps(status, pending?.phase);
  const hasActive = steps.some((s) => s.status === 'active');
  const phaseText = status ? hostStatusText(status) : (pending?.label ?? `Connecting to ${label}`);
  const phaseElapsed = status
    ? elapsedNow(status.phaseElapsedMs, status.at, now)
    : (pending?.elapsedMs ?? 0);
  const totalElapsed = status ? elapsedNow(status.connectElapsedMs, status.at, now) : 0;
  const note = connectNote(status, steps);

  return (
    <div className="sps-host-connecting sps-host-steps" role="status" data-host={hostKey}>
      <div className="sps-host-step-phase">
        {/* Exactly one spinner on the row: on the active step when there is one,
            here when the chain has no active step (e.g. every step already done
            while the directory listing itself is still in flight). */}
        {!hasActive && <span className="sps-host-spinner" aria-hidden="true" />}
        <span className="sps-host-step-phase-text">{phaseText}</span>
      </div>

      <ol className="sps-host-step-list">
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
              <span className="sps-host-step-elapsed">{formatElapsed(phaseElapsed)}</span>
            )}
          </li>
        ))}
      </ol>

      {note && <div className="sps-host-step-note">{note}</div>}
      {totalElapsed > 0 && (
        <div className="sps-host-step-total">Connecting for {formatElapsed(totalElapsed)}</div>
      )}
    </div>
  );
}
