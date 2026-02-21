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

export function useContextInspector(): UseContextInspectorReturn {
  const [data, setData] = useState<ContextInspectorResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isOpen, setIsOpen] = useState(false);
  const isOpenRef = useRef(false);

  const doFetch = useCallback(() => {
    setLoading(true);
    setError(null);
    fetchAgentContext()
      .then((res) => setData(res))
      .catch((err) => {
        // On error during refresh (data already loaded), preserve existing data
        // and surface the error separately instead of blanking the display.
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

  useEvent('agent:response', () => {
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
