/**
 * The home task panel's two layouts, picked as the Display menu's Group row
 * (2026-10-30, the user: "default can be flat ... you can also in display by project,
 * by project is our normal way"):
 *
 *   status   Flat (the default): the panel is its status sections, each a flat list
 *            of two-line rows (project and tags on a small line, then the title):
 *            Watching and Needs you on top, then Working, Waiting / snoozed and
 *            Completed as folded divider rows.
 *   project  By project: the list as it was, projects at the top level; each project
 *            ends with its own folded Waiting / snoozed and Completed rows.
 *
 * A stored 'shelf' (a third layout once on trial) reads as Flat.
 */
import { useCallback, useEffect, useState } from 'react';

export type PanelDesign = 'status' | 'project';

export const PANEL_DESIGNS: readonly { id: PanelDesign; label: string; title: string }[] = [
  { id: 'status', label: 'Flat', title: 'One list per status (Needs you, Working, Waiting, Completed), each task with its project above the title' },
  { id: 'project', label: 'By project', title: 'Grouped by project; each project folds its own waiting and completed tasks' },
];

/** walnut-todo-* keys sync across devices (ui-prefs-sync.ts). */
export const LS_PANEL_DESIGN_KEY = 'walnut-todo-panel-design';

export function readPanelDesign(raw: string | null): PanelDesign {
  return raw === 'project' ? 'project' : 'status';
}

export function usePanelDesign(): [PanelDesign, (next: PanelDesign) => void] {
  const [design, setDesign] = useState<PanelDesign>(() => {
    try { return readPanelDesign(localStorage.getItem(LS_PANEL_DESIGN_KEY)); } catch { return 'status'; }
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

export function projectFoldKey(region: string, project: string, kind: 'waiting' | 'done'): string {
  return `${region}\u0000${project}\u0000${kind}`;
}
