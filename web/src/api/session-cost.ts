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
