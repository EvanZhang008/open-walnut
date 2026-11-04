/**
 * When a scroll takes down a menu opened at the cursor (a right-click on a row).
 *
 * A cursor anchor is a frozen viewport point, so the menu has to go once the row it was opened
 * on moves away from under it. But the menus heard every scroll on the page (a capture listener on
 * `window`) and closed on the first one, and two kinds of scroll move no row at all:
 *   - a pane that does not hold the row (a list restoring its offset, a timeline following its
 *     tail): the 2026-09-22 "right-click disappears" report, fixed for ContextMenu.tsx only;
 *   - the scroll that brought the row into view right before the click: its `scroll` event is
 *     dispatched on the next frame, after the menu opened (a trackpad's momentum, a page's own
 *     scroll-into-view, and Playwright's click on a row below the fold: 2026-11-04, the Tasks
 *     page's project menu opened and closed 10 ms later in org-main-and-chart.spec.ts).
 * So the menu records where the row sat when it opened, and closes only on a scroll of a pane that
 * holds the row and only once the row is somewhere else.
 */

/** The right-clicked row and where it sat when its menu opened. */
export interface RowAnchor {
  el: HTMLElement;
  top: number;
  left: number;
}

export function rowAnchorOf(el: HTMLElement | null | undefined): RowAnchor | null {
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { el, top: r.top, left: r.left };
}

/** True when this scroll moved the row away from under its menu (no row known: any scroll does). */
export function scrollMovedRow(anchor: RowAnchor | null, scrolled: EventTarget | null): boolean {
  if (!anchor || !anchor.el.isConnected) return true;
  // A scrolled element or the document; a pane that does not hold the row cannot move it.
  const pane = scrolled as { contains?: (node: Node) => boolean } | null;
  if (pane && typeof pane.contains === 'function' && !pane.contains(anchor.el)) return false;
  const r = anchor.el.getBoundingClientRect();
  return Math.abs(r.top - anchor.top) > 1 || Math.abs(r.left - anchor.left) > 1;
}
