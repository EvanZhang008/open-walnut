/**
 * Settings, Sessions: "Share new tasks". Tasks started without an engine take turns between
 * the checked engines (`defaults.engine_split`, core/agents/engine-split.ts); Usage & Costs
 * compares how each did. Saves on each check, like the default engine row above it.
 */
import { useMemo } from 'react';
import type { Config } from '@open-walnut/core';
import { SettingsRow } from '../SettingsSection';
import { SettingsCheckbox } from '../inputs/SettingsCheckbox';
import { useOptimisticSetting } from '../inputs/useOptimisticSetting';
import { useEngineCatalog, useEngineCatalogHydration } from '@/hooks/useEngineCatalog';
import { engineName } from './DefaultEngineRow';
import { defaultEnginePickerReady } from './default-engine-select';
import { engineSplitSave, splitChecked, splitModelEntries, splitSize } from './engine-split-select';
import type { useSerialSave } from './GeneralSection';

const ROW_KEY = 'sessions.engine-split';

export function EngineSplitRow({ config, save }: { config: Config; save: ReturnType<typeof useSerialSave> }) {
  const catalog = useEngineCatalog();
  const ready = defaultEnginePickerReady(useEngineCatalogHydration());
  const order = useMemo(() => catalog.map((e) => e.id as string), [catalog]);
  const saved = splitChecked(config, order);
  const pick = useOptimisticSetting<string>(saved, (v) => save((c) => engineSplitSave(c, v, order), { rowKey: ROW_KEY }), { rowKey: ROW_KEY });
  const checked = new Set(pick.value ? pick.value.split(',') : []);
  // Installed engines, and any checked one this machine no longer has (so it can be unchecked).
  const offered = catalog.filter((e) => e.availability.installed || checked.has(e.id));
  const withModel = splitModelEntries(config);
  const on = splitSize(pick.value, config) >= 2;
  const toggle = (id: string, v: boolean) => {
    const next = new Set(checked);
    if (v) next.add(id); else next.delete(id);
    pick.set(order.filter((x) => next.has(x)).join(','));
  };
  return (
    <>
      <SettingsRow
        label="Share new tasks"
        help={on
          ? 'Any task start that names no engine takes turns between these (not the chat composer, Main, leads, asks, routines, plugin tasks or reviewer subtasks). Usage & Costs compares them.'
          : 'Check two or more engines to spread new tasks between them; until then they all run on the default engine.'}
        error={pick.error}
        data-testid="engine-split-row"
        control={<span className="settings-addons-muted" data-testid="engine-split-state" data-on={on || undefined}>{on ? 'On' : 'Off'}</span>}
      />
      {offered.map((e) => (
        <SettingsCheckbox
          key={e.id}
          checked={checked.has(e.id)}
          disabled={!ready}
          onChange={(v) => toggle(e.id, v)}
          label={engineName(e.displayName)}
          trailing={!e.availability.installed ? <span className="settings-addons-muted">not installed</span> : undefined}
          data-testid={`engine-split-${e.id}`}
        />
      ))}
      {withModel.length > 0 && (
        <SettingsRow label="Also in the split" help="Set in config.yaml (defaults.engine_split)."
          control={<span className="settings-addons-muted">{withModel.map((m) => `${engineName(catalog.find((e) => e.id === m.engine)?.displayName ?? m.engine)} · ${m.model}`).join(', ')}</span>} />
      )}
    </>
  );
}
