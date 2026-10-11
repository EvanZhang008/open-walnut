/**
 * The Mac app's own update, as the page sees it. The app shell owns the updater
 * (desktop/AppUpdater.swift, T3 Code's flow); the page reads its state and asks
 * for the next step through the `walnutUpdate` message handler, which answers
 * each request with a promise, and hears every change as a `walnut:app-update`
 * window event. In a browser tab, or an app built before this, there is no
 * handler and nothing here renders.
 *
 * One module-level copy (T3's desktop update atom): subscribe first, then read
 * the current state (three tries), and drop that read if an event already came.
 */
import { useEffect, useState } from 'react';
import { log } from '@/utils/log';

export type AppUpdateStatus =
  | 'disabled' | 'idle' | 'checking' | 'up-to-date' | 'available' | 'downloading' | 'downloaded' | 'error';

/** Twin of AppUpdateState in desktop/AppUpdateMachine.swift (T3's DesktopUpdateState). */
export interface AppUpdateState {
  enabled: boolean;
  status: AppUpdateStatus;
  currentVersion: string;
  hostArch: string;
  appArch: string;
  runningUnderArm64Translation: boolean;
  availableVersion: string | null;
  downloadedVersion: string | null;
  downloadPercent: number | null;
  checkedAt: string | null;
  message: string | null;
  errorContext: 'check' | 'download' | 'install' | null;
  canRetry: boolean;
  disabledReason: string | null;
}

export interface AppUpdateActionResult {
  accepted: boolean;
  completed: boolean;
  failed?: boolean;
  state: AppUpdateState;
}

export interface AppUpdateCheckResult {
  checked: boolean;
  state: AppUpdateState;
}

interface UpdateHandler { postMessage(body: Record<string, unknown>): Promise<unknown> }

export const APP_UPDATE_EVENT = 'walnut:app-update';

function handler(): UpdateHandler | null {
  if (typeof window === 'undefined') return null;
  const h = (window as unknown as { webkit?: { messageHandlers?: { walnutUpdate?: UpdateHandler } } })
    .webkit?.messageHandlers?.walnutUpdate;
  return h && typeof h.postMessage === 'function' ? h : null;
}

/** Whether this page runs inside a Walnut.app that updates itself. */
export function hasAppUpdater(): boolean {
  return handler() !== null;
}

function ask<T>(op: string, extra: Record<string, unknown> = {}): Promise<T> {
  const h = handler();
  if (!h) return Promise.reject(new Error('Not running in the Walnut app.'));
  return h.postMessage({ op, ...extra }) as Promise<T>;
}

export const appUpdateBridge = {
  check: () => ask<AppUpdateCheckResult>('check'),
  download: () => ask<AppUpdateActionResult>('download'),
  /** The app's own confirmation sheet; resolves true to go ahead. */
  confirmInstall: () => ask<boolean>('confirmInstall'),
  install: () => ask<AppUpdateActionResult>('install'),
  /** Opens the release page in the browser; resolves false when the app has no feed. */
  openRelease: (version: string) => ask<boolean>('openRelease', { version }),
};

let shared: AppUpdateState | null = null;
let started = false;
const listeners = new Set<(s: AppUpdateState | null) => void>();

function publish(next: AppUpdateState | null): void {
  shared = next;
  for (const fn of listeners) fn(next);
}

const INITIAL_READ_ATTEMPTS = 3;

/** Starts listening once per page; exported for tests. */
export function startAppUpdateState(): void {
  if (started || !handler()) return;
  started = true;
  let heard = false;
  window.addEventListener(APP_UPDATE_EVENT, (e) => {
    const detail = (e as CustomEvent<AppUpdateState>).detail;
    if (!detail || typeof detail !== 'object') return;
    heard = true;
    publish(detail);
  });
  void (async () => {
    for (let attempt = 1; attempt <= INITIAL_READ_ATTEMPTS; attempt++) {
      try {
        const r = await ask<{ state: AppUpdateState }>('getState');
        if (!heard && r?.state) publish(r.state);
        return;
      } catch (err) {
        if (attempt === INITIAL_READ_ATTEMPTS) {
          log.warn('app-update', 'could not read the app update state', { error: String(err), attempts: attempt });
        }
      }
    }
  })();
}

/** The page's current copy (null before the shell answered, or outside the app). */
export function peekAppUpdateState(): AppUpdateState | null {
  return shared;
}

/** Test seam: forget the module copy. */
export function resetAppUpdateStateForTests(): void {
  shared = null;
  started = false;
  listeners.clear();
}

export function useAppUpdateState(): AppUpdateState | null {
  const [state, setState] = useState<AppUpdateState | null>(shared);
  useEffect(() => {
    listeners.add(setState);
    startAppUpdateState();
    setState(shared);
    return () => { listeners.delete(setState); };
  }, []);
  return state;
}
