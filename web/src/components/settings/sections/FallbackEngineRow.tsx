/**
 * Settings, Sessions: "When it is out of usage" (`defaults.fallback_engine`), under Default
 * engine. While the default engine's usage limit is reached on a machine, a new task that names
 * no engine starts there on this engine and model instead (core/agents/fallback-engine.ts). Off,
 * a new task starts on the default engine and waits for the reset, as before.
 *
 *   When it is out of usage   [Codex              v]
 *     Model                   [Codex's default    v]
 *   The Claude 5-hour limit is reached here (resets 3:00 PM): new tasks start on Codex now.
 *
 * Saves on pick, like Default engine. The line under it is the server's own answer for its
 * machine (GET /api/engines/fallback), read again after each save; when a fallback that is set
 * does not take new tasks, it says why.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { Config, SessionEngine } from '@open-walnut/core';
import { claudeFamilyOf, fallbackEngineName, fallbackModelName, limitName, limitTimeWords } from '@open-walnut/user-status';
import { SettingsRow } from '../SettingsSection';
import { useOptimisticSetting } from '../inputs/useOptimisticSetting';
import { useEngineCatalog } from '@/hooks/useEngineCatalog';
import { useModelOptions } from '@/components/sessions/path-selector/model-options';
import { fetchEngineModelCatalog } from '@/api/sessions';
import { fetchEngineFallbackNow, type EngineFallbackNow } from '@/api/engine-fallback';
import { currentDefaultEngine } from './default-engine-select';
import { currentFallback, FALLBACK_OFF, fallbackEngineOptions, fallbackNeedsModel, fallbackSave } from './fallback-engine-select';
import { engineName } from './DefaultEngineRow';
import type { useSerialSave } from './GeneralSection';
import { log } from '@/utils/log';

type SerialSave = ReturnType<typeof useSerialSave>;

const ENGINE_KEY = 'sessions.fallback-engine';
const MODEL_KEY = 'sessions.fallback-model';

/** One engine's model rows: the host catalog for Claude Code, the adapter's own list otherwise. */
function useFallbackModels(engine: SessionEngine | null): { options: Array<{ value: string; label: string }>; loading: boolean; error: string | null } {
  const claude = useModelOptions(null);
  const [acp, setAcp] = useState<{ engine: string; options: Array<{ value: string; label: string }>; error: string | null } | null>(null);
  const isClaude = engine === 'claude';
  useEffect(() => {
    if (!engine || isClaude) return;
    let live = true;
    fetchEngineModelCatalog(engine).then(
      (c) => { if (live) setAcp({ engine, options: c.models.map((m) => ({ value: m.modelId, label: m.name || m.modelId })), error: null }); },
      (err: unknown) => {
        if (!live) return;
        const message = err instanceof Error ? err.message : String(err);
        log.warn('settings', 'fallback engine: model list failed', { engine, error: message });
        setAcp({ engine, options: [], error: message });
      },
    );
    return () => { live = false; };
  }, [engine, isClaude]);
  if (!engine) return { options: [], loading: false, error: null };
  if (isClaude) return { options: claude.options, loading: false, error: null };
  const mine = acp?.engine === engine ? acp : null;
  return { options: mine?.options ?? [], loading: !mine, error: mine?.error ?? null };
}

/** "The Claude 5-hour limit is reached here (resets 3:00 PM): new tasks start on Codex now." */
export function fallbackNowLine(now: EngineFallbackNow | null, nowMs: number): string | null {
  if (!now) return null;
  const from = now.fallback?.note.from ?? now.defaultEngine;
  const limit = now.fallback ? { window: now.fallback.note.window, resetsAt: now.fallback.note.resets_at } : now.limit;
  if (!from || !limit) return null;
  const when = limitTimeWords(limit.resetsAt, nowMs);
  const head = `The ${limitName({ engine: from, window: limit.window })} is reached here${when ? ` (resets ${when})` : ''}`;
  if (now.fallback) {
    const model = fallbackModelName(now.fallback.note);
    return `${head}: new tasks start on ${fallbackEngineName(now.fallback.engine)}${model ? ` (${model})` : ''} now.`;
  }
  if (!now.setting) return `${head}: new tasks wait for the reset.`;
  const engine = fallbackEngineName(now.setting.engine);
  switch (now.skip) {
    case 'needs_model': return `${head}: pick a model below, or new tasks wait for the reset.`;
    case 'shares_limit': return `${head}, and it covers ${fallbackModelName(now.setting) ?? 'that model'} too, so new tasks wait for the reset.`;
    case 'limited_too': return `${head}, and ${engine} is out of usage too, so new tasks wait for the reset.`;
    case 'not_runnable': return `${head}, and ${engine} is not installed here, so new tasks wait for the reset.`;
    default: return `${head}, and ${engine} cannot start here, so new tasks wait for the reset.`;
  }
}

export function FallbackEngineRow({ config, save }: { config: Config; save: SerialSave }) {
  const catalog = useEngineCatalog();
  const defaultEngine = currentDefaultEngine(config);
  const saved = currentFallback(config);
  const savedKey = saved ? saved.engine : FALLBACK_OFF;
  const engine = useOptimisticSetting<string>(
    savedKey,
    (id) => save((c) => fallbackSave(c, id as SessionEngine | typeof FALLBACK_OFF), { rowKey: ENGINE_KEY }),
    { rowKey: ENGINE_KEY },
  );
  const picked = engine.value === FALLBACK_OFF ? null : (engine.value as SessionEngine);
  // The model belongs to the engine it was saved with; a fresh engine pick starts on its default.
  const savedModel = saved && saved.engine === picked ? saved.model ?? '' : '';
  // The listed names by id, read when a pick saves (the label rides the setting for the words).
  const labels = useRef(new Map<string, string>());
  const model = useOptimisticSetting<string>(
    savedModel,
    (m) => save((c) => fallbackSave(c, (picked ?? FALLBACK_OFF), m || undefined, m ? labels.current.get(m) : undefined), { rowKey: MODEL_KEY }),
    { rowKey: MODEL_KEY },
  );
  const models = useFallbackModels(picked);
  labels.current = new Map(models.options.map((o) => [o.value, o.label]));
  const options = useMemo(() => fallbackEngineOptions(catalog, defaultEngine, engineName), [catalog, defaultEngine]);

  // The server's answer for this Mac, read on open and after each save.
  const [now, setNow] = useState<EngineFallbackNow | null>(null);
  useEffect(() => {
    let live = true;
    fetchEngineFallbackNow(null, { withLimit: true }).then((n) => { if (live) setNow(n); }, () => { if (live) setNow(null); });
    return () => { live = false; };
  }, [config.defaults?.fallback_engine?.engine, config.defaults?.fallback_engine?.model, config.defaults?.engine]);
  // Another Claude model of the same subscription: which limits it helps with.
  const sameClaude = picked === 'claude' && defaultEngine === 'claude';
  const line = fallbackNowLine(now, Date.now());

  const pickedName = picked ? engineName(catalog.find((e) => e.id === picked)?.displayName ?? picked) : '';
  const needsModel = fallbackNeedsModel(picked ? { engine: picked, ...(model.value ? { model: model.value } : {}) } : null, defaultEngine);
  // A saved model the list does not carry (an older catalog, a hand edit) stays shown and selected.
  const modelRows = model.value && !models.options.some((o) => o.value === model.value)
    ? [{ value: model.value, label: saved?.model_label ?? model.value }, ...models.options] : models.options;
  const claudeRows = modelRows.filter((o) => claudeFamilyOf(o.value) || claudeFamilyOf(o.label));
  const otherRows = modelRows.filter((o) => !claudeFamilyOf(o.value) && !claudeFamilyOf(o.label));

  return (
    <>
      <SettingsRow
        label="When it is out of usage"
        htmlFor="fallback-engine-select"
        help={<span data-testid="fallback-engine-help">{picked
          ? 'A new task starts on this engine while the default engine is out of usage on its machine. Sessions already running wait for the reset.'
          : 'Pick an engine for new tasks while the default engine is out of usage on its machine. Off, they wait for the reset, as sessions already running do.'}</span>}
        error={engine.error}
        data-testid="fallback-engine-row"
        control={(
          <select
            id="fallback-engine-select"
            data-testid="fallback-engine-select"
            className="settings-select engine-row-control"
            value={engine.value}
            onChange={(e) => engine.set(e.target.value)}
          >
            {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        )}
      >
        {line && <span className={now?.fallback ? 'settings-help-now' : 'settings-help-warning'} data-testid="fallback-engine-now">{line}</span>}
      </SettingsRow>
      {picked && (
        <SettingsRow
          indent
          label="Model"
          htmlFor="fallback-model-select"
          help={needsModel
            ? <span className="settings-help-warning" data-testid="fallback-model-needed">Pick a model: {pickedName} on its own default model is the engine that is out of usage.</span>
            : models.error ? <span data-testid="fallback-model-error">{pickedName} did not list its models ({models.error}). Its default model is used.</span>
            : sameClaude
              ? <span data-testid="fallback-model-same-help">Claude models share the 5-hour and weekly limits: one helps only under another model's own weekly limit. A model behind a proxy helps under any limit{otherRows.length ? '' : ' (none is set up here)'}.</span>
            : `The model a task started on ${pickedName} uses.`}
          error={model.error}
          data-testid="fallback-model-row"
          control={(
            <select
              id="fallback-model-select"
              data-testid="fallback-model-select"
              className="settings-select engine-row-control"
              value={model.value}
              disabled={models.loading && !model.value}
              onChange={(e) => model.set(e.target.value)}
            >
              <option value="">{needsModel ? 'Pick a model' : models.loading ? 'Loading models…' : `${pickedName}'s default`}</option>
              {sameClaude ? (
                // Which models help: a Claude model shares the 5-hour and weekly limits.
                <>
                  {otherRows.length > 0 && (
                    <optgroup label="Other providers: under any Claude limit">
                      {otherRows.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                    </optgroup>
                  )}
                  <optgroup label="Claude models: only for one model's weekly limit">
                    {claudeRows.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                  </optgroup>
                </>
              ) : modelRows.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          )}
        />
      )}
    </>
  );
}
