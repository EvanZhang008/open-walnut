/**
 * useAgents — the /agents management page's view of the shared agent store.
 *
 * Same return shape as before; the list itself now lives in
 * `@/stores/agents-store` so a write here also reaches the homepage agent
 * switcher (see the store's header for why that used to need a page reload).
 */
import { useEffect, useSyncExternalStore } from 'react';
import type { AgentDefinition, CreateAgentInput, UpdateAgentInput } from '@/api/agents';
import { useEvent } from './useWebSocket';
import {
  cloneAgentDefinition,
  createAgentDefinition,
  deleteAgentDefinition,
  getAgentsSnapshot,
  loadAgents,
  subscribeAgents,
  updateAgentDefinition,
} from '@/stores/agents-store';

interface UseAgentsReturn {
  agents: AgentDefinition[];
  loading: boolean;
  error: string | null;
  refetch: () => void;
  create: (input: CreateAgentInput) => Promise<AgentDefinition>;
  update: (id: string, input: UpdateAgentInput) => Promise<AgentDefinition>;
  remove: (id: string) => Promise<void>;
  clone: (id: string, newId: string, newName?: string) => Promise<AgentDefinition>;
}

function refetch(): void {
  void loadAgents(true);
}

export function useAgents(): UseAgentsReturn {
  const shared = useSyncExternalStore(subscribeAgents, getAgentsSnapshot, getAgentsSnapshot);

  useEffect(() => {
    void loadAgents();
  }, []);

  useEvent('agents:changed', () => { void loadAgents(true); });

  return {
    agents: shared.agents,
    // Only the FIRST resolve blocks the page. A refresh after a write must not
    // swap the whole list for a spinner.
    loading: !shared.agentsLoaded,
    error: shared.error,
    refetch,
    create: createAgentDefinition,
    update: updateAgentDefinition,
    remove: deleteAgentDefinition,
    clone: cloneAgentDefinition,
  };
}
