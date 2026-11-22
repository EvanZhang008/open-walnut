/**
 * One experiment's switch as server code reads it: `now()` the value last read (sync, for a prompt
 * builder or a pure rule), `on()` the value read from the config now (a route right after Settings
 * changed it agrees), `set()` for the status sync, which reads every switch on each config change.
 * Server only: experimental.ts stays browser-safe, so this lives beside it.
 *
 * It never imports config-manager itself: config-manager hands it its reader when it loads
 * (setExperimentConfigReader). A module the fast CLI bundles (src/cli-fast.ts) reads a switch
 * through here (org/one-card.ts, via the ops catalog), and a literal import of config-manager
 * here took the whole server into dist/cli-fast.js (2,400 modules instead of about 250,
 * tests/scripts/cli-fast-bytecode.test.ts). Before config-manager loaded (or where a test mocks it,
 * so its own code never runs), on() loads it by a specifier built at run time, which no bundler
 * follows; in a bundle with no config-manager that load fails and on() keeps the last value read.
 */
import { experimentalEnabled, type ExperimentalFeatureId } from './experimental.js';

type ExperimentalConfig = Parameters<typeof experimentalEnabled>[0];
let readConfig: (() => Promise<{ experimental?: ExperimentalConfig }>) | null = null;

// Built at run time so the bundler never follows it (a literal, even a dynamic import, would).
const CONFIG_MANAGER = ['.', 'config-manager.js'].join('/');

async function loadConfigManager(): Promise<{ experimental?: ExperimentalConfig }> {
  const mod = await import(/* @vite-ignore */ CONFIG_MANAGER) as { getConfig?: () => Promise<{ experimental?: ExperimentalConfig }> };
  if (typeof mod.getConfig !== 'function') throw new Error('config-manager has no getConfig');
  return mod.getConfig();
}

/** config-manager's getConfig, handed over when it loads; nothing else sets it. */
export function setExperimentConfigReader(read: () => Promise<{ experimental?: ExperimentalConfig }>): void {
  readConfig = read;
}

export interface ExperimentCache {
  now(): boolean;
  on(): Promise<boolean>;
  set(value: boolean): void;
}

export function experimentCache(id: ExperimentalFeatureId): ExperimentCache {
  let value = false;
  return {
    now: () => value,
    set: (v) => { value = v; },
    on: async () => {
      const read = readConfig ?? loadConfigManager;
      try {
        value = experimentalEnabled((await read()).experimental, id);
      } catch { /* the last value read stands */ }
      return value;
    },
  };
}
