/**
 * useTeamStream — manage team info loading and per-agent tab subscriptions.
 *
 * When a session has team Agent tools, this hook:
 * 1. Fetches team config (member list) via RPC
 * 2. When user clicks an agent tab, subscribes to that agent's JSONL stream
 * 3. Returns agent events for the active tab
 */

import { useState, useCallback, useRef, useEffect } from 'react';
import { wsClient } from '@/api/ws';
import { useEvent } from './useWebSocket';

export interface TeamMember {
  name: string;
  agentType: string;
  model: string;
  isLead: boolean;
  backendType?: string;
}

export interface TeamAgentEvent {
  type: 'text' | 'tool_use' | 'tool_result' | 'system' | 'user-sent';
  text?: string;
  toolName?: string;
  toolUseId?: string;
  input?: Record<string, unknown>;
  result?: string;
  subtype?: string;
  model?: string;
  /** Timestamp for sent messages */
  timestamp?: string;
}

interface UseTeamStreamReturn {
  /** Team name (null if no team detected) */
  teamName: string | null;
  /** Team members */
  members: TeamMember[];
  /** Currently active agent tab name */
  activeAgent: string | null;
  /** Events for the active agent */
  agentEvents: TeamAgentEvent[];
  /** Loading state for the active agent's data */
  agentLoading: boolean;
  /** Switch to viewing a specific agent's tab */
  selectAgent: (agentName: string) => void;
  /** Whether team info has been loaded */
  loaded: boolean;
  /** Add a sent message to the active agent's events (optimistic UI) */
  addSentMessage: (text: string) => void;
}

/**
 * Hook to manage team streaming for a session.
 *
 * @param sessionId - The Claude session ID
 * @param teamName - Team name (from tool detection or team-info RPC)
 */
export function useTeamStream(sessionId: string | null, teamName: string | null): UseTeamStreamReturn {
  const [members, setMembers] = useState<TeamMember[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [activeAgent, setActiveAgent] = useState<string | null>(null);
  const [agentEvents, setAgentEvents] = useState<TeamAgentEvent[]>([]);
  const [agentLoading, setAgentLoading] = useState(false);
  const activeSessionRef = useRef<string | null>(null);
  const activeAgentRef = useRef<string | null>(null);

  // Load team info when teamName changes
  useEffect(() => {
    if (!sessionId || !teamName) {
      setMembers([]);
      setLoaded(false);
      setActiveAgent(null);
      setAgentEvents([]);
      return;
    }

    activeSessionRef.current = sessionId;

    wsClient.sendRpc<{ teamName: string | null; members: TeamMember[] }>('session:team-info', {
      sessionId,
      teamName,
    }).then((result) => {
      if (activeSessionRef.current !== sessionId) return;
      if (result?.members) {
        setMembers(result.members);
        setLoaded(true);
      }
    }).catch(() => {
      setLoaded(true); // Mark as loaded even on error to prevent infinite loading
    });

    // Cleanup: unsubscribe from agent polling when session changes
    return () => {
      if (activeAgentRef.current) {
        wsClient.sendRpc('session:team-agent-unsubscribe', { sessionId }).catch(() => {});
        activeAgentRef.current = null;
      }
    };
  }, [sessionId, teamName]);

  // Subscribe to agent events (incremental updates)
  useEvent('session:team-agent-delta', (data) => {
    const payload = data as { sessionId: string; agentName: string; events: TeamAgentEvent[] };
    if (!sessionId || payload.sessionId !== sessionId) return;
    if (payload.agentName !== activeAgentRef.current) return;

    setAgentEvents(prev => [...prev, ...payload.events]);
  });

  // Add a user-sent message optimistically
  const addSentMessage = useCallback((text: string) => {
    setAgentEvents(prev => [...prev, {
      type: 'user-sent' as const,
      text,
      timestamp: new Date().toISOString(),
    }]);
  }, []);

  // Select an agent tab and start streaming its JSONL
  const selectAgent = useCallback((agentName: string) => {
    if (!sessionId || !teamName) return;
    if (agentName === activeAgentRef.current) return;

    activeAgentRef.current = agentName;
    setActiveAgent(agentName);
    setAgentEvents([]);
    setAgentLoading(true);

    // Subscribe to this agent's JSONL stream
    wsClient.sendRpc<{ events: TeamAgentEvent[]; error?: string }>('session:team-agent-subscribe', {
      sessionId,
      agentName,
      teamName,
    }).then((result) => {
      if (activeAgentRef.current !== agentName) return;
      if (result?.events) {
        setAgentEvents(result.events);
      }
      setAgentLoading(false);
    }).catch(() => {
      if (activeAgentRef.current === agentName) {
        setAgentLoading(false);
      }
    });
  }, [sessionId, teamName]);

  return {
    teamName,
    members,
    activeAgent,
    agentEvents,
    agentLoading,
    selectAgent,
    loaded,
    addSentMessage,
  };
}
