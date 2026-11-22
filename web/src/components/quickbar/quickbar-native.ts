/**
 * The quick bar's line to the Mac app (desktop/QuickBarPanel.swift): the page posts to the
 * `walnutQuickBar` handler, and the app calls `window.__walnutQuickBar`.
 *
 * Page to app:
 *   { type: 'flag', on }                       the experiment is on or off (main window): the app
 *                                              registers Control-Option-Command-Space only while on
 *   { type: 'layout', mode, width, height }    the panel page's size: `bar` (centered, takes keys),
 *                                              `receipts` (top right, never takes keys), `hidden`
 *                                              (said again every minute while a hidden send is on
 *                                              its way: each one restarts the app's release clock)
 *   { type: 'open', taskId } | { type: 'open', to } open that task's chat, or an app path (a note:
 *                                              `/notes?path=...`), in the Walnut window
 *   { type: 'capture' }                        take a screenshot of an area, then call attach()
 * App to page (the panel page): open(), hotkey(), attach(base64Png), close() (a click in another app).
 */
import { taskIdOfPath } from '@/utils/task-path';

export type NativeQuickBarMessage =
  | { type: 'flag'; on: boolean }
  | { type: 'layout'; mode: 'bar' | 'receipts' | 'hidden'; width: number; height: number }
  | { type: 'open'; taskId: string }
  // `taskId` beside `to` for a task: a Mac app from before `to` reads only the id.
  | { type: 'open'; to: string; taskId?: string }
  | { type: 'capture' };

interface Handler { postMessage(message: NativeQuickBarMessage): void }

function handler(): Handler | null {
  const w = window as unknown as { webkit?: { messageHandlers?: { walnutQuickBar?: Handler } } };
  return w.webkit?.messageHandlers?.walnutQuickBar ?? null;
}

/** The Mac app answers: its own hotkey and panel do the work, so the page's own listener stays out. */
export function hasNativeQuickBar(): boolean {
  return handler() !== null;
}

export function postToNative(message: NativeQuickBarMessage): boolean {
  const h = handler();
  if (!h) return false;
  try { h.postMessage(message); return true; } catch { return false; }
}

export interface QuickBarPageApi {
  open(): void;
  hotkey(): void;
  attach(base64Png: string): void;
  close(): void;
}

export function exposeToNative(api: QuickBarPageApi | null): void {
  (window as unknown as { __walnutQuickBar?: QuickBarPageApi }).__walnutQuickBar = api ?? undefined;
}

/** Control-Option-Command-Space, by the key's place (Option changes `key` on a Mac). */
export function isQuickBarKey(e: KeyboardEvent): boolean {
  return e.code === 'Space' && e.ctrlKey && e.altKey && e.metaKey && !e.shiftKey;
}

/**
 * Open the quick bar from a click (the rail's magnifier, QuickBarRailButton.tsx), as the key does:
 * the page's bar (QuickBarHost.tsx) hears it, the experiment on or not being its own question.
 */
export const OPEN_QUICK_BAR_EVENT = 'walnut:quick-bar-open';

export interface OpenQuickBarDetail { listen?: boolean; mode?: 'send' | 'tasks' | 'notes' | 'ask' }

export function openQuickBar(detail: OpenQuickBarDetail = {}): void {
  window.dispatchEvent(new CustomEvent<OpenQuickBarDetail>(OPEN_QUICK_BAR_EVENT, { detail }));
}

/** Cmd-K (Ctrl-K elsewhere), the search key every app knows: opens the bar for typing. */
export function isQuickBarSearchKey(e: KeyboardEvent): boolean {
  // On a Mac Control-K is a text field's own key (delete to the end of the line): only Command-K.
  const onMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
  return (e.metaKey || (!onMac && e.ctrlKey)) && !e.altKey && !e.shiftKey && (e.key === 'k' || e.key === 'K');
}

/** A task path's id, sent beside the path so an older Mac app (which reads only `taskId`) opens it. */
export function openTaskOf(to: string): { taskId?: string } {
  const taskId = taskIdOfPath(to);
  return taskId ? { taskId } : {};
}
