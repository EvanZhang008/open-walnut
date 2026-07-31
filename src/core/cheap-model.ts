import { MODEL_CATALOG } from '../agent/providers/model-catalog.js';
import type { Config } from './types.js';

/**
 * Resolve the model used for cheap background work. Providers without a Haiku
 * catalog entry fall back to the main model through sendMessage unless
 * agent.fast_model is configured explicitly.
 */
export function fastModelFor(config: Config): string | undefined {
  if (config.agent?.fast_model) return config.agent.fast_model;
  const providerName = config.agent?.main_provider ?? 'bedrock';
  return MODEL_CATALOG[providerName]?.find((model) =>
    model.id.toLowerCase().includes('haiku')
  )?.id;
}

/**
 * True when UNPROMPTED background model calls (session auto-organize, project
 * summaries) must not fire. Test servers (vitest e2e, the Playwright fixture)
 * are real servers with the host's real ~/.aws — without this gate every
 * quick-start POST in a test would hit live Bedrock: cost + nondeterminism
 * (a "successful" categorization moving a task mid-assertion is a flake).
 * Unit tests that mock sendMessage call the workers DIRECTLY, bypassing the
 * gated call sites, so they stay testable. WALNUT_DISABLE_BACKGROUND_AI=1
 * forces the gate outside test env (e.g. a constrained deployment).
 */
export function backgroundAiDisabled(): boolean {
  return !!(
    process.env.VITEST
    || process.env.VITEST_WORKER_ID
    || process.env.NODE_ENV === 'test'
    || process.env.WALNUT_DISABLE_BACKGROUND_AI === '1'
  );
}
