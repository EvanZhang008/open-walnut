/**
 * Settings, Sessions: "When it is out of usage", the fallback engine's logic (FallbackEngineRow).
 * Pure, for the same reason as default-engine-select.ts: which engines may be offered and what a
 * pick writes are invisible in the DOM, and the write must keep every sibling of `defaults`.
 */
import type { Config, FallbackEngineSetting, SessionEngine } from '@open-walnut/core';
import type { EngineCatalog } from '@/utils/engines';

/** The select's value for "no fallback": a new task waits for the reset on the default engine. */
export const FALLBACK_OFF = 'off';

export interface FallbackEngineOption {
  value: SessionEngine | typeof FALLBACK_OFF;
  label: string;
}

/** The saved setting, or null when off (the server's reader: core/agents/fallback-engine.ts). */
export function currentFallback(config: Pick<Config, 'defaults'> | undefined): FallbackEngineSetting | null {
  const fb = config?.defaults?.fallback_engine;
  return fb && typeof fb === 'object' && typeof fb.engine === 'string' ? fb : null;
}

/**
 * What the engine select offers: off first, then every engine in registry order. The default
 * engine is offered too, as "another model" (a per-model window, or a model behind another
 * provider). An engine this machine has not found is still offered, marked: a fallback can run on
 * another host that has it, and the server checks the launch's own host when it starts.
 */
export function fallbackEngineOptions(
  catalog: EngineCatalog, defaultEngine: SessionEngine, nameOf: (label: string) => string,
): FallbackEngineOption[] {
  return [
    { value: FALLBACK_OFF, label: 'Wait for the reset' },
    ...catalog.map((e) => ({
      value: e.id,
      label: `${nameOf(e.displayName)}${e.id === defaultEngine ? ', another model' : ''}${e.availability.installed ? '' : ' (not installed here)'}`,
    })),
  ];
}

/** The config patch of a pick. A new engine drops the model, which belongs to the old one. */
export function fallbackSave(
  config: Pick<Config, 'defaults'>, engine: SessionEngine | typeof FALLBACK_OFF, model?: string,
  /** The model's name as the list shows it, kept for the words ("Started on Sonnet"). */
  modelLabel?: string,
): Partial<Config> {
  const rest = { ...config.defaults };
  delete rest.fallback_engine;
  if (engine === FALLBACK_OFF) return { defaults: rest };
  const label = model && modelLabel && modelLabel !== model ? modelLabel.slice(0, 80) : undefined;
  return { defaults: { ...rest, fallback_engine: { engine, ...(model ? { model } : {}), ...(label ? { model_label: label } : {}) } } };
}

/** The same engine on its own default model falls back to nothing: the row says so. */
export function fallbackNeedsModel(setting: FallbackEngineSetting | null, defaultEngine: SessionEngine): boolean {
  return !!setting && setting.engine === defaultEngine && !setting.model;
}
