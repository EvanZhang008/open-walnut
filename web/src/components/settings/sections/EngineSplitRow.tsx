/**
 * Settings, Sessions: "Share new tasks". Tasks started without an engine take turns between
 * the checked entries (`defaults.engine_split`, core/agents/engine-split.ts); Usage & Costs
 * compares how each did. An entry is an engine, or an engine on a named model ("Claude Code
 * on sonnet"), added in place. Saves on each change, like the default engine row above it.
 *
 * The switch is the master of the rows under it (a ControlGroup), as every Settings master is:
 * switched off, they read disabled and grey, kept as they are, with the reason under it. Switched
 * on with fewer than two entries, the rows are live and the state says "Not yet": nothing is
 * shared until a second entry is checked (the 2026-11-22 audit: a grey Off switch over a box that
 * still looked live, with one engine installed).
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { Config } from '@open-walnut/core';
import { SettingsRow } from '../SettingsSection';
import { SettingsCheckbox } from '../inputs/SettingsCheckbox';
import { SettingsButton } from '../inputs/SettingsButton';
import { ToggleSwitch } from '../inputs/ToggleSwitch';
import { ControlGroup, masterProps } from '@/components/controls';
import { useOptimisticSetting } from '../inputs/useOptimisticSetting';
import { useEngineCatalog, useEngineCatalogHydration } from '@/hooks/useEngineCatalog';
import { engineName } from './DefaultEngineRow';
import { defaultEnginePickerReady } from './default-engine-select';
import { modelLineLabel } from '@open-walnut/model-line';
import { useModelOptions } from '@/components/sessions/path-selector/model-options';
import { engineSplitProjectsSave, engineSplitSave, engineSplitSwitchSave, entryKey, entryOfKey, splitChecked, splitIsOff, splitProjectsOf, splitSize } from './engine-split-select';
import { useProjectRegistry } from '@/hooks/useProjectRegistry';
import type { useSerialSave } from './GeneralSection';
import { MicInput, type BoxMicHandle } from '@/components/common/BoxMic';
import { useSendAfterDictation, dictationWaitProps } from '@/hooks/useSendAfterDictation';

const ROW_KEY = 'sessions.engine-split';
const SWITCH_KEY = 'sessions.engine-split-switch';
const PROJECTS_KEY = 'sessions.engine-split-projects';
const ENTRIES_ID = 'engine-split-entries';

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
  // Switched on in this visit with no entries yet: the switch shows on so its rows can be ticked.
  const [armed, setArmed] = useState(false);
  const switchOn = !offPick.value && (armed || keys.length > 0);
  const on = enough && switchOn;
  const flip = (v: boolean) => {
    setArmed(v);
    // Off keeps the entries (the flag); with none there is nothing to keep, so nothing is written.
    if (v ? offPick.value : keys.length > 0) offPick.set(!v);
  };
  const nameOf = (id: string) => engineName(catalog.find((e) => e.id === id)?.displayName ?? id);
  const set = (next: string[]) => pick.set([...new Set(next)].join(','));
  const toggle = (key: string, v: boolean) => {
    setArmed(true);
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
  // The projects it shares: none named = every project. One unchecked stays listed until the page is left.
  const projectsPick = useOptimisticSetting<string>(splitProjectsOf(config).join('\n'),
    (v) => save((c) => engineSplitProjectsSave(c, v), { rowKey: PROJECTS_KEY }), { rowKey: PROJECTS_KEY });
  const projects = projectsPick.value ? projectsPick.value.split('\n') : [];
  const [shownProjects, setShownProjects] = useState<string[]>([]);
  const listedProjects = [...shownProjects, ...projects.filter((n) => !shownProjects.some((s) => s.toLowerCase() === n.toLowerCase()))];
  useEffect(() => {
    if (listedProjects.length !== shownProjects.length) setShownProjects(listedProjects);
  }, [listedProjects.join('\n')]); // eslint-disable-line react-hooks/exhaustive-deps
  const { projectNames } = useProjectRegistry();
  const [addProject, setAddProject] = useState('');
  const projectTyped = addProject.trim();
  const projectHas = (n: string) => projects.some((p) => p.toLowerCase() === n.toLowerCase());
  const setProjects = (next: string[]) => projectsPick.set(next.join('\n'));
  const addOneProject = () => {
    if (!projectTyped || projectHas(projectTyped)) return;
    // Spelled as the project is, when it is one.
    setProjects([...projects, projectNames.find((n) => n.toLowerCase() === projectTyped.toLowerCase()) ?? projectTyped]);
    projectMic.current?.clear();
    setAddProject('');
  };
  // Add (the button, or Enter in the box) waits for a project name still being dictated.
  const projectMic = useRef<BoxMicHandle | null>(null);
  const addGate = useSendAfterDictation([projectMic], addOneProject);
  return (
    <>
      <SettingsRow
        label="Share new tasks"
        // Each row's help is one short line and the rest opens under its More: two-line helps here
        // pushed the engine list off the first screen (2026-11-22, the audit's second look), and a
        // hover alone hid them (its third look).
        help={on
          ? 'New tasks that name no engine take turns between the entries below.'
          : switchOn
            ? 'Check two or more entries below to share new tasks between them.'
            // Off: what happens now only. What switching on gives is said once, in the entries'
            // reason line right under this row (ControlGroup `reason`).
            : enough
              ? 'Every new task runs on the default engine. The entries below are kept.'
              : 'Every new task runs on the default engine.'}
        more={on ? 'Not shared: the chat composer, Main, leads, asks, routines, plugin tasks and reviewer subtasks. Switching off keeps the entries.'
          : switchOn ? 'Until then every new task runs on the default engine.' : undefined}
        error={pick.error ?? offPick.error}
        data-testid="engine-split-row"
        control={(
          <span className="engine-split-control">
            <span className="settings-addons-muted" data-testid="engine-split-state" data-on={on || undefined}>{on ? 'On' : switchOn ? 'Not yet' : 'Off'}</span>
            {/* Off keeps the entries. */}
            <ToggleSwitch checked={switchOn} disabled={!ready} onChange={flip}
              aria-label="Share new tasks" data-testid="engine-split-switch" {...masterProps(ENTRIES_ID)} />
          </span>
        )}
      />
      <ControlGroup id={ENTRIES_ID} off={!switchOn} className="settings-rows-contents" reason="Switch Share new tasks on to pick the entries it shares between.">
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
            trailing={acp.has(engine) ? <span className="settings-addons-muted">takes no model here: set it in <code>engines.{engine}.model</code> in <code>config.yaml</code></span>
              : modelLineLabel(nameOf(engine), engine, model).toLowerCase().endsWith((model ?? "").toLowerCase()) ? undefined : <span className="settings-addons-muted">{model}</span>}
            data-testid={`engine-split-${k}`} />
        );
      })}
      {missing.length > 0 && (
        <SettingsRow label="Not installed on this machine" data-testid="engine-split-missing"
          help={`${missing.map((e) => engineName(e.displayName)).join(', ')}.`}
          more="Install one where Walnut runs and it is offered here to share tasks with." />
      )}
      <SettingsRow
        label="In projects"
        help={projects.length ? `Only tasks in ${projects.join(', ')} take turns; the rest run on the default engine.` : 'None named, so tasks in every project take turns.'}
        more={projects.length ? undefined : 'Name projects here to share only their tasks; tasks in any other project then run on the default engine.'}
        error={projectsPick.error}
        data-testid="engine-split-projects"
        control={(
          <span className="engine-split-add">
            <MicInput fieldClassName="settings-mic-field mic-field-grow" className="settings-input" aria-label="Project" placeholder="Project name" value={addProject} list="engine-split-project-names"
              setText={setAddProject} micRef={projectMic} onEnter={addGate.send}
              data-testid="engine-split-project-input" data-no-draft="picker" />
            <datalist id="engine-split-project-names">{projectNames.filter((n) => !projectHas(n)).map((n) => <option key={n} value={n} />)}</datalist>
            <SettingsButton disabled={(!projectTyped || projectHas(projectTyped)) && !addGate.micBusy && !addGate.waiting} onClick={addGate.send} data-testid="engine-split-project-add" {...dictationWaitProps(addGate)}>Add</SettingsButton>
          </span>
        )}
      />
      {listedProjects.map((n) => (
        <SettingsCheckbox key={n.toLowerCase()} checked={projectHas(n)} label={n}
          onChange={(v) => setProjects(v ? [...projects, n] : projects.filter((p) => p.toLowerCase() !== n.toLowerCase()))}
          data-testid={`split-project-${n}`} />
      ))}
      {modelEngines.length > 0 && (
        <SettingsRow
          label="Add an engine with a chosen model"
          help={unlisted
            ? `${typed} is not a model Claude Code lists here. It is sent as typed, so check the name (a model your proxy serves is fine).`
            : 'Adds an entry above on the model you name.'}
          more={unlisted ? undefined : 'Say Claude Code on sonnet: new tasks take turns between it and the other entries.'}
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
                data-testid="engine-split-add-model" data-no-draft="picker" />
              <datalist id="engine-split-models">{known.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</datalist>
              <SettingsButton disabled={!addKey || checked.has(addKey) || !ready} onClick={add} data-testid="engine-split-add-button">Add</SettingsButton>
            </span>
          )}
        />
      )}
      </ControlGroup>
    </>
  );
}

