/**
 * Model pricing table and cost computation.
 *
 * Prices are in USD per million tokens. Verified from official sources:
 * - Anthropic: platform.claude.com (Feb 2025)
 * - Zhipu: docs.z.ai (Feb 2025)
 * - Perplexity: docs.perplexity.ai (Feb 2025)
 */

export const PRICING_VERSION = '2025-02-10';

export interface PricingEntry {
  /** Substring pattern matched against model ID. First match wins. */
  pattern: string;
  /** $/MTok for input tokens */
  input: number;
  /** $/MTok for output tokens */
  output: number;
  /** $/MTok for cache write (creation) tokens */
  cacheWrite?: number;
  /** $/MTok for cache read tokens */
  cacheRead?: number;
}

/**
 * Built-in pricing table. Ordered from most-specific to least-specific
 * to prevent partial matches (e.g. "claude-opus-4-6" before "claude-opus-4").
 */
export const DEFAULT_PRICING: PricingEntry[] = [
  // ── Claude models (Anthropic/Bedrock on-demand) ──
  { pattern: 'claude-opus-4-6',     input: 5.00,  output: 25.00, cacheWrite: 6.25,   cacheRead: 0.50 },
  { pattern: 'claude-opus-4-5',     input: 5.00,  output: 25.00, cacheWrite: 6.25,   cacheRead: 0.50 },
  { pattern: 'claude-opus-4-1',     input: 15.00, output: 75.00, cacheWrite: 18.75,  cacheRead: 1.50 },
  { pattern: 'claude-opus-4',       input: 15.00, output: 75.00, cacheWrite: 18.75,  cacheRead: 1.50 },
  { pattern: 'claude-sonnet-4-5',   input: 3.00,  output: 15.00, cacheWrite: 3.75,   cacheRead: 0.30 },
  { pattern: 'claude-sonnet-4',     input: 3.00,  output: 15.00, cacheWrite: 3.75,   cacheRead: 0.30 },
  { pattern: 'claude-3-7-sonnet',   input: 3.00,  output: 15.00, cacheWrite: 3.75,   cacheRead: 0.30 },
  { pattern: 'claude-haiku-4-5',    input: 1.00,  output: 5.00,  cacheWrite: 1.25,   cacheRead: 0.10 },
  { pattern: 'claude-3-5-haiku',    input: 0.80,  output: 4.00,  cacheWrite: 1.00,   cacheRead: 0.08 },
  { pattern: 'claude-3-haiku',      input: 0.25,  output: 1.25,  cacheWrite: 0.30,   cacheRead: 0.03 },

  // ── Zhipu GLM (docs.z.ai international USD pricing) ──
  { pattern: 'glm-4.7-flashx',     input: 0.07,  output: 0.40,  cacheRead: 0.01 },
  { pattern: 'glm-4.7',            input: 0.60,  output: 2.20,  cacheRead: 0.11 },
  { pattern: 'glm-4.6',            input: 0.60,  output: 2.20,  cacheRead: 0.11 },
  { pattern: 'glm-4.5-airx',       input: 1.10,  output: 4.50,  cacheRead: 0.22 },
  { pattern: 'glm-4.5-air',        input: 0.20,  output: 1.10,  cacheRead: 0.03 },
  { pattern: 'glm-4.5-x',          input: 2.20,  output: 8.90,  cacheRead: 0.45 },
  { pattern: 'glm-4.5',            input: 0.60,  output: 2.20,  cacheRead: 0.11 },
  { pattern: 'glm-4-plus',         input: 0.70,  output: 0.70 },
  { pattern: 'glm-4-airx',         input: 1.40,  output: 1.40 },
  { pattern: 'glm-4-air',          input: 0.07,  output: 0.07 },
  { pattern: 'glm-4-flashx',       input: 0.014, output: 0.014 },
  { pattern: 'glm-4-flash',        input: 0,     output: 0 },

  // ── Perplexity ──
  { pattern: 'sonar-pro',          input: 3.00,  output: 15.00 },
  { pattern: 'sonar',              input: 1.00,  output: 1.00 },
];

/**
 * Find the pricing entry for a model ID.
 * Matches as substring — e.g. "global.anthropic.claude-opus-4-6-v1" matches "claude-opus-4-6".
 * Returns undefined if no match found.
 */
export function findPricing(modelId: string, customPricing?: PricingEntry[]): PricingEntry | undefined {
  // Check custom pricing first (overrides)
  if (customPricing) {
    const custom = customPricing.find((e) => modelId.includes(e.pattern));
    if (custom) return custom;
  }
  return DEFAULT_PRICING.find((e) => modelId.includes(e.pattern));
}

/**
 * Compute cost in USD for a single API call.
 *
 * For unknown models, falls back to the most expensive known Claude price (conservative).
 */
export function computeCost(params: {
  model: string;
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  customPricing?: PricingEntry[];
}): number {
  const pricing = findPricing(params.model, params.customPricing);

  // Fallback: most expensive Claude model (Opus 4.0/4.1)
  const entry = pricing ?? { input: 15.00, output: 75.00, cacheWrite: 18.75, cacheRead: 1.50 };

  const inputCost = (params.input_tokens / 1_000_000) * entry.input;
  const outputCost = (params.output_tokens / 1_000_000) * entry.output;
  const cacheWriteCost = entry.cacheWrite
    ? ((params.cache_creation_input_tokens ?? 0) / 1_000_000) * entry.cacheWrite
    : 0;
  const cacheReadCost = entry.cacheRead
    ? ((params.cache_read_input_tokens ?? 0) / 1_000_000) * entry.cacheRead
    : 0;

  return inputCost + outputCost + cacheWriteCost + cacheReadCost;
}
