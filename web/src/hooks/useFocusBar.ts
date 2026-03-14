import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useEvent } from './useWebSocket';
import * as focusApi from '@/api/focus';
import type { Task } from '@open-walnut/core';

export interface UseFocusBarReturn {
  pinnedIds: string[];
  pinnedTasks: Task[];
  pin: (taskId: string) => Promise<void>;
  unpin: (taskId: string) => Promise<void>;
  reorder: (newIds: string[]) => Promise<void>;
  isPinned: (taskId: string) => boolean;
}

// How long to ignore config:changed events after we caused them (ms)
const SELF_CHANGE_COOLDOWN = 3000;

export function useFocusBar(tasks: Task[]): UseFocusBarReturn {
  const [pinnedIds, setPinnedIds] = useState<string[]>([]);
  // Track when WE last wrote to the focus_bar config, so we can ignore
  // the resulting config:changed event and avoid overwriting optimistic state.
  const lastWriteRef = useRef(0);

  const fetchPinned = useCallback(() => {
    focusApi.fetchPinnedTasks()
      .then((data) => setPinnedIds(data.pinned_tasks))
      .catch(() => {});
  }, []);

  useEffect(() => { fetchPinned(); }, [fetchPinned]);

  // Re-sync only when focus_bar config changes from EXTERNAL sources
  // (another tab, another agent). Skip if we caused the change ourselves.
  useEvent('config:changed', (data: unknown) => {
    const { key } = (data ?? {}) as { key?: string };
    if (key !== 'focus_bar') return;
    if (Date.now() - lastWriteRef.current < SELF_CHANGE_COOLDOWN) return;
    fetchPinned();
  });

  // Auto-unpin completed tasks (status=done or phase=COMPLETE)
  useEvent('task:completed', (data: unknown) => {
    const { id } = data as { id: string };
    if (pinnedIds.includes(id)) {
      lastWriteRef.current = Date.now();
      setPinnedIds((prev) => prev.filter((pid) => pid !== id));
      focusApi.unpinTask(id).catch(() => {});
    }
  });
  useEvent('task:updated', (data: unknown) => {
    const { task } = data as { task: { id: string; phase?: string; status?: string } };
    if ((task.phase === 'COMPLETE' || task.status === 'done') && pinnedIds.includes(task.id)) {
      lastWriteRef.current = Date.now();
      setPinnedIds((prev) => prev.filter((pid) => pid !== task.id));
      focusApi.unpinTask(task.id).catch(() => {});
    }
  });

  const pin = useCallback(async (taskId: string) => {
    lastWriteRef.current = Date.now();
    setPinnedIds((prev) => prev.includes(taskId) ? prev : [...prev, taskId]);
    try {
      await focusApi.pinTask(taskId);
    } catch {
      setPinnedIds((prev) => prev.filter((id) => id !== taskId));
    }
  }, []);

  const unpin = useCallback(async (taskId: string) => {
    lastWriteRef.current = Date.now();
    setPinnedIds((prev) => prev.filter((id) => id !== taskId));
    try {
      await focusApi.unpinTask(taskId);
    } catch {
      setPinnedIds((prev) => prev.includes(taskId) ? prev : [...prev, taskId]);
    }
  }, []);

  const reorder = useCallback(async (newIds: string[]) => {
    lastWriteRef.current = Date.now();
    setPinnedIds(newIds);
    try {
      await focusApi.reorderPinnedTasks(newIds);
    } catch {
      fetchPinned();
    }
  }, [fetchPinned]);

  const isPinned = useCallback(
    (taskId: string) => pinnedIds.includes(taskId),
    [pinnedIds],
  );

  // Resolve pinned IDs to Task objects (preserving pin order).
  // Completed tasks are filtered out of the display list; event handlers
  // (task:completed, task:updated) handle server-side cleanup.
  const pinnedTasks = useMemo(() => {
    const taskMap = new Map(tasks.map((t) => [t.id, t]));
    return pinnedIds
      .map((id) => taskMap.get(id))
      .filter((t): t is Task => !!t && t.phase !== 'COMPLETE' && t.status !== 'done');
  }, [pinnedIds, tasks]);

  return { pinnedIds, pinnedTasks, pin, unpin, reorder, isPinned };
}
