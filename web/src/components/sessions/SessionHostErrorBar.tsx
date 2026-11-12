/**
 * The host half of a session's error banner (spec 2.3, G15): what the lid-open
 * user reads first. A reconnect names its host and the last failure
 * ('Reconnecting to Dev box' / 'Last attempt: Connecting to Dev box timed out');
 * a failed host gets the shared HostFailureText and a Retry that runs through
 * useHostActions (the same connect route as the banner and Settings); a
 * connected host whose Claude Code cannot run says the readiness sentence under
 * the session's own error, and a test server's host says it is off.
 * Sentences come from @open-walnut/host-problem (or the server) only.
 */
import { useEffect, useRef, useState } from 'react';
import { REMOTE_OFF_NOTE, hostProblemOf, type HostProblem } from '@open-walnut/host-problem';
import { serverNow, useHostStatus } from '@/hooks/useHostStatus';
import { useHostActions, RETRY_FAILED_TEXT, CHECK_FAILED_TEXT } from '@/hooks/useHostActions';
import { useIsCloudReplica } from '@/hooks/useIsCloudReplica';
import { HostFailureText } from '@/components/hosts/HostFailureText';
import { HostCommands } from '@/components/hosts/HostCommands';
import { InlineCodeText } from '@/components/common/InlineCodeText';
import { StableButton } from '@/components/common/HostProblemRows';
import { PanelNotice } from './PanelNotice';
import '@/styles/attention-banner.css';

export function reconnectingText(label: string): string {
  return `Reconnecting to ${label}`;
}

/**
 * Whether the session's host has a problem the host line explains (the generic
 * suggestion then stays quiet). Every kind hostProblemOf reports is one
 * SessionHostErrorText renders, so a quiet suggestion always has a sentence in its place.
 */
export function useSessionHostHasProblem(host: string | null | undefined): boolean {
  const status = useHostStatus(host ?? null);
  return !!host && !!hostProblemOf(status);
}

export function SessionHostErrorText({ host, label, reconnecting, fallback }: {
  host: string;
  /** Shown when the store has no label for the host. */
  label: string;
  /** The session monitor says it is reconnecting (the host frame may lag). */
  reconnecting: boolean;
  /** The session's own sentence when the host has nothing to add. */
  fallback: string;
}) {
  const status = useHostStatus(host);
  const actions = useHostActions(host);
  const replica = useIsCloudReplica();
  const l = status?.label || label || host;
  const p = hostProblemOf(status, { replica });
  if (p?.type === 'connect') {
    return (
      <div className="session-host-error" data-testid="session-host-error" data-kind={p.kind}>
        <HostFailureText headline={p.headline} hint={p.hint} summary={p.summary} kind={p.kind} retryAt={p.retryAt}
          lastFrameAt={status?.serverNow ?? status?.at} />
        {/* A replica cannot dial ssh: no Retry there, only the sentence. */}
        <HostConnectButton actions={actions} replica={replica} idle="Retry" busy="Retrying..." testId="session-host-retry" />
      </div>
    );
  }
  if (reconnecting || p?.type === 'reconnecting') {
    // Walnut re-dials by itself; Reconnect now dials at once instead of waiting for the next try.
    return (
      <div className="session-host-error" data-testid="session-host-reconnecting">
        <span className="session-error-banner-text">{reconnectingText(l)}</span>
        {p?.type === 'reconnecting' && p.headline && <div className="hpb-last">Last attempt: {p.headline}</div>}
        <HostConnectButton actions={actions} replica={replica} idle="Reconnect now" busy="Reconnecting..." testId="session-host-reconnect" />
      </div>
    );
  }
  if (p?.type === 'readiness') {
    const check = actions.pending === 'check' ? 'Checking...' : actions.failed === 'check' ? CHECK_FAILED_TEXT : 'Check again';
    return (
      <div className="session-host-error" data-testid="session-host-readiness" data-kind={p.problem.kind}>
        <span className="session-error-banner-text">{fallback}</span>
        <div className="hpb-message"><InlineCodeText text={p.problem.message} /></div>
        {p.problem.commands.length > 0 && <HostCommands commands={p.problem.commands} />}
        <div className="session-host-error-actions">
          <StableButton label={check} labels={['Check again', 'Checking...', CHECK_FAILED_TEXT]}
            disabled={actions.pending !== null} onClick={() => { void actions.checkAgain(); }} testId="session-host-check" />
          {actions.receipt && <span className="hpb-receipt">{actions.receipt}</span>}
        </div>
      </div>
    );
  }
  if (p?.type === 'off') {
    return (
      <div className="session-host-error" data-testid="session-host-off">
        <span className="session-error-banner-text">{fallback}</span>
        <div className="hpb-last">{REMOTE_OFF_NOTE}</div>
      </div>
    );
  }
  return <span className="session-error-banner-text">{fallback}</span>;
}

/** One click that dials the host now (the connect route every host surface uses), with its receipt or failure. */
function HostConnectButton({ actions, replica, idle, busy, testId }: {
  actions: ReturnType<typeof useHostActions>; replica: boolean; idle: string; busy: string; testId: string;
}) {
  // A replica cannot dial ssh: no button there, only a receipt or failure already on screen.
  if (replica && !actions.receipt && actions.failed !== 'retry') return null;
  return (
    <div className="session-host-error-actions">
      {!replica && <StableButton label={actions.pending === 'retry' ? busy : idle} labels={[idle, busy]}
        disabled={actions.pending !== null} onClick={() => { void actions.retry(); }} testId={testId} />}
      {actions.receipt && <span className="hpb-receipt">{actions.receipt}</span>}
      {actions.failed === 'retry' && <span className="host-connect-retry-msg" role="alert">{RETRY_FAILED_TEXT}</span>}
    </div>
  );
}

/** An added host nothing dials now and nothing failed on: the session says so with Connect. */
export function hostIdleText(label: string): string {
  return `${label} is not connected right now. Connect reaches it; a message you send connects it too.`;
}

function SessionHostIdleText({ host, label }: { host: string; label: string }) {
  const actions = useHostActions(host);
  const replica = useIsCloudReplica();
  return (
    <div className="session-host-error" data-testid="session-host-idle">
      <span className="session-error-banner-text">{hostIdleText(label)}</span>
      <HostConnectButton actions={actions} replica={replica} idle="Connect" busy="Connecting..." testId="session-host-connect" />
    </div>
  );
}

/** What the panel says, beside the host line, about messages while nothing reaches the host. */
export const HOST_DOWN_MESSAGES_NOTE = 'Messages you send wait and go out by themselves once the connection is back; replies written meanwhile show then.';

/**
 * How long a re-dial runs before the panel says the host cannot be reached (2026-11-11: a
 * link a relay kept ending came back in 3 to 5 s each time, and the notice blinked on and
 * off with every drop). A failed or switched-off host is said at once.
 */
export const HOST_DOWN_GRACE_MS = 10_000;

/**
 * When the host-down notice may show for `p` (server clock), or null for no notice: at once
 * for a failed or switched-off host, for a reconnect once it has lasted HOST_DOWN_GRACE_MS
 * from its start or from when this panel first saw it, whichever is earlier.
 */
export function hostDownShowsAt(p: HostProblem | null, firstSeenAt: number, idle = false): number | null {
  // An idle host (added, nothing dialling, nothing failed) waits the same grace: a dial is often a moment away.
  if (!p) return idle ? firstSeenAt + HOST_DOWN_GRACE_MS : null;
  if (p.type === 'connect' || p.type === 'off') return 0;
  if (p.type !== 'reconnecting') return null;
  const start = p.since > 0 ? Math.min(p.since, firstSeenAt) : firstSeenAt;
  return start + HOST_DOWN_GRACE_MS;
}

/** The host is added and not connected, with nothing dialling and nothing failed (its link was never asked for). */
export function hostSitsIdle(status: { connected?: boolean; phase?: string; removed?: boolean } | undefined, p: HostProblem | null): boolean {
  return !!status && !status.removed && !status.connected && status.phase === 'idle' && !p;
}

/**
 * A live session whose host nothing reaches now, said once the link has been down a few
 * seconds (2026-11-06: a host's sign-in expired and its tasks' panels said nothing; the
 * record turns 'error' only after five minutes down, and the main banner waits two). Nothing
 * for a host that is fine or only not ready: the error banner speaks for a session in error.
 */
export function SessionHostDownBanner({ host, label }: { host: string; label: string }) {
  const status = useHostStatus(host);
  const replica = useIsCloudReplica();
  const p = hostProblemOf(status, { replica });
  const idle = hostSitsIdle(status, p);
  const down = (!!p && (p.type === 'connect' || p.type === 'reconnecting' || p.type === 'off')) || idle;
  const connected = status?.connected === true;
  // The first moment this panel saw the link down, kept until it is connected again.
  const firstSeen = useRef<number | null>(null);
  if (connected || !status) firstSeen.current = null;
  else if (down && firstSeen.current === null) firstSeen.current = serverNow();
  const showAt = down ? hostDownShowsAt(p, firstSeen.current ?? serverNow(), idle) : null;
  const [tick, rerender] = useState(0);
  // Armed again after each fire (`tick`): a fire a moment early (the server clock's skew moved) waits on.
  useEffect(() => {
    if (showAt === null) return;
    const wait = showAt - serverNow();
    if (wait <= 0) return;
    const t = setTimeout(() => rerender((n) => n + 1), wait + 50);
    return () => clearTimeout(t);
  }, [showAt, tick]);
  const showNow = showAt !== null && serverNow() >= showAt;
  // Held until the host is connected again: a re-dial in flight reads as no problem for its
  // first half minute (no failure recorded yet), and the notice must not blink off meanwhile.
  const [held, setHeld] = useState(false);
  useEffect(() => {
    if (showNow) setHeld(true);
    else if (connected || !status) setHeld(false);
  }, [showNow, connected, status]);
  if (!showNow && !held) return null;
  const l = status?.label || label || host;
  return (
    <PanelNotice className="session-error-banner session-error-banner--reconnecting" icon={'\u21BB'} testId="session-host-down" role="status">
      <div className="session-host-down-body">
        {idle ? <SessionHostIdleText host={host} label={l} /> : (
          <>
            <SessionHostErrorText host={host} label={label} reconnecting={!down} fallback={`${l} cannot be reached right now`} />
            <div className="hpb-last" data-testid="session-host-down-note">{HOST_DOWN_MESSAGES_NOTE}</div>
          </>
        )}
      </div>
    </PanelNotice>
  );
}
