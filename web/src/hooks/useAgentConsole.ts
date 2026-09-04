/**
 * useAgentConsole — manages console agent state.
 *
 * Provides: activeAgentId, agent list, switching, unread badge counts.
 * Persists activeAgentId to localStorage so it survives page refresh.
 *
 * The agent list comes from the shared agent store, so an agent created or
 * renamed on /agents shows up here without a page reload (MainPage never
 * unmounts, so this hook's own mount effect would never run again).
 */

import { useState, useCallback, useEffect, useMemo, useSyncExternalStore } from 'react';
import type { AgentDefinition } from '@/api/agents';
import { useEvent } from './useWebSocket';
import { getAgentsSnapshot, loadAgents, subscribeAgents } from '@/stores/agents-store';

const STORAGE_KEY = 'walnut:activeAgentId';

export interface AgentConsoleState {
  /** Currently active console agent ID. */
  activeAgentId: string;
  /** All available console agents. */
  agents: AgentDefinition[];
  /** Switch to a different agent. */
  switchAgent: (agentId: string) => void;
  /** Re-fetch the console agent list (e.g. after creating a new agent). */
  refresh: () => void;
  /** Unread message counts per agent (excludes the active agent). */
  unreadCounts: Record<string, number>;
}

const NO_UNREAD: Record<string, number> = {};

export function useAgentConsole(): AgentConsoleState {
  const [activeAgentId, setActiveAgentId] = useState<string>(() => {
    try {
      return localStorage.getItem(STORAGE_KEY) || 'general';
    } catch {
      return 'general';
    }
  });
  const shared = useSyncExternalStore(subscribeAgents, getAgentsSnapshot, getAgentsSnapshot);

  useEffect(() => { void loadAgents(); }, []);

  useEvent('agents:changed', () => { void loadAgents(true); });

  // 'general' is the default console agent — its definition predates the
  // console flag (console=null), so an exact `a.console` filter drops it
  // and the switcher shows no row for the ACTIVE agent.
  const agents = useMemo(
    () => shared.agents.filter((a) => a.console || a.id === 'general'),
    [shared.agents],
  );

  // TODO: wire up unread tracking using event subscriptions

  const switchAgent = useCallback((agentId: string) => {
    setActiveAgentId(agentId);
    try {
      localStorage.setItem(STORAGE_KEY, agentId);
    } catch { /* localStorage unavailable */ }
  }, []);

  const refresh = useCallback(() => {
    void loadAgents(true);
  }, []);

  return {
    activeAgentId,
    agents,
    switchAgent,
    refresh,
    unreadCounts: NO_UNREAD,
  };
}
