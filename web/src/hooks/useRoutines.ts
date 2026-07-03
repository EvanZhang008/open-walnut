import { useState, useEffect, useCallback } from 'react';
import { useEvent } from './useWebSocket';
import * as api from '@/api/routines';
import type { Routine, CreateRoutineInput, UpdateRoutineInput, ExecutorInfo, ExecutorOptions } from '@/api/routines';

interface UseRoutinesReturn {
  routines: Routine[];
  loading: boolean;
  error: string | null;
  refetch: () => void;
  create: (input: CreateRoutineInput) => Promise<Routine>;
  update: (id: string, input: UpdateRoutineInput) => Promise<Routine>;
  toggle: (id: string) => Promise<Routine>;
  remove: (id: string) => Promise<void>;
  runNow: (id: string) => Promise<unknown>;
}

export function useRoutines(includeDisabled = true): UseRoutinesReturn {
  const [routines, setRoutines] = useState<Routine[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refetch = useCallback(() => {
    setError(null);
    api.fetchRoutines(includeDisabled)
      .then(setRoutines)
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false));
  }, [includeDisabled]);

  useEffect(() => { refetch(); }, [refetch]);

  // Engine still emits cron:job-* — event names unchanged by design
  useEvent('cron:job-added', () => refetch());
  useEvent('cron:job-updated', () => refetch());
  useEvent('cron:job-removed', () => refetch());
  useEvent('cron:job-started', () => refetch());
  useEvent('cron:job-finished', () => refetch());

  const create = useCallback(async (input: CreateRoutineInput) => api.createRoutine(input), []);
  const update = useCallback(async (id: string, input: UpdateRoutineInput) => api.updateRoutine(id, input), []);
  const toggle = useCallback(async (id: string) => api.toggleRoutine(id), []);
  const remove = useCallback(async (id: string) => { await api.deleteRoutine(id); }, []);
  const runNow = useCallback(async (id: string) => api.runRoutine(id), []);

  return { routines, loading, error, refetch, create, update, toggle, remove, runNow };
}

interface UseExecutorsReturn {
  executors: ExecutorInfo[];
  options: ExecutorOptions;
  loading: boolean;
}

const EMPTY_OPTIONS: ExecutorOptions = { hosts: [], models: [] };

export function useExecutors(): UseExecutorsReturn {
  const [executors, setExecutors] = useState<ExecutorInfo[]>([]);
  const [options, setOptions] = useState<ExecutorOptions>(EMPTY_OPTIONS);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.fetchExecutors()
      .then((res) => { setExecutors(res.executors); setOptions(res.options); })
      .catch(() => { /* form falls back to free-text fields */ })
      .finally(() => setLoading(false));
  }, []);

  return { executors, options, loading };
}
