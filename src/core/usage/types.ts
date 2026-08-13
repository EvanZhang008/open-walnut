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
  | 'chat'         // butler turn answered by a lane-bound CLI session (agent.provider='claude-code')
  | 'perplexity'   // web search via Perplexity
  | 'glm'          // Zhipu GLM-4 API calls
  | 'heartbeat'    // periodic health checks
  | 'cron'         // cron-triggered agent turns
  | 'triage'       // session/subagent triage
  | 'background-review' // every-N-turn butler self-review fork
  | 'task-hook';   // task lifecycle → overview maintainer agent

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
  agentId?: string;            // which agent spent this (e.g. 'turn-complete-triage', 'note-agent', 'general')
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

/**
 * Unified cross-filter for the usage dashboard. Every field is optional and
 * ANDed together, so the UI can drill in on any combination (e.g. "subagent
 * spend, on the opus model, between two dates"). Dates are inclusive YYYY-MM-DD.
 */
export interface UsageFilter {
  startDate?: string;   // YYYY-MM-DD inclusive
  endDate?: string;     // YYYY-MM-DD inclusive
  source?: string;      // exact source column match
  model?: string;       // exact model column match
  agentId?: string;     // matched against the canonical agent-name expression
}

/**
 * One-shot payload for the dashboard: every aggregate computed under the same
 * filter, plus the DB's overall date bounds for the date-range picker.
 */
export interface UsageOverview {
  summary: UsageSummary;
  daily: DailyCost[];
  bySource: UsageByGroup[];
  byModel: UsageByGroup[];
  byAgent: UsageByGroup[];
  recent: UsageRecord[];
  dateBounds: { min: string | null; max: string | null };
}

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
  agentId?: string;            // which agent spent this (e.g. 'turn-complete-triage', 'note-agent', 'general')
  external_cost_usd?: number;
  duration_ms?: number;
  parent_source?: UsageSource;  // which source invoked this (e.g. subagent via 'agent')
}
