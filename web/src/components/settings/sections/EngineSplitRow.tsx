/**
 * Settings, Sessions: "Share new tasks". Tasks started without an engine take turns between
 * the checked entries (`defaults.engine_split`, core/agents/engine-split.ts); Usage & Costs
 * compares how each did. An entry is an engine, or an engine on a named model ("Claude Code
 * on sonnet"), added in place. Saves on each change, like the default engine row above it.
 */
import { useEffect, useMemo, useState } from 'react';
import type { Config } from '@open-walnut/core';
import { SettingsRow } from '../SettingsSection';
import { SettingsCheckbox } from '../inputs/SettingsCheckbox';
import { SettingsButton } from '../inputs/SettingsButton';
import { ToggleSwitch } from '../inputs/ToggleSwitch';
import { useOptimisticSetting } from '../inputs/useOptimisticSetting';
import { useEngineCatalog, useEngineCatalogHydration } from '@/hooks/useEngineCatalog';
import { engineName } from './DefaultEngineRow';
import { defaultEnginePickerReady } from './default-engine-select';
import { modelLineLabel } from '@open-walnut/model-line';
import { useModelOptions } from '@/components/sessions/path-selector/model-options';
import { engineSplitSave, engineSplitSwitchSave, entryKey, entryOfKey, splitChecked, splitIsOff, splitSize } from './engine-split-select';
import type { useSerialSave } from './GeneralSection';

const ROW_KEY = 'sessions.engine-split';
const SWITCH_KEY = 'sessions.engine-split-switch';

export function EngineSplitRow({ config, save }: { config: Config; save: ReturnType<typeof useSerialSave> }) {
  const catalog = useEngineCatalog();
  const ready = defaultEnginePickerReady(useEngineCatalogHydration());
  const order = useMemo(() => catalog.map((e) => e.id as string), [catalog]);
  const saved = splitChecked(config, order);
  const pick = useOptimisticSetting<string>(saved, (v) => save((c) => engineSplitSave(c, v, order), { rowKey: ROW_KEY }), { rowKey: ROW_KEY });
  const keys = pick.value ? pick.value.split(',') : [];
  const checked = new Set(keys);
  // An entry with a model is listed while it is in the config, and one unchecked here stays listed
  // (unchecked) until the page is left, so a slip of the click is undone with another.
  const [shownModelKeys, setShownModelKeys] = useState<string[]>([]);
  const modelKeys = [...new Set([...shownModelKeys, ...keys.filter((k) => entryOfKey(k).model)])];
  useEffect(() => {
    if (modelKeys.some((k) => !shownModelKeys.includes(k))) setShownModelKeys(modelKeys);
  }, [modelKeys.join(',')]); // eslint-disable-line react-hooks/exhaustive-deps
  // An ACP engine takes no model per entry (the server ignores it): only a native engine is offered one.
  const acp = new Set(catalog.filter((e) => e.runtimeKind === 'acp').map((e) => e.id as string));
  const enough = splitSize(pick.value, acp) >= 2;
  const offPick = useOptimisticSetting<boolean>(splitIsOff(config), (off) => save((c) => engineSplitSwitchSave(c, !off), { rowKey: SWITCH_KEY }), { rowKey: SWITCH_KEY });
  const on = enough && !offPick.value;
  const nameOf = (id: string) => engineName(catalog.find((e) => e.id === id)?.displayName ?? id);
  const set = (next: string[]) => pick.set([...new Set(next)].join(','));
  const toggle = (key: string, v: boolean) => {
    if (v) { set([...keys, key]); return; }
    set(keys.filter((k) => k !== key));
  };
  const installed = catalog.filter((e) => e.availability.installed);
  const modelEngines = installed.filter((e) => e.runtimeKind !== 'acp');
  const missing = catalog.filter((e) => !e.availability.installed && !checked.has(e.id));
  const [addEngine, setAddEngine] = useState('');
  const [addModel, setAddModel] = useState('');
  const engineForAdd = addEngine || modelEngines[0]?.id || '';
  // The models Claude Code reported on this machine, as suggestions; a model outside them (another
  // company's model your proxy serves) is kept as typed, with a note.
  const known = useModelOptions().options;
  const typed = addModel.trim();
  const unlisted = engineForAdd === 'claude' && !!typed && !known.some((o) => o.value === typed);
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
          ? 'Any task start that names no engine takes turns between the checked entries below (not the chat composer, Main, leads, asks, routines, plugin tasks or reviewer subtasks). Usage & Costs compares them. Switch off to run every new task on the default engine again; the entries stay as they are.'
          : enough
            ? 'Switched off: every new task runs on the default engine. The entries below are kept; switch on to share tasks between them again.'
            : 'Check two or more entries below to spread new tasks between them; until then they all run on the default engine.'}
        error={pick.error ?? offPick.error}
        data-testid="engine-split-row"
        control={(
          <span className="engine-split-switch">
            <span className="settings-addons-muted" data-testid="engine-split-state" data-on={on || undefined}>{on ? 'On' : 'Off'}</span>
            {/* Off keeps the entries; with fewer than two there is nothing to switch on. */}
            <ToggleSwitch checked={on} disabled={!enough || !ready} onChange={(v) => offPick.set(!v)}
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
          <SettingsCheckbox key={k} checked={checked.has(k)} onChange={(v) => toggle(k, v)} disabled={!ready}
            label={modelLineLabel(nameOf(engine), engine, model)}
            trailing={acp.has(engine) ? <span className="settings-addons-muted">takes no model here: set it in engines.{engine}.model</span>
              : modelLineLabel(nameOf(engine), engine, model).toLowerCase().endsWith((model ?? "").toLowerCase()) ? undefined : <span className="settings-addons-muted">{model}</span>}
            data-testid={`engine-split-${k}`} />
        );
      })}
      {missing.length > 0 && (
        <SettingsRow label="Not installed on this machine" data-testid="engine-split-missing"
          help={`${missing.map((e) => engineName(e.displayName)).join(', ')}. Install one where Walnut runs and it is offered here to share tasks with.`} />
      )}
      {modelEngines.length > 0 && (
        <SettingsRow
          label="Add an engine on a model"
          help={unlisted
            ? `${typed} is not in the models Claude Code lists on this machine. It is sent as typed, so check the name (a model your proxy serves is fine).`
            : "Shares tasks with an engine running a model you name (for example Claude Code on sonnet, or another company's model your proxy serves), next to the engines above."}
          state={unlisted ? 'warning' : undefined}
          data-testid="engine-split-add"
          control={(
            <span className="engine-split-add">
              {modelEngines.length > 1 && (
                <select className="settings-select" aria-label="Engine" value={engineForAdd} onChange={(ev) => setAddEngine(ev.target.value)} data-testid="engine-split-add-engine">
                  {modelEngines.map((e) => <option key={e.id} value={e.id}>{engineName(e.displayName)}</option>)}
                </select>
              )}
              <input className="settings-input" aria-label="Model" placeholder="Model, e.g. sonnet" value={addModel} list="engine-split-models"
                onChange={(ev) => setAddModel(ev.target.value)} onKeyDown={(ev) => { if (ev.key === 'Enter') add(); }}
                data-testid="engine-split-add-model" />
              <datalist id="engine-split-models">{known.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</datalist>
              <SettingsButton disabled={!addKey || checked.has(addKey) || !ready} onClick={add} data-testid="engine-split-add-button">Add</SettingsButton>
            </span>
          )}
        />
      )}
    </>
  );
}

