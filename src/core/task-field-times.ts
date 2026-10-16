/**
 * Per-field change times on a task (`task.field_at`, docs/plan/walnut-replica-servers-impl.md
 * section 7). The offline drain decides "newer" per field: a replica's write made at a
 * host time T (shifted to this server's clock) beats the Mac's value of that field only
 * when the Mac changed it before T. One `updated_at` cannot say that: an unrelated edit
 * (a pin, a sync pull) would make every field look new.
 *
 * Stamped at the two places every task row is written (task-manager.ts `writeStore` and
 * `updateTaskRaw`), by diffing the row before and after, so no write path can forget it.
 * A replay names the time to stamp (`updateTaskRaw`'s `fieldTimes` option): the record's
 * shifted `at`, never the drain's wall clock, so two host journals drained in either order
 * end the same. The stamp is an argument of that ONE row write, never ambient state: an
 * async-context override leaked into every write the drain's events caused on other tasks
 * (a woken parent's phase stamped hours in the past).
 */

import type { Task } from './types.js';

/** The fields a host may queue while the Mac is away; their change times are kept. */
export const TIMED_TASK_FIELDS = [
  'title', 'phase', 'priority', 'project', 'group_id', 'due_date', 'start_date', 'end_date', 'pinned', 'tags',
  'summary', 'description', 'note', 'sprint', 'unread', 'focus_tier', 'pin_order', 'depends_on', 'wait_until', 'parent_task_id',
] as const;

/** The time one replayed row write stamps: `at`, or `fields[f]` for a field named there. */
export interface FieldStamp { at: string; fields?: Record<string, string> }

/** Two stored values are the same field value (absent, null and '' alike for strings; arrays by content). */
export function sameFieldValue(a: unknown, b: unknown): boolean {
  const norm = (v: unknown): string => {
    if (v === undefined || v === null || v === '') return 'null';
    if (Array.isArray(v) && v.length === 0) return 'null';
    if (v === false) return 'null';
    return JSON.stringify(v);
  };
  return norm(a) === norm(b);
}

/**
 * The field_at `after` should store: `before`'s times, with every timed field that
 * differs stamped now (or at `stamp`, a replay's time). Returns null when nothing changed.
 * `project` and `group_id` are one compound field (section 7): both move together.
 */
export function stampedFieldTimes(before: Partial<Task> | undefined, after: Partial<Task>, stamp?: FieldStamp): Record<string, string> | null {
  if (!before) return null;
  const o = stamp;
  const at = o?.at ?? new Date().toISOString();
  const timeOf = (f: string): string => o?.fields?.[f] ?? at;
  const prev = (after.field_at ?? before.field_at ?? {}) as Record<string, string>;
  let next: Record<string, string> | null = null;
  const b = before as Record<string, unknown>;
  const a = after as Record<string, unknown>;
  for (const f of TIMED_TASK_FIELDS) {
    if (sameFieldValue(b[f], a[f])) continue;
    next ??= { ...prev };
    next[f] = timeOf(f);
    if (f === 'project' || f === 'group_id') { next.project = timeOf('project'); next.group_id = timeOf('group_id'); }
  }
  return next;
}

/**
 * `task.field_at` with every timed field that has no time of its own frozen at the row's
 * CURRENT fallback (updated_at, else created_at), for a drain write about to move
 * updated_at: fieldTimeOf then never reads the drain's own clock for a field the write
 * did not change, so a later base-unknown write on that field is judged against the
 * time the Mac really last could have changed it, in every drain order and batching.
 * Null when every field already has a time, or the row has no time to freeze at.
 */
export function frozenFieldTimes(task: Pick<Task, 'field_at' | 'updated_at' | 'created_at'>): Record<string, string> | null {
  const fallback = Number.isFinite(Date.parse(task.updated_at ?? '')) ? task.updated_at
    : Number.isFinite(Date.parse(task.created_at ?? '')) ? task.created_at : undefined;
  if (!fallback) return null;
  const own = (task.field_at ?? {}) as Record<string, string>;
  const missing = TIMED_TASK_FIELDS.filter((f) => !Number.isFinite(Date.parse(own[f] ?? '')));
  if (!missing.length) return null;
  const out = { ...own };
  for (const f of missing) out[f] = fallback;
  return out;
}

/** When the Mac last changed field `f` of `task` (ms), falling back to updated_at, then created_at. */
export function fieldTimeOf(task: Pick<Task, 'field_at' | 'updated_at' | 'created_at'>, f: string): number {
  const own = task.field_at?.[f];
  const t = Date.parse(own ?? '');
  if (Number.isFinite(t)) return t;
  return Date.parse(task.updated_at ?? '') || Date.parse(task.created_at ?? '') || 0;
}
