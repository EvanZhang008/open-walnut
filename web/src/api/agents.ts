import { apiGet, apiPost, apiPatch, apiDelete } from './client';

export type ContextSourceId =
  | 'task_details' | 'project_memory' | 'project_task_list'
  | 'global_memory' | 'daily_log' | 'session_history' | 'conversation_log'
  | 'main_global_memory' | 'main_daily_log';

export interface ContextSourceConfig {
  id: ContextSourceId;
  enabled: boolean;
  token_budget?: number;
}

/** A persona for a Claude Code session: the session itself picks model, tools and directory. */
export interface AgentDefinition {
  id: string;
  name: string;
  description?: string;
  system_prompt?: string;
  context_sources?: ContextSourceConfig[];
  console?: boolean;
  source: 'builtin' | 'config' | 'plugin';
  overrides_builtin?: boolean;
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
