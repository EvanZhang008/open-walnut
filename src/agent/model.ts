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
import { resolveProvider, synthesizeFromLegacy, resetAllAdapters } from './providers/registry.js';
import {
  DEFAULT_MODEL,
  DEFAULT_MAX_TOKENS,
  CONTEXT_WINDOW_1M,
  CONTEXT_WINDOW_DEFAULT,
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

// ── Context window helpers (unchanged) ──

/**
 * Get the context window size for a model string.
 * Models with `[1m]` suffix have a 1M token context window; all others default to 200K.
 * TODO: Phase 4 — use ModelEntry.context_window from config when available.
 */
export function getContextWindowSize(model?: string): number {
  return model?.includes('[1m]') ? CONTEXT_WINDOW_1M : CONTEXT_WINDOW_DEFAULT;
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

  // Build providers map: explicit config.providers + auto-detected + legacy fallback
  let providers = fullConfig.providers;
  if (!providers || Object.keys(providers).length === 0) {
    providers = synthesizeFromLegacy(fullConfig);
  }

  // Resolve the provider
  const resolved = resolveProvider(providerName, providers);

  // Apply region override from ModelConfig (legacy compat)
  if (config?.region && !resolved.config.region) {
    resolved.config = { ...resolved.config, region: config.region };
  }

  return {
    ...resolved,
    model: config?.model ?? fullConfig.agent?.main_model ?? DEFAULT_MODEL,
    maxTokens: config?.maxTokens ?? DEFAULT_MAX_TOKENS,
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
  const { adapter, config: providerConfig, model, maxTokens } = await resolveForCall(opts.config);

  return adapter.sendMessage({
    providerConfig,
    model,
    maxTokens,
    system: opts.system,
    messages: opts.messages,
    tools: opts.tools,
    signal: opts.signal,
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
  const { adapter, config: providerConfig, model, maxTokens } = await resolveForCall(opts.config);

  return adapter.sendMessageStream({
    providerConfig,
    model,
    maxTokens,
    system: opts.system,
    messages: opts.messages,
    tools: opts.tools,
    signal: opts.signal,
    onTextDelta: opts.onTextDelta,
  });
}

/**
 * Reset all cached adapter clients (useful for testing or config changes).
 */
export function resetClient(): void {
  resetAllAdapters();
}
