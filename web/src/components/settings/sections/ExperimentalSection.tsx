import { EXPERIMENTAL_FEATURES, EVERY_EXPERIMENT, everyExperimentOn, experimentalEnabled, experimentSummary, type Config } from '@open-walnut/core';
import { SettingsGroup, SettingsRow, SettingsSection } from '../SettingsSection';
import { ToggleSwitch } from '../inputs/ToggleSwitch';
import { useOptimisticSetting } from '../inputs/useOptimisticSetting';
import { useSerialSave, type OnSave } from './GeneralSection';

/**
 * One switch: `key` is an experiment's id, or EVERY_EXPERIMENT for the switch over all of them.
 * Its help is one short line; an experiment's full description, when longer, is the row's hover
 * (2026-11-22 audit: forty rows of three-line paragraphs made the page a wall of text).
 */
function ExperimentalRow({ label, help, more, flagKey, value, save }: {
  label: string; help: string; more?: string; flagKey: string; value: boolean;
  save: (key: string, enabled: boolean) => Promise<unknown>;
}) {
  const rowKey = `experimental.${flagKey}`;
  const setting = useOptimisticSetting(value, (enabled) => save(flagKey, enabled), { rowKey });
  const id = `experimental-${flagKey}`;
  return <SettingsRow label={label} help={help} title={more} htmlFor={id} error={setting.error}
    control={<ToggleSwitch id={id} checked={setting.value} busy={setting.busy} onChange={setting.set} />} />;
}

export function ExperimentalSection({ config, onSave }: { config: Config; onSave: OnSave }) {
  const save = useSerialSave(config, onSave);
  const write = (key: string, enabled: boolean) =>
    save((c) => ({ experimental: { ...c.experimental, [key]: enabled } }), { rowKey: `experimental.${key}` });
  return <SettingsSection id="experimental" title="Experimental">
    {/* A builder's switch in a small group of its own, so the experiments stay the page (2026-11-22 audit). */}
    <SettingsGroup heading="For people who build or test Walnut" data-testid="experimental-builders">
      <ExperimentalRow label="Every experiment on" flagKey={EVERY_EXPERIMENT}
        help="Turns on every experiment, new ones too, except ones you switch off below and a few that keep their own switch."
        value={everyExperimentOn(config.experimental)} save={write} />
    </SettingsGroup>
    <SettingsGroup>
      {EXPERIMENTAL_FEATURES.map((feature) => <ExperimentalRow key={feature.id} label={feature.name}
        help={experimentSummary(feature)} more={experimentSummary(feature) === feature.description ? undefined : feature.description}
        flagKey={feature.id} value={experimentalEnabled(config.experimental, feature.id)} save={write} />)}
    </SettingsGroup>
  </SettingsSection>;
}
