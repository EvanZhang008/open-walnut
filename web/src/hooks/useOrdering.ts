import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useEvent } from './useWebSocket';
import * as orderingApi from '@/api/ordering';
import type { TierSeparator } from '@/components/tasks/tier-separators';

export interface UseOrderingReturn {
  /** Flat project display order (config `ordering.projects`). */
  projectOrder: string[];
  reorderProjects: (order: string[]) => Promise<void>;
  /** Hand-placed divider lines inside the pinned tiers (`ordering.separators`). */
  separators: TierSeparator[];
  /** Whole-list replace, applied locally first (a dropped line must not wait a
   *  round trip to appear where the user let go of it). */
  saveSeparators: (next: TierSeparator[]) => Promise<void>;
}

export function useOrdering(): UseOrderingReturn {
  const [projectOrder, setProjectOrder] = useState<string[]>([]);
  const [separators, setSeparators] = useState<TierSeparator[]>([]);
  // A local write and the config:changed echo of that same write race. Ignore
  // the refetch while our own PUT is in flight, otherwise the optimistic line
  // snaps back to its old slot for one frame.
  const pendingWrites = useRef(0);

  const fetchAll = useCallback(() => {
    orderingApi.fetchOrdering()
      .then((data) => {
        setProjectOrder(data.projects ?? []);
        if (pendingWrites.current === 0) setSeparators(data.separators ?? []);
      })
      .catch(() => {});
  }, []);

  useEffect(() => { fetchAll(); }, [fetchAll]);

  // Re-sync when ordering config changes from other sources
  useEvent('config:changed', (data: unknown) => {
    const { key } = (data ?? {}) as { key?: string };
    if (key && key !== 'ordering') return;
    fetchAll();
  });

  const reorderProjects = useCallback(async (order: string[]) => {
    setProjectOrder(order);
    await orderingApi.saveProjectOrder(order);
  }, []);

  const saveSeparators = useCallback(async (next: TierSeparator[]) => {
    const prev = separators;
    setSeparators(next);
    pendingWrites.current += 1;
    try {
      await orderingApi.saveSeparators(next);
    } catch (err) {
      setSeparators(prev); // roll back — a line that "moved" but didn't persist lies
      throw err;
    } finally {
      pendingWrites.current -= 1;
    }
  }, [separators]);

  return useMemo(
    () => ({ projectOrder, reorderProjects, separators, saveSeparators }),
    [projectOrder, reorderProjects, separators, saveSeparators],
  );
}
