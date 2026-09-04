import { useState, useEffect, useCallback, useMemo } from 'react';
import { useEvent } from './useWebSocket';
import { subscribeProjectMutations, migrateProjectNameList } from './useProjectRegistry';
import * as favApi from '@/api/favorites';

export interface UseFavoritesReturn {
  favoriteProjects: string[];
  favoriteNotes: string[];
  toggleFavoriteProject: (name: string) => Promise<void>;
  toggleFavoriteNote: (path: string) => Promise<void>;
  isProjectFavorite: (name: string) => boolean;
  isNoteFavorite: (path: string) => boolean;
  hasFavorites: boolean;
}

export function useFavorites(): UseFavoritesReturn {
  const [favoriteProjects, setFavoriteProjects] = useState<string[]>([]);
  const [favoriteNotes, setFavoriteNotes] = useState<string[]>([]);

  const fetchAll = useCallback(() => {
    favApi.fetchFavorites()
      .then((data) => {
        setFavoriteProjects(data.projects ?? []);
        setFavoriteNotes(data.notes ?? []);
      })
      .catch(() => {});
  }, []);

  useEffect(() => { fetchAll(); }, [fetchAll]);

  // Re-sync when favorites config changes from other sources
  useEvent('config:changed', (data: unknown) => {
    const { key } = (data ?? {}) as { key?: string };
    if (key && key !== 'favorites') return;
    fetchAll();
  });

  // A rename rewrites `favorites.projects` server-side, but this list is keyed by
  // NAME: the instant a surface shows the new name, isProjectFavorite() would say
  // false and the star would go hollow until the config:changed refetch landed.
  // Follow the registry store's local mutation instead, so the star never blinks.
  useEffect(() => subscribeProjectMutations((m) => {
    if (m.kind === 'resync') { fetchAll(); return; }
    setFavoriteProjects((prev) => (m.kind === 'rename'
      ? migrateProjectNameList(prev, m.from, m.to)
      : migrateProjectNameList(prev, m.name, null)));
  }), [fetchAll]);

  // Project identity is case-INSENSITIVE server-side (task_projects is NOCASE),
  // so every project comparison here folds case — a favorite stored as "HomeLab"
  // must also match a task on "homelab". The server answers with the full
  // post-write list under the registry's CANONICAL spelling; adopt that instead
  // of appending the requested spelling.
  const toggleFavoriteProject = useCallback(async (name: string) => {
    const lower = name.toLowerCase();
    if (favoriteProjects.some((p) => p.toLowerCase() === lower)) {
      const next = await favApi.removeFavoriteProject(name);
      setFavoriteProjects(next);
    } else {
      const next = await favApi.addFavoriteProject(name);
      setFavoriteProjects(next);
    }
  }, [favoriteProjects]);

  const toggleFavoriteNote = useCallback(async (path: string) => {
    if (favoriteNotes.includes(path)) {
      await favApi.removeFavoriteNote(path);
      setFavoriteNotes((prev) => prev.filter((p) => p !== path));
    } else {
      await favApi.addFavoriteNote(path);
      setFavoriteNotes((prev) => [...prev, path]);
    }
  }, [favoriteNotes]);

  const favoriteProjectsLower = useMemo(
    () => new Set(favoriteProjects.map((p) => p.toLowerCase())),
    [favoriteProjects],
  );

  const isProjectFavorite = useCallback(
    (name: string) => favoriteProjectsLower.has(name.toLowerCase()),
    [favoriteProjectsLower],
  );

  const isNoteFavorite = useCallback(
    (path: string) => favoriteNotes.includes(path),
    [favoriteNotes],
  );

  const hasFavorites = favoriteProjects.length > 0 || favoriteNotes.length > 0;

  // Stabilize return value — prevents downstream memo invalidation (e.g. TodoPanel filtered)
  return useMemo(() => ({
    favoriteProjects,
    favoriteNotes,
    toggleFavoriteProject,
    toggleFavoriteNote,
    isProjectFavorite,
    isNoteFavorite,
    hasFavorites,
  }), [favoriteProjects, favoriteNotes, toggleFavoriteProject,
       toggleFavoriteNote, isProjectFavorite, isNoteFavorite, hasFavorites]);
}
