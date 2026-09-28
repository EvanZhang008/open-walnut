/**
 * The heading of one root-cause block in the notification panel's Errors view
 * ("Can't reach Dev box"): the host's display label from the host store (the
 * alias when the store does not know it), plus a quiet "Shown in System" link
 * while the System section's host list gives that host its card row
 * (systemListShowsRow). The block records what HAPPENED, the list says what IS,
 * so the two sentences may differ; a host that recovered drops the link, never
 * the block. Dismissing the Home card's row changes nothing here: the System
 * list ignores dismissals.
 */
import { useMemo, type ReactNode } from 'react';
import { getAllHostStatus, useAllHostStatus } from '@/hooks/useHostStatus';
import { causeLabelOf, hostOfCauseKey, setCauseHostLabelResolver } from '@/contexts/notifications/notification-model';
import { useIsCloudReplica } from '@/hooks/useIsCloudReplica';
import { systemListShowsRow } from './NotificationHostRow';

setCauseHostLabelResolver((alias) => getAllHostStatus().find((s) => s.host === alias)?.label);

export const SHOWN_IN_SYSTEM_LABEL = 'Shown in System';

export function ErrorCategoryTitle({ causeKey, label, onShowSystem }: {
  causeKey: string;
  label: string;
  /** Opens the System section with this host's row open (its details shown) and in view. */
  onShowSystem?: (host: string) => void;
}): ReactNode {
  const statuses = useAllHostStatus();
  const replica = useIsCloudReplica();
  const host = hostOfCauseKey(causeKey);
  const name = useMemo(() => {
    if (!host) return label;
    const byAlias = new Map(statuses.map((s) => [s.host, s.label] as const));
    return causeLabelOf(causeKey, (a) => byAlias.get(a)) ?? label;
  }, [causeKey, label, host, statuses]);
  const shown = !!host && systemListShowsRow(statuses.find((s) => s.host === host), replica);
  return (
    <span className="nfc-cat-title" data-cause-key={causeKey}>
      <span className="nfc-cat-name">{name}</span>
      {shown && (onShowSystem
        ? <button type="button" tabIndex={0} className="nfc-cat-shown nfc-cat-shown-link" onClick={() => onShowSystem(host!)}>{SHOWN_IN_SYSTEM_LABEL}</button>
        : <span className="nfc-cat-shown">{SHOWN_IN_SYSTEM_LABEL}</span>)}
    </span>
  );
}
