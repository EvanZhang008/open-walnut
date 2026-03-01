import { useState, useEffect, useCallback, useMemo } from 'react';
import { useEvent } from './useWebSocket';
import * as focusApi from '@/api/focus';
import type { Task } from '@walnut/core';

export interface UseFocusBarReturn {
  pinnedIds: string[];
  pinnedTasks: Task[];
  pin: (taskId: string) => Promise<void>;
  unpin: (taskId: string) => Promise<void>;
  isPinned: (taskId: string) => boolean;
  isFull: boolean;
}

export function useFocusBar(tasks: Task[]): UseFocusBarReturn {
  const [pinnedIds, setPinnedIds] = useState<string[]>([]);

  const fetchPinned = useCallback(() => {
    focusApi.fetchPinnedTasks()
      .then((data) => setPinnedIds(data.pinned_tasks))
      .catch(() => {});
  }, []);

  useEffect(() => { fetchPinned(); }, [fetchPinned]);

  // Re-sync when config changes (from other tabs/agents)
  useEvent('config:changed', () => { fetchPinned(); });

  // Auto-unpin completed tasks
  useEvent('task:completed', (data: unknown) => {
    const { id } = data as { id: string };
    if (pinnedIds.includes(id)) {
      focusApi.unpinTask(id).catch(() => {});
      setPinnedIds((prev) => prev.filter((pid) => pid !== id));
    }
  });

  const pin = useCallback(async (taskId: string) => {
    const data = await focusApi.pinTask(taskId);
    if (data?.pinned_tasks) setPinnedIds(data.pinned_tasks);
    else setPinnedIds((prev) => prev.includes(taskId) ? prev : [...prev, taskId]);
  }, []);

  const unpin = useCallback(async (taskId: string) => {
    await focusApi.unpinTask(taskId);
    setPinnedIds((prev) => prev.filter((id) => id !== taskId));
  }, []);

  const isPinned = useCallback(
    (taskId: string) => pinnedIds.includes(taskId),
    [pinnedIds],
  );

  // Resolve pinned IDs to Task objects (preserving pin order)
  const pinnedTasks = useMemo(() => {
    const taskMap = new Map(tasks.map((t) => [t.id, t]));
    return pinnedIds.map((id) => taskMap.get(id)).filter(Boolean) as Task[];
  }, [pinnedIds, tasks]);

  const isFull = pinnedIds.length >= 3;

  return { pinnedIds, pinnedTasks, pin, unpin, isPinned, isFull };
}
