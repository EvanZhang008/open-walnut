/**
 * Model API — thin dispatcher through the provider registry.
 *
 * All public exports maintain backward-compatible signatures.
 * Callers (agent loop, subagent runner, chat history) see zero changes.
 *
 * Resolution: ModelConfig.provider → config.providers[name] → protocol adapter.
 * Falls back to Bedrock (legacy) when no provider is specified.
 */
import type { MessageParam, ContentBlock, Tool, TextBlockParam } from '@anthropic-ai/sdk/resources/messages';
import { getConfig } from '../core/config-manager.js';
import { resolveProvider, buildProviderMap, synthesizeFromLegacy, resetAllAdapters } from './providers/registry.js';
import {
  DEFAULT_MODEL,
  DEFAULT_MAX_TOKENS,
  CONTEXT_WINDOW_1M,
  CONTEXT_WINDOW_DEFAULT,
  BETA_CONTEXT_1M,
} from './providers/defaults.js';
import type { UsageStats, ModelResult } from './providers/types.js';

// Re-export types for backward compatibility — all callers import from here
export type { MessageParam, ContentBlock, Tool, TextBlockParam };
export type { UsageStats, ModelResult };

export interface ModelConfig {
  model?: string;
  region?: string;
  maxTokens?: number;
  /** Provider name — maps to config.providers[name]. Falls back to 'bedrock'. */
  provider?: string;
}

export { DEFAULT_MODEL };

// ── Context window helpers ──

/** Check if a model string indicates 1M extended context. */
function is1MModel(model?: string): boolean {
  return model?.endsWith('[1m]') === true;
}

/**
 * Get the context window size for a model string.
 * Models with `[1m]` suffix have a 1M token context window; all others default to 200K.
 * TODO: Phase 4 — use ModelEntry.context_window from config when available.
 */
export function getContextWindowSize(model?: string): number {
  return is1MModel(model) ? CONTEXT_WINDOW_1M : CONTEXT_WINDOW_DEFAULT;
}

/**
 * Compute a token threshold as a percentage of the model's context window.
 */
export function getContextThreshold(model: string | undefined, percent: number): number {
  return Math.round(getContextWindowSize(model) * percent);
}

// ── Provider resolution ──

/**
 * Resolve the provider config + adapter for a given ModelConfig.
 * Falls back to Bedrock from legacy config when no explicit provider is set.
 */
async function resolveForCall(config?: ModelConfig) {
  const fullConfig = await getConfig();
  const providerName = config?.provider ?? fullConfig.agent?.main_provider ?? 'bedrock';

  // Build providers map: auto-detected (env) + explicit config.providers overlay
  // Always go through buildProviderMap to ensure env-detected providers (bedrock, ollama)
  // are included even when config.providers only contains a subset.
  const hasExplicitProviders = fullConfig.providers && Object.keys(fullConfig.providers).length > 0;
  let providers = hasExplicitProviders
    ? buildProviderMap(fullConfig.providers)
    : synthesizeFromLegacy(fullConfig);

  // Resolve the provider
  const resolved = resolveProvider(providerName, providers);

  // Apply region override from ModelConfig (legacy compat)
  if (config?.region && !resolved.config.region) {
    resolved.config = { ...resolved.config, region: config.region };
  }

  const model = config?.model ?? fullConfig.agent?.main_model ?? DEFAULT_MODEL;

  return {
    ...resolved,
    model,
    maxTokens: config?.maxTokens ?? DEFAULT_MAX_TOKENS,
    // 1M context requires the beta header (not thinking)
    ...(is1MModel(model) && { betas: [BETA_CONTEXT_1M] }),
  };
}

// ── Public API (unchanged signatures) ──

/**
 * Send a message and return the full response.
 * Dispatches to the appropriate protocol adapter based on provider config.
 */
export async function sendMessage(opts: {
  system: string | TextBlockParam[];
  messages: MessageParam[];
  tools?: Tool[];
  config?: ModelConfig;
  signal?: AbortSignal;
}): Promise<ModelResult> {
  const { adapter, config: providerConfig, model, maxTokens, betas } = await resolveForCall(opts.config);

  return adapter.sendMessage({
    providerConfig,
    model,
    maxTokens,
    system: opts.system,
    messages: opts.messages,
    tools: opts.tools,
    signal: opts.signal,
    betas,
  });
}

/**
 * Send a message using streaming.
 * Fires onTextDelta with each text chunk as it arrives.
 * Dispatches to the appropriate protocol adapter based on provider config.
 */
export async function sendMessageStream(opts: {
  system: string | TextBlockParam[];
  messages: MessageParam[];
  tools?: Tool[];
  config?: ModelConfig;
  signal?: AbortSignal;
  onTextDelta?: (delta: string) => void;
}): Promise<ModelResult> {
  const { adapter, config: providerConfig, model, maxTokens, betas } = await resolveForCall(opts.config);

  return adapter.sendMessageStream({
    providerConfig,
    model,
    maxTokens,
    system: opts.system,
    messages: opts.messages,
    tools: opts.tools,
    signal: opts.signal,
    onTextDelta: opts.onTextDelta,
    betas,
  });
}

/**
 * Reset all cached adapter clients (useful for testing or config changes).
 */
export function resetClient(): void {
  resetAllAdapters();
}
