import { useState, useEffect, useCallback } from 'react';
import { useEvent } from './useWebSocket';
import * as favApi from '@/api/favorites';

export interface UseFavoritesReturn {
  favoriteCategories: string[];
  favoriteProjects: string[];
  toggleFavoriteCategory: (name: string) => Promise<void>;
  toggleFavoriteProject: (name: string) => Promise<void>;
  isCategoryFavorite: (name: string) => boolean;
  isProjectFavorite: (name: string) => boolean;
  hasFavorites: boolean;
}

export function useFavorites(): UseFavoritesReturn {
  const [favoriteCategories, setFavoriteCategories] = useState<string[]>([]);
  const [favoriteProjects, setFavoriteProjects] = useState<string[]>([]);

  const fetchAll = useCallback(() => {
    favApi.fetchFavorites()
      .then((data) => {
        setFavoriteCategories(data.categories);
        setFavoriteProjects(data.projects);
      })
      .catch(() => {});
  }, []);

  useEffect(() => { fetchAll(); }, [fetchAll]);

  // Re-sync when config changes from other sources
  useEvent('config:changed', () => { fetchAll(); });

  const toggleFavoriteCategory = useCallback(async (name: string) => {
    if (favoriteCategories.includes(name)) {
      await favApi.removeFavoriteCategory(name);
      setFavoriteCategories((prev) => prev.filter((c) => c !== name));
    } else {
      await favApi.addFavoriteCategory(name);
      setFavoriteCategories((prev) => [...prev, name]);
    }
  }, [favoriteCategories]);

  const toggleFavoriteProject = useCallback(async (name: string) => {
    if (favoriteProjects.includes(name)) {
      await favApi.removeFavoriteProject(name);
      setFavoriteProjects((prev) => prev.filter((p) => p !== name));
    } else {
      await favApi.addFavoriteProject(name);
      setFavoriteProjects((prev) => [...prev, name]);
    }
  }, [favoriteProjects]);

  const isCategoryFavorite = useCallback(
    (name: string) => favoriteCategories.includes(name),
    [favoriteCategories],
  );

  const isProjectFavorite = useCallback(
    (name: string) => favoriteProjects.includes(name),
    [favoriteProjects],
  );

  const hasFavorites = favoriteCategories.length > 0 || favoriteProjects.length > 0;

  return {
    favoriteCategories,
    favoriteProjects,
    toggleFavoriteCategory,
    toggleFavoriteProject,
    isCategoryFavorite,
    isProjectFavorite,
    hasFavorites,
  };
}
