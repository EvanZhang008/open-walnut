/**
 * Status dot for a remote host, the SAME shape everywhere (picker tabs, draft
 * pills, quick chips, banner rows, Settings rows, the rail): failed = solid
 * circle, warn = solid square, off = hollow ring, unknown = slow pulse,
 * connecting / checking = pulse, connected = solid green circle.
 *
 * Two ways to use it: `{host, label}` reads the live store; `{dot}` renders a
 * verdict the caller already has. The sentence is the aria-label only: the
 * surrounding control owns the one tooltip (a dot inside a tab must not show a
 * different title from the tab around it). `decorative` is for a dot inside a
 * control that already carries the same sentence as its aria-label (a picker
 * tab, the rail's Settings link): the dot is then aria-hidden, or a screen
 * reader would read the host's name twice.
 */
import { useEffect, useState } from 'react';
import { useHostStatus, useHostStatusHydration, serverNow } from '@/hooks/useHostStatus';
import { hostDotOf, READINESS_ANSWER_GRACE_MS, type HostDot } from '@open-walnut/host-problem';
import '@/styles/host-status.css';

type Props =
  | { host: string; label: string; dot?: undefined; className?: string; decorative?: boolean }
  | { dot: HostDot; host?: string; label?: string; className?: string; decorative?: boolean };

/** The legacy class older specs and styles key on (data-kind is the full truth). */
function legacyClass(kind: HostDot['kind']): string {
  return kind === 'checking' ? 'connected' : kind;
}

function DotView({ dot, host, phase, className, decorative }: { dot: HostDot; host?: string; phase?: string; className?: string; decorative?: boolean }) {
  return (
    <span
      className={`sps-host-dot sps-host-dot-${legacyClass(dot.kind)} hsd${className ? ` ${className}` : ''}`}
      data-kind={dot.kind}
      {...(host ? { 'data-host': host } : {})}
      {...(phase ? { 'data-phase': phase } : {})}
      {...(decorative ? { 'aria-hidden': true } : { role: 'img', 'aria-label': dot.title })}
    />
  );
}

function LiveDot({ host, label, className, decorative }: { host: string; label: string; className?: string; decorative?: boolean }) {
  const status = useHostStatus(host);
  const hydration = useHostStatusHydration();
  const [, setTick] = useState(0);
  const dot = hostDotOf(status, { hydrating: hydration === 'never' || hydration === 'pending', now: serverNow(), label });
  // 'checking' ends by the clock (no readiness answer within the grace): re-render then.
  const connectedAt = status?.connectedAt;
  useEffect(() => {
    if (dot.kind !== 'checking' || typeof connectedAt !== 'number') return;
    const wait = Math.max(0, connectedAt + READINESS_ANSWER_GRACE_MS - serverNow()) + 50;
    const t = setTimeout(() => setTick((n) => n + 1), wait);
    return () => clearTimeout(t);
  }, [dot.kind, connectedAt]);
  return <DotView dot={dot} host={host} phase={status?.phase ?? 'unknown'} className={className} decorative={decorative} />;
}

export function HostStatusDot(props: Props) {
  if (props.dot) return <DotView dot={props.dot} host={props.host} className={props.className} decorative={props.decorative} />;
  return <LiveDot host={props.host} label={props.label} className={props.className} decorative={props.decorative} />;
}
