/**
 * A project's launch defaults, in its detail pane's Settings: the engine, model
 * and permission mode a new task of the project starts on when it picks none
 * (server: src/core/sessions/project-launch-defaults.ts).
 *
 *   New tasks start on                        [Use global defaults]
 *   Engine      [Codex                  v]   Project
 *   Model       [GPT-5.5                v]   Project
 *   Permission  [Global default (Bypass)v]   Global
 *   Workspace   [Global: Folder itself  v]   Global
 *
 * Each row says where its value comes from: this project, or the global default
 * (Settings > Sessions), named. Workspace: whether a code task starts in an isolated
 * workspace (default-isolation.ts). "Use global defaults" clears them all at once. A
 * pick saves at once (optimistically in the shared registry store, which the
 * draft's pills read); a refusal puts the old value back and says why.
 */
import { useCallback, useMemo, useState } from 'react';
import { DEFAULT_SESSION_MODE, SESSION_MODES, SESSION_MODE_LABELS, type SessionMode } from '@open-walnut/core';
import { saveProjectMetadata } from '@/api/projects';
import { patchProjectLocal, type ProjectRegistryRow, type ProjectRowPatch } from '@/hooks/useProjectRegistry';
import { useEngineCatalog } from '@/hooks/useEngineCatalog';
import { useFallbackModels } from '@/components/settings/sections/FallbackEngineRow';
import { engineName } from '@/components/settings/sections/DefaultEngineRow';
import { launchSourceWords, useGlobalDefaultEngine } from '@/utils/launch-source';
import { engineEntry } from '@/utils/engines';
import { LaunchSourceTag } from '@/components/sessions/LaunchSourceNote';
import { useClaudeLaunchMode } from '@/hooks/useClaudeLaunchMode';
import { useExperimental } from '@/hooks/useExperimental';

type Field = 'default_engine' | 'default_model' | 'default_mode' | 'isolated_workspace';

const PATCH_KEY: Record<Field, keyof ProjectRowPatch> = {
  default_engine: 'defaultEngine', default_model: 'defaultModel', default_mode: 'defaultMode', isolated_workspace: 'isolatedWorkspace',
};

export function ProjectLaunchDefaults({ project, row }: { project: string; row: ProjectRegistryRow | null }) {
  const catalog = useEngineCatalog();
  const globalEngine = useGlobalDefaultEngine();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const engine = row?.defaultEngine;
  const model = engine ? row?.defaultModel : undefined;
  const mode = row?.defaultMode;
  const isolation = row?.isolatedWorkspace;
  const globalIsolation = useExperimental('isolated_workspace_by_default');
  const models = useFallbackModels(engine ?? null);
  const nameOf = useCallback((id: string) => engineName(engineEntry(catalog, id).displayName), [catalog]);
  const engineLabel = engine ? nameOf(engine) : '';
  // The project's engine is not on this server: new tasks start Claude Code (the server's rule).
  const missing = !!engine && engine !== 'claude' && engineEntry(catalog, engine).availability.installed === false;
  // The mode a start that names none runs in: Claude Code's own default on the project's host and
  // folder (its settings, else Auto), another engine's Walnut's.
  const startsClaude = (engine ?? globalEngine) === 'claude' || missing;
  const claudeMode = useClaudeLaunchMode(row?.defaultHost, row?.defaultCwd, startsClaude);
  const globalMode = startsClaude ? claudeMode : DEFAULT_SESSION_MODE;
  const globalModeLabel = (SESSION_MODE_LABELS as Record<string, string>)[globalMode] ?? globalMode;
  // A saved model the list does not carry (still loading, an older catalog) stays shown and selected.
  const modelRows = useMemo(() => (model && !models.options.some((o) => o.value === model)
    ? [{ value: model, label: model }, ...models.options] : models.options), [model, models.options]);

  /** One write: optimistic in the registry store, put back when the server refuses. */
  const save = useCallback(async (patch: Partial<Record<Field, string | null>>) => {
    setError(null);
    const local: ProjectRowPatch = {};
    for (const [k, v] of Object.entries(patch) as Array<[Field, string | null]>) {
      (local as Record<string, unknown>)[PATCH_KEY[k]] = v || null;
    }
    const settle = patchProjectLocal(project, local);
    setBusy(true);
    try {
      await saveProjectMetadata(project, patch);
      settle(true);
    } catch (err) {
      settle(false);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [project]);

  const any = !!(engine || mode || isolation);
  const engineFrom = engine ? 'project' : 'global';
  const modeFrom = mode ? 'project' : 'global';
  const modelFrom = model ? 'project' : 'global';

  return (
    <div className="project-launch-defaults" data-testid="project-launch-defaults">
      <div className="project-launch-defaults-head">
        <span className="project-launch-defaults-title">New tasks start on</span>
        <button
          type="button"
          className="project-launch-defaults-clear"
          data-testid="project-launch-defaults-clear"
          disabled={!any || busy}
          onClick={() => { void save({ default_engine: null, default_model: null, default_mode: null, isolated_workspace: null }); }}
          title="Clear this project's engine, model and permission mode: new tasks use the global defaults (Settings > Sessions)"
        >
          Use global defaults
        </button>
      </div>

      <div className="detail-setting-row">
        <label className="detail-setting-label" htmlFor={`pld-engine-${project}`}>Engine</label>
        <select
          id={`pld-engine-${project}`}
          className="detail-setting-select"
          data-testid="project-default-engine"
          value={engine ?? ''}
          disabled={busy}
          onChange={(e) => { void save({ default_engine: e.target.value || null }); }}
        >
          <option value="">Global: {nameOf(globalEngine)}</option>
          {catalog.map((c) => (
            <option key={c.id} value={c.id}>{engineName(c.displayName)}{c.availability.installed ? '' : ' (not installed)'}</option>
          ))}
        </select>
        <LaunchSourceTag row={{ source: engineFrom, words: launchSourceWords(engineFrom, engine ? project : undefined) }} />
      </div>

      <div className="detail-setting-row">
        <label className="detail-setting-label" htmlFor={`pld-model-${project}`}>Model</label>
        <select
          id={`pld-model-${project}`}
          className="detail-setting-select"
          data-testid="project-default-model"
          value={model ?? ''}
          // A model belongs to one engine: the project picks its engine first.
          disabled={!engine || busy || (models.loading && !model)}
          title={engine ? undefined : 'Pick an engine for this project first: a model belongs to one engine'}
          onChange={(e) => { void save({ default_model: e.target.value || null }); }}
        >
          <option value="">{!engine ? 'Engine default' : models.loading ? 'Loading models…' : `${engineLabel} default`}</option>
          {engine && modelRows.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
        {/* An engine's own default model is no global setting: no tag then, the row keeps its place. */}
        {engine && !model
          ? <span className="launch-source-tag is-placeholder" aria-hidden="true" />
          : <LaunchSourceTag row={{ source: modelFrom, words: launchSourceWords(modelFrom, model ? project : undefined) }} />}
      </div>

      <div className="detail-setting-row">
        <label className="detail-setting-label" htmlFor={`pld-mode-${project}`}>Permission</label>
        <select
          id={`pld-mode-${project}`}
          className="detail-setting-select"
          data-testid="project-default-mode"
          value={mode ?? ''}
          disabled={busy}
          onChange={(e) => { void save({ default_mode: (e.target.value as SessionMode) || null }); }}
        >
          <option value="">Global: {globalModeLabel}</option>
          {SESSION_MODES.map((m) => <option key={m.id} value={m.id} title={m.description}>{m.label}</option>)}
        </select>
        <LaunchSourceTag row={{ source: modeFrom, words: launchSourceWords(modeFrom, mode ? project : undefined) }} />
      </div>

      <div className="detail-setting-row">
        <label className="detail-setting-label" htmlFor={`pld-isolation-${project}`}>Workspace</label>
        <select
          id={`pld-isolation-${project}`}
          className="detail-setting-select"
          data-testid="project-isolated-workspace"
          value={isolation ?? ''}
          disabled={busy}
          title="A new task whose folder is a repository starts in its own isolated workspace (a git worktree, or a workspace plugin's copy)"
          onChange={(e) => { void save({ isolated_workspace: e.target.value || null }); }}
        >
          <option value="">Global: {globalIsolation ? 'Isolated workspace' : 'Folder itself'}</option>
          <option value="on">Isolated workspace</option>
          <option value="off">Folder itself</option>
        </select>
        <LaunchSourceTag row={{ source: isolation ? 'project' : 'global', words: launchSourceWords(isolation ? 'project' : 'global', isolation ? project : undefined) }} />
      </div>

      {missing ? (
        <p className="project-launch-defaults-warning" data-testid="project-default-engine-missing">
          {engineLabel} isn't installed here, so new tasks start Claude Code.
        </p>
      ) : models.error && engine && (
        <p className="project-launch-defaults-hint" data-testid="project-default-model-error" title={models.error}>
          {engineLabel} did not list its models, so its default model is used.
        </p>
      )}
      {error && <p className="project-launch-defaults-error" role="alert" data-testid="project-launch-defaults-error">{error}</p>}
      <p className="project-launch-defaults-hint">
        Every new session in this project uses these unless its task picks its own (the project's lead too). Anything unset follows the global defaults (Settings &gt; Sessions); a value picked here stays when those change.
      </p>
    </div>
  );
}

