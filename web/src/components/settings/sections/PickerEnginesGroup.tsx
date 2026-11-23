/**
 * Settings, Sessions: which engines the model picker offers (`session.picker_engines`), and the
 * command of the custom ACP engine (`engines.custom.adapter_cmd`). The picker shows Claude Code,
 * Codex, Antigravity, OpenCode and Pi unless the list says otherwise; a session on an engine turned off here
 * keeps it, and its picker still shows it.
 */
import type { Config, SessionEngine } from '@open-walnut/core';
import { SettingsGroup, SettingsRow } from '../SettingsSection';
import { SettingsCheckbox } from '../inputs/SettingsCheckbox';
import { useOptimisticSetting } from '../inputs/useOptimisticSetting';
import { useCommitField } from '../inputs/useCommitField';
import { refreshEngineCatalog, useEngineCatalog, useEngineCatalogHydration } from '@/hooks/useEngineCatalog';
import { engineLabel } from '@/utils/engine-capabilities';
import { defaultEnginePickerReady } from './default-engine-select';
import { argvText, customAdapterSave, pickerChecked, pickerEnginesSave } from './picker-engines-select';
import type { useSerialSave } from './GeneralSection';

const ROW_KEY = 'sessions.picker-engines';
const CUSTOM_KEY = 'sessions.custom-acp-engine';

export function PickerEnginesGroup({ config, save }: { config: Config; save: ReturnType<typeof useSerialSave> }) {
  const catalog = useEngineCatalog();
  const ready = defaultEnginePickerReady(useEngineCatalogHydration());
  const saved = pickerChecked(config, catalog).join(',');
  const pick = useOptimisticSetting<string>(
    saved,
    // The picker reads the list from the engine catalog, so it is read again once saved.
    (v) => save((c) => pickerEnginesSave(c, (v ? v.split(',') : []) as SessionEngine[], catalog), { rowKey: ROW_KEY })
      .then(() => refreshEngineCatalog()),
    { rowKey: ROW_KEY },
  );
  const checked = new Set(pick.value ? pick.value.split(',') : []);
  const toggle = (id: string, on: boolean) => {
    const next = on ? [...checked, id] : [...checked].filter((k) => k !== id);
    // In catalog order, as the saved value reads, so the echo of the save matches it.
    const order = catalog.map((e) => e.id as string);
    pick.set(next.sort((a, b) => order.indexOf(a) - order.indexOf(b)).join(','));
  };
  const command = useCommitField<string>(
    argvText(config.engines?.custom?.adapter_cmd),
    (text) => save((c) => customAdapterSave(c, text), { rowKey: CUSTOM_KEY }).then(() => refreshEngineCatalog()),
    { rowKey: CUSTOM_KEY, kind: 'text' },
  );
  return (
    <SettingsGroup
      heading="Engines in the model picker"
      description="The engines the model picker offers. A session on an engine turned off here keeps it."
      className="settings-checklist"
      data-testid="picker-engines-group"
    >
      {catalog.map((e) => (
        <SettingsCheckbox
          key={e.id}
          checked={checked.has(e.id)}
          disabled={!ready}
          onChange={(v) => toggle(e.id, v)}
          label={engineLabel(e)}
          trailing={e.availability.installed ? undefined
            : <span className="settings-addons-muted">{e.id === 'custom' ? 'set its command below' : 'not installed on this machine'}</span>}
          data-testid={`picker-engine-${e.id}`}
        />
      ))}
      {pick.error && <p className="settings-row-error" role="alert">{pick.error}</p>}
      <SettingsRow
        anchor="custom-acp-engine-row"
        label="Custom ACP engine"
        help="The command that starts an agent speaking ACP (Agent Client Protocol) here. Check Custom (ACP) above to offer it."
        htmlFor="custom-acp-engine-command"
        error={command.error}
        control={(
          <input
            id="custom-acp-engine-command"
            data-testid="custom-acp-engine-command"
            data-no-draft="autosave"
            type="text"
            className="settings-input settings-input--long"
            placeholder="npx -y my-acp-agent --stdio"
            spellCheck={false}
            {...command.inputProps}
          />
        )}
      />
    </SettingsGroup>
  );
}
