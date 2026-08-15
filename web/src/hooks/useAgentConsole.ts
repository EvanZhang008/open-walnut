/**
 * useAgentConsole — manages console agent state.
 *
 * Provides: activeAgentId, agent list, switching, unread badge counts.
 * Persists activeAgentId to localStorage so it survives page refresh.
 */

import { useState, useCallback, useEffect, useRef } from 'react';
import type { AgentDefinition } from '@/api/agents';

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

export function useAgentConsole(): AgentConsoleState {
  const [activeAgentId, setActiveAgentId] = useState<string>(() => {
    try {
      return localStorage.getItem(STORAGE_KEY) || 'general';
    } catch {
      return 'general';
    }
  });
  const [agents, setAgents] = useState<AgentDefinition[]>([]);
  const [unreadCounts] = useState<Record<string, number>>({});
  const activeAgentIdRef = useRef(activeAgentId);
  activeAgentIdRef.current = activeAgentId;

  const loadAgents = useCallback(async (signal?: { cancelled: boolean }) => {
    try {
      const { fetchAgents } = await import('@/api/agents');
      const all = await fetchAgents();
      if (signal?.cancelled) return;
      // 'general' is the default console agent — its definition predates the
      // console flag (console=null), so an exact `a.console` filter drops it
      // and the switcher shows no row for the ACTIVE agent.
      const consoleAgents = all.filter((a: AgentDefinition) => a.console || a.id === 'general');
      setAgents(consoleAgents);
    } catch (err) {
      console.warn('useAgentConsole: failed to load agents', err);
    }
  }, []);

  // Fetch console agents on mount
  useEffect(() => {
    const signal = { cancelled: false };
    void loadAgents(signal);
    return () => { signal.cancelled = true; };
  }, [loadAgents]);

  // TODO: wire up unread tracking using event subscriptions

  const switchAgent = useCallback((agentId: string) => {
    setActiveAgentId(agentId);
    try {
      localStorage.setItem(STORAGE_KEY, agentId);
    } catch { /* localStorage unavailable */ }
  }, []);

  const refresh = useCallback(() => {
    void loadAgents();
  }, [loadAgents]);

  return {
    activeAgentId,
    agents,
    switchAgent,
    refresh,
    unreadCounts,
  };
}
