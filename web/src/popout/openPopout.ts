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
 */

import { taskPath } from '@/utils/task-path';

/** `task` is no view of its own any more: an old `/popout?view=task` link opens the task on Home. */
export type PopoutView = 'file' | 'global-notes' | 'note' | 'session' | 'task';

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
  channel.postMessage({ ask, taskId });
  setTimeout(() => { if (answered) return; channel.close(); fallback(); }, 600);
}

/** A short line at the bottom of the pop-out: it has no toaster of its own. */
function flashNotice(text: string): void {
  const el = document.createElement('div');
  el.setAttribute('role', 'status');
  el.className = 'popout-flash-notice';
  el.textContent = text;
  el.style.cssText = 'position:fixed;left:50%;bottom:20px;transform:translateX(-50%);z-index:2147483000;padding:8px 14px;border-radius:8px;font-size:13px;color:var(--fg);background:var(--bg-secondary);border:1px solid var(--border);box-shadow:0 4px 16px rgba(0,0,0,.18)';
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 2_500);
}
