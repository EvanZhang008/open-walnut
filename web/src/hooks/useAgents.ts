import { useState, useEffect, useCallback } from 'react';
import * as agentsApi from '@/api/agents';
import type { AgentDefinition, CreateAgentInput, UpdateAgentInput, SkillMeta } from '@/api/agents';

interface UseAgentsReturn {
  agents: AgentDefinition[];
  toolNames: string[];
  availableModels: string[];
  skills: SkillMeta[];
  loading: boolean;
  error: string | null;
  refetch: () => void;
  create: (input: CreateAgentInput) => Promise<AgentDefinition>;
  update: (id: string, input: UpdateAgentInput) => Promise<AgentDefinition>;
  remove: (id: string) => Promise<void>;
  clone: (id: string, newId: string, newName?: string) => Promise<AgentDefinition>;
}

export function useAgents(): UseAgentsReturn {
  const [agents, setAgents] = useState<AgentDefinition[]>([]);
  const [toolNames, setToolNames] = useState<string[]>([]);
  const [availableModels, setAvailableModels] = useState<string[]>([]);
  const [skills, setSkills] = useState<SkillMeta[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refetch = useCallback(() => {
    setLoading(true);
    setError(null);
    Promise.all([agentsApi.fetchAgents(), agentsApi.fetchToolNames(), agentsApi.fetchAvailableModels(), agentsApi.fetchAvailableSkills()])
      .then(([agentList, tools, models, skillList]) => {
        setAgents(agentList);
        setToolNames(tools);
        setAvailableModels(models);
        setSkills(skillList);
      })
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { refetch(); }, [refetch]);

  const create = useCallback(async (input: CreateAgentInput) => {
    const agent = await agentsApi.createAgentDef(input);
    refetch();
    return agent;
  }, [refetch]);

  const update = useCallback(async (id: string, input: UpdateAgentInput) => {
    const agent = await agentsApi.updateAgentDef(id, input);
    refetch();
    return agent;
  }, [refetch]);

  const remove = useCallback(async (id: string) => {
    await agentsApi.deleteAgentDef(id);
    refetch();
  }, [refetch]);

  const clone = useCallback(async (id: string, newId: string, newName?: string) => {
    const agent = await agentsApi.cloneAgentDef(id, newId, newName);
    refetch();
    return agent;
  }, [refetch]);

  return { agents, toolNames, availableModels, skills, loading, error, refetch, create, update, remove, clone };
}
