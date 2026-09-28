/**
 * The heading of one root-cause block in the notification panel's Errors view
 * ("Can't reach Dev box"): the host's display label from the host store (the
 * alias when the store does not know it), plus a quiet "Shown in System" link
 * while the attention card (it lives in the System section) has a row for
 * that host. The block records what HAPPENED, the card says what IS, so the
 * two sentences may differ; dismissing the card's row drops the link, never
 * the block.
 */
import { useMemo, type ReactNode } from 'react';
import { getAllHostStatus, useAllHostStatus } from '@/hooks/useHostStatus';
import { causeLabelOf, hostOfCauseKey, setCauseHostLabelResolver } from '@/contexts/notifications/notification-model';
import { useBannerHostAliases } from '@/utils/host-banner-placement';

setCauseHostLabelResolver((alias) => getAllHostStatus().find((s) => s.host === alias)?.label);

export const SHOWN_IN_SYSTEM_LABEL = 'Shown in System';

export function ErrorCategoryTitle({ causeKey, label, onShowSystem }: {
  causeKey: string;
  label: string;
  /** Opens the System section, where the card's row for this host is. */
  onShowSystem?: () => void;
}): ReactNode {
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
      {shown && (onShowSystem
        ? <button type="button" className="nfc-cat-shown nfc-cat-shown-link" onClick={onShowSystem}>{SHOWN_IN_SYSTEM_LABEL}</button>
        : <span className="nfc-cat-shown">{SHOWN_IN_SYSTEM_LABEL}</span>)}
    </span>
  );
}
