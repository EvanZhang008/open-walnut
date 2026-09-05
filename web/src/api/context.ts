import { apiGet } from './client';

export interface ContextSection<T = string> {
  content: T;
  tokens: number;
  count?: number;
}

export interface ModelConfig {
  model: string;
  max_tokens: number;
  region: string;
}

export interface ToolSchema {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export interface ApiMessage {
  role: string;
  content: unknown;
}

export interface ContextInspectorResponse {
  /**
   * Which engine this context belongs to. Absent = in-process loop (legacy).
   *
   * Open-ended string, not a two-value union: a named session reports the engine
   * off its OWN record, so any registered coding-agent engine ('codex', …) can
   * appear here. Only 'claude-code' unlocks the Claude Code readings.
   */
  engine?: string;
  sections: {
    modelConfig: ContextSection<ModelConfig>;
    roleAndRules: ContextSection;
    skills: ContextSection;
    compactionSummary: ContextSection;
    taskProjects: ContextSection;
    /** Recent-task ledger (General agent only). */
    recentTasks?: ContextSection;
    userProfile: ContextSection;
    globalMemory: ContextSection;
    notesContext: ContextSection;
    dailyLogs: ContextSection;
    tools: ContextSection<ToolSchema[]>;
    apiMessages: ContextSection<ApiMessage[]>;
    // Non-General agent split sections
    agentMemory?: ContextSection;
    mainAgentMemory?: ContextSection;
    agentDailyLogs?: ContextSection;
    mainAgentDailyLogs?: ContextSection;
  };
  totalTokens: number;
}

/**
 * Read the launch context of one conversation.
 *
 * `sessionId` names a claude-code session directly — what an Ask Walnut
 * conversation IS. `agentId`/`conversationId` is the legacy console-agent form;
 * with neither, the server answers for the configured default.
 */
export async function fetchAgentContext(
  agentId?: string, conversationId?: string, sessionId?: string,
): Promise<ContextInspectorResponse> {
  const params: Record<string, string> = {};
  if (agentId) params.agentId = agentId;
  if (conversationId) params.conversationId = conversationId;
  if (sessionId) params.sessionId = sessionId;
  return apiGet<ContextInspectorResponse>('/api/context', params);
}
