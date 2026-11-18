import { SectionCard } from '../inputs/SectionCard';
import { PhonesCloudTabHead, usePhonesCloudView } from './cloud/PhonesCloudTabs';
import { DEVICES_TAB } from '../settings-way-panes';
import { DeviceList } from './cloud/DeviceList';

export { humanDeviceModel, describeDevice, describeMacRow, CLOUD_UNPAIRED_NOTICE, DEVICES_CHANGED_EVENT, UNPAIR_SELF_WARNING } from './cloud/device-rows-copy';

/**
 * Settings > Phones & Cloud > All devices (a tab, PhonesCloudTabs.tsx): every phone,
 * browser, extension and Mac that can open Walnut, each tagged with the ways it uses,
 * and pairing a new phone with the address picker. Each way's own tab lists the
 * devices of that way (cloud/DeviceList.tsx).
 *
 * The picker only chooses which address goes in the QR. A phone paired through
 * any address learns the other addresses by itself, so pick the one the phone
 * can reach right now: a Wi-Fi QR scanned over cellular never connects at all.
 */
export function DevicesSection() {
  const tabView = usePhonesCloudView();
  return (
    <SectionCard id={DEVICES_TAB} title="Phones & Cloud">
      <PhonesCloudTabHead tab={DEVICES_TAB} view={tabView} />
      <DeviceList scope="all" />
    </SectionCard>
  );
}
