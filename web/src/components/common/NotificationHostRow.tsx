/**
 * One host in the notification panel's System list ("Remote hosts"): each host
 * appears once.
 *
 * A host with a problem is the Home card's own row: SingleHostRow in its dense
 * form, built by the card's model (hostRowFor: dismissals ignored, one host
 * per row, never grouped), so the dot, the bold headline, the primary button
 * under it and Show details read exactly as on the card. The expanded flag is
 * the card's (the page session, by row id), so opening details in one place
 * opens it in the other, and the buttons run through the shared attempt store:
 * a Retry here and one on the Home card are ONE attempt. `statusList`: no x
 * and no Dismiss all, this is a status list.
 *
 * Every other host (healthy, disabled, off, connecting, a version floor) is a
 * plain line: its dot, its name, and the status sentence under it. A host that
 * is mid-connect says which step it is on: a bare "Disconnected" during the
 * 40-second first-connect install reads as a dead host, and this list is where
 * people look to decide whether to go fix something.
 */
import { useRef, type ReactNode } from 'react';
import { BANNER_READINESS_KINDS, firstSentence, hostProblemOf } from '@open-walnut/host-problem';
import type { DaemonHealth } from '@/hooks/useSystemHealth';
import { serverNow, useHostStatus } from '@/hooks/useHostStatus';
import { useIsCloudReplica } from '@/hooks/useIsCloudReplica';
import { hostStatusText, isHostConnecting } from '@/utils/host-connect';
import { hostRowFor, type BannerRow } from '@/utils/attention-banner-model';
import { useUserRetryingHosts } from '@/utils/host-user-retrying';
import { HostStatusDot } from '@/components/sessions/path-selector/HostStatusDot';
import { SingleHostRow } from './HostProblemRows';

/** Settings' word for a host switched off there (RemoteHostStatus DISABLED_TEXT). */
const DISABLED_TEXT = 'Disabled';

/** A host with nothing to fix: the dot, the name, the status sentence. */
function HostStatusLine({ daemon, disabled }: { daemon: DaemonHealth; disabled: boolean }): ReactNode {
  const status = useHostStatus(daemon.host);
  // The live frame is the authority when there is one: the health poll lags it
  // (and knows nothing of a host the pool never dialed), so the two would disagree.
  const connected = status ? status.connected : daemon.connected;
  const connecting = !connected && isHostConnecting(status);
  // Connected is not the same as able to start work: a readiness problem (an old
  // Claude Code) rides along, in the shared words.
  const problem = hostProblemOf(status);
  const blocking = problem?.type === 'readiness' ? firstSentence(problem.problem.message) : null;
  // A failed connect says why, in the card's own sentence, not a bare 'Disconnected' (N14):
  // here only for a host switched off (disabled) or one the card has no row for.
  const failure = !disabled && !connected && !connecting && (problem?.type === 'connect' || problem?.type === 'reconnecting')
    ? problem.type === 'connect' ? problem.headline : `Reconnecting to ${status?.label ?? daemon.label ?? daemon.host}`
    : null;
  const phase = disabled ? DISABLED_TEXT : connected ? 'Connected' : connecting ? hostStatusText(status) : failure ?? 'Disconnected';
  const label = daemon.label ?? daemon.host;
  // Only a banner problem wears the warn colour; a version floor for one model is a quiet
  // note (the user's rule, N14). A failed connect's words take its red dot's tone (N3-15).
  const bannerKind = problem?.type === 'readiness' && BANNER_READINESS_KINDS.includes(problem.problem.kind);
  const tone = disabled ? 'muted' : blocking ? (bannerKind ? 'warn' : '') : connected ? 'ok' : connecting ? '' : failure ? 'error' : 'muted';
  return (
    <li className="notification-detail-row nfc-daemon-row" data-host={daemon.host}>
      <span className="notification-daemon-name" title={label}>
        {daemon.host !== '__local__' && <HostStatusDot host={daemon.host} label={label} />}
        <span className="nfc-daemon-label">{label}</span>
      </span>
      <span
        className={`notification-detail-value nfc-daemon-status ${tone}`}
        title={blocking ? `${phase}. ${blocking}` : status ? hostStatusText(status) : undefined}
      >
        {/* 'Idle' used to render for connected:false, hiding real outages. */}
        {phase}{blocking && !disabled ? `. ${blocking}` : ''}
        {/* Cloud-bridge state (phone reachability): only when a bridge is
            configured AND the host itself is connected: bridge liveness rides
            the daemon connection, so next to 'Disconnected' any mark is stale
            and contradictory. */}
        {connected && daemon.bridgeConnected != null && (
          <span className={`notification-detail-value ${daemon.bridgeConnected ? 'ok' : 'warn'}`}>
            {daemon.bridgeConnected ? ' · bridge ✓' : ' · bridge ✗'}
          </span>
        )}
      </span>
    </li>
  );
}

export interface NotificationHostRowProps {
  daemon: DaemonHealth;
  /** Switched off in Settings: always the plain 'Disabled' line. */
  disabled: boolean;
  onOpenSettings: (alias?: string) => void;
}

export function NotificationHostRow({ daemon, disabled, onOpenSettings }: NotificationHostRowProps): ReactNode {
  const status = useHostStatus(daemon.host);
  const replica = useIsCloudReplica();
  const userRetrying = useUserRetryingHosts();
  // The row this host showed last here: through an attempt it stays, reading the attempt (G9).
  const prev = useRef<BannerRow | null>(null);
  const row = !disabled && status ? hostRowFor(status, { now: serverNow(), replica, userRetrying }, prev.current) : null;
  prev.current = row;
  if (!row) return <HostStatusLine daemon={daemon} disabled={disabled} />;
  return <SingleHostRow row={row} defaultExpanded={false} dense statusList onOpenSettings={onOpenSettings} />;
}
