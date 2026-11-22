/**
 * The Agenda and the Scratchpad beside any page, not only Home (2026-11-06, the user, of the
 * rail's Agenda and Scratchpad: "extract it to global, any page can show this side bar, I find I
 * sometimes need it for the org page").
 *
 * Home keeps its own place (HomeCompanionPanel, right of the task panel, under Home's own flags).
 * Every other page gets the same two panes on its left edge, beside the rail that opens them,
 * without leaving the page. What is open there is kept PER PAGE through view memory
 * (utils/view-memory.ts): the Agenda open on Org stays closed on Notes, and both come back as
 * left after another page, a reload or a restart.
 *
 * The two panes are two side bars side by side, the Scratchpad right of the Agenda, never one
 * column stacked (2026-11-16, the user: "side bar should be independent, new one on the right,
 * instead of top and bottom"). Each has its own width, dragged on its own right edge and kept
 * per page, Home's under the id `home` (its panes' flags stay Home's own).
 */
import { useCallback } from 'react';
import { shownText, storedView, usePageViewOf, viewKey, writeView } from '@/utils/view-memory';

export interface PageSideBarView {
  agenda: boolean;
  scratchpad: boolean;
  /** The Agenda's width in px; absent until the user drags it. Before the panes were two side
   *  bars it was the one column's width, so a Scratchpad with no width of its own starts here. */
  width?: number;
  /** The Scratchpad's width in px; absent until the user drags it. */
  scratchpadWidth?: number;
}

export type SideBarPane = 'agenda' | 'scratchpad';

export const SIDE_BAR_CLOSED: PageSideBarView = { agenda: false, scratchpad: false };
export const SIDE_BAR_WIDTH_DEFAULT = 400;
export const SIDE_BAR_WIDTH_MIN = 280;
export const SIDE_BAR_WIDTH_MAX = 720;
/** A side bar alone never takes more than this share of the window, so the page keeps room. */
export const SIDE_BAR_WINDOW_SHARE = 0.5;
/** Each of the two side by side never takes more than this share. */
export const SIDE_BAR_PAIR_SHARE = 0.3;

/** Sent after the side bar opens, closes or changes width, so the full screen area follows it. */
export const SIDE_BAR_LAYOUT_EVENT = 'page-side-bar:layout';

/**
 * Where a full screen sheet's area starts (--fullscreen-left): the shell's page column (`main`,
 * 0 on a phone, whatever its safe-area padding), or the side bar's right edge while it shows, beside
 * the page.
 */
export function pageAreaLeft(main: Element): number {
  let left = main.getBoundingClientRect().left;
  const bar = document.querySelector('[data-testid="page-side-bar"]');
  if (bar && bar.getClientRects().length > 0) left = Math.max(left, bar.getBoundingClientRect().right);
  return Math.max(0, Math.round(left));
}

/**
 * The page a side bar view belongs to, or null on Home (which has its own column). One page per
 * route section: `/notes/a/b` is `notes`, a plugin app `/apps/<id>/...` is `app:<id>`.
 */
export function sideBarPageOf(pathname: string): string | null {
  const parts = pathname.split('/').filter(Boolean);
  if (parts.length === 0) return null;
  const [first, second] = parts;
  if (first === 'apps' && second) {
    let id = second;
    try { id = decodeURIComponent(second); } catch { /* keep it as written */ }
    return `app:${id}`;
  }
  return first;
}

export function isPageSideBarView(v: unknown): v is PageSideBarView {
  if (!v || typeof v !== 'object') return false;
  const r = v as Record<string, unknown>;
  const px = (v: unknown) => v === undefined || (typeof v === 'number' && Number.isFinite(v));
  return typeof r.agenda === 'boolean' && typeof r.scratchpad === 'boolean' && px(r.width) && px(r.scratchpadWidth);
}

/** The width that shows in a window `windowWidth` px wide; `paired` while both side bars show. */
export function sideBarWidth(stored: number | undefined, windowWidth: number, paired = false): number {
  const share = paired ? SIDE_BAR_PAIR_SHARE : SIDE_BAR_WINDOW_SHARE;
  const max = Math.max(SIDE_BAR_WIDTH_MIN, Math.min(SIDE_BAR_WIDTH_MAX, Math.floor(windowWidth * share)));
  return Math.round(Math.min(max, Math.max(SIDE_BAR_WIDTH_MIN, stored ?? SIDE_BAR_WIDTH_DEFAULT)));
}

/** The width kept for one pane (the Scratchpad falls back to the old one-column width). */
export function storedPaneWidth(view: PageSideBarView, pane: SideBarPane): number | undefined {
  return pane === 'agenda' ? view.width : view.scratchpadWidth ?? view.width;
}

const VIEW_KEY = viewKey('side-bar', 'view');

/**
 * Open or shut one pane of `page`'s side bar, read and written by page id (the rail passes the page
 * the window's URL names, which can run ahead of the route React has drawn).
 */
export function toggleSideBarPane(page: string, pane: 'agenda' | 'scratchpad'): void {
  const prev = storedView(shownText(VIEW_KEY), page, isPageSideBarView) ?? SIDE_BAR_CLOSED;
  writeView(VIEW_KEY, page, { ...prev, [pane]: !prev[pane] });
}

/** Open (or shut) one pane of `page`'s side bar. */
export function setSideBarPane(page: string, pane: 'agenda' | 'scratchpad', open: boolean): void {
  const prev = storedView(shownText(VIEW_KEY), page, isPageSideBarView) ?? SIDE_BAR_CLOSED;
  if (prev[pane] !== open) writeView(VIEW_KEY, page, { ...prev, [pane]: open });
}

/**
 * `view` with one pane's width set (the same object when nothing changes). A scratchpad that still
 * reads the old one-column width keeps it when the agenda is dragged: that drag is the agenda's own.
 */
export function withPaneWidth(view: PageSideBarView, pane: SideBarPane, width: number): PageSideBarView {
  if (pane === 'scratchpad') return view.scratchpadWidth === width ? view : { ...view, scratchpadWidth: width };
  if (view.width === width) return view;
  return view.scratchpadWidth === undefined && view.width !== undefined
    ? { ...view, width, scratchpadWidth: view.width }
    : { ...view, width };
}

/** The view id of a page's side bars: Home's widths are kept under `home`. */
export const HOME_SIDE_BAR_ID = 'home';

/**
 * The side bars of `page` (null on Home), with a setter per pane and one per pane's width. Home's
 * panes are opened by Home's own flags, so on Home only the widths are written.
 */
export function usePageSideBar(page: string | null) {
  const [view, setView] = usePageViewOf<PageSideBarView>('side-bar', 'view', page ?? HOME_SIDE_BAR_ID, SIDE_BAR_CLOSED, isPageSideBarView);
  const setPane = useCallback((pane: SideBarPane, open: boolean | ((prev: boolean) => boolean)) => {
    if (page === null) return;
    setView((prev) => {
      const next = typeof open === 'function' ? open(prev[pane]) : open;
      return next === prev[pane] ? prev : { ...prev, [pane]: next };
    });
  }, [page, setView]);
  const setWidth = useCallback((pane: SideBarPane, width: number) => {
    setView((prev) => withPaneWidth(prev, pane, width));
  }, [setView]);
  return { view, setPane, setWidth };
}
