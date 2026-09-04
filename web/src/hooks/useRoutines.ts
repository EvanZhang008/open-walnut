/**
 * useRoutines — the routine list for both surfaces that show it (the homepage
 * routines panel and /routines).
 *
 * Thin view onto `@/stores/routines-store`: one fetch, one shared list, and
 * optimistic writes with rollback, so the enable/disable switch moves in the same
 * frame instead of waiting for the round-trip plus a `cron:job-*` broadcast.
 */
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { useEvent } from './useWebSocket';
import * as api from '@/api/routines';
import type { Routine, CreateRoutineInput, UpdateRoutineInput, ExecutorInfo, ExecutorOptions } from '@/api/routines';
import {
  createRoutine,
  getRoutinesSnapshot,
  loadRoutines,
  onRoutinesChanged,
  removeRoutine,
  runRoutineNow,
  subscribeRoutines,
  toggleRoutine,
  updateRoutine,
} from '@/stores/routines-store';

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
  const shared = useSyncExternalStore(subscribeRoutines, getRoutinesSnapshot, getRoutinesSnapshot);

  useEffect(() => { void loadRoutines(); }, []);

  // Engine still emits cron:job-* — event names unchanged by design
  useEvent('cron:job-added', () => onRoutinesChanged());
  useEvent('cron:job-updated', () => onRoutinesChanged());
  useEvent('cron:job-removed', () => onRoutinesChanged());
  useEvent('cron:job-started', () => onRoutinesChanged());
  useEvent('cron:job-finished', () => onRoutinesChanged());

  const routines = useMemo(
    () => (includeDisabled ? shared.routines : shared.routines.filter((r) => r.enabled)),
    [shared.routines, includeDisabled],
  );

  const refetch = useCallback(() => { void loadRoutines(true); }, []);

  return {
    routines,
    loading: shared.loading,
    error: shared.error,
    refetch,
    create: createRoutine,
    update: updateRoutine,
    toggle: toggleRoutine,
    remove: removeRoutine,
    runNow: runRoutineNow,
  };
}

interface UseExecutorsReturn {
  executors: ExecutorInfo[];
  options: ExecutorOptions;
  loading: boolean;
}

const EMPTY_OPTIONS: ExecutorOptions = { hosts: [], models: [] };

// The executor catalogue is static for the life of the page and both routine
// surfaces mount at once, so it is fetched once per page load, not once per mount.
let executorsCache: { executors: ExecutorInfo[]; options: ExecutorOptions } | null = null;
let executorsInflight: Promise<void> | null = null;

function loadExecutors(): Promise<void> {
  if (executorsCache) return Promise.resolve();
  if (executorsInflight) return executorsInflight;
  executorsInflight = api.fetchExecutors()
    .then((res) => { executorsCache = { executors: res.executors, options: res.options }; })
    .catch(() => { executorsCache = { executors: [], options: EMPTY_OPTIONS }; })
    .finally(() => { executorsInflight = null; });
  return executorsInflight;
}

export function useExecutors(): UseExecutorsReturn {
  const [, bump] = useState(0);
  const loading = executorsCache === null;

  useEffect(() => {
    if (executorsCache) return;
    let alive = true;
    void loadExecutors().then(() => { if (alive) bump((n) => n + 1); });
    return () => { alive = false; };
  }, []);

  return {
    executors: executorsCache?.executors ?? [],
    options: executorsCache?.options ?? EMPTY_OPTIONS,
    loading,
  };
}
