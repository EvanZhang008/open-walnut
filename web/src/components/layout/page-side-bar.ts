/**
 * The Agenda and the Scratchpad beside any page, not only Home (2026-11-06, the user, of the
 * rail's Agenda and Scratchpad: "extract it to global, any page can show this side bar, I find I
 * sometimes need it for the org page").
 *
 * Home keeps its own column (HomeCompanionPanel, right of the task panel, under Home's own flags).
 * Every other page gets the same two panes in one column on its left edge, beside the rail that
 * opens them, without leaving the page. What is open there, and how wide the column is, is kept
 * PER PAGE through view memory (utils/view-memory.ts): the Agenda open on Org stays closed on
 * Notes, and both come back as left after another page, a reload or a restart.
 */
import { useCallback } from 'react';
import { shownText, storedView, usePageViewOf, viewKey, writeView } from '@/utils/view-memory';

export interface PageSideBarView {
  agenda: boolean;
  scratchpad: boolean;
  /** The column's width in px; absent until the user drags it. */
  width?: number;
}

export const SIDE_BAR_CLOSED: PageSideBarView = { agenda: false, scratchpad: false };
export const SIDE_BAR_WIDTH_DEFAULT = 400;
export const SIDE_BAR_WIDTH_MIN = 280;
export const SIDE_BAR_WIDTH_MAX = 720;
/** A column never takes more than this share of the window, so the page keeps room. */
export const SIDE_BAR_WINDOW_SHARE = 0.5;

/** Sent after the side bar opens, closes or changes width, so the full screen area follows it. */
export const SIDE_BAR_LAYOUT_EVENT = 'page-side-bar:layout';

/**
 * Where a full screen sheet's area starts (--fullscreen-left): the shell's page column (`main`,
 * 0 on a phone, whatever its safe-area padding), or the side bar's right edge while it shows, beside
 * the page or over it (a narrow window).
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
  return typeof r.agenda === 'boolean' && typeof r.scratchpad === 'boolean'
    && (r.width === undefined || (typeof r.width === 'number' && Number.isFinite(r.width)));
}

/** The width that shows in a window `windowWidth` px wide. */
export function sideBarWidth(stored: number | undefined, windowWidth: number): number {
  const max = Math.max(SIDE_BAR_WIDTH_MIN, Math.min(SIDE_BAR_WIDTH_MAX, Math.floor(windowWidth * SIDE_BAR_WINDOW_SHARE)));
  return Math.round(Math.min(max, Math.max(SIDE_BAR_WIDTH_MIN, stored ?? SIDE_BAR_WIDTH_DEFAULT)));
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

/** The side bar of `page` (Home's id is never written), with a setter per pane and the width. */
export function usePageSideBar(page: string | null) {
  const [view, setView] = usePageViewOf<PageSideBarView>('side-bar', 'view', page ?? 'home', SIDE_BAR_CLOSED, isPageSideBarView);
  const setPane = useCallback((pane: 'agenda' | 'scratchpad', open: boolean | ((prev: boolean) => boolean)) => {
    if (page === null) return;
    setView((prev) => {
      const next = typeof open === 'function' ? open(prev[pane]) : open;
      return next === prev[pane] ? prev : { ...prev, [pane]: next };
    });
  }, [page, setView]);
  const setWidth = useCallback((width: number) => {
    if (page === null) return;
    setView((prev) => (prev.width === width ? prev : { ...prev, width }));
  }, [page, setView]);
  return { view, setPane, setWidth };
}
