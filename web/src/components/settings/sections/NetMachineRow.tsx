/**
 * Settings > Remote Hosts: one machine that joined with a link, as a row of Hosts beside the
 * SSH hosts (useHostNetwork.ts): its name, its system and how this Mac reaches it, a Link
 * tag, its status line, and Remove (which also takes it off the companion's list).
 */
import type { NetMachine, NetRelay } from '@/api/hosts-net';
import { SettingsRow, SettingsTag } from '../SettingsSection';
import { InlineConfirmButton } from '../inputs/InlineConfirmButton';
import { RemoteHostDetail, RemoteHostStatus } from './RemoteHostStatus';
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
  const rtt = typeof m.rttMs === 'number' ? ` · ${Math.round(m.rttMs)} ms` : '';
  if (m.path === 'direct') return `Direct${rtt}`;
  if (m.path === 'relay') return `${relay === 'public' ? 'Through a public relay' : 'Through your relay'}${rtt}`;
  // No link right now: the status line under the name says why.
  return '';
}

export function NetMachineRow({ machine: m, name, relay, error, onRemove }: {
  machine: NetMachine; name: string; relay: NetRelay; error?: string; onRemove: () => void | Promise<unknown>;
}) {
  const sub = [platformLabel(m.platform), pathLabel(m, relay)].filter(Boolean).join(' · ');
  return (
    <SettingsRow
      id={hostRowId(m.host)}
      className="rh-host-row"
      data-host-alias={m.host}
      data-net-path={m.path}
      data-row-key={`net:${m.host}`}
      label={
        <span className="settings-addons-inline">
          <span className="rh-host-name">{name}</span>
          {sub && <span className="settings-addons-muted settings-addons-ellipsis" data-testid="host-network-path">{sub}</span>}
          <SettingsTag title="Joined with a link: no SSH">Link</SettingsTag>
        </span>
      }
      help={<RemoteHostStatus alias={m.host} name={name} enabled={m.enabled} />}
      error={error}
      children={<RemoteHostDetail alias={m.host} name={name} enabled={m.enabled} />}
      control={<InlineConfirmButton quiet aria-label={`Remove ${name}`} onConfirm={onRemove} />}
    />
  );
}
