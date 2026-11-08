/**
 * Settings > Remote Hosts: one machine that joined with a link, a row of the list beside the
 * SSH hosts (useHostNetwork.ts): its name, its system and how this Mac reaches it, a Link
 * tag, its state line and one action (useLinkedHostRow.tsx). Remove, in its menu, also takes
 * it off the list your cloud companion keeps.
 */
import type { FleetHost } from '@/api/hosts-fleet';
import type { NetMachine, NetRelay } from '@/api/hosts-net';
import { SettingsTag } from '../SettingsSection';
import { HostDetails } from './HostDetails';
import { HostRow } from './HostRow';
import { useLinkedHostRow } from './useLinkedHostRow';
import { hostRowId } from '@/utils/host-settings-nav';

/** `linux-x64` -> `Linux x86_64`. */
export function platformLabel(p?: string): string {
  if (!p) return '';
  const [os, arch] = p.split('-');
  const osName = os === 'darwin' ? 'macOS' : os === 'linux' ? 'Linux' : os;
  const archName = arch === 'x64' ? 'x86_64' : arch ?? '';
  return `${osName} ${archName}`.trim();
}

export function pathLabel(m: Pick<NetMachine, 'path' | 'rttMs'>, relay: NetRelay = 'own'): string {
  const rtt = typeof m.rttMs === 'number' ? `, ${Math.round(m.rttMs)} ms` : '';
  if (m.path === 'direct') return `Direct${rtt}`;
  if (m.path === 'relay') return `${relay === 'public' ? 'Through a public relay' : 'Through your relay'}${rtt}`;
  // No link right now: the state line under the name says why.
  return '';
}

export function NetMachineRow({ machine: m, name, relay, error, card, now, detailsOpen, onDetails, onRemove }: {
  machine: NetMachine; name: string; relay: NetRelay; error?: string; card?: FleetHost; now: number;
  detailsOpen: boolean; onDetails: (open: boolean) => void; onRemove: () => void | Promise<unknown>;
}) {
  // "Linux x86_64, direct, 31 ms": the path reads on in the platform's sentence.
  const path = pathLabel(m, relay);
  const sub = [platformLabel(m.platform), path && path[0].toLowerCase() + path.slice(1)].filter(Boolean).join(', ');
  const live = useLinkedHostRow({ alias: m.host, name, enabled: m.enabled, saved: true, card, now, via: 'net' });
  return (
    <HostRow
      rowKey={`net:${m.host}`}
      id={hostRowId(m.host)}
      alias={m.host}
      name={name}
      sub={sub && <span className="settings-addons-muted settings-addons-ellipsis" data-testid="host-network-path">{sub}</span>}
      tag={<SettingsTag title="Joined with a link: no SSH">Link</SettingsTag>}
      dot={live.dot}
      state={live.state}
      lines={error ? [...live.lines, <span key="err" className="rh-row-line" data-tone="bad" role="alert">{error}</span>] : live.lines}
      primary={live.primary}
      menu={[
        { key: 'details', label: detailsOpen ? 'Hide details' : 'Details', onSelect: () => onDetails(!detailsOpen) },
      ]}
      onRemove={onRemove}
      removeNote="It leaves your machines, on this Mac and on your cloud companion: joining again takes a new link."
      needsLook={live.needsLook}
      report={{
        host: m.host, counted: true, online: live.online, off: !m.enabled, local: false, via: 'net', phone: card?.server?.phone === 'connected', unstable: !!card?.connection.unstable,
        rttMs: live.online && typeof m.rttMs === 'number' ? Math.round(m.rttMs) : null,
        sessions: card?.sessions.running ?? null, spendUsd: card?.spend?.last30dUsd ?? null, sub,
      }}
      data={{ 'data-net-path': m.path }}
      panel={detailsOpen && <HostDetails alias={m.host} name={name} card={card} now={now} linked kind="net" rowProblem={live.problemKey} onClose={() => onDetails(false)} />}
    />
  );
}
