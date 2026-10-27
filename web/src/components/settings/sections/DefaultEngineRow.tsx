/**
 * Settings, Sessions: "Default engine", the engine every session Walnut starts
 * runs on unless the launch names its own (`defaults.engine`).
 *
 * It used to head the Engines pane; that pane is gone (each engine's own
 * settings live in the session's Engine settings popover), and this is the one
 * Walnut-config control it held. It saves on pick: deliberately not through
 * useAutoSave, so merely opening the pane can never write the config back.
 */
import { useMemo } from 'react';
import type { Config, SessionEngine } from '@open-walnut/core';
import { SettingsRow } from '../SettingsSection';
import { SegmentedControl } from '../inputs/SegmentedControl';
import { useOptimisticSetting } from '../inputs/useOptimisticSetting';
import { useEngineCatalog, useEngineCatalogHydration } from '@/hooks/useEngineCatalog';
import { useSystemHealth } from '@/hooks/useSystemHealth';
import {
  currentDefaultEngine, defaultEngineOptions, defaultEnginePickerReady, defaultEngineSave,
} from './default-engine-select';
import { resolveMainProvider } from './main-provider';
import type { useSerialSave } from './GeneralSection';

/** Segmented up to this many choices, a select beyond it. */
const MAX_SEGMENTS = 5;

const ROW_KEY = 'sessions.default-engine';

/** The engine is "Claude Code" wherever it is named, never bare "Claude" (N30). */
export function engineName(label: string): string {
  return label.replace(/^Claude\b(?! Code)/, 'Claude Code');
}

type SerialSave = ReturnType<typeof useSerialSave>;

export function DefaultEngineRow({ config, save }: { config: Config; save: SerialSave }) {
  const catalog = useEngineCatalog();
  const catalogHydration = useEngineCatalogHydration();
  const { health } = useSystemHealth();

  // Its option list is the WHOLE catalog (minus what isn't installed).
  const savedDefault = currentDefaultEngine(config);
  const pick = useOptimisticSetting<SessionEngine>(
    savedDefault,
    (id) => save((c) => defaultEngineSave(c, id), { rowKey: ROW_KEY }),
    { rowKey: ROW_KEY },
  );
  const value = pick.value;
  const options = useMemo(() => defaultEngineOptions(catalog, savedDefault), [catalog, savedDefault]);
  const ready = defaultEnginePickerReady(catalogHydration);
  const provider = config.agent?.main_provider ?? health.mainProvider;
  const usesApi = resolveMainProvider(provider, config.providers).kind !== 'cli';
  const smallJobs = usesApi ? (
    <>Small background jobs use an API instead (<a href="#providers">Advanced</a>).</>
  ) : value !== 'claude' ? 'Small background jobs stay on Claude Code.' : null;

  const control = options.length <= MAX_SEGMENTS ? (
    <span data-testid="default-engine-select" data-value={value}>
      <SegmentedControl<SessionEngine>
        id="default-engine-select"
        aria-label="Default engine"
        value={value}
        disabled={!ready}
        onChange={pick.set}
        options={options.map((o) => ({ value: o.id, label: engineName(o.label), testId: `default-engine-option-${o.id}` }))}
      />
    </span>
  ) : (
    <select
      id="default-engine-select"
      data-testid="default-engine-select"
      className="settings-select"
      value={value}
      disabled={!ready}
      onChange={(e) => pick.set(e.target.value as SessionEngine)}
    >
      {options.map((option) => (
        <option key={option.id} value={option.id}>{engineName(option.label)}</option>
      ))}
    </select>
  );

  return (
    <SettingsRow
      label="Default engine"
      help={<span data-testid="default-engine-used-for">Everything Walnut starts uses it; a session can still pick its own.</span>}
      error={pick.error}
      data-testid="default-engine-row"
      control={control}
    >
      {smallJobs && <span className="settings-help-warning" data-testid="default-engine-small-jobs">{smallJobs}</span>}
    </SettingsRow>
  );
}
