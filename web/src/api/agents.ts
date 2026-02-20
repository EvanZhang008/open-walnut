import { apiGet, apiPost, apiPatch, apiDelete } from './client';

export type ContextSourceId =
  | 'task_details' | 'project_memory' | 'project_task_list'
  | 'global_memory' | 'daily_log' | 'session_history' | 'conversation_log';

export interface ContextSourceConfig {
  id: ContextSourceId;
  enabled: boolean;
  token_budget?: number;
}

export interface AgentStatefulConfig {
  memory_project: string;
  memory_budget_tokens?: number;
  memory_source?: string;
}

export interface AgentDefinition {
  id: string;
  name: string;
  description?: string;
  runner: 'embedded' | 'cli';
  model?: string;
  region?: string;
  max_tokens?: number;
  max_tool_rounds?: number;
  system_prompt?: string;
  denied_tools?: string[];
  allowed_tools?: string[];
  working_directory?: string;
  context_sources?: ContextSourceConfig[];
  stateful?: AgentStatefulConfig;
  skills?: string[];
  source: 'builtin' | 'config';
  overrides_builtin?: boolean;
}

export interface SkillMeta {
  dirName: string;
  name: string;
  description: string;
}

export type CreateAgentInput = Omit<AgentDefinition, 'source'>;
export type UpdateAgentInput = Partial<Omit<AgentDefinition, 'id' | 'source'>>;

export async function fetchAgents(): Promise<AgentDefinition[]> {
  const res = await apiGet<{ agents: AgentDefinition[] }>('/api/agents');
  return res.agents;
}

export async function fetchAgent(id: string): Promise<AgentDefinition> {
  const res = await apiGet<{ agent: AgentDefinition }>(`/api/agents/${id}`);
  return res.agent;
}

export async function fetchToolNames(): Promise<string[]> {
  const res = await apiGet<{ tools: string[] }>('/api/agents/meta/tools');
  return res.tools;
}

export async function fetchAvailableModels(): Promise<string[]> {
  const res = await apiGet<{ models: string[] }>('/api/agents/meta/models');
  return res.models;
}

export async function createAgentDef(input: CreateAgentInput): Promise<AgentDefinition> {
  const res = await apiPost<{ agent: AgentDefinition }>('/api/agents', input);
  return res.agent;
}

export async function updateAgentDef(id: string, input: UpdateAgentInput): Promise<AgentDefinition> {
  const res = await apiPatch<{ agent: AgentDefinition }>(`/api/agents/${id}`, input);
  return res.agent;
}

export async function deleteAgentDef(id: string): Promise<void> {
  await apiDelete(`/api/agents/${id}`);
}

export async function cloneAgentDef(id: string, newId: string, newName?: string): Promise<AgentDefinition> {
  const res = await apiPost<{ agent: AgentDefinition }>(`/api/agents/${id}/clone`, { id: newId, name: newName });
  return res.agent;
}

export async function fetchAvailableSkills(): Promise<SkillMeta[]> {
  const res = await apiGet<{ skills: SkillMeta[] }>('/api/agents/meta/skills');
  return res.skills;
}
