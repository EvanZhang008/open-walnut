import { EXPERIMENTAL_FEATURES, experimentalEnabled, type Config, type ExperimentalFeatureId } from '@open-walnut/core';
import { SettingsGroup, SettingsRow, SettingsSection } from '../SettingsSection';
import { ToggleSwitch } from '../inputs/ToggleSwitch';
import { useOptimisticSetting } from '../inputs/useOptimisticSetting';
import { useSerialSave, type OnSave } from './GeneralSection';

function ExperimentalRow({ config, feature, save }: {
  config: Config;
  feature: typeof EXPERIMENTAL_FEATURES[number];
  save: (id: ExperimentalFeatureId, enabled: boolean) => Promise<unknown>;
}) {
  const rowKey = `experimental.${feature.id}`;
  const setting = useOptimisticSetting(experimentalEnabled(config.experimental, feature.id),
    (enabled) => save(feature.id, enabled), { rowKey });
  const id = `experimental-${feature.id}`;
  return <SettingsRow label={feature.name} help={feature.description} htmlFor={id} error={setting.error}
    control={<ToggleSwitch id={id} checked={setting.value} busy={setting.busy} onChange={setting.set} />} />;
}

export function ExperimentalSection({ config, onSave }: { config: Config; onSave: OnSave }) {
  const save = useSerialSave(config, onSave);
  return <SettingsSection id="experimental" title="Experimental">
    <SettingsGroup>
      {EXPERIMENTAL_FEATURES.map((feature) => <ExperimentalRow key={feature.id} config={config} feature={feature}
        save={(id, enabled) => save((c) => ({ experimental: { ...c.experimental, [id]: enabled } }), { rowKey: `experimental.${id}` })} />)}
    </SettingsGroup>
  </SettingsSection>;
}
