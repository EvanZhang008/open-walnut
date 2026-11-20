/**
 * The quick bar's line to the Mac app (desktop/QuickBarPanel.swift): the page posts to the
 * `walnutQuickBar` handler, and the app calls `window.__walnutQuickBar`.
 *
 * Page to app:
 *   { type: 'flag', on }                       the experiment is on or off (main window): the app
 *                                              registers Control-Option-Command-Space only while on
 *   { type: 'layout', mode, width, height }    the panel page's size: `bar` (centered, takes keys),
 *                                              `receipts` (top right, never takes keys), `hidden`
 *   { type: 'open', taskId }                   open that task's chat in the Walnut window
 *   { type: 'capture' }                        take a screenshot of an area, then call attach()
 * App to page (the panel page): open(), hotkey(), attach(base64Png), close() (a click in another app).
 */

export type NativeQuickBarMessage =
  | { type: 'flag'; on: boolean }
  | { type: 'layout'; mode: 'bar' | 'receipts' | 'hidden'; width: number; height: number }
  | { type: 'open'; taskId: string }
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
