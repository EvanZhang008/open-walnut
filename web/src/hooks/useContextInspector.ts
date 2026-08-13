import { useState, useCallback, useRef, useEffect } from 'react';
import { useEvent } from './useWebSocket';
import { fetchAgentContext, type ContextInspectorResponse } from '@/api/context';

export interface UseContextInspectorReturn {
  data: ContextInspectorResponse | null;
  loading: boolean;
  error: string | null;
  isOpen: boolean;
  open: () => void;
  close: () => void;
  toggle: () => void;
  refresh: () => void;
}

export function useContextInspector(agentId?: string, conversationId?: string): UseContextInspectorReturn {
  const [data, setData] = useState<ContextInspectorResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isOpen, setIsOpen] = useState(false);
  const isOpenRef = useRef(false);
  const agentIdRef = useRef(agentId);
  agentIdRef.current = agentId;
  const conversationIdRef = useRef(conversationId);
  conversationIdRef.current = conversationId;

  // Clear cached data when agent OR conversation changes so stale context isn't shown
  useEffect(() => {
    setData(null);
    if (isOpenRef.current) {
      doFetch();
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentId, conversationId]);

  const doFetch = useCallback(() => {
    setLoading(true);
    setError(null);
    fetchAgentContext(agentIdRef.current, conversationIdRef.current)
      .then((res) => setData(res))
      .catch((err) => {
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => setLoading(false));
  }, []);

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
    // A butler-lane turn (source 'session') runs in a claude CLI session — its
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

  return { data, loading, error, isOpen, open, close, toggle, refresh: doFetch };
}
