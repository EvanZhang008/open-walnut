import { useState, useCallback, useRef, useEffect } from 'react';
import { useEvent } from './useWebSocket';
import { fetchAgentContext, type ContextInspectorResponse } from '@/api/context';

export interface UseContextInspectorReturn {
  data: ContextInspectorResponse | null;
  loading: boolean;
  error: string | null;
  isOpen: boolean;
  /** No conversation to describe (no session, no agent/conversation pair). The
   *  hook issues NO request in this state; the panel says so instead. */
  noSubject: boolean;
  open: () => void;
  close: () => void;
  toggle: () => void;
  refresh: () => void;
}

/**
 * The context inspector's data source.
 *
 * `sessionId` is the CURRENT form: an Ask Walnut conversation is an ordinary
 * claude-code session, so the panel describes THAT session's launch config. The
 * agentId/conversationId pair is the legacy console-agent form and still works —
 * both are just query params on the same route.
 *
 * With NONE of the three the hook stays silent. A parameterless GET /api/context
 * answers for the configured default lane, which on the home page meant "no ask is
 * selected" rendered some other conversation's launch config as if it were the
 * one on screen.
 */
export function useContextInspector(
  agentId?: string, conversationId?: string, sessionId?: string,
): UseContextInspectorReturn {
  const [data, setData] = useState<ContextInspectorResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isOpen, setIsOpen] = useState(false);
  const isOpenRef = useRef(false);
  const agentIdRef = useRef(agentId);
  agentIdRef.current = agentId;
  const conversationIdRef = useRef(conversationId);
  conversationIdRef.current = conversationId;
  const sessionIdRef = useRef(sessionId);
  sessionIdRef.current = sessionId;

  const noSubject = !sessionId && !agentId && !conversationId;
  const noSubjectRef = useRef(noSubject);
  noSubjectRef.current = noSubject;

  const doFetch = useCallback(() => {
    if (noSubjectRef.current) {
      setLoading(false);
      setError(null);
      setData(null);
      return;
    }
    setLoading(true);
    setError(null);
    fetchAgentContext(agentIdRef.current, conversationIdRef.current, sessionIdRef.current)
      .then((res) => setData(res))
      .catch((err) => {
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => setLoading(false));
  }, []);

  // Clear cached data when the subject changes (agent, conversation OR session)
  // so stale context isn't shown for the new one.
  useEffect(() => {
    setData(null);
    if (isOpenRef.current) {
      doFetch();
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentId, conversationId, sessionId]);

  const open = useCallback(() => {
    setIsOpen(true);
    isOpenRef.current = true;
    doFetch();
  }, [doFetch]);

  const close = useCallback(() => {
    setIsOpen(false);
    isOpenRef.current = false;
  }, []);

  const toggle = useCallback(() => {
    if (isOpenRef.current) {
      close();
    } else {
      open();
    }
  }, [open, close]);

  // Auto-refresh when agent finishes a response (context may have changed).
  // Debounced to 2 seconds to avoid hammering the server during multi-turn tool use.
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEvent('agent:response', (data) => {
    // A SESSION subject has nothing to auto-refresh: what the panel shows is that
    // session's LAUNCH config, fixed for the life of the session. Refetching on
    // every turn burned a request (and a full prompt re-assembly server-side) to
    // repaint identical bytes. Manual Refresh still works.
    if (sessionIdRef.current || noSubjectRef.current) return;
    // A personal-ai-lane turn (source 'session') runs in a claude CLI session — its
    // tokens never touch the in-process context stats, so refetching would just
    // repaint the same (now stale) numbers as if they were fresh.
    if ((data as { source?: string } | undefined)?.source === 'session') return;
    if (isOpenRef.current) {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => {
        doFetch();
        debounceRef.current = null;
      }, 2000);
    }
  });

  // Cleanup debounce timer on unmount
  useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, []);

  return { data, loading, error, isOpen, noSubject, open, close, toggle, refresh: doFetch };
}
