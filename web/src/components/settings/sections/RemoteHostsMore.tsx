/**
 * Remote Hosts > More settings: what a person changes rarely, folded under the Hosts list
 * (2026-11-04 review: the page showed the same hosts in five groups at once). Closed by
 * default; its line says what is inside and how many rows need a look, and each group keeps
 * reading while it is closed (SettingsFold).
 */
import type { Config } from '@open-walnut/core';
import type { NetOverview } from '@/api/hosts-net';
import { SettingsFold } from '../SettingsFold';
import { HostNetworkRelay } from './HostNetworkRelay';
import { HostServersGroup } from './HostServersGroup';
import { HostExecGrantsGroup } from './HostExecGrantsGroup';
import { SecretsGroup } from './SecretsGroup';
import { SessionLimitsGroup } from './RemoteHostLimits';

interface Props {
  hosts: Config['hosts'];
  hostLabels: Record<string, string>;
  net: NetOverview | null;
  onNetChanged: () => void;
  limits: Record<string, string | number>;
  onLimits: (update: (prev: Record<string, string | number>) => Record<string, string | number>) => void;
}

export function RemoteHostsMore({ hosts, hostLabels, net, onNetChanged, limits, onLimits }: Props) {
  return (
    <SettingsFold
      id="remote-hosts-more"
      label="More settings"
      summary="Relay, Walnut on a host, tasks using other hosts, secrets, session limits."
      data-testid="remote-hosts-more"
    >
      {net && <HostNetworkRelay net={net} onChanged={onNetChanged} />}
      <HostServersGroup hosts={hosts} />
      <HostExecGrantsGroup hostLabels={hostLabels} />
      <SecretsGroup hostLabels={hostLabels} />
      <SessionLimitsGroup limits={limits} onChange={onLimits} />
    </SettingsFold>
  );
}
