/**
 * Open-in-new-tab helper.
 *
 * Opens a standalone `/popout?view=<view>&...params` route in a NEW BROWSER TAB
 * that renders a single view (file / note / session / task / global-notes)
 * without the app shell or sidebar. See PopoutRoot.tsx for the
 * receiving end and the SHARED CONTRACT in the popout/ dir.
 *
 * We open a plain tab (window.open(url, '_blank')) rather than a popup window:
 * tabs are far easier for the user to manage (move between displays, pin,
 * reorder) than OS-level popups. The tab NAME is stable per logical target
 * (e.g. one tab per session id) so re-invoking for the same target focuses the
 * existing tab instead of spawning duplicates.
 *
 * The one exception is an app's own window (`openAppWindow`, the sidebar's "Open in new
 * window"): the person asked for a window to put beside the console, so that one is a popup.
 */

import { hasRecentHumanInput } from '@/utils/recent-opened';
import { taskPath } from '@/utils/task-path';
import { CORNER_ORDER, appendToCornerStack } from '@/components/common/corner-stack';

/** `task` is no view of its own any more: an old `/popout?view=task` link opens the task on Home. */
export type PopoutView = 'app' | 'file' | 'global-notes' | 'note' | 'session' | 'task';

export type PopoutParams = Record<string, string | number | null | undefined>;

export function isPopoutPath(pathname: string): boolean {
  return pathname === '/popout' || pathname.startsWith('/popout/');
}

function popoutSearch(view: PopoutView, params: PopoutParams): URLSearchParams {
  const search = new URLSearchParams();
  search.set('view', view);
  for (const [key, value] of Object.entries(params)) {
    if (value === null || value === undefined) continue;
    const str = String(value);
    if (str === '') continue;
    search.set(key, str);
  }
  return search;
}

/**
 * The `/popout` path for a view + params: what a link INSIDE a pop-out uses to
 * stay in it (an app path there renders the whole app in the pop-out tab).
 * Non-empty params are URL-encoded; empty/nullish params are dropped.
 */
export function popoutPath(view: PopoutView, params: PopoutParams = {}): string {
  return `/popout?${popoutSearch(view, params).toString()}`;
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
  const search = popoutSearch(view, params);
  const url = `/popout?${search.toString()}`;

  // Stable per-target tab name: same view+params reuses (focuses) the tab.
  const tabName = `walnut-popout-${view}-${search.toString()}`;

  // No "features" arg → browser opens a normal TAB, not a popup window.
  return window.open(url, tabName);
}

/**
 * An app's own window (`view=app`, PopoutAppView.tsx): the app alone, no Home or sidebar. The
 * address names the app by its registry key and never changes while the window is open (moving
 * inside the app stays in the window's memory), because the Mac app finds the window already
 * showing an app by its exact address (desktop/LinkPolicy.swift `isSameWindowTarget`).
 */
export function appWindowPath(appKey: string): string {
  return popoutPath('app', { app: appKey });
}

/** One window per app: the browser reuses a window by its name. */
export function appWindowName(appKey: string): string {
  return `walnut-app-${appKey}`;
}

/** Home is the console itself; every other app has a page of its own a window can show. */
export function canOpenAppWindow(app: { path: string }): boolean {
  return app.path !== '/';
}

interface ScreenBox {
  screenX: number;
  screenY: number;
  outerWidth: number;
  outerHeight: number;
  screen: { availWidth: number; availHeight: number };
}

/**
 * The popup features of an app window: about 1200 by 800, never larger than the screen, centred
 * over the window it was opened from. The size is what makes a browser open a WINDOW, not a tab.
 */
export function appWindowFeatures(from: ScreenBox): string {
  const width = Math.max(480, Math.min(1200, from.screen.availWidth || 1200));
  const height = Math.max(360, Math.min(800, from.screen.availHeight || 800));
  const left = Math.max(0, Math.round(from.screenX + (from.outerWidth - width) / 2));
  const top = Math.max(0, Math.round(from.screenY + (from.outerHeight - height) / 2));
  return `popup=yes,width=${width},height=${height},left=${left},top=${top}`;
}

/**
 * Does the window of this name still show the app at `url`? A new window is blank, and one the
 * person moved away (a link followed to another site, another page of the console) shows something
 * else; a window of another origin cannot even be read, so it has left too. A hash is still the app.
 */
function showsAppWindow(win: Window, url: string): boolean {
  try {
    const at = new URL(win.location.href);
    const want = new URL(url);
    return at.origin === want.origin && at.pathname === want.pathname && at.search === want.search;
  } catch {
    return false;
  }
}

/**
 * Open the app in its own window, or bring forward the one already showing it.
 *
 * A browser hands back an open window of the same name for an empty address without loading
 * anything, so a second click keeps where the person was in the app; a blank answer is a new
 * window, sent to the app's address, and so is a window of that name that no longer shows the app
 * (showsAppWindow). The Mac app answers an empty open with no window
 * (LinkPolicy.swift: an empty window.open is cancelled), so the address itself opens there, and
 * the Mac app brings forward the window that already shows it.
 */
export function openAppWindow(appKey: string): Window | null {
  const name = appWindowName(appKey);
  const features = appWindowFeatures(window);
  const url = new URL(appWindowPath(appKey), window.location.origin).href;
  let existing: Window | null = null;
  try { existing = window.open('', name, features); } catch { existing = null; }
  if (existing) {
    if (!showsAppWindow(existing, url)) existing.location.replace(url);
    try { existing.focus(); } catch { /* the browser decides */ }
    return existing;
  }
  return window.open(url, name, features);
}

/** The channel a pop-out asks the app's own window on (App.tsx `useOpenTaskRequests`). */
export const OPEN_TASK_CHANNEL = 'walnut-open-task';

/**
 * A task clicked inside a pop-out opens on the app's Home (there is no task page, utils/task-path.ts).
 * The app's own window does it when one is open: it answers on OPEN_TASK_CHANNEL and the pop-out
 * keeps what it shows. With no answer (no app window, or no BroadcastChannel), Home opens in a
 * tab of its own, the same one each time. The Mac app makes a new window for every such open, so
 * asking first is what keeps a click from piling up windows there.
 */
export function openTaskInApp(taskId: string): void {
  const fallback = () => { window.open(taskPath(taskId), 'walnut-app-home'); };
  let channel: BroadcastChannel;
  try { channel = new BroadcastChannel(OPEN_TASK_CHANNEL); } catch { fallback(); return; }
  const ask = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  let answered = false;
  channel.onmessage = (e: MessageEvent) => {
    if ((e.data as { answer?: string } | null)?.answer !== ask) return;
    answered = true;
    channel.close();
    flashNotice('Opened on Home in the Walnut window');
  };
  channel.postMessage({ ask, taskId, human: hasRecentHumanInput() });
  setTimeout(() => { if (answered) return; channel.close(); fallback(); }, 600);
}

/** A short line in the pop-out's notice corner (it has no toaster of its own). */
function flashNotice(text: string): void {
  const el = document.createElement('div');
  el.setAttribute('role', 'status');
  el.className = 'popout-flash-notice';
  el.textContent = text;
  el.style.cssText = 'align-self:flex-start;pointer-events:auto;padding:8px 14px;border-radius:8px;font-size:13px;color:var(--fg);background:var(--bg-secondary);border:1px solid var(--border);box-shadow:0 4px 16px rgba(0,0,0,.18)';
  appendToCornerStack(el, CORNER_ORDER.flash);
  setTimeout(() => el.remove(), 2_500);
}
