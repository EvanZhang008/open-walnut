import { useState, useEffect, useCallback } from 'react';
import { useEvent } from './useWebSocket';
import * as cronApi from '@/api/cron';
import type { CronJob, CreateCronJobInput, UpdateCronJobInput } from '@/api/cron';

interface UseCronJobsReturn {
  jobs: CronJob[];
  loading: boolean;
  error: string | null;
  refetch: () => void;
  create: (input: CreateCronJobInput) => Promise<CronJob>;
  update: (id: string, input: UpdateCronJobInput) => Promise<CronJob>;
  toggle: (id: string) => Promise<CronJob>;
  remove: (id: string) => Promise<void>;
  runNow: (id: string) => Promise<unknown>;
}

export function useCronJobs(includeDisabled = true): UseCronJobsReturn {
  const [jobs, setJobs] = useState<CronJob[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refetch = useCallback(() => {
    setLoading(true);
    setError(null);
    cronApi.fetchCronJobs(includeDisabled)
      .then(setJobs)
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false));
  }, [includeDisabled]);

  useEffect(() => { refetch(); }, [refetch]);

  // Real-time WS event handlers
  useEvent('cron:job-added', () => refetch());
  useEvent('cron:job-updated', () => refetch());
  useEvent('cron:job-removed', () => refetch());
  useEvent('cron:job-started', () => refetch());
  useEvent('cron:job-finished', () => refetch());

  const create = useCallback(async (input: CreateCronJobInput) => {
    return await cronApi.createCronJob(input);
  }, []);

  const update = useCallback(async (id: string, input: UpdateCronJobInput) => {
    return await cronApi.updateCronJob(id, input);
  }, []);

  const toggle = useCallback(async (id: string) => {
    return await cronApi.toggleCronJob(id);
  }, []);

  const remove = useCallback(async (id: string) => {
    await cronApi.deleteCronJob(id);
  }, []);

  const runNow = useCallback(async (id: string) => {
    return await cronApi.runCronJob(id);
  }, []);

  return { jobs, loading, error, refetch, create, update, toggle, remove, runNow };
}
