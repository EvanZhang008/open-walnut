/**
 * Usage tracking types.
 */

export type UsageSource =
  | 'agent'        // main agent (web chat)
  | 'agent-cli'    // main agent (CLI)
  | 'subagent'     // embedded subagent
  | 'compaction'   // chat compaction summarizer
  | 'image-tool'   // direct sendMessage for image analysis
  | 'session'      // Claude Code CLI session (external process)
  | 'perplexity'   // web search via Perplexity
  | 'glm'          // Zhipu GLM-4 API calls
  | 'heartbeat'    // periodic health checks
  | 'cron'         // cron-triggered agent turns
  | 'triage';      // session/subagent triage

export interface UsageRecord {
  id: string;
  timestamp: string;           // ISO 8601
  date: string;                // YYYY-MM-DD (indexed)
  source: UsageSource;
  model: string;
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
  cost_usd: number;
  taskId?: string;
  sessionId?: string;
  runId?: string;
  external_cost_usd?: number;  // Claude Code CLI's self-reported cost
  duration_ms?: number;
  parent_source?: UsageSource;  // which source invoked this (e.g. subagent via 'agent')
}

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

export type UsagePeriod = 'today' | '7d' | '30d' | 'all';

export interface RecordParams {
  source: UsageSource;
  model: string;
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  taskId?: string;
  sessionId?: string;
  runId?: string;
  external_cost_usd?: number;
  duration_ms?: number;
  parent_source?: UsageSource;  // which source invoked this (e.g. subagent via 'agent')
}
