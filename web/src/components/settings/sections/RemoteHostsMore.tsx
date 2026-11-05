/**
 * Remote Hosts > More settings: what belongs to the whole page, not to one host, folded under
 * the Hosts list: the relay machines that joined with a link use, and the list of secrets. A
 * host's own settings (its session limit, which tasks may use it, Walnut on it, which secrets
 * are copied to it) live in its Details, under "This host" (2026-11-04 review: one host's
 * settings sat in four groups here, away from the host). No count of its own: the page has one,
 * at the top (HostNeedsLook.tsx).
 */
import type { NetOverview } from '@/api/hosts-net';
import { SettingsFold } from '../SettingsFold';
import { HostNetworkRelay } from './HostNetworkRelay';
import { SecretsGroup } from './SecretsGroup';

interface Props {
  hostLabels: Record<string, string>;
  net: NetOverview | null;
  onNetChanged: () => void;
}

export function RemoteHostsMore({ hostLabels, net, onNetChanged }: Props) {
  return (
    <SettingsFold
      id="remote-hosts-more"
      label="More settings"
      summary={net ? 'Relay and secrets. A host\'s own settings are in its Details.' : 'Secrets. A host\'s own settings are in its Details.'}
      data-testid="remote-hosts-more"
    >
      {net && <HostNetworkRelay net={net} onChanged={onNetChanged} />}
      <SecretsGroup hostLabels={hostLabels} />
    </SettingsFold>
  );
}
