/**
 * Local page-use counts (server: src/core/page-visits.ts). Every page and Settings pane
 * records a visit; Settings > Page use shows where the user goes and what he never opens.
 * Visits gather for a few seconds and go out in one small POST to this Walnut only.
 */
import { apiDelete, apiGet, apiPost } from './client';
import { log } from '@/utils/log';

export interface VisitEntry { count: number; firstAt: string; lastAt: string; days: Record<string, number> }
export interface VisitStore { version: 1; since: string; keys: Record<string, VisitEntry> }

const SEND_AFTER_MS = 4_000;
const KEY_RE = /^(page|settings|app):[A-Za-z0-9._~-]{1,72}$/;

const pending: string[] = [];
let timer: ReturnType<typeof setTimeout> | null = null;

/**
 * The page key of a route, or null for a route that records itself (Settings records
 * its pane instead) or names no page. `/tasks/<id>` is one page, `/apps/<id>/…` the app.
 */
export function pageKeyForPath(pathname: string): string | null {
  const parts = pathname.split('/').filter(Boolean);
  if (parts.length === 0) return 'page:home';
  const [first, second] = parts;
  if (first === 'settings') return null;
  if (first === 'apps' && second) return safeKey(`app:${decodeSafe(second)}`);
  if (first === 'tasks' && second) return 'page:task';
  return safeKey(`page:${first}`);
}

/** The visit key of a Settings pane: `settings:sessions`, `settings:mail~rules` for a plugin's `mail:rules`. */
export function settingsVisitKey(paneId: string): string | null {
  return safeKey(`settings:${paneId.replace(/:/g, '~')}`);
}

function decodeSafe(s: string): string {
  try { return decodeURIComponent(s); } catch { return s; }
}

function safeKey(key: string): string | null {
  return KEY_RE.test(key) ? key : null;
}

function send(): void {
  timer = null;
  const keys = pending.splice(0, pending.length);
  if (!keys.length) return;
  // keepalive: a batch still in flight when the page reloads or closes is not cancelled.
  apiPost('/api/page-visits', { keys }, { background: true, priority: 'low', timeoutMs: 10_000, keepalive: true })
    .catch((err) => log.info('page-visits', 'visit batch not recorded', { error: err instanceof Error ? err.message : String(err), count: keys.length }));
}

/** Count one visit of `key` (`page:org`, `settings:sessions`); invalid keys are ignored. */
export function recordVisit(key: string | null | undefined): void {
  if (!key || !KEY_RE.test(key)) return;
  pending.push(key);
  if (!timer) timer = setTimeout(send, SEND_AFTER_MS);
}

if (typeof document !== 'undefined') {
  // A window going away sends what it holds now, not never (pagehide too: a reload may not hide first).
  const flush = () => {
    if (!pending.length) return;
    if (timer) clearTimeout(timer);
    send();
  };
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flush();
  });
  window.addEventListener('pagehide', flush);
}

export function fetchVisits(): Promise<VisitStore> {
  return apiGet<VisitStore>('/api/page-visits');
}

export function clearVisits(): Promise<{ ok: boolean }> {
  return apiDelete<{ ok: boolean }>('/api/page-visits');
}
