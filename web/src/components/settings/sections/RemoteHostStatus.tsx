/**
 * Live connect status for ONE row of Settings: Remote Hosts, plus the button that
 * starts a connect on purpose.
 *
 * Its own component so the pushed status re-renders one row, not the whole section
 * (the section owns the auto-saving host editor; re-rendering it on every phase
 * push would fight the inputs the user is typing in).
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { connectHost } from '@/api/hosts';
import { seedHostStatus, useHostStatus, useHostStatusHydration } from '@/hooks/useHostStatus';
import {
  elapsedNow, formatElapsed, hostIndicatorStatus, hostStatusText, isHostConnecting, isHostFailed,
} from '@/utils/host-connect';
import { hostReadinessCheck, hostReadinessNotes, hostReadinessProblems } from '@/utils/host-readiness';
import { StatusIndicator } from '../inputs/StatusIndicator';
import { SettingsButton } from '../inputs/SettingsButton';
import { CopyButton } from '../inputs/CopyButton';
import { SettingsNotice } from '../SettingsSection';
import { InlineCodeText } from '@/components/common/InlineCodeText';

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
 * `<host>: <message>`, unless the message already names the host ("Claude Code
 * on devbox is not signed in. Run `ssh -t devbox claude` ..."), and with its
 * `backticked` commands as code. `inline`: the message already quotes the command.
 */
function ProblemText({ name, message, command }: { name: string; message: string; command?: string }) {
  const named = message.includes(name);
  const inline = !!command && message.includes('`' + command + '`');
  return (
    <>
      {named ? '' : `${name}: `}<InlineCodeText text={message} />
      {command && !inline && <> <code>{command}</code></>}
    </>
  );
}

/**
 * One line per thing a CONNECTED host still needs (claude missing, an npm claude
 * without a working node, a claude too old for the model or not signed in, no C
 * compiler for dtach), each with its command and a Copy. Renders nothing when
 * the host is fine or its daemon cannot tell.
 *
 * Walnut fixes most of these by itself (server host autofix): a problem being
 * fixed reads "Installing Claude Code on <host>..." instead of its command, a
 * failed fix keeps the line and adds why ("... (sudo needs a password): run
 * <exact command>"), and a fixed problem simply disappears with the next
 * readiness. A finished fix no problem carries (a success, or a dtach build)
 * gets one muted line for a while.
 *
 * "Check again" asks the server to re-run the host's preflight (and lets a
 * failed fix run once more). The POST answers at once, but the preflight takes
 * up to 12s and reports through a LATER host:status push, so the button stays in
 * "Checking..." until a readiness with a newer `checkedAt` arrives (or 15s
 * pass). A newer answer that carries `checkError`, or no answer within 15s,
 * reads "Check failed"; an answer with no problems left removes the lines.
 */
export function RemoteHostReadiness({ alias, name }: { alias: string; name: string }) {
  const status = useHostStatus(alias);
  const problems = hostReadinessProblems(status);
  // When THIS status arrived, on this browser's clock: a fix line's age is the
  // server's `ageMs` plus how long we have held the snapshot, never a
  // comparison of the two machines' clocks.
  const receivedAt = useMemo(() => Date.now(), [status]);
  const [, setExpiryTick] = useState(0);
  const notes = hostReadinessNotes(status, Date.now() - receivedAt);
  const nextExpiry = notes.reduce<number | null>(
    (min, n) => (n.expiresInMs === undefined ? min : min === null ? n.expiresInMs : Math.min(min, n.expiresInMs)), null);
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

  // A finished-fix line disappears on its own, even when no push arrives.
  useEffect(() => {
    if (nextExpiry === null) return;
    const timer = setTimeout(() => setExpiryTick((n) => n + 1), nextExpiry + 50);
    return () => clearTimeout(timer);
  }, [nextExpiry, receivedAt]);

  if (problems.length === 0 && notes.length === 0) return null;
  const checking = waitingFrom !== null;
  // "Check again" rides the first line that still asks the user for something.
  const recheckAt = problems.findIndex((p) => p.fix?.state !== 'running');

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
        if (problem.fix?.state === 'running') {
          return (
            <SettingsNotice key={problem.kind} kind="info">
              <span className="rh-readiness" data-host={alias} data-problem={problem.kind} data-fix="running">
                {`${problem.fix.text} on ${name}...`}
              </span>
            </SettingsNotice>
          );
        }
        const failedFix = problem.fix?.state === 'failed' ? problem.fix : undefined;
        const [first, ...alternatives] = problem.commands;
        const withRecheck = idx === recheckAt;
        return (
          <SettingsNotice
            key={problem.kind}
            kind="warn"
            action={(first || withRecheck) && (
              <>
                {first && <CopyButton text={first} data-testid={`rh-readiness-copy-${problem.kind}`} />}
                {withRecheck && failed && !checking && <span className="rh-status-error">Check failed</span>}
                {withRecheck && (
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
            <span
              className="rh-readiness"
              data-host={alias}
              data-problem={problem.kind}
              data-fix={failedFix ? 'failed' : undefined}
              title={failedFix?.detail}
            >
              {failedFix
                ? <><ProblemText name={name} message={problem.message} />{` ${failedFix.text}`}{first ? <>: run <code>{first}</code></> : '.'}</>
                : <ProblemText name={name} message={problem.message} command={first} />}
              {alternatives.map((alt) => <span key={alt}> or <code>{alt}</code></span>)}
            </span>
          </SettingsNotice>
        );
      })}
      {notes.map((note) => (
        <SettingsNotice key={note.key} kind="info">
          <span className="rh-readiness-note" data-host={alias} data-fix={note.kind} title={note.detail}>
            {note.kind === 'running' ? `${note.text} on ${name}...` : `${name}: ${note.text}.`}
          </span>
        </SettingsNotice>
      ))}
    </>
  );
}
