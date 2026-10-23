import { apiGet } from './client';

/** Rates in USD per million tokens. */
export interface SessionCostRates {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
  cacheWrite1h?: number;
  threshold?: number;
  long?: { input: number; output: number; cacheRead?: number; cacheWrite?: number; cacheWrite1h?: number };
  singleCacheWrite?: boolean;
}

/** One row of a model's cost table. */
export interface SessionCostLine {
  kind: 'input' | 'cacheWrite' | 'cacheWrite5m' | 'cacheWrite1h' | 'cacheRead' | 'output' | 'webSearch';
  /** Tokens, or searches for webSearch. */
  count: number;
  /** USD per million tokens, or per thousand searches. */
  rate: number;
  costUsd: number;
}

export interface SessionCostTier {
  tier: 'base' | 'long';
  responses: number;
  costUsd: number;
  lines: SessionCostLine[];
}

export interface SessionCostModel {
  model: string;
  speed: 'standard' | 'fast';
  responses: number;
  tokens: { input: number; output: number; cacheRead: number; cacheWrite5m: number; cacheWrite1h: number; cacheWrite: number };
  costUsd: number | null;
  unpricedResponses: number;
  unpricedReason?: string;
  longResponses: number;
  webSearches: number;
  usRegionResponses: number;
  rates?: SessionCostRates;
  /** Cost table per prompt tier (priced requests only); absent from older servers. */
  tiers?: SessionCostTier[];
  priceSource?: { kind: 'override' | 'litellm' | 'builtin'; key: string; asOf?: string };
  firstAt: string;
  lastAt: string;
}

export interface SessionCost {
  sessionId: string;
  engine: string;
  source: 'claude-transcript' | 'codex-rollout' | 'opencode-export' | 'none' | 'unavailable';
  status: 'priced' | 'partial' | 'unpriced' | 'empty' | 'pending' | 'unavailable';
  pending?: { readBytes: number; totalBytes: number };
  reason?: string;
  totalUsd: number | null;
  responses: number;
  unpricedResponses: number;
  models: SessionCostModel[];
  firstAt?: string;
  lastAt?: string;
  engineCostUsd?: number;
  apiDurationMs?: number;
  durationMs?: number;
  prices: { source: 'litellm' | 'builtin'; asOf?: string };
  scanMs?: number;
}

/** What the session cost, priced per request on the server (GET /api/sessions/:id/cost). */
export function fetchSessionCost(sessionId: string, signal?: AbortSignal): Promise<SessionCost> {
  // The server answers within its own 25s deadline; leave room for the response.
  return apiGet(`/api/sessions/${encodeURIComponent(sessionId)}/cost`, undefined, { timeoutMs: 35_000, priority: 'low', signal });
}

/** The same usage priced at another model's list price. */
export interface SessionCostComparisonRow {
  id: string;
  key: string;
  label?: string;
  group: 'walnut' | 'popular';
  costUsd: number;
  longResponses: number;
  rates: { input: number; output: number; cacheRead: number; cacheWrite: number; threshold?: number };
  assumptions: string[];
  current: boolean;
  priceSource: { kind: 'override' | 'litellm' | 'builtin'; key: string };
}

export interface SessionCostComparison {
  sessionId: string;
  status: 'ok' | 'pending' | 'unavailable' | 'empty';
  reason?: string;
  responses: number;
  rows: SessionCostComparisonRow[];
  unknown: string[];
}

/** What this session's usage would cost on each model (the picker's, plus popular ones). */
export function fetchSessionCostComparison(sessionId: string, models: string[], signal?: AbortSignal): Promise<SessionCostComparison> {
  const q = models.length ? `?models=${encodeURIComponent(models.join(','))}` : '';
  return apiGet(`/api/sessions/${encodeURIComponent(sessionId)}/cost/compare${q}`, undefined, { timeoutMs: 35_000, priority: 'low', signal });
}
