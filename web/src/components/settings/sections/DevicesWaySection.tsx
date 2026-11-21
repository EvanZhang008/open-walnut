/**
 * Settings > Phones & Cloud > Tailscale, > the tunnel's tab and > Same Wi-Fi: one way of
 * reaching Walnut, as a tab (PhonesCloudTabs.tsx). The Cloud companion tab
 * is CloudSection itself, and the Devices tab DevicesSection.
 * Tailscale's steps need the device list (which phones are on the tailnet, and
 * whether this Mac has a tailnet address to pair with). Under the way's own
 * settings, the devices that use it (cloud/DeviceList.tsx).
 */
import { SettingsGroup, SettingsEmpty } from '../SettingsSection';
import { useIsReplicaServer } from '@/hooks/useServerRole';
import { RemoteAccessCard } from './cloud/RemoteAccessCard';
import { BrowserAccessGroup } from './cloud/BrowserAccessGroup';
import { useDevicesData } from './cloud/useDevicesData';
import { PhonesCloudTabPane } from './cloud/PhonesCloudTabs';
import { WAY_PANES } from '../settings-way-panes';
import { DeviceList } from './cloud/DeviceList';
import '@/styles/settings-sections-addons.css';

type SubWay = 'tailscale' | 'browser' | 'wifi';

function TailscaleSteps() {
  const { devices, cloudDevices, targets, listState, refresh } = useDevicesData({ replica: false });
  // Step 3: this tab's own Pair the Walnut app this way, below the steps.
  const chooseTailnet = () => {
    const field = document.getElementById('devices-new-name');
    field?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    field?.focus({ preventScroll: true });
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
          {/* Same Wi-Fi has nothing to set up: its list pairs a phone and signs a browser in. */}
          {way === 'tailscale' ? <TailscaleSteps /> : way === 'browser' ? <BrowserAccessGroup heading="Web browser: sign in" /> : null}
          <DeviceList scope={way} />
        </div>
      )}
    </PhonesCloudTabPane>
  );
}
