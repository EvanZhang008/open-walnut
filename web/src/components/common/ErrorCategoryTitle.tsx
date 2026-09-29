/**
 * The heading of one root-cause block in the notification panel's Errors view
 * ("Can't reach Dev box"): the host's display label from the host store (the
 * alias when the store does not know it). A host that has a problem right now
 * never gets such a block: its errors sit under its own row at the top of the
 * view (NotificationProblems), so a block like this one is the record of a host
 * that has since recovered, or of a cause that is not a host.
 */
import { useMemo, type ReactNode } from 'react';
import { getAllHostStatus, useAllHostStatus } from '@/hooks/useHostStatus';
import { causeLabelOf, hostOfCauseKey, setCauseHostLabelResolver } from '@/contexts/notifications/notification-model';

setCauseHostLabelResolver((alias) => getAllHostStatus().find((s) => s.host === alias)?.label);

export function ErrorCategoryTitle({ causeKey, label }: { causeKey: string; label: string }): ReactNode {
  const statuses = useAllHostStatus();
  const host = hostOfCauseKey(causeKey);
  const name = useMemo(() => {
    if (!host) return label;
    const byAlias = new Map(statuses.map((s) => [s.host, s.label] as const));
    return causeLabelOf(causeKey, (a) => byAlias.get(a)) ?? label;
  }, [causeKey, label, host, statuses]);
  return (
    <span className="nfc-cat-title" data-cause-key={causeKey}>
      <span className="nfc-cat-name">{name}</span>
    </span>
  );
}
