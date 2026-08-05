import { useState, useEffect, useCallback, useMemo } from 'react';
import { useEvent } from './useWebSocket';
import * as orderingApi from '@/api/ordering';

export interface UseOrderingReturn {
  /** Flat project display order (config `ordering.projects`). */
  projectOrder: string[];
  reorderProjects: (order: string[]) => Promise<void>;
}

export function useOrdering(): UseOrderingReturn {
  const [projectOrder, setProjectOrder] = useState<string[]>([]);

  const fetchAll = useCallback(() => {
    orderingApi.fetchOrdering()
      .then((data) => { setProjectOrder(data.projects ?? []); })
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

  return useMemo(() => ({ projectOrder, reorderProjects }), [projectOrder, reorderProjects]);
}
