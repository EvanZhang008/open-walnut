import type { ProcessStatus } from '@/types/session';
import {
  PROCESS_LABELS,
  PROCESS_COLORS,
  WAITING_COLOR,
  deriveDisplayStatus,
  waitingBadgeTitle,
} from '@/utils/session-status';

interface ProcessStatusBadgeProps {
  processStatus: ProcessStatus;
  /** Badge size variant. */
  size?: 'sm' | 'md';
  /** Error detail shown on hover when process_status is 'error'. */
  errorMessage?: string;
  /** Pending permission prompt the CLI is paused on (requires_action). Drives
   *  the derived amber "Waiting" display — see deriveDisplayStatus for why this
   *  is a display-layer derivation and not a ProcessStatus enum value. */
  pendingPermission?: { requestId?: string; toolName?: string; receivedAt?: string } | null;
}

export function ProcessStatusBadge({ processStatus, size = 'md', errorMessage, pendingPermission }: ProcessStatusBadgeProps) {
  const badgeBase = size === 'sm' ? 'session-panel-badge' : 'session-detail-badge';
  const dotClass = size === 'sm' ? 'session-panel-badge-dot' : 'session-detail-badge-dot';
  const display = deriveDisplayStatus(processStatus, pendingPermission);

  if (display === 'waiting') {
    return (
      <span
        className={badgeBase}
        style={{
          color: WAITING_COLOR,
          background: `color-mix(in srgb, ${WAITING_COLOR} 8%, transparent)`,
        }}
        title={waitingBadgeTitle(pendingPermission!)}
      >
        <span className={dotClass} style={{ background: WAITING_COLOR }} />
        Waiting
      </span>
    );
  }

  const psColor = PROCESS_COLORS[display];
  return (
    <span
      className={badgeBase}
      style={{
        color: psColor,
        background: `color-mix(in srgb, ${psColor} 8%, transparent)`,
      }}
      title={display === 'error' && errorMessage ? errorMessage : PROCESS_LABELS[display]}
    >
      {display === 'running' && (
        <span className={dotClass} style={{ background: psColor }} />
      )}
      {PROCESS_LABELS[display]}
    </span>
  );
}
