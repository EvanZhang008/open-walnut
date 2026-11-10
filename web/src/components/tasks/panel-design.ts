/**
 * The home task panel's two layouts, picked as the Display menu's Group row. By project
 * is the default and Flat is experimental (2026-11-06, the user: "when people first use
 * this please only default to the project, the flat (show experimental, not default)"):
 *
 *   project  By project (the default): projects at the top level; each project ends
 *            with its own folded Waiting / snoozed row, and the view's completed tasks
 *            fold once, in one Completed row at its bottom (never per project).
 *   status   Flat (experimental): the panel is its status sections, each a flat list
 *            of two-line rows (project and tags on a small line, then the title):
 *            Watching and Needs you on top, then Working, Waiting / snoozed and
 *            Completed as folded divider rows.
 *
 * Only a stored 'status' (the user's own pick of Flat) reads as Flat: nothing stored, a
 * stored 'shelf' (a third layout once on trial) or anything else reads as By project.
 */
import { useCallback, useEffect, useState } from 'react';
import type { Task } from '@open-walnut/core';
import { isWatched, projectRuns, sortSectionTasks, stateSectionNoNeeds, type StatusSectionKey } from './status-sections';

export type PanelDesign = 'status' | 'project';

export const PANEL_DESIGNS: readonly { id: PanelDesign; label: string; title: string; experimental?: true }[] = [
  { id: 'project', label: 'By project', title: 'Grouped by project; each project folds its own waiting tasks, and completed tasks fold in one row at the bottom' },
  { id: 'status', label: 'Flat', title: 'Experimental: one list per status (Needs you, Working, Waiting, Completed), each task with its project above the title', experimental: true },
];

export const DEFAULT_PANEL_DESIGN: PanelDesign = 'project';

/** walnut-todo-* keys sync across devices (ui-prefs-sync.ts). */
export const LS_PANEL_DESIGN_KEY = 'walnut-todo-panel-design';

export function readPanelDesign(raw: string | null): PanelDesign {
  return raw === 'status' ? 'status' : DEFAULT_PANEL_DESIGN;
}

export function usePanelDesign(): [PanelDesign, (next: PanelDesign) => void] {
  const [design, setDesign] = useState<PanelDesign>(() => {
    try { return readPanelDesign(localStorage.getItem(LS_PANEL_DESIGN_KEY)); } catch { return DEFAULT_PANEL_DESIGN; }
  });
  useEffect(() => {
    const changed = (e: StorageEvent) => {
      if (e.key !== LS_PANEL_DESIGN_KEY && e.key !== null) return;
      try { setDesign(readPanelDesign(localStorage.getItem(LS_PANEL_DESIGN_KEY))); } catch { /* keep */ }
    };
    window.addEventListener('storage', changed);
    return () => window.removeEventListener('storage', changed);
  }, []);
  const set = useCallback((next: PanelDesign) => {
    setDesign(next);
    try { localStorage.setItem(LS_PANEL_DESIGN_KEY, next); } catch { /* the pick still holds for this page */ }
  }, []);
  return [design, set];
}

/** Per-project fold state for the By project design: `${region}\0${project}\0${kind}` keys that are open. */
export const LS_PROJECT_FOLDS_KEY = 'walnut-todo-project-status-folds';

export function projectFoldKey(region: string, project: string, kind: 'waiting'): string {
  return `${region}\u0000${project}\u0000${kind}`;
}

/**
 * The status sections a view folds at its bottom. Completed is always one row there, in
 * both layouts and on every tab: By project folds Waiting inside each project but never
 * Completed (2026-11-05, the user: "show a drop down below to open all completed ... not
 * each project"), so a project with only completed tasks draws no group. Recent has no
 * projects to fold into, so it keeps Waiting here too. Flat folds Not started on its own,
 * between Waiting and Completed (2026-11-09, the user: not started is "completeli differnet"
 * from wait and snooze); By project keeps those tasks in its list, its to-do list.
 */
export function bottomStatusSections(design: PanelDesign, view: string): readonly StatusSectionKey[] {
  if (design === 'status' && view !== 'recent') return ['waiting', 'notstarted', 'done'];
  return design !== 'project' || view === 'recent' ? ['waiting', 'done'] : ['done'];
}

export interface ProjectFoldTasks { waiting: Task[] }

/** A region's waiting tasks by project (watched ones stay under Watching, completed ones under Completed). */
export function foldTasksByProject(
  scope: readonly Task[],
  passes: (t: Task) => boolean,
  snoozed?: (t: Task) => boolean,
): Map<string, ProjectFoldTasks> {
  const out = new Map<string, ProjectFoldTasks>();
  const seen = new Set<string>();
  for (const t of scope) {
    if (seen.has(t.id) || isWatched(t) || !passes(t)) continue;
    seen.add(t.id);
    // Needs you stays in the list in this design: only a parked or snoozed one folds.
    if (stateSectionNoNeeds(t, snoozed) !== 'waiting') continue;
    const key = t.project || '';
    let f = out.get(key);
    if (!f) { f = { waiting: [] }; out.set(key, f); }
    f.waiting.push(t);
  }
  for (const f of out.values()) f.waiting = sortSectionTasks('waiting', f.waiting);
  return out;
}

/** Projects of a region whose only tasks here are waiting: drawn at its end. */
export function leftoverFoldProjects(folds: Map<string, ProjectFoldTasks>, drawn: ReadonlySet<string>): string[] {
  return projectRuns([...folds.values()].flatMap((f) => f.waiting))
    .map((r) => r.project)
    .filter((p) => !drawn.has(p));
}
