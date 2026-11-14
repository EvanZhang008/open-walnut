/** Experimental choices in an automated window stay in that test run. */
import type { Config } from './types.js';
import type { ExperimentalFlags } from './experimental.js';
import { testRunPrefsRead, testRunPrefsWrite } from './test-run-prefs.js';

export function experimentalConfigView(config: Config): Config {
  const patch = testRunPrefsRead<ExperimentalFlags>('experimental');
  return patch ? { ...config, experimental: { ...config.experimental, ...patch } } : config;
}

/** True means the request wrote only its private preference copy. */
export function writeTestExperimental(flags: Record<string, boolean | null>, stored: ExperimentalFlags | undefined): boolean {
  const patch = testRunPrefsWrite<ExperimentalFlags>('experimental', () => ({}));
  if (!patch) return false;
  // A client sends the whole map back: keep only what differs from the user's own values, so
  // the copy never freezes a flag the test did not touch.
  for (const [id, value] of Object.entries(flags)) {
    // A flag sent as null is removed (core/config-section-write.ts): the user's own value again.
    if (value === null || value === stored?.[id]) delete patch[id];
    else patch[id] = value;
  }
  return true;
}
