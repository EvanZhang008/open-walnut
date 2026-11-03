/**
 * Settings > Phones & Cloud itself: it has no page of its own, it opens the tab the
 * phone uses (cloud/PhonesCloudTabs.tsx) once the device list says which, and shows
 * the tab bar over a loading line until then.
 */
import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { SettingsSection, SettingsGroup, SettingsLoadingRow } from '../SettingsSection';
import { PHONES_CLOUD_PANE } from '../settings-way-panes';
import { PANE_TITLE, TabBar, usePhonesCloudView } from './cloud/PhonesCloudTabs';

/** Phones & Cloud itself: opens the tab in use once the list says which. */
export function PhonesCloudLanding() {
  const navigate = useNavigate();
  const view = usePhonesCloudView();
  useEffect(() => {
    if (view.landing) navigate({ hash: `#${view.landing}` }, { replace: true });
  }, [view.landing, navigate]);
  return (
    <SettingsSection id={PHONES_CLOUD_PANE} title={PANE_TITLE}>
      <div className="pc-head">
        <TabBar tabs={view.tabs} current={null} />
      </div>
      <SettingsGroup>
        <SettingsLoadingRow>{view.now.title}</SettingsLoadingRow>
      </SettingsGroup>
    </SettingsSection>
  );
}
