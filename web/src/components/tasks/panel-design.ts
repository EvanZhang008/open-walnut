/**
 * The home task panel's layout designs, for the user to try on real data before one
 * ships (2026-10-29, the user: "give me a few designs first, let me try how we should
 * organize these tasks"). All three keep the shared parts: Watching on top, status
 * counts on each project heading, waiting and completed tasks folded out of sight.
 * They differ in how the rest is organized:
 *
 *   status   By status: the panel is five status sections (Watching, Needs you,
 *            Working, Waiting / snoozed, Completed), each grouped by project.
 *   project  By project: projects stay the top level; each project ends with its
 *            own folded Waiting / snoozed and Completed rows.
 *   shelf    List + shelf: the list as it was (a red row needs you, in place), with
 *            Waiting / snoozed and Completed folded on one shelf at the bottom.
 */
import { useCallback, useEffect, useState } from 'react';

export type PanelDesign = 'status' | 'project' | 'shelf';

export const PANEL_DESIGNS: readonly { id: PanelDesign; label: string; title: string }[] = [
  { id: 'status', label: 'By status', title: 'Five status sections across the panel, projects inside each' },
  { id: 'project', label: 'By project', title: 'Projects on top; each project folds its own waiting and completed tasks' },
  { id: 'shelf', label: 'List + shelf', title: 'The list as before; waiting and completed tasks fold on one shelf at the bottom' },
];

/** walnut-todo-* keys sync across devices (ui-prefs-sync.ts). */
export const LS_PANEL_DESIGN_KEY = 'walnut-todo-panel-design';

export function readPanelDesign(raw: string | null): PanelDesign {
  return raw === 'project' || raw === 'shelf' ? raw : 'status';
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
