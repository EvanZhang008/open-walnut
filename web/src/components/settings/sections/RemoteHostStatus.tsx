/**
 * Live connect status for ONE row of Settings: Remote Hosts, plus the button that
 * starts a connect on purpose.
 *
 * Its own component so the pushed status re-renders one row, not the whole section
 * (the section owns the auto-saving host editor; re-rendering it on every phase
 * push would fight the inputs the user is typing in).
 */
import { useEffect, useRef, useState } from 'react';
import { connectHost } from '@/api/hosts';
import { seedHostStatus, useHostStatus, useHostStatusHydration } from '@/hooks/useHostStatus';
import {
  elapsedNow, formatElapsed, hostIndicatorStatus, hostStatusText, isHostConnecting, isHostFailed,
} from '@/utils/host-connect';
import { hostReadinessCheck, hostReadinessProblems } from '@/utils/host-readiness';
import { StatusIndicator } from '../inputs/StatusIndicator';
import { SettingsButton } from '../inputs/SettingsButton';
import { CopyButton } from '../inputs/CopyButton';
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

/** How long "Check again" waits for the re-check to answer (the host caps itself at 12s). */
const RECHECK_WAIT_MS = 15_000;

/**
 * One line per thing a CONNECTED host still needs (claude missing, an npm claude
 * without a working node, no C compiler for dtach), each with its command and a
 * Copy. Renders nothing when the host is fine or its daemon cannot tell.
 *
 * "Check again" asks the server to re-run the host's preflight. The POST answers
 * at once, but the preflight takes up to 12s and reports through a LATER
 * host:status push, so the button stays in "Checking..." until a readiness with
 * a newer `checkedAt` arrives (or 15s pass). A newer answer that carries
 * `checkError`, or no answer within 15s, reads "Check failed"; an answer with no
 * problems left removes the lines.
 */
export function RemoteHostReadiness({ alias, name }: { alias: string; name: string }) {
  const status = useHostStatus(alias);
  const problems = hostReadinessProblems(status);
  const { checkedAt, checkError } = hostReadinessCheck(status);
  // The checkedAt on screen when the user clicked; null = not waiting.
  const [waitingFrom, setWaitingFrom] = useState<number | null>(null);
  const [failed, setFailed] = useState(false);
  const clickedAt = useRef(0);

  useEffect(() => {
    if (waitingFrom === null) return;
    if (checkedAt > waitingFrom) {
      setWaitingFrom(null);
      setFailed(!!checkError);
      return;
    }
    // No answer at all in time is a failed check too, from where the user sits.
    const timer = setTimeout(() => { setWaitingFrom(null); setFailed(true); }, Math.max(0, RECHECK_WAIT_MS - (Date.now() - clickedAt.current)));
    return () => clearTimeout(timer);
  }, [waitingFrom, checkedAt, checkError]);

  if (problems.length === 0) return null;
  const checking = waitingFrom !== null;

  const recheck = () => {
    clickedAt.current = Date.now();
    setFailed(false);
    setWaitingFrom(checkedAt);
    connectHost(alias).then(seedHostStatus, () => {
      // The POST itself failed (unknown or disabled host): nothing is coming.
      setWaitingFrom(null);
      setFailed(true);
    });
  };

  return (
    <>
      {problems.map((problem, idx) => {
        const [first, ...alternatives] = problem.commands;
        return (
          <SettingsNotice
            key={problem.kind}
            kind="warn"
            action={(first || idx === 0) && (
              <>
                {first && <CopyButton text={first} data-testid={`rh-readiness-copy-${problem.kind}`} />}
                {idx === 0 && failed && !checking && <span className="rh-status-error">Check failed</span>}
                {idx === 0 && (
                  <SettingsButton
                    variant="text"
                    disabled={checking}
                    reserve={['Check again', 'Checking...']}
                    onClick={recheck}
                    data-testid="rh-readiness-recheck"
                  >
                    {checking ? 'Checking...' : 'Check again'}
                  </SettingsButton>
                )}
              </>
            )}
          >
            <span className="rh-readiness" data-host={alias} data-problem={problem.kind}>
              {`${name}: ${problem.message}`}
              {first && <> <code>{first}</code></>}
              {alternatives.map((alt) => <span key={alt}> or <code>{alt}</code></span>)}
            </span>
          </SettingsNotice>
        );
      })}
    </>
  );
}
