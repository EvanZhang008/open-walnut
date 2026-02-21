import { apiGet } from './client';

export interface UsageSummary {
  total_cost: number;
  session_cost: number;
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
}

export interface UsageRecord {
  id: string;
  timestamp: string;
  date: string;
  source: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
  cost_usd: number;
  taskId?: string;
  sessionId?: string;
  runId?: string;
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

export async function fetchRecentRecords(limit = 50): Promise<UsageRecord[]> {
  const res = await apiGet<{ records: UsageRecord[] }>('/api/usage/recent', { limit: String(limit) });
  return res.records;
}

export async function fetchPricing(): Promise<{ models: PricingEntry[]; version: string }> {
  return apiGet('/api/usage/pricing');
}
