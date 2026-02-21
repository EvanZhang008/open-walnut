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
    taskCategories: ContextSection;
    globalMemory: ContextSection;
    projectSummaries: ContextSection;
    dailyLogs: ContextSection;
    tools: ContextSection<ToolSchema[]>;
    apiMessages: ContextSection<ApiMessage[]>;
  };
  totalTokens: number;
}

export async function fetchAgentContext(): Promise<ContextInspectorResponse> {
  return apiGet<ContextInspectorResponse>('/api/context');
}
