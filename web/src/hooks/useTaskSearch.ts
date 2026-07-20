/**
 * useTaskSearch — debounced search hook for the TODO panel.
 * Any non-empty query triggers debounced server-side QMD search.
 */

import { useState, useRef, useCallback, useEffect } from 'react';
import { apiGet } from '@/api/client';

export interface TaskSearchResult {
  taskId: string;
}

interface ServerSearchItem {
  type: 'task' | 'memory';
  taskId?: string;
}

export interface UseTaskSearchReturn {
  query: string;
  setQuery: (q: string) => void;
  results: TaskSearchResult[] | null; // null = no active search
  isSearching: boolean;
  clearSearch: () => void;
}

// Update query/generation immediately on every keystroke, but wait before the
// HTTP request. Debouncing in the input component left a 500ms window where an
// older response could be accepted under newly typed text.
const DEBOUNCE_MS = 500;

export function useTaskSearch(): UseTaskSearchReturn {
  const [query, setQueryState] = useState('');
  const [results, setResults] = useState<TaskSearchResult[] | null>(null);
  const [isSearching, setIsSearching] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const requestGenerationRef = useRef(0);

  const clearSearch = useCallback(() => {
    requestGenerationRef.current++;
    setQueryState('');
    setResults(null);
    setIsSearching(false);
    if (abortRef.current) {
      // QMD does not expose inference cancellation, so this only stops the
      // browser from waiting. The generation check below is the correctness
      // guard when an older server computation still finishes later.
      abortRef.current.abort();
      abortRef.current = null;
    }
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
      debounceRef.current = null;
    }
  }, []);

  const setQuery = useCallback((q: string) => {
    const generation = ++requestGenerationRef.current;
    setQueryState(q);

    if (abortRef.current) {
      // QMD does not expose inference cancellation, so this only stops the
      // browser from waiting. The generation check below is the correctness
      // guard when an older server computation still finishes later.
      abortRef.current.abort();
      abortRef.current = null;
    }
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
      debounceRef.current = null;
    }

    if (!q.trim()) {
      setResults(null);
      setIsSearching(false);
      return;
    }

    // Clear stale QMD results immediately so the UI falls back to client-side
    // substring/reference matches in TodoPanel while the
    // debounced QMD request is in flight. Without this, the old query's results
    // linger and the list looks stale.
    setResults(null);

    // Debounced server-side QMD search — fires in background, merges in when ready.
    setIsSearching(true);

    debounceRef.current = setTimeout(async () => {
      debounceRef.current = null;
      const controller = new AbortController();
      abortRef.current = controller;

      try {
        const params: Record<string, string> = {
          q: q.trim(),
          types: 'task',
          // QMD 2.1 caps its fused candidate pool at 40.
          limit: '40',
        };
        const res = await apiGet<{ results: ServerSearchItem[] }>(
          '/api/search',
          params,
          { signal: controller.signal, timeoutMs: 30_000 },
        );

        if (
          controller.signal.aborted
          || generation !== requestGenerationRef.current
        ) return;

        const taskResults: TaskSearchResult[] = res.results
          .filter((r) => r.type === 'task' && r.taskId)
          .map((r) => ({
            taskId: r.taskId!,
          }));

        setResults(taskResults);
      } catch (err) {
        if (
          controller.signal.aborted
          || generation !== requestGenerationRef.current
          || (err instanceof DOMException && err.name === 'AbortError')
        ) return;
        // On error, clear results (graceful degradation)
        setResults(null);
      } finally {
        if (
          generation === requestGenerationRef.current
          && !controller.signal.aborted
        ) {
          setIsSearching(false);
        }
        if (abortRef.current === controller) abortRef.current = null;
      }
    }, DEBOUNCE_MS);
  }, []);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (abortRef.current) abortRef.current.abort();
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, []);

  return { query, setQuery, results, isSearching, clearSearch };
}
