/**
 * Tiny connect-status dot for a remote host tab.
 *
 * Sized like the ✎ raw-name marker next to it: the tab row is already crowded, so
 * this is a 6px dot whose whole job is "green / pulsing / red at a glance", with
 * the sentence in the tooltip and the accessible name.
 */
import { useHostStatus, useHostStatusHydration } from '@/hooks/useHostStatus';
import { hostDotAriaLabel, hostDotKind, hostDotTitle } from '@/utils/host-connect';

interface Props {
  /** Config alias — also the store key. */
  host: string;
  /** Human label, used in the tooltip ("Big remote host: Connected"). */
  label: string;
}

export function HostStatusDot({ host, label }: Props) {
  const status = useHostStatus(host);
  const hydration = useHostStatusHydration();
  const kind = hostDotKind(status);
  return (
    <span
      className={`sps-host-dot sps-host-dot-${kind}`}
      data-host={host}
      data-phase={status?.phase ?? 'unknown'}
      role="img"
      aria-label={hostDotAriaLabel(status, hydration)}
      title={hostDotTitle(label, status, hydration)}
    />
  );
}
