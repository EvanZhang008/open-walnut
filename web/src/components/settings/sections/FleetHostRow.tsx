/**
 * Settings > Remote Hosts: a machine of the list that has no SSH entry or join link to edit
 * (This Mac, the cloud companion's box): its reading only (useHostFleet.ts), its one action
 * when its reading asks for one (Set up), and Details.
 */
import type { FleetHost } from '@/api/hosts-fleet';
import { SettingsTag } from '../SettingsSection';
import { HostStatusDot } from '@/components/sessions/path-selector/HostStatusDot';
import { HostDetails } from './HostDetails';
import { HostRow, RowLine, type RowPrimary } from './HostRow';
import { isLive, offlineLine, problemsOf } from './host-fleet-dashboard-model';
import { statusKind, THIS_MAC } from './host-fleet-model';
import { liveLine, needsLook } from './host-row-model';
import type { ActionState } from './useHostFleet';
import { hostRowId } from '@/utils/host-settings-nav';

export function FleetHostRow({ card, now, detailsOpen, onDetails, boot, onBootStart }: {
  card: FleetHost; now: number; detailsOpen: boolean; onDetails: (open: boolean) => void; boot?: ActionState; onBootStart: () => void;
}) {
  const name = card.local ? THIS_MAC : card.label;
  const live = isLive(card);
  const kind = statusKind(card);
  const problem = live ? problemsOf(card, now).find((p) => p.tone === 'warn' || p.tone === 'bad') : undefined;
  const primary: RowPrimary | null = problem?.action
    ? { label: boot?.busy ? 'Setting up...' : problem.action.label, disabled: !!boot?.busy, reserve: ['Set up', 'Setting up...', 'Check again'], testId: 'host-fleet-fix', onClick: onBootStart }
    : null;
  return (
    <HostRow
      rowKey={`fleet:${card.host}`}
      id={hostRowId(card.host)}
      alias={card.host}
      name={name}
      tag={card.connection.kind === 'bridge' ? <SettingsTag title="The cloud companion's own box">Cloud</SettingsTag> : undefined}
      dot={<HostStatusDot dot={{ kind: kind === 'warn' ? 'connected' : kind === 'off' ? 'unknown' : kind, title: `${name}: ${live ? 'Online' : offlineLine(card)}` }} host={card.host} />}
      state={live ? liveLine(card) : offlineLine(card)}
      lines={[
        problem && <RowLine key="p" tone={problem.tone === 'bad' ? 'bad' : 'warn'} testId="rh-row-warning">{problem.text}</RowLine>,
        boot?.note && <RowLine key="n" tone="note" testId="host-fleet-action-note">{boot.note}</RowLine>,
        boot?.error && <RowLine key="e" tone="bad" testId="host-fleet-action-error">{boot.error}</RowLine>,
      ].filter(Boolean)}
      primary={primary}
      menu={[{ key: 'details', label: detailsOpen ? 'Hide details' : 'Details', onSelect: () => onDetails(!detailsOpen) }]}
      needsLook={needsLook(card, now)}
      panel={detailsOpen && <HostDetails alias={card.host} name={name} card={card} now={now} linked={false} profile={false} />}
    />
  );
}
