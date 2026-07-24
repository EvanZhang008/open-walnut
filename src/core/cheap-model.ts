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
