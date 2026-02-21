import { useState, useEffect, useCallback } from 'react';
import { useEvent } from './useWebSocket';
import * as orderingApi from '@/api/ordering';

export interface UseOrderingReturn {
  categoryOrder: string[];
  projectOrder: Record<string, string[]>;
  reorderCategories: (order: string[]) => Promise<void>;
  reorderProjects: (category: string, order: string[]) => Promise<void>;
}

export function useOrdering(): UseOrderingReturn {
  const [categoryOrder, setCategoryOrder] = useState<string[]>([]);
  const [projectOrder, setProjectOrder] = useState<Record<string, string[]>>({});

  const fetchAll = useCallback(() => {
    orderingApi.fetchOrdering()
      .then((data) => {
        setCategoryOrder(data.categories);
        setProjectOrder(data.projects);
      })
      .catch(() => {});
  }, []);

  useEffect(() => { fetchAll(); }, [fetchAll]);

  // Re-sync when config changes from other sources
  useEvent('config:changed', () => { fetchAll(); });

  const reorderCategories = useCallback(async (order: string[]) => {
    setCategoryOrder(order);
    await orderingApi.saveCategoryOrder(order);
  }, []);

  const reorderProjects = useCallback(async (category: string, order: string[]) => {
    setProjectOrder((prev) => ({ ...prev, [category]: order }));
    await orderingApi.saveProjectOrder(category, order);
  }, []);

  return { categoryOrder, projectOrder, reorderCategories, reorderProjects };
}
