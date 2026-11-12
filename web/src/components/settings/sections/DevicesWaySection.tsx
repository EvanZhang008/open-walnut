/**
 * Settings > Phones & Cloud > Tailscale, and > Browser link: one way of reaching
 * Walnut away from home, as a tab (PhonesCloudTabs.tsx). The Cloud companion tab
 * is CloudSection itself, and the Devices tab DevicesSection.
 * Tailscale's steps need the device list (which phones are on the tailnet, and
 * whether this Mac has a tailnet address for the pairing picker).
 */
import { useNavigate } from 'react-router-dom';
import { SettingsGroup, SettingsEmpty } from '../SettingsSection';
import { useIsReplicaServer } from '@/hooks/useServerRole';
import { RemoteAccessCard } from './cloud/RemoteAccessCard';
import { BrowserAccessGroup } from './cloud/BrowserAccessGroup';
import { requestPairTarget, useDevicesData } from './cloud/useDevicesData';
import { PhonesCloudTabPane } from './cloud/PhonesCloudTabs';
import { DEVICES_TAB, WAY_PANES } from '../settings-way-panes';
import '@/styles/settings-sections-addons.css';

type SubWay = 'tailscale' | 'browser';

function TailscaleSteps() {
  const navigate = useNavigate();
  const { devices, cloudDevices, targets, listState, refresh } = useDevicesData({ replica: false });
  // Step 3 picks the tailnet address in the pairing picker, which is on the Devices tab.
  const chooseTailnet = () => {
    requestPairTarget('tailnet');
    navigate({ hash: `#${DEVICES_TAB}` }, { replace: true });
  };
  return (
    <RemoteAccessCard
      heading="Steps"
      devices={listState === 'ready' ? [...devices, ...cloudDevices] : null}
      tailnetOffered={targets.some((t) => t.kind === 'tailnet')}
      onChooseTailnet={chooseTailnet}
      onTailnetChange={refresh}
    />
  );
}

export function DevicesWaySection({ way }: { way: SubWay }) {
  const replica = useIsReplicaServer();
  return (
    <PhonesCloudTabPane tab={WAY_PANES[way]}>
      {replica ? (
        // A replica answering without the Mac: these ways are set up on the Mac.
        <SettingsGroup>
          <SettingsEmpty>This is set up on the Mac itself; open these settings there.</SettingsEmpty>
        </SettingsGroup>
      ) : (
        <div className="devices-way-panel" id={`devices-way-panel-${way}`} data-testid={`devices-way-panel-${way}`}>
          {way === 'tailscale' ? <TailscaleSteps /> : <BrowserAccessGroup />}
        </div>
      )}
    </PhonesCloudTabPane>
  );
}
