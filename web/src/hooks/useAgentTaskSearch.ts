/**
 * useAgentTaskSearch — thin React adapter over agentSearchController.
 * Feed it the live search query; it renders the AI panel's state.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchAgentSearch, peekAgentSearch, type AgentSearchPayload } from '@/api/agentSearch';
import {
  clearAgentSearchLatch,
  createAgentSearchController,
  type AgentPanelState,
  type AgentSearchSnapshot,
} from '@/hooks/agentSearchController';
import { AGENT_SEARCH_TOGGLE_KEY } from '@/hooks/agentSearchTrigger';

function readToggle(): boolean {
  try {
    return localStorage.getItem(AGENT_SEARCH_TOGGLE_KEY) !== '0';
  } catch {
    return true;
  }
}

export function useAgentTaskSearch(query: string): {
  state: AgentPanelState;
  data?: AgentSearchPayload;
  /** Progress-stream id while loading — see AgentSearchSnapshot.sid. */
  sid?: string;
  enabled: boolean;
  toggle: () => void;
  retry: () => void;
} {
  const [snapshot, setSnapshot] = useState<AgentSearchSnapshot>({ state: 'hidden' });
  const [enabled, setEnabled] = useState(readToggle);
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;

  const controllerRef = useRef<ReturnType<typeof createAgentSearchController> | null>(null);
  if (!controllerRef.current) {
    controllerRef.current = createAgentSearchController({
      fetcher: fetchAgentSearch,
      peek: peekAgentSearch,
      onState: (s) => setSnapshot(s),
      isEnabled: () => enabledRef.current,
    });
  }

  // Re-evaluated on toggle too: turning the lane back on fires for the query
  // already in the box; turning it off collapses to hidden immediately.
  useEffect(() => {
    controllerRef.current?.setQuery(query);
  }, [query, enabled]);

  useEffect(() => () => controllerRef.current?.dispose(), []);

  const toggle = useCallback(() => {
    setEnabled((prev) => {
      const next = !prev;
      try { localStorage.setItem(AGENT_SEARCH_TOGGLE_KEY, next ? '1' : '0'); } catch { /* private mode */ }
      enabledRef.current = next;
      if (next) {
        // The user may have fixed the environment (installed the CLI,
        // re-enabled AI) — give the lane another chance.
        clearAgentSearchLatch();
      }
      return next;
    });
  }, []);

  const retry = useCallback(() => controllerRef.current?.retry(), []);

  return { state: snapshot.state, data: snapshot.data, sid: snapshot.sid, enabled, toggle, retry };
}
