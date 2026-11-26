/**
 * Local page-use counts (server: src/core/page-visits.ts). Every page and Settings pane
 * records a visit; Settings > Page use shows where the user goes and what he never opens.
 * Visits gather for a few seconds and go out in one small POST to this Walnut only.
 */
import { apiDelete, apiGet, apiPost } from './client';
import { log } from '@/utils/log';
import { VISIT_KEY_RE, pageKeyForPath, settingsVisitKey } from '@open-walnut/page-places';

export interface VisitEntry { count: number; firstAt: string; lastAt: string; days: Record<string, number> }
export interface VisitStore { version: 1; since: string; keys: Record<string, VisitEntry> }

const SEND_AFTER_MS = 4_000;

// One definition of a place and its key, shared with the server (src/core/page-places.ts): real use
// judges a `page:` watch target by these same visits.
export { pageKeyForPath, settingsVisitKey };

const pending: string[] = [];
let timer: ReturnType<typeof setTimeout> | null = null;

function send(): void {
  timer = null;
  const keys = pending.splice(0, pending.length);
  if (!keys.length) return;
  // keepalive: a batch still in flight when the page reloads or closes is not cancelled.
  apiPost('/api/page-visits', { keys }, { background: true, quietRetry: true, priority: 'low', timeoutMs: 10_000, keepalive: true })
    .catch((err) => log.info('page-visits', 'visit batch not recorded', { error: err instanceof Error ? err.message : String(err), count: keys.length }));
}

/** Count one visit of `key` (`page:org`, `settings:sessions`, `part:session-panel`); invalid keys are ignored. */
export function recordVisit(key: string | null | undefined): void {
  if (!key || !VISIT_KEY_RE.test(key)) return;
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
