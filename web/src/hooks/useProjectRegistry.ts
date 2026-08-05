import { useState, useEffect, useCallback, useMemo } from 'react';
import { useEvent } from './useWebSocket';
import { fetchProjects } from '@/api/projects';

export interface UseProjectRegistryReturn {
  /**
   * Canonical project names from the `task_projects` registry, sorted for
   * display. Includes projects with ZERO tasks — the whole point of not deriving
   * this from the loaded task list.
   */
  projectNames: string[];
  /** Case-insensitive membership test (project identity is NOCASE server-side). */
  isKnownProject: (name: string) => boolean;
}

/**
 * The project REGISTRY, as opposed to "the projects the loaded tasks happen to
 * mention". Callers that only need chip labels can keep deriving from tasks, but
 * anything answering "does this project exist?" must use this: an existing but
 * EMPTY project is invisible in the task list, so a task-derived list wrongly
 * reports it as new (the false "new" badge in quick-task capture).
 *
 * Deliberately lightweight — one fetch on mount plus a refetch on
 * `project:created` (the server broadcasts it from ensureProject to 'web-ui').
 * No polling: a stale-by-seconds registry only ever affects a cosmetic badge and
 * a datalist, and the create path is idempotent either way.
 */
export function useProjectRegistry(): UseProjectRegistryReturn {
  const [projectNames, setProjectNames] = useState<string[]>([]);

  const refresh = useCallback(() => {
    fetchProjects()
      .then((data) => {
        setProjectNames(
          (data.projects ?? [])
            .map((p) => p.name)
            .sort((a, b) => a.localeCompare(b)),
        );
      })
      .catch(() => { /* non-critical — callers fall back to task-derived names */ });
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  useEvent('project:created', refresh);

  const lowerSet = useMemo(
    () => new Set(projectNames.map((n) => n.toLowerCase())),
    [projectNames],
  );

  const isKnownProject = useCallback(
    (name: string) => lowerSet.has(name.trim().toLowerCase()),
    [lowerSet],
  );

  return useMemo(() => ({ projectNames, isKnownProject }), [projectNames, isKnownProject]);
}
