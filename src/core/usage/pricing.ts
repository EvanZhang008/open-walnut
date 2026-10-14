/** Prices are in USD per million tokens. */
export const PRICING_VERSION = '2026-10-14';

export interface PricingRates {
  input: number;
  output: number;
  cacheWrite?: number;
  cacheWrite1h?: number;
  cacheRead?: number;
}

export interface PricingEntry extends PricingRates {
  pattern: string;
  contextThreshold?: number;
  longContext?: PricingRates;
  separateCacheCreation?: boolean;
}

export interface PriceUsageParams {
  model: string;
  speed?: string | null;
  inference_geo?: string | null;
  service_tier?: string | null;
  pricing_context_complete?: boolean;
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation?: {
    ephemeral_5m_input_tokens?: number;
    ephemeral_1h_input_tokens?: number;
  } | null;
  customPricing?: PricingEntry[];
}

export interface UsagePrice {
  costUsd: number | null;
  pricingStatus: 'priced' | 'unpriced';
  pricingVersion: string;
  components: {
    input: number | null;
    output: number | null;
    cacheRead: number | null;
    cacheWrite: number | null;
    cacheWrite5m: number | null;
    cacheWrite1h: number | null;
  };
}

/**
 * Built-in pricing table. Ordered from most-specific to least-specific
 * to prevent partial matches (e.g. "claude-opus-4-6" before "claude-opus-4").
 */
export const DEFAULT_PRICING: PricingEntry[] = [
  // Public standard/global token rates: https://platform.claude.com/docs/en/about-claude/pricing
  { pattern: 'claude-fable-5-1',    input: 10.00, output: 50.00, cacheWrite: 12.50, cacheWrite1h: 20.00, cacheRead: 0.25 },
  { pattern: 'claude-opus-5-5-fast', input: 8.00, output: 40.00, cacheWrite: 10.00, cacheWrite1h: 16.00, cacheRead: 0.40 },
  { pattern: 'claude-opus-5-5',     input: 4.00,  output: 20.00, cacheWrite: 5.00, cacheWrite1h: 8.00, cacheRead: 0.20 },
  { pattern: 'claude-opus-5-fast',  input: 10.00, output: 50.00, cacheWrite: 12.50,  cacheWrite1h: 20.00, cacheRead: 1.00 },
  { pattern: 'claude-opus-5',       input: 5.00,  output: 25.00, cacheWrite: 6.25,   cacheWrite1h: 10.00, cacheRead: 0.50 },
  { pattern: 'claude-opus-4-8',     input: 5.00,  output: 25.00, cacheWrite: 6.25,   cacheWrite1h: 10.00, cacheRead: 0.50 },
  { pattern: 'claude-opus-4-7',     input: 5.00,  output: 25.00, cacheWrite: 6.25,   cacheWrite1h: 10.00, cacheRead: 0.50 },
  { pattern: 'claude-opus-4-6',     input: 5.00,  output: 25.00, cacheWrite: 6.25,   cacheWrite1h: 10.00, cacheRead: 0.50 },
  { pattern: 'claude-opus-4-5',     input: 5.00,  output: 25.00, cacheWrite: 6.25,   cacheWrite1h: 10.00, cacheRead: 0.50 },
  { pattern: 'claude-opus-4-1',     input: 15.00, output: 75.00, cacheWrite: 18.75,  cacheWrite1h: 30.00, cacheRead: 1.50 },
  { pattern: 'claude-opus-4',       input: 15.00, output: 75.00, cacheWrite: 18.75,  cacheWrite1h: 30.00, cacheRead: 1.50 },
  // Sonnet 5.5 (2026-09-28) kept Sonnet 5's list price. Its row sits above
  // 'claude-sonnet-5', which is a substring of it.
  { pattern: 'claude-sonnet-5-5',   input: 2.00,  output: 10.00, cacheWrite: 2.50,   cacheWrite1h: 4.00, cacheRead: 0.20 },
  { pattern: 'claude-sonnet-5',     input: 2.00,  output: 10.00, cacheWrite: 2.50,   cacheWrite1h: 4.00, cacheRead: 0.20 },
  { pattern: 'claude-sonnet-4-5',   input: 3.00,  output: 15.00, cacheWrite: 3.75,   cacheWrite1h: 6.00, cacheRead: 0.30 },
  { pattern: 'claude-sonnet-4',     input: 3.00,  output: 15.00, cacheWrite: 3.75,   cacheWrite1h: 6.00, cacheRead: 0.30 },
  { pattern: 'claude-3-7-sonnet',   input: 3.00,  output: 15.00, cacheWrite: 3.75,   cacheWrite1h: 6.00, cacheRead: 0.30 },
  {
    pattern: 'claude-haiku-5-5', input: 0.10, output: 0.50,
    cacheWrite: 0.125, cacheWrite1h: 0.20, cacheRead: 0.01, contextThreshold: 100_000,
    longContext: { input: 0.50, output: 2.50, cacheWrite: 0.625, cacheWrite1h: 1.00, cacheRead: 0.05 },
  },
  { pattern: 'claude-haiku-4-5',    input: 1.00,  output: 5.00,  cacheWrite: 1.25,   cacheWrite1h: 2.00, cacheRead: 0.10 },
  { pattern: 'claude-3-5-haiku',    input: 0.80,  output: 4.00,  cacheWrite: 1.00,   cacheWrite1h: 1.60, cacheRead: 0.08 },
  { pattern: 'claude-3-haiku',      input: 0.25,  output: 1.25,  cacheWrite: 0.30,   cacheWrite1h: 0.50, cacheRead: 0.03 },

  // Public standard token rates: https://developers.openai.com/api/docs/pricing
  {
    pattern: 'gpt-6.1-sol', input: 2.00, output: 10.00, cacheRead: 0.10, cacheWrite: 2.50,
    separateCacheCreation: true, contextThreshold: 272_000,
    longContext: { input: 4.00, output: 15.00, cacheRead: 0.20, cacheWrite: 5.00 },
  },
  { pattern: 'gpt-6-sol',          input: 2.00,  output: 10.00, cacheRead: 0.20, separateCacheCreation: true },
  { pattern: 'gpt-6-luna', input: 0.10, output: 0.50, cacheRead: 0.01, cacheWrite: 0.125,
    separateCacheCreation: true, contextThreshold: 272_000,
    longContext: { input: 0.20, output: 0.75, cacheRead: 0.02, cacheWrite: 0.25 } },
  {
    pattern: 'gpt-6-astra', input: 10.00, output: 50.00, cacheRead: 1.00, cacheWrite: 12.50,
    separateCacheCreation: true, contextThreshold: 272_000,
    longContext: { input: 20.00, output: 75.00, cacheRead: 2.00, cacheWrite: 25.00 },
  },
  { pattern: 'gpt-5.6',            input: 8.80,  output: 33.00, cacheRead: 0.88 },

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

  // ── TypeSafe Jev (System One decisions; output tokens are free) ──
  // Matches 'jev-latest', 'jev-1.13.0' and gateway ids like 'typesafe/jev-1.13'.
  { pattern: 'jev',                input: 0.042, output: 0 },
];

function normalizeModel(model: string): string {
  return model.trim().toLowerCase()
    .replace(/(?:\[[^\]]*\])+$/, '')
    .replace(/(\d)\.(?=\d)/g, '$1-')
    .replace(/claude-haiku-3-5(?=-|$)/, 'claude-3-5-haiku');
}

export function findPricing(modelId: string, customPricing?: PricingEntry[]): PricingEntry | undefined {
  const normalized = normalizeModel(modelId);
  const custom = customPricing?.find((entry) => normalized.includes(normalizeModel(entry.pattern)));
  if (custom) return custom;
  return DEFAULT_PRICING.find((entry) => {
    const pattern = normalizeModel(entry.pattern).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const suffix = entry.pattern === 'jev'
      ? '(?:-(?:latest|\\d+(?:-\\d+)*))?'
      : '(?:-(?:\\d{8}|v\\d+))*(?::\\d+)?';
    const family = entry.pattern === 'gpt-5.6' ? '(?:-(?:sol|luna|astra))?' : '';
    return new RegExp(`(?:^|[./:])${pattern}${family}${suffix}$`).test(normalized);
  });
}

function unpriced(): UsagePrice {
  return {
    costUsd: null,
    pricingStatus: 'unpriced',
    pricingVersion: PRICING_VERSION,
    components: { input: null, output: null, cacheRead: null, cacheWrite: null, cacheWrite5m: null, cacheWrite1h: null },
  };
}

function validTokens(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function tokenCost(tokens: number, rate: number | undefined): number | null {
  if (tokens === 0) return 0;
  if (rate === undefined || !Number.isFinite(rate) || rate < 0) return null;
  const cost = (tokens / 1_000_000) * rate;
  return Number.isFinite(cost) ? cost : null;
}

/** Prices one response; input excludes separately reported cache tokens. */
export function priceUsage(params: PriceUsageParams): UsagePrice {
  const model = params.speed === 'fast' ? `${params.model.replace(/-fast(?:\[[^\]]*\])?$/, '')}-fast` : params.model;
  const entry = findPricing(model, params.customPricing);
  if (!entry || params.pricing_context_complete === false
    || (params.speed != null && !['standard', 'fast'].includes(params.speed))
    || (params.service_tier != null && params.service_tier !== 'standard')
    || (params.inference_geo != null && !['', 'global', 'us'].includes(params.inference_geo))) return unpriced();

  const read = params.cache_read_input_tokens ?? 0;
  const write5m = params.cache_creation?.ephemeral_5m_input_tokens ?? 0;
  const write1h = params.cache_creation?.ephemeral_1h_input_tokens ?? 0;
  const hasDetails = params.cache_creation?.ephemeral_5m_input_tokens !== undefined
    || params.cache_creation?.ephemeral_1h_input_tokens !== undefined;
  const creation = params.cache_creation_input_tokens ?? (write5m + write1h);
  const context = params.input_tokens + read + creation;
  if (![params.input_tokens, params.output_tokens, read, creation, write5m, write1h, context].every(validTokens)
    || (hasDetails && creation !== write5m + write1h)) return unpriced();

  const rates = entry.contextThreshold !== undefined && context > entry.contextThreshold
    ? entry.longContext
    : entry;
  if (!rates) return unpriced();

  const separate = entry.separateCacheCreation === true;
  const components: UsagePrice['components'] = {
    input: tokenCost(params.input_tokens, rates.input),
    output: tokenCost(params.output_tokens, rates.output),
    cacheRead: tokenCost(read, rates.cacheRead),
    cacheWrite: separate ? tokenCost(creation, rates.cacheWrite) : 0,
    cacheWrite5m: separate ? 0 : tokenCost(write5m, rates.cacheWrite),
    cacheWrite1h: separate ? 0 : tokenCost(write1h, rates.cacheWrite1h),
  };
  if (!separate && creation > 0 && !hasDetails) {
    components.cacheWrite5m = null;
    components.cacheWrite1h = null;
  }
  if (params.inference_geo === 'us') {
    for (const key of Object.keys(components) as (keyof typeof components)[]) {
      if (components[key] !== null) components[key] *= 1.1;
    }
  }
  const values = Object.values(components);
  const total = values.every((value): value is number => value !== null)
    ? values.reduce((sum, value) => sum + value, 0)
    : null;
  const costUsd = total !== null && Number.isFinite(total) ? total : null;
  return {
    costUsd,
    pricingStatus: costUsd === null ? 'unpriced' : 'priced',
    pricingVersion: PRICING_VERSION,
    components,
  };
}

export function priceReconciledUsage(params: PriceUsageParams & { forwardedModel: string | null }): UsagePrice {
  const published = ['claude-opus-5-5', 'claude-fable-5-1', 'claude-haiku-5-5'];
  if (!published.includes(findPricing(params.model)?.pattern ?? '')
    || !params.forwardedModel?.startsWith('global.anthropic.claude-') || !params.model.startsWith('claude-')
    || findPricing(params.forwardedModel)?.pattern !== findPricing(params.model)?.pattern
    || params.pricing_context_complete !== true || params.speed !== 'standard'
    || params.service_tier !== 'standard' || params.inference_geo !== '' || params.model.endsWith('-fast')) return unpriced();
  return priceUsage(params);
}

/** Numeric compatibility API. Unpriced usage returns NaN, never a guessed price. */
export function computeCost(params: PriceUsageParams): number {
  return priceUsage(params).costUsd ?? Number.NaN;
}
