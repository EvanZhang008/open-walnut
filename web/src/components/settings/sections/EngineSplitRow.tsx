/**
 * Settings, Sessions: "Share new tasks". Tasks started without an engine take turns between
 * the checked entries (`defaults.engine_split`, core/agents/engine-split.ts); Usage & Costs
 * compares how each did. An entry is an engine, or an engine on a named model ("Claude Code
 * on sonnet"), added in place. Saves on each change, like the default engine row above it.
 */
import { useMemo, useState } from 'react';
import type { Config } from '@open-walnut/core';
import { SettingsRow } from '../SettingsSection';
import { SettingsCheckbox } from '../inputs/SettingsCheckbox';
import { SettingsButton } from '../inputs/SettingsButton';
import { ToggleSwitch } from '../inputs/ToggleSwitch';
import { useOptimisticSetting } from '../inputs/useOptimisticSetting';
import { useEngineCatalog, useEngineCatalogHydration } from '@/hooks/useEngineCatalog';
import { engineName } from './DefaultEngineRow';
import { defaultEnginePickerReady } from './default-engine-select';
import { engineSplitSave, entryKey, entryOfKey, splitChecked, splitSize } from './engine-split-select';
import type { useSerialSave } from './GeneralSection';

const ROW_KEY = 'sessions.engine-split';

export function EngineSplitRow({ config, save }: { config: Config; save: ReturnType<typeof useSerialSave> }) {
  const catalog = useEngineCatalog();
  const ready = defaultEnginePickerReady(useEngineCatalogHydration());
  const order = useMemo(() => catalog.map((e) => e.id as string), [catalog]);
  const saved = splitChecked(config, order);
  const pick = useOptimisticSetting<string>(saved, (v) => save((c) => engineSplitSave(c, v, order), { rowKey: ROW_KEY }), { rowKey: ROW_KEY });
  const keys = pick.value ? pick.value.split(',') : [];
  const checked = new Set(keys);
  // An entry with a model stays listed while it is in the config; unchecking one removes it.
  const modelKeys = keys.filter((k) => entryOfKey(k).model);
  const on = splitSize(pick.value) >= 2;
  const nameOf = (id: string) => engineName(catalog.find((e) => e.id === id)?.displayName ?? id);
  const set = (next: string[]) => pick.set([...new Set(next)].join(','));
  const toggle = (key: string, v: boolean) => {
    if (v) { set([...keys, key]); return; }
    set(keys.filter((k) => k !== key));
  };
  const installed = catalog.filter((e) => e.availability.installed);
  const missing = catalog.filter((e) => !e.availability.installed && !checked.has(e.id));
  const [addEngine, setAddEngine] = useState('');
  const [addModel, setAddModel] = useState('');
  const engineForAdd = addEngine || installed[0]?.id || '';
  const addKey = engineForAdd && addModel.trim() ? entryKey({ engine: engineForAdd, model: addModel.trim() }) : '';
  const add = () => {
    if (!addKey) return;
    set([...keys, addKey]);
    setAddModel('');
  };
  return (
    <>
      <SettingsRow
        label="Share new tasks"
        help={on
          ? 'Any task start that names no engine takes turns between the checked entries below (not the chat composer, Main, leads, asks, routines, plugin tasks or reviewer subtasks). Usage & Costs compares them. Switch off to run every new task on the default engine again.'
          : 'Check two or more entries below to spread new tasks between them; until then they all run on the default engine.'}
        error={pick.error}
        data-testid="engine-split-row"
        control={(
          <span className="engine-split-switch">
            <span className="settings-addons-muted" data-testid="engine-split-state" data-on={on || undefined}>{on ? 'On' : 'Off'}</span>
            {/* Turning it on is checking two entries; the switch turns it off in one step. */}
            <ToggleSwitch checked={on} disabled={!on || !ready} onChange={(v) => { if (!v) set([]); }}
              aria-label="Share new tasks" data-testid="engine-split-switch" />
          </span>
        )}
      />
      {catalog.filter((e) => e.availability.installed || checked.has(e.id)).map((e) => (
        <SettingsCheckbox
          key={e.id}
          checked={checked.has(e.id)}
          disabled={!ready}
          onChange={(v) => toggle(e.id, v)}
          label={engineName(e.displayName)}
          // A checked engine this machine no longer has stays listed, so it can be unchecked.
          trailing={!e.availability.installed ? <span className="settings-addons-muted">not installed on this machine</span> : undefined}
          data-testid={`engine-split-${e.id}`}
        />
      ))}
      {modelKeys.map((k) => {
        const { engine, model } = entryOfKey(k);
        return (
          <SettingsCheckbox key={k} checked onChange={(v) => toggle(k, v)} disabled={!ready}
            label={`${nameOf(engine)} on ${model}`} data-testid={`engine-split-${k}`} />
        );
      })}
      {missing.length > 0 && (
        <SettingsRow label="Not installed on this machine" data-testid="engine-split-missing"
          help={`${missing.map((e) => engineName(e.displayName)).join(', ')}. Install one where Walnut runs and it is offered here to share tasks with.`} />
      )}
      {installed.length > 0 && (
        <SettingsRow
          label="Add an engine on a model"
          help="Shares tasks with an engine running a model you name (for example Claude Code on sonnet), next to the engines above."
          data-testid="engine-split-add"
          control={(
            <span className="engine-split-add">
              {installed.length > 1 && (
                <select className="settings-select" aria-label="Engine" value={engineForAdd} onChange={(ev) => setAddEngine(ev.target.value)} data-testid="engine-split-add-engine">
                  {installed.map((e) => <option key={e.id} value={e.id}>{engineName(e.displayName)}</option>)}
                </select>
              )}
              <input className="settings-input" aria-label="Model" placeholder="Model, e.g. sonnet" value={addModel}
                onChange={(ev) => setAddModel(ev.target.value)} onKeyDown={(ev) => { if (ev.key === 'Enter') add(); }}
                data-testid="engine-split-add-model" />
              <SettingsButton disabled={!addKey || checked.has(addKey) || !ready} onClick={add} data-testid="engine-split-add-button">Add</SettingsButton>
            </span>
          )}
        />
      )}
    </>
  );
}

