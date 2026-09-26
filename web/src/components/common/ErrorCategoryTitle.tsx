/**
 * The heading of one root-cause block in the notification panel's Errors view
 * ("Can't reach Dev box"): the host's display label from the host store (the
 * alias when the store does not know it), plus a quiet "Shown above" line while
 * the attention card at the top of the panel has a row for that host. The
 * block records what HAPPENED, the card says what IS, so the two sentences may
 * differ; dismissing the card's row drops the line, never the block.
 */
import { useMemo, type ReactNode } from 'react';
import { getAllHostStatus, useAllHostStatus } from '@/hooks/useHostStatus';
import { causeLabelOf, hostOfCauseKey, setCauseHostLabelResolver } from '@/contexts/notifications/notification-model';
import { useBannerHostAliases } from '@/utils/host-banner-placement';

setCauseHostLabelResolver((alias) => getAllHostStatus().find((s) => s.host === alias)?.label);

export const SHOWN_ABOVE_LABEL = 'Shown above';

export function ErrorCategoryTitle({ causeKey, label }: { causeKey: string; label: string }): ReactNode {
  const statuses = useAllHostStatus();
  const bannerHosts = useBannerHostAliases();
  const host = hostOfCauseKey(causeKey);
  const name = useMemo(() => {
    if (!host) return label;
    const byAlias = new Map(statuses.map((s) => [s.host, s.label] as const));
    return causeLabelOf(causeKey, (a) => byAlias.get(a)) ?? label;
  }, [causeKey, label, host, statuses]);
  const shown = !!host && bannerHosts.has(host);
  return (
    <span className="nfc-cat-title" data-cause-key={causeKey}>
      <span className="nfc-cat-name">{name}</span>
      {shown && <span className="nfc-cat-shown">{SHOWN_ABOVE_LABEL}</span>}
    </span>
  );
}
