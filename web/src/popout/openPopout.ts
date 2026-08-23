/**
 * Open-in-new-tab helper.
 *
 * Opens a standalone `/popout?view=<view>&...params` route in a NEW BROWSER TAB
 * that renders a single view (file / note / session / task / global-notes)
 * without the app shell, sidebar, or providers. See PopoutRoot.tsx for the
 * receiving end and the SHARED CONTRACT in the popout/ dir.
 *
 * We open a plain tab (window.open(url, '_blank')) rather than a popup window:
 * tabs are far easier for the user to manage (move between displays, pin,
 * reorder) than OS-level popups. The tab NAME is stable per logical target
 * (e.g. one tab per session id) so re-invoking for the same target focuses the
 * existing tab instead of spawning duplicates.
 */

export type PopoutView = 'file' | 'global-notes' | 'note' | 'session' | 'task';

export type PopoutParams = Record<string, string | number | null | undefined>;

export function isPopoutPath(pathname: string): boolean {
  return pathname === '/popout' || pathname.startsWith('/popout/');
}

/**
 * Build a `/popout` URL for the given view + params and open it in a new tab.
 * Non-empty params are URL-encoded; empty/nullish params are dropped.
 *
 * @param view   which popout view to render
 * @param params view-specific query params (e.g. { path } for file, { id } for task)
 * @returns the opened Window (or null if the browser blocked it)
 */
export function openPopout(view: PopoutView, params: PopoutParams = {}): Window | null {
  const search = new URLSearchParams();
  search.set('view', view);
  for (const [key, value] of Object.entries(params)) {
    if (value === null || value === undefined) continue;
    const str = String(value);
    if (str === '') continue;
    search.set(key, str);
  }
  const url = `/popout?${search.toString()}`;

  // Stable per-target tab name: same view+params reuses (focuses) the tab.
  const tabName = `walnut-popout-${view}-${search.toString()}`;

  // No "features" arg → browser opens a normal TAB, not a popup window.
  return window.open(url, tabName);
}
