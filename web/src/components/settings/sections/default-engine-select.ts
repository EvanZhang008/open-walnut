/**
 * Settings, Engines: the "Default engine for new sessions" picker's logic.
 *
 * Pure on purpose: the two decisions that can silently regress are WHICH engines
 * may be offered and WHAT the save writes, and neither is visible from the DOM.
 *
 * The save shape is the one with teeth. `updateConfig` replaces a whole top-level
 * key, so writing `{ defaults: { engine } }` would delete `defaults.priority`,
 * `defaults.platform` and `defaults.project`: the default task priority and the
 * default project for quick-add. Every sibling is spread back.
 */
import type { Config, SessionEngine } from '@open-walnut/core';
import { resolveEngine, type EngineCatalog } from '@/utils/engines';

/** One row of the picker. */
export interface DefaultEngineOption {
  id: SessionEngine;
  label: string;
  /** True when the engine's CLI was found on this machine. */
  installed: boolean;
}

/**
 * The engine new sessions inherit today. Mirrors the server's reader
 * (core/agents/default-engine.ts): the default lives here, not in the config
 * file, and an unknown value reads as the default rather than as a broken UI.
 */
export function currentDefaultEngine(config: Pick<Config, 'defaults'> | undefined): SessionEngine {
  return resolveEngine(config?.defaults?.engine);
}

/**
 * May the picker be used yet? Only once the catalog is the SERVER's.
 *
 * The compiled-in cold-start catalog says `installed: true` for both engines it
 * carries, on purpose: it exists so the composer's engine toggle paints its two
 * buttons without waiting for a fetch (utils/engines.ts). That preset is wrong
 * for THIS control: a pick made against it can name an engine this machine does
 * not have, and the mistake is silent afterwards, because the server degrades
 * such a default back to Claude on every launch (core/agents/default-engine.ts)
 * instead of failing. One fetch is worth waiting for to avoid writing a setting
 * that never takes effect. A hydration that FAILED is offered anyway: the
 * compiled-in list is then the only answer anyone has, and a picker that can
 * never be used is worse than one whose verdict the server re-checks.
 */
export function defaultEnginePickerReady(hydration: 'pending' | 'hydrated' | 'failed'): boolean {
  return hydration !== 'pending';
}

/**
 * What the picker may offer: every INSTALLED engine, in catalog (registry) order.
 *
 * An engine that is not installed is not offered: picking it would break every
 * launch that inherits it. The one exception is the value currently configured:
 * it stays in the list, marked, because dropping it would show a selected engine
 * the config does not name and one stray change event would silently rewrite the
 * user's setting.
 */
export function defaultEngineOptions(
  catalog: EngineCatalog,
  current: SessionEngine,
): DefaultEngineOption[] {
  const rows: DefaultEngineOption[] = catalog
    .filter((e) => e.availability.installed)
    .map((e) => ({ id: e.id, label: e.displayName, installed: true }));
  if (rows.some((r) => r.id === current)) return rows;
  const known = catalog.find((e) => e.id === current);
  return [
    { id: current, label: `${known?.displayName ?? current} (not installed)`, installed: false },
    ...rows,
  ];
}

/**
 * The config patch a pick writes. Spreads the sibling `defaults` keys: see the
 * file header for why that is not optional.
 */
export function defaultEngineSave(
  config: Pick<Config, 'defaults'>,
  engine: SessionEngine,
): Partial<Config> {
  return { defaults: { ...config.defaults, engine } };
}
