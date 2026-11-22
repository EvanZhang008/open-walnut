import { EXPERIMENTAL_FEATURES, EVERY_EXPERIMENT, everyExperimentOn, experimentalEnabled, type Config } from '@open-walnut/core';
import { SettingsGroup, SettingsRow, SettingsSection } from '../SettingsSection';
import { ToggleSwitch } from '../inputs/ToggleSwitch';
import { useOptimisticSetting } from '../inputs/useOptimisticSetting';
import { useSerialSave, type OnSave } from './GeneralSection';

/** One switch: `key` is an experiment's id, or EVERY_EXPERIMENT for the switch over all of them. */
function ExperimentalRow({ label, help, flagKey, value, save }: {
  label: string; help: string; flagKey: string; value: boolean;
  save: (key: string, enabled: boolean) => Promise<unknown>;
}) {
  const rowKey = `experimental.${flagKey}`;
  const setting = useOptimisticSetting(value, (enabled) => save(flagKey, enabled), { rowKey });
  const id = `experimental-${flagKey}`;
  return <SettingsRow label={label} help={help} htmlFor={id} error={setting.error}
    control={<ToggleSwitch id={id} checked={setting.value} busy={setting.busy} onChange={setting.set} />} />;
}

export function ExperimentalSection({ config, onSave }: { config: Config; onSave: OnSave }) {
  const save = useSerialSave(config, onSave);
  const write = (key: string, enabled: boolean) =>
    save((c) => ({ experimental: { ...c.experimental, [key]: enabled } }), { rowKey: `experimental.${key}` });
  return <SettingsSection id="experimental" title="Experimental">
    <SettingsGroup>
      <ExperimentalRow label="Every experiment on" flagKey={EVERY_EXPERIMENT}
        help="For people who build or test Walnut: every experiment below is on unless you turn its own switch off, and each new one is on as soon as it arrives. The few that copy or download all of your data say so and keep their own switch."
        value={everyExperimentOn(config.experimental)} save={write} />
    </SettingsGroup>
    <SettingsGroup>
      {EXPERIMENTAL_FEATURES.map((feature) => <ExperimentalRow key={feature.id} label={feature.name} help={feature.description}
        flagKey={feature.id} value={experimentalEnabled(config.experimental, feature.id)} save={write} />)}
    </SettingsGroup>
  </SettingsSection>;
}
