/**
 * Toolbar popovers (Filter, Display) keep their left edge on the task panel
 * (F11): right-aligned to their button when they fit, otherwise they grow to the
 * right over the session area, never left over the app's navigation rail.
 */
import type { MenuPlacement } from '@/hooks/useMenuPlacement';

export interface PanelClampInput {
  /** The placement useMenuPlacement computed (right-anchored). */
  placement: MenuPlacement | null;
  menuWidth: number;
  /** The task panel's left edge in viewport px, or null when unknown. */
  panelLeft: number | null;
  viewportWidth: number;
  margin?: number;
}

export function clampToPanelLeft({ placement, menuWidth, panelLeft, viewportWidth, margin = 8 }: PanelClampInput): MenuPlacement | null {
  if (!placement || panelLeft === null || menuWidth <= 0) return placement;
  const left = viewportWidth - placement.right - menuWidth;
  if (left >= panelLeft) return placement;
  // Slide right until the left edge meets the panel, but stay inside the viewport.
  const right = Math.max(margin, viewportWidth - Math.max(panelLeft, margin) - menuWidth);
  return { ...placement, right };
}

/** The panel's left edge for an element inside it. */
export function panelLeftOf(el: HTMLElement | null): number | null {
  const panel = el?.closest('.todo-panel');
  return panel ? panel.getBoundingClientRect().left : null;
}
