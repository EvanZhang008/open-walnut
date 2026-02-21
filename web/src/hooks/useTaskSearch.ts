/**
 * useTaskSearch — debounced search hook for the TODO panel.
 * Any non-empty query triggers debounced server-side hybrid search.
 */

import { useState, useRef, useCallback, useEffect } from 'react';
import { apiGet } from '@/api/client';

export interface TaskSearchResult {
  taskId: string;
  score: number;
  matchField: string;
  keywordScore?: number;  // normalized BM25 [0,1], undefined if no keyword match
  semanticScore?: number; // normalized cosine [0,1], undefined if no vector match
}

interface ServerSearchItem {
  type: 'task' | 'memory';
  title: string;
  snippet: string;
  path?: string;
  taskId?: string;
  score: number;
  matchField: string;
  keywordScore?: number;
  semanticScore?: number;
}

export interface UseTaskSearchReturn {
  query: string;
  setQuery: (q: string) => void;
  results: TaskSearchResult[] | null; // null = no active search
  isSearching: boolean;
  clearSearch: () => void;
}

const DEBOUNCE_MS = 300;

export function useTaskSearch(): UseTaskSearchReturn {
  const [query, setQueryState] = useState('');
  const [results, setResults] = useState<TaskSearchResult[] | null>(null);
  const [isSearching, setIsSearching] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearSearch = useCallback(() => {
    setQueryState('');
    setResults(null);
    setIsSearching(false);
    if (abortRef.current) {
      abortRef.current.abort();
      abortRef.current = null;
    }
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
      debounceRef.current = null;
    }
  }, []);

  const setQuery = useCallback((q: string) => {
    setQueryState(q);

    if (!q.trim()) {
      setResults(null);
      setIsSearching(false);
      return;
    }

    // Debounced server-side search
    if (debounceRef.current) clearTimeout(debounceRef.current);
    setIsSearching(true);

    debounceRef.current = setTimeout(async () => {
      if (abortRef.current) abortRef.current.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      try {
        const params: Record<string, string> = {
          q: q.trim(),
          types: 'task',
          mode: 'hybrid',
          limit: '100',
        };
        const res = await apiGet<{ results: ServerSearchItem[] }>('/api/search', params);

        if (controller.signal.aborted) return;

        const taskResults: TaskSearchResult[] = res.results
          .filter((r) => r.type === 'task' && r.taskId)
          .map((r) => ({
            taskId: r.taskId!,
            score: r.score,
            matchField: r.matchField,
            keywordScore: r.keywordScore,
            semanticScore: r.semanticScore,
          }));

        setResults(taskResults);
      } catch (err) {
        if (err instanceof DOMException && err.name === 'AbortError') return;
        // On error, clear results (graceful degradation)
        setResults(null);
      } finally {
        if (!controller.signal.aborted) {
          setIsSearching(false);
        }
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
