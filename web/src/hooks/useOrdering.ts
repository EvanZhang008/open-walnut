import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useEvent } from './useWebSocket';
import { subscribeProjectMutations, migrateProjectNameList } from './useProjectRegistry';
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
  // snaps back to its old slot for one frame. One counter per list: a separator
  // write must not freeze a project-order refetch, or the other way round.
  const pendingWrites = useRef(0);
  const pendingProjectWrites = useRef(0);

  const fetchAll = useCallback(() => {
    orderingApi.fetchOrdering()
      .then((data) => {
        if (pendingProjectWrites.current === 0) setProjectOrder(data.projects ?? []);
        if (pendingWrites.current === 0) setSeparators(data.separators ?? []);
      })
      .catch(() => {});
  }, []);

  useEffect(() => { fetchAll(); }, [fetchAll]);

  // A project rename/delete rewrites `ordering.projects` SERVER-side, and the
  // server is right long before its config:changed lands. Follow the shared
  // registry store's local mutation so the group keeps its hand-placed slot in the
  // same frame instead of jumping to the alphabetical tail and back.
  useEffect(() => subscribeProjectMutations((m) => {
    if (m.kind === 'resync') { fetchAll(); return; }
    setProjectOrder((prev) => (m.kind === 'rename'
      ? migrateProjectNameList(prev, m.from, m.to)
      : migrateProjectNameList(prev, m.name, null)));
  }), [fetchAll]);

  // Re-sync when ordering config changes from other sources
  useEvent('config:changed', (data: unknown) => {
    const { key } = (data ?? {}) as { key?: string };
    if (key && key !== 'ordering') return;
    fetchAll();
  });

  // Same contract as saveSeparators: applied locally first (a dropped group must
  // not wait a round trip to appear where the user let go of it), rolled back if
  // the PUT fails, and the refetch of our own echo suppressed while it is in
  // flight. Without the rollback a failed write left the UI showing an order the
  // server never accepted, which the next reload silently undid.
  const reorderProjects = useCallback(async (order: string[]) => {
    const prev = projectOrder;
    setProjectOrder(order);
    pendingProjectWrites.current += 1;
    try {
      await orderingApi.saveProjectOrder(order);
    } catch (err) {
      setProjectOrder(prev);
      throw err;
    } finally {
      pendingProjectWrites.current -= 1;
    }
  }, [projectOrder]);

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
