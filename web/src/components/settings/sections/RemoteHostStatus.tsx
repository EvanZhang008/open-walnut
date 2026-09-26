/**
 * Settings › Remote Hosts, one row's live parts (spec 5.2):
 *
 *   RemoteHostStatus  the short status line in the row's help slot: the host's
 *                     dot, a few words ('Connected', 'Not connected',
 *                     'Reconnecting to Dev box', 'Off on this test server') and
 *                     the one connect button (Retry / Connect now).
 *   RemoteHostDetail  the block below it: the failure (HostFailureText, the SAME
 *                     rendering the banner and the picker use: headline, the
 *                     server's hint verbatim, SSH output behind a toggle, a real
 *                     countdown), the last reconnect cause, and the readiness lines.
 *
 * The failure is never inside .rh-status / .rh-status-error: those shared rules
 * are one-line nowrap, and a hint must wrap.
 *
 * Their own components so a status push re-renders one row, not the section
 * (the section owns the auto-saving host editor the user may be typing in).
 */
import { useEffect, useState } from 'react';
import {
  hostDotOf, hostProblemOf, isConnectingPhaseWire, OFF_PHASE_LABEL,
} from '@open-walnut/host-problem';
import { serverNow, useHostStatus, useHostStatusHydration } from '@/hooks/useHostStatus';
import { useHostActions, RETRY_FAILED_TEXT } from '@/hooks/useHostActions';
import { formatElapsed, hostStatusText } from '@/utils/host-connect';
import { HostStatusDot } from '@/components/sessions/path-selector/HostStatusDot';
import { HostFailureText } from '@/components/hosts/HostFailureText';
import { InlineCodeText } from '@/components/common/InlineCodeText';
import { SettingsButton } from '../inputs/SettingsButton';
import { RemoteHostReadiness } from './RemoteHostReadiness';
import { useIsCloudReplica } from '@/hooks/useIsCloudReplica';
import '@/styles/host-picker-settings.css';

/** Shared status text uses a typographic ellipsis; settings copy uses `...`. */
const plain = (text: string) => text.replace(/…/g, '...');

const OFF_TITLE = 'This test server never dials remote hosts. Start it with WALNUT_EPHEMERAL_REMOTE_HOSTS=1 to test one.';
/** A host switched off in Settings: the server never dials it and pushes no status for it. */
export const DISABLED_TEXT = 'Disabled';
const DISABLED_TITLE = 'Turn this host on to connect to it.';

type Line = { text: string; title?: string; button: null | { label: string; disabled: boolean; kind: 'retry' | 'connectNow' } };

export function RemoteHostStatus({ alias, name, enabled = true }: { alias: string; name?: string; enabled?: boolean }) {
  const status = useHostStatus(alias);
  const hydration = useHostStatusHydration();
  const actions = useHostActions(alias);
  const replica = useIsCloudReplica();
  const label = status?.label || name || alias;
  const hydrating = hydration === 'never' || hydration === 'pending';
  const problem = hostProblemOf(status, { replica });
  const dot = hostDotOf(status, { hydrating, now: serverNow(), label });
  const connecting = !!status && !status.connected && isConnectingPhaseWire(status.phase) && status.phase !== 'reconnecting';
  const retrying = actions.pending === 'retry';

  // Tick only while an attempt runs: a settled row keeps no timer alive.
  const [now, setNow] = useState(() => serverNow());
  useEffect(() => {
    if (!connecting) return;
    const t = setInterval(() => setNow(serverNow()), 1000);
    return () => clearInterval(t);
  }, [connecting]);

  let line: Line;
  // Off in Settings: nothing to connect (a Connect now there only ever answered 409 host_disabled).
  if (!enabled) line = { text: DISABLED_TEXT, title: DISABLED_TITLE, button: null };
  else if (!status) line = { text: hydrating ? 'Checking...' : 'Not connected', button: hydrating ? null : { label: 'Connect now', disabled: false, kind: 'connectNow' } };
  else if (problem?.type === 'off') line = { text: OFF_PHASE_LABEL, title: OFF_TITLE, button: null };
  else if (problem?.type === 'connect') line = { text: 'Not connected', button: { label: retrying ? 'Retrying...' : 'Retry', disabled: retrying, kind: 'retry' } };
  else if (problem?.type === 'reconnecting') line = { text: `Reconnecting to ${label}`, button: { label: retrying ? 'Retrying...' : 'Connect now', disabled: retrying, kind: 'connectNow' } };
  else if (connecting) line = { text: plain(hostStatusText(status, hydration)), button: { label: 'Retrying...', disabled: true, kind: 'retry' } };
  else if (status.connected) line = { text: 'Connected', button: null };
  else line = { text: 'Not connected', button: { label: retrying ? 'Retrying...' : 'Connect now', disabled: retrying, kind: 'connectNow' } };
  if (replica) line = { ...line, button: null };

  const started = status?.attemptStartedAt;
  const elapsed = connecting && typeof started === 'number' ? formatElapsed(Math.max(0, now - started)) : '';
  return (
    <span className="rh-status" data-host={alias} data-phase={enabled ? status?.phase ?? 'unknown' : 'disabled'} title={line.title}>
      <HostStatusDot dot={enabled ? dot : { kind: 'off', title: `${label}: ${DISABLED_TEXT}` }} host={alias} />
      <span className="status-text rh-status-short">{line.text}</span>
      {enabled && elapsed && <span className="rh-status-elapsed">{elapsed}</span>}
      {enabled && actions.failed === 'retry' && <span className="rh-status-error">{RETRY_FAILED_TEXT}</span>}
      {enabled && actions.receipt && <span className="rh-receipt">{actions.receipt}</span>}
      {line.button && (
        <SettingsButton
          variant="text"
          className="rh-connect-btn"
          disabled={line.button.disabled}
          reserve={['Connect now', 'Retry', 'Retrying...']}
          onClick={(e) => { e.preventDefault(); e.stopPropagation(); void (line.button!.kind === 'retry' ? actions.retry() : actions.connectNow()); }}
          title={line.button.kind === 'retry' ? 'Try connecting to this host again' : 'Connect to this host now'}
        >
          {line.button.label}
        </SettingsButton>
      )}
    </span>
  );
}

/**
 * The block under a row's status line: the failure text, the last reconnect
 * cause, then the readiness lines. Nothing at all for a healthy host.
 */
export function RemoteHostDetail({ alias, name, enabled = true }: { alias: string; name?: string; enabled?: boolean }) {
  const status = useHostStatus(alias);
  const actions = useHostActions(alias);
  const replica = useIsCloudReplica();
  const label = status?.label || name || alias;
  const problem = hostProblemOf(status, { replica });
  // A disabled host says nothing below its status line (a last frame from before
  // it was switched off may still be in the store for a moment).
  if (!enabled) return null;

  const failure = problem?.type === 'connect'
    ? (
      <div className="rh-failure" data-host={alias} data-kind={problem.kind}>
        <HostFailureText
          headline={problem.headline} hint={problem.hint} summary={problem.summary} kind={problem.kind}
          retryAt={problem.retryAt} lastFrameAt={status?.at}
        />
      </div>
    )
    : problem?.type === 'reconnecting' && problem.headline
      ? (
        <div className="rh-failure" data-host={alias} data-kind={problem.kind} data-type="reconnecting">
          <div className="hft-headline" title={problem.headline}>{`Last attempt: ${problem.headline}`}</div>
          {problem.hint && <div className="hft-hint"><InlineCodeText text={problem.hint} /></div>}
        </div>
      )
      : null;
  const readiness = problem?.type === 'off'
    ? null
    : <RemoteHostReadiness alias={alias} label={label} status={status} actions={actions} replica={replica} />;
  if (!failure && !status?.connected) return null;
  return (
    <div className="rh-host-detail" data-host={alias}>
      {failure}
      {readiness}
    </div>
  );
}
