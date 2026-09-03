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
import { resolveMainProviderName } from './providers/default-provider.js';
import {
  DEFAULT_MODEL,
  DEFAULT_MAX_TOKENS,
  CONTEXT_WINDOW_1M,
  CONTEXT_WINDOW_DEFAULT,
  BETA_CONTEXT_1M,
  INTERLEAVED_THINKING_BETA,
} from './providers/defaults.js';
import { MODEL_CATALOG } from './providers/model-catalog.js';
import type { UsageStats, ModelResult, ThinkingConfig, ModelEntry } from './providers/types.js';

// Re-export types for backward compatibility — all callers import from here
export type { MessageParam, ContentBlock, Tool, TextBlockParam };
export type { UsageStats, ModelResult, ThinkingConfig };

export interface ModelConfig {
  model?: string;
  region?: string;
  maxTokens?: number;
  /** Provider name — maps to config.providers[name]. Falls back to 'bedrock'. */
  provider?: string;
}

export { DEFAULT_MODEL };

// ── Catalog lookup ──

/** Find a model entry in MODEL_CATALOG by model ID across all providers, or for a specific provider. */
function lookupCatalogEntry(modelId: string, providerName?: string): ModelEntry | undefined {
  if (providerName && MODEL_CATALOG[providerName]) {
    const entry = MODEL_CATALOG[providerName].find(m => m.id === modelId);
    if (entry) return entry;
  }
  // Fallback: search all providers
  for (const entries of Object.values(MODEL_CATALOG)) {
    const entry = entries.find(m => m.id === modelId);
    if (entry) return entry;
  }
  return undefined;
}

// ── Context window helpers ──

/**
 * Get the context window size for a model.
 * Uses MODEL_CATALOG to determine size; falls back to 200K for unknown models.
 * When totalInput exceeds the resolved window, auto-upgrades to 1M as a safety net.
 *
 * Observed usage OUTRANKS the catalog label: a prompt can't be larger than the window
 * that accepted it, so totalInput above the catalog size means the real window is bigger
 * (resume dropped the `-1m` variant id, an env clamp raised it, or the string isn't a
 * catalog id at all). Checking the catalog FIRST and returning early — as this did
 * between dd16928 and now — disabled the net for every catalogued model, i.e. almost
 * all of them, silently reinstating the 434%-context bug f686c8d fixed.
 */
export function getContextWindowSize(model?: string, totalInput?: number): number {
  const catalogWindow = model ? lookupCatalogEntry(model)?.context_window : undefined;
  const resolved = catalogWindow ?? CONTEXT_WINDOW_DEFAULT;
  if (totalInput != null && totalInput > resolved) {
    // max() so a >1M catalog window (e.g. gpt-5.4's 1.05M) is never downgraded.
    return Math.max(CONTEXT_WINDOW_1M, resolved);
  }
  return resolved;
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
 *
 * Automatically determines:
 * - betas: 1M context beta (from catalog context_window) + interleaved thinking beta
 * - thinking: adaptive/enabled based on catalog compat
 * - maxTokens: from catalog max_tokens (not hardcoded 4096)
 */
async function resolveForCall(config?: ModelConfig) {
  const fullConfig = await getConfig();
  const providerName = config?.provider ?? resolveMainProviderName(fullConfig);

  // Build providers map: auto-detected (env) + explicit config.providers overlay
  const hasExplicitProviders = fullConfig.providers && Object.keys(fullConfig.providers).length > 0;
  let providers = hasExplicitProviders
    ? buildProviderMap(fullConfig.providers, fullConfig)
    : synthesizeFromLegacy(fullConfig);

  // Resolve the provider
  const resolved = resolveProvider(providerName, providers);

  // Apply region override from ModelConfig (legacy compat)
  if (config?.region && !resolved.config.region) {
    resolved.config = { ...resolved.config, region: config.region };
  }

  const model = config?.model ?? fullConfig.agent?.main_model ?? DEFAULT_MODEL;
  const catalogEntry = lookupCatalogEntry(model, providerName);

  // Build betas array from catalog capabilities
  const betas: string[] = [];

  // 1M context beta — driven by catalog context_window, not [1m] suffix.
  // Guard is bedrock/anthropic only: other providers (OpenRouter, Gemini) have native 1M support without beta headers.
  // native_1m models (Opus 5+) get 1M by default with no beta — skip the flag.
  if (catalogEntry?.context_window && catalogEntry.context_window >= 1_000_000
      && !catalogEntry.compat?.native_1m
      && ['bedrock', 'anthropic'].includes(providerName)) {
    betas.push(BETA_CONTEXT_1M);
  }

  // NB: the 1h extended prompt-cache TTL (`cache_control.ttl:'1h'`) is GA on Bedrock
  // and the Claude API — it needs NO beta header. We verified empirically (skill-e2e,
  // real Bedrock) that sending `extended-cache-ttl-2025-04-11` returns
  // `400 invalid beta flag`, so we deliberately do NOT add it. The ttl marker flows
  // through cache_control verbatim. (See EXTENDED_CACHE_TTL_BETA in defaults.ts.)

  // Thinking config — from catalog compat
  let thinking: ThinkingConfig | undefined;
  if (catalogEntry?.compat?.thinking_format === 'anthropic') {
    if (catalogEntry.compat.supports_adaptive) {
      // display:'summarized' — Opus 4.7/4.8+ default to 'omitted' (empty thinking
      // text, signature only). Requesting summarized restores visible thinking;
      // full thinking tokens are billed either way.
      thinking = { type: 'adaptive', display: 'summarized' };
    } else {
      const budget = Math.min((catalogEntry.max_tokens ?? 64_000) - 1, 64_000);
      thinking = { type: 'enabled', budget_tokens: budget };
    }
    betas.push(INTERLEAVED_THINKING_BETA);
  }

  // max_tokens: caller override > catalog > default
  const maxTokens = config?.maxTokens ?? catalogEntry?.max_tokens ?? DEFAULT_MAX_TOKENS;

  // Resolve API model ID: catalog model_id (for variants like -1m) or the user-facing ID
  const apiModel = catalogEntry?.model_id ?? model;

  return {
    ...resolved,
    model: apiModel,
    maxTokens,
    ...(betas.length && { betas }),
    ...(thinking && { thinking }),
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
  const { adapter, config: providerConfig, model, maxTokens, betas, thinking } = await resolveForCall(opts.config);

  return adapter.sendMessage({
    providerConfig, model, maxTokens,
    system: opts.system, messages: opts.messages, tools: opts.tools,
    signal: opts.signal, betas, thinking,
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
  const { adapter, config: providerConfig, model, maxTokens, betas, thinking } = await resolveForCall(opts.config);

  return adapter.sendMessageStream({
    providerConfig, model, maxTokens,
    system: opts.system, messages: opts.messages, tools: opts.tools,
    signal: opts.signal, onTextDelta: opts.onTextDelta, betas, thinking,
  });
}

/**
 * Reset all cached adapter clients (useful for testing or config changes).
 */
export function resetClient(): void {
  resetAllAdapters();
}
