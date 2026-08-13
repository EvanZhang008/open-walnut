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
  /** lowercased name → provider source ('local' | 'ms-todo' | 'jira' | …). Drives the one-letter badges. */
  sourceByName: Map<string, string>;
  /** lowercased names of favorited projects (server folds config.favorites.projects in). */
  favoriteByName: Set<string>;
  /**
   * A project's `default_cwd` → its canonical name. Answers "which project is
   * this folder?", which is what lets a folder pick set the project in the same
   * click (the draft column's quick-access chips).
   *
   * PATHS ARE CASE-SENSITIVE (unlike project identity), so this is keyed
   * verbatim — only trailing slashes are normalised away. First writer wins when
   * two projects declare the same folder: the list arrives name-sorted, so the
   * mapping is at least stable rather than render-order dependent.
   */
  projectByCwd: Map<string, string>;
  /**
   * The INVERSE of `projectByCwd`: lowercased project name → the folder it
   * declares (`default_cwd` + `default_host`). Answers "where does this project
   * run?" WITHOUT a fetch, which is what lets a draft column follow an
   * AI-suggested project to its folder while the user is still typing (the
   * detail-fetch path stays for the "+" seed, where one round-trip is fine).
   *
   * Keyed lowercase because project identity is case-insensitive server-side,
   * while the VALUE keeps the path verbatim (paths are case-sensitive).
   */
  projectDefaults: Map<string, { cwd: string; host: string | null }>;
  /** True once the first fetch has resolved — consumers that reconcile against the
   *  registry (e.g. pruning stale session-local names) must wait for this. */
  loaded: boolean;
  /** Re-fetch the registry now (e.g. right after createProject). */
  refresh: () => void;
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
  const [rows, setRows] = useState<Array<{ name: string; source: string; favorite: boolean; defaultCwd?: string; defaultHost?: string }>>([]);
  const [loaded, setLoaded] = useState(false);

  const refresh = useCallback(() => {
    fetchProjects()
      .then((data) => {
        setRows(
          (data.projects ?? [])
            .map((p) => ({
              name: p.name, source: p.source, favorite: p.favorite,
              ...(p.metadata?.default_cwd ? { defaultCwd: p.metadata.default_cwd } : {}),
              ...(p.metadata?.default_host ? { defaultHost: p.metadata.default_host } : {}),
            }))
            .sort((a, b) => a.name.localeCompare(b.name)),
        );
        setLoaded(true);
      })
      .catch(() => { /* non-critical — callers fall back to task-derived names */ });
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  useEvent('project:created', refresh);

  const projectNames = useMemo(() => rows.map((r) => r.name), [rows]);

  const lowerSet = useMemo(
    () => new Set(rows.map((r) => r.name.toLowerCase())),
    [rows],
  );

  const sourceByName = useMemo(
    () => new Map(rows.map((r) => [r.name.toLowerCase(), r.source])),
    [rows],
  );

  const favoriteByName = useMemo(
    () => new Set(rows.filter((r) => r.favorite).map((r) => r.name.toLowerCase())),
    [rows],
  );

  const projectByCwd = useMemo(() => {
    const map = new Map<string, string>();
    for (const r of rows) {
      const cwd = r.defaultCwd?.replace(/\/+$/, '');
      if (cwd && !map.has(cwd)) map.set(cwd, r.name);
    }
    return map;
  }, [rows]);

  const projectDefaults = useMemo(() => {
    const map = new Map<string, { cwd: string; host: string | null }>();
    for (const r of rows) {
      const cwd = r.defaultCwd?.replace(/\/+$/, '');
      if (!cwd) continue;
      map.set(r.name.toLowerCase(), { cwd, host: r.defaultHost ?? null });
    }
    return map;
  }, [rows]);

  const isKnownProject = useCallback(
    (name: string) => lowerSet.has(name.trim().toLowerCase()),
    [lowerSet],
  );

  return useMemo(
    () => ({ projectNames, isKnownProject, sourceByName, favoriteByName, projectByCwd, projectDefaults, loaded, refresh }),
    [projectNames, isKnownProject, sourceByName, favoriteByName, projectByCwd, projectDefaults, loaded, refresh],
  );
}
