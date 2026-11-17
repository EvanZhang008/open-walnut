/**
 * Walnut Health's error log, from the records the notification store holds for it
 * (audience 'health', src/core/notifications/audience.ts): one group per category,
 * the group with the newest occurrence first, and inside it each kind of error with
 * how often it happened, when first and last, and whether it is still happening.
 * Pure, so the grouping is tested without a browser.
 */
import { categoryOf, effectiveTs, presentError, type Notification } from '@/contexts/notifications';

export type HealthErrorState = 'open' | 'recovered' | 'stale';

export interface HealthErrorRow {
  dedupKey: string;
  title: string;
  body: string;
  detail?: string;
  times: number;
  firstSeen: number;
  lastSeen: number;
  state: HealthErrorState;
  sessionId?: string;
  taskId?: string;
  /** The repair session "Fix with agent" started for it (server-owned). */
  fix?: { taskId: string; sessionId?: string };
}

export interface HealthErrorGroup {
  category: string;
  rows: HealthErrorRow[];
  open: number;
  times: number;
  firstSeen: number;
  lastSeen: number;
}

/** Every occurrence the server counted (older records only have the bell's fold count). */
function timesOf(n: Notification): number {
  return Math.max(1, n.occurrences ?? n.count ?? 1);
}

function stateOf(n: Notification): HealthErrorState {
  if (n.resolved === 'recovered') return 'recovered';
  return n.resolved ? 'stale' : 'open';
}

export function healthErrorRow(n: Notification): HealthErrorRow {
  const shown = presentError(n);
  return {
    dedupKey: n.dedupKey,
    title: shown.title,
    body: shown.body,
    ...(shown.detail ? { detail: shown.detail } : {}),
    times: timesOf(n),
    firstSeen: n.timestamp,
    lastSeen: effectiveTs(n),
    state: stateOf(n),
    ...(n.sessionId ? { sessionId: n.sessionId } : {}),
    ...(n.taskId ? { taskId: n.taskId } : {}),
    ...(n.fix ? { fix: { taskId: n.fix.taskId, ...(n.fix.sessionId ? { sessionId: n.fix.sessionId } : {}) } } : {}),
  };
}

export function groupHealthErrors(records: readonly Notification[]): HealthErrorGroup[] {
  const byCategory = new Map<string, HealthErrorRow[]>();
  for (const n of records) {
    if (n.kind !== 'operation-error') continue;
    const category = categoryOf(n);
    const rows = byCategory.get(category) ?? [];
    rows.push(healthErrorRow(n));
    byCategory.set(category, rows);
  }
  const groups: HealthErrorGroup[] = [];
  for (const [category, rows] of byCategory) {
    // Still happening first, then the newest.
    rows.sort((a, b) => Number(b.state === 'open') - Number(a.state === 'open') || b.lastSeen - a.lastSeen);
    groups.push({
      category,
      rows,
      open: rows.filter(r => r.state === 'open').length,
      times: rows.reduce((sum, r) => sum + r.times, 0),
      firstSeen: Math.min(...rows.map(r => r.firstSeen)),
      lastSeen: Math.max(...rows.map(r => r.lastSeen)),
    });
  }
  return groups.sort((a, b) => Number(b.open > 0) - Number(a.open > 0) || b.lastSeen - a.lastSeen);
}
