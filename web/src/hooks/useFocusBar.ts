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
}

export function useFocusBar(tasks: Task[]): UseFocusBarReturn {
  const [pinnedIds, setPinnedIds] = useState<string[]>([]);

  const fetchPinned = useCallback(() => {
    focusApi.fetchPinnedTasks()
      .then((data) => setPinnedIds(data.pinned_tasks))
      .catch(() => {});
  }, []);

  useEffect(() => { fetchPinned(); }, [fetchPinned]);

  // Re-sync only when focus_bar config changes (not every config change —
  // avoids ghost pins from concurrent saveConfig callers overwriting focus_bar)
  useEvent('config:changed', (data: unknown) => {
    const { key } = (data ?? {}) as { key?: string };
    if (key === 'focus_bar') fetchPinned();
  });

  // Auto-unpin completed tasks
  useEvent('task:completed', (data: unknown) => {
    const { id } = data as { id: string };
    if (pinnedIds.includes(id)) {
      focusApi.unpinTask(id).catch(() => {});
      setPinnedIds((prev) => prev.filter((pid) => pid !== id));
    }
  });

  const pin = useCallback(async (taskId: string) => {
    // Optimistic: show in UI immediately
    setPinnedIds((prev) => prev.includes(taskId) ? prev : [...prev, taskId]);
    try {
      const data = await focusApi.pinTask(taskId);
      if (data?.pinned_tasks) setPinnedIds(data.pinned_tasks);
    } catch {
      // Revert on failure
      setPinnedIds((prev) => prev.filter((id) => id !== taskId));
    }
  }, []);

  const unpin = useCallback(async (taskId: string) => {
    // Optimistic: remove from UI immediately
    setPinnedIds((prev) => prev.filter((id) => id !== taskId));
    try {
      await focusApi.unpinTask(taskId);
    } catch {
      // Revert on failure
      setPinnedIds((prev) => prev.includes(taskId) ? prev : [...prev, taskId]);
    }
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

  return { pinnedIds, pinnedTasks, pin, unpin, isPinned };
}
