/**
 * One experiment's switch as server code reads it: `now()` the value last read (sync, for a prompt
 * builder or a pure rule), `on()` the value read from the config now (a route right after Settings
 * changed it agrees), `set()` for the status sync, which reads every switch on each config change.
 * Server only: experimental.ts stays browser-safe, so this lives beside it.
 */
import { experimentalEnabled, type ExperimentalFeatureId } from './experimental.js';

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
      try {
        const { getConfig } = await import('./config-manager.js');
        value = experimentalEnabled((await getConfig()).experimental, id);
      } catch { /* the last value read stands */ }
      return value;
    },
  };
}
