import { apiGet, apiPost } from './client';

export interface UsageSummary {
  total_cost: number;
  session_cost: number;
  verified_calls?: number;
  unverified_calls?: number;
  token_counts_complete?: boolean;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
  api_calls: number;
}

export interface DailyCost {
  date: string;
  cost_usd: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
  api_calls: number;
}

export interface UsageByGroup {
  name: string;
  cost_usd: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
  api_calls: number;
  percentage: number;
  unverified_calls?: number;
  token_counts_complete?: boolean;
}

export interface UsageRecord {
  id: string;
  timestamp: string;
  date: string;
  source: string;
  model: string;
  input_tokens: number | null;
  output_tokens: number | null;
  cache_creation_input_tokens: number | null;
  cache_read_input_tokens: number | null;
  cost_usd: number | null;
  verification?: string;
  taskTitle?: string;
  host?: string;
  project?: string;
  taskId?: string;
  sessionId?: string;
  runId?: string;
  agentId?: string;
  external_cost_usd?: number;
  duration_ms?: number;
  parent_source?: string;
}

export interface PricingEntry {
  pattern: string;
  input: number;
  output: number;
  cacheWrite?: number;
  cacheRead?: number;
}

export type Period = 'today' | '7d' | '30d' | 'all';

/** Cross-filter for the interactive dashboard — all fields optional, ANDed. */
export interface UsageFilter {
  startDate?: string;   // YYYY-MM-DD inclusive
  endDate?: string;     // YYYY-MM-DD inclusive
  source?: string;
  model?: string;
  agentId?: string;
}

export interface UsageOverview {
  summary: UsageSummary;
  daily: DailyCost[];
  bySource: UsageByGroup[];
  byModel: UsageByGroup[];
  byAgent: UsageByGroup[];
  recent: UsageRecord[];
  dateBounds: { min: string | null; max: string | null };
  sessions?: { sessionId: string; taskId?: string; title?: string; project?: string; host: string; calls: number; cost: number; unverified: number }[];
  collection?: { running: boolean; startedAt?: string; finishedAt?: string; error?: string };
  accuracy?: {
    timezone: string; pricingVersion: string; until: string | null; status: string; note: string;
    checks: { source: string; host: string; status: string; matchedCalls: number; unmatchedCalls: number; detail: string;
      residuals?: { source: string; model: string; count: number; input_tokens: number | null; output_tokens: number | null;
        cache_read_input_tokens: number | null; cache_creation_input_tokens: number | null }[] }[];
  };
}

export function collectUsage(since?: string) { return apiPost('/api/usage/collect', { since }); }

export async function fetchUsageOverview(filter: UsageFilter, limit = 100): Promise<UsageOverview> {
  const q: Record<string, string> = { limit: String(limit) };
  if (filter.startDate) q.start = filter.startDate;
  if (filter.endDate) q.end = filter.endDate;
  if (filter.source) q.source = filter.source;
  if (filter.model) q.model = filter.model;
  if (filter.agentId) q.agent = filter.agentId;
  return apiGet('/api/usage/overview', q);
}

export async function fetchUsageSummary(): Promise<Record<string, UsageSummary>> {
  return apiGet('/api/usage/summary');
}

export async function fetchDailyCosts(days = 30): Promise<DailyCost[]> {
  const res = await apiGet<{ daily: DailyCost[] }>('/api/usage/daily', { days: String(days) });
  return res.daily;
}

export async function fetchBySource(period: Period = '30d'): Promise<UsageByGroup[]> {
  const res = await apiGet<{ sources: UsageByGroup[] }>('/api/usage/by-source', { period });
  return res.sources;
}

export async function fetchByModel(period: Period = '30d'): Promise<UsageByGroup[]> {
  const res = await apiGet<{ models: UsageByGroup[] }>('/api/usage/by-model', { period });
  return res.models;
}

export async function fetchByAgent(period: Period = '30d'): Promise<UsageByGroup[]> {
  const res = await apiGet<{ agents: UsageByGroup[] }>('/api/usage/by-agent', { period });
  return res.agents;
}

export async function fetchRecentRecords(limit = 50): Promise<UsageRecord[]> {
  const res = await apiGet<{ records: UsageRecord[] }>('/api/usage/recent', { limit: String(limit) });
  return res.records;
}

export async function fetchPricing(): Promise<{ models: PricingEntry[]; version: string }> {
  return apiGet('/api/usage/pricing');
}

// ── Usage & Costs (GET /api/usage/costs, src/core/usage/cost-report.ts) ──

/** `all`: every coding agent plus Walnut's own calls, the page's view; the other two stay for older callers. */
export type CostView = 'all' | 'walnut' | 'agents';
export interface CostTokens { input: number; output: number; cacheRead: number; cacheWrite: number }
export interface CostLine { key: string; label: string; costUsd: number; requests: number; tokens: CostTokens; unpriced: number }
export interface CostTaskLine extends CostLine { taskId?: string; sessionId?: string; project: string; hosts: string[]; engines: string[] }
export interface CostUnpriced { model: string; where: string; requests: number }
export interface CostFold { count: number; costUsd: number; requests: number; tokens?: number }
/** One breakdown (agent, model, project, host...): its lines over the period and each day's cost per line key. */
export interface CostGroup { id: string; heading: string; lines: CostLine[]; daily?: { date: string; costs: Record<string, number> }[] }
export interface CostSourceCheck { source: string; host: string; status: string; matchedCalls: number; unmatchedCalls: number; detail: string }

export interface CostReport {
  view: CostView;
  range: { start: string | null; end: string | null };
  /** Agents only: the one engine counted (claude, codex, opencode...), null for all. */
  engine?: string | null;
  /** Agents only: the engines with sessions in the period. */
  engines?: { key: string; label: string }[];
  totals: CostLine;
  daily: { date: string; costUsd: number; requests: number }[];
  groups: CostGroup[];
  tasks?: CostTaskLine[];
  moreTasks?: CostFold;
  shortSessions?: CostFold & { lines: CostTaskLine[] };
  unpricedModels: string[];
  unpriced?: CostUnpriced[];
  prices: { source: string; asOf?: string };
  ready: boolean;
  timeZone: string;
  bounds: { min: string | null; max: string | null };
  countedUntil: { host: string; until: string }[];
  checks: CostSourceCheck[];
  collection?: { running: boolean; startedAt?: string; finishedAt?: string; error?: string };
}

/** `engine`: one coding engine's key, agents view only; absent or 'all' counts every engine. */
export function fetchUsageCosts(view: CostView, range: { start?: string; end?: string }, engine?: string): Promise<CostReport> {
  const q: Record<string, string> = { view };
  if (range.start) q.start = range.start;
  if (range.end) q.end = range.end;
  if (view === 'agents' && engine && engine !== 'all') q.engine = engine;
  return apiGet('/api/usage/costs', q);
}
