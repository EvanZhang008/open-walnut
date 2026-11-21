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
 * tests/scripts/cli-fast-bytecode.test.ts). Where no config-manager ever loaded, on() keeps the
 * last value read.
 */
import { experimentalEnabled, type ExperimentalFeatureId } from './experimental.js';

type ExperimentalConfig = Parameters<typeof experimentalEnabled>[0];
let readConfig: (() => Promise<{ experimental?: ExperimentalConfig }>) | null = null;

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
      const read = readConfig;
      if (!read) return value;
      try {
        value = experimentalEnabled((await read()).experimental, id);
      } catch { /* the last value read stands */ }
      return value;
    },
  };
}
