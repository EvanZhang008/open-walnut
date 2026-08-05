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
  sections: {
    modelConfig: ContextSection<ModelConfig>;
    roleAndRules: ContextSection;
    skills: ContextSection;
    compactionSummary: ContextSection;
    taskProjects: ContextSection;
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

export async function fetchAgentContext(agentId?: string, conversationId?: string): Promise<ContextInspectorResponse> {
  const params: Record<string, string> = {};
  if (agentId) params.agentId = agentId;
  if (conversationId) params.conversationId = conversationId;
  return apiGet<ContextInspectorResponse>('/api/context', params);
}
