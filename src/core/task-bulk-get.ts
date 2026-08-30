/**
 * Bulk task read with field projection — one call for a triage pass.
 *
 * Why it exists: reviewing a board meant one task_get per row, each answering the
 * FULL task (note included, multiple KB), so a 30-row pass cost 30 round trips and
 * most of the payload was Work Log prose nobody asked for. This reads many tasks
 * at once and returns only the named fields, including the derived `progress`
 * board (the note's Progress bullets, without the Work Log).
 *
 * Contract: the result array is in INPUT ORDER, and an id that resolves to
 * nothing (or to several tasks) becomes a per-item `error` entry — one bad id
 * must not fail the other 49.
 */

import type { Task } from './types.js';
import { extractProgressLines, summarizeProgress } from './task-progress.js';

/** Max ids per call. Above this the reply stops being a triage payload. */
export const MAX_BULK_GET_IDS = 50;

/**
 * Every field a bulk read may project. `progress` is DERIVED (see task-progress.ts);
 * everything else is a stored task field. `note` is allowed but heavy — it is the
 * whole reason `progress` exists.
 */
export const BULK_GET_FIELDS = [
  'title', 'status', 'phase', 'project', 'priority', 'tags',
  'start_date', 'due_date', 'end_date', 'created_at', 'updated_at', 'completed_at',
  'pinned', 'focus_tier', 'pin_order', 'unread', 'blocked_by',
  'last_session_update', 'summary', 'note', 'progress',
] as const;
export type BulkGetField = (typeof BULK_GET_FIELDS)[number];

/**
 * Group aliases a caller may pass instead of listing columns. `dates` is the one
 * the triage callers asked for (start/due/created/updated/completed).
 */
export const BULK_GET_FIELD_GROUPS: Readonly<Record<string, readonly BulkGetField[]>> = {
  dates: ['start_date', 'due_date', 'created_at', 'updated_at', 'completed_at'],
};

/**
 * Fields returned when the caller names none: the slim triage set plus `summary`.
 * Deliberately NOT the whole catalog — `note` in a default would put the payload
 * this op exists to avoid right back into every reply.
 */
export const DEFAULT_BULK_GET_FIELDS: readonly BulkGetField[] = [
  'title', 'status', 'phase', 'project', 'priority',
  'due_date', 'updated_at', 'pinned', 'focus_tier', 'unread', 'summary',
];

/** One projected row. `id` is always present; `error` replaces the fields. */
export interface BulkGetItem {
  id: string;
  error?: string;
  [field: string]: unknown;
}

export interface BulkGetResult {
  /** The resolved field list, echoed so a caller sees what a group alias expanded to. */
  fields: BulkGetField[];
  items: BulkGetItem[];
  /** How many items carry an `error` instead of fields. */
  errors: number;
}

export class BulkGetError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'BulkGetError';
  }
}

/**
 * Validate + expand a requested field list. Unknown names are REJECTED rather
 * than ignored: a silently dropped field reads as "the task has no due date".
 */
export function resolveBulkGetFields(requested: readonly string[] | undefined): BulkGetField[] {
  if (requested === undefined || requested.length === 0) return [...DEFAULT_BULK_GET_FIELDS];
  const resolved: BulkGetField[] = [];
  for (const raw of requested) {
    const name = raw.trim().toLowerCase();
    if (name === '') continue;
    const group = BULK_GET_FIELD_GROUPS[name];
    const expanded = group ?? ((BULK_GET_FIELDS as readonly string[]).includes(name) ? [name as BulkGetField] : undefined);
    if (!expanded) {
      throw new BulkGetError(
        'unknown_field',
        `Unknown field "${raw}". Valid: ${[...BULK_GET_FIELDS, ...Object.keys(BULK_GET_FIELD_GROUPS)].join(', ')}`,
      );
    }
    for (const field of expanded) if (!resolved.includes(field)) resolved.push(field);
  }
  if (resolved.length === 0) return [...DEFAULT_BULK_GET_FIELDS];
  return resolved;
}

/** Project ONE task onto the requested fields. Absent values are omitted, not null. */
export function projectTaskFields(task: Task, fields: readonly BulkGetField[]): BulkGetItem {
  const item: BulkGetItem = { id: task.id };
  for (const field of fields) {
    if (field === 'progress') {
      const lines = extractProgressLines(task.note);
      // Always present, even empty: "no Progress section" is an answer a triage
      // caller acts on (the task has never been self-reported).
      item.progress = lines;
      item.progress_counts = summarizeProgress(lines);
      continue;
    }
    if (field === 'blocked_by') {
      if (task.depends_on?.length) item.blocked_by = task.depends_on;
      continue;
    }
    if (field === 'pinned') {
      item.pinned = Boolean(task.pinned);
      continue;
    }
    const value = (task as unknown as Record<string, unknown>)[field];
    if (value !== undefined && value !== '' && !(Array.isArray(value) && value.length === 0)) {
      item[field] = value;
    }
  }
  return item;
}

/**
 * Resolve ids (exact, or a unique prefix like task_get accepts) against a task
 * list and project the requested fields. Pure over the supplied tasks so the
 * route, the CLI and the tests all exercise the same resolution rules.
 */
export function bulkGetFromTasks(
  ids: readonly string[],
  tasks: readonly Task[],
  requestedFields?: readonly string[],
): BulkGetResult {
  if (ids.length === 0) throw new BulkGetError('no_ids', 'ids must contain at least one task id');
  if (ids.length > MAX_BULK_GET_IDS) {
    throw new BulkGetError('too_many_ids', `ids may contain at most ${MAX_BULK_GET_IDS} entries (got ${ids.length})`);
  }
  const fields = resolveBulkGetFields(requestedFields);

  const byId = new Map(tasks.map((t) => [t.id, t]));
  const items: BulkGetItem[] = [];
  let errors = 0;
  for (const raw of ids) {
    const id = raw.trim();
    if (id === '') {
      items.push({ id: raw, error: 'empty id' });
      errors += 1;
      continue;
    }
    // Exact hit first — the common case, and it keeps a full id that happens to
    // prefix another id from ever reading as ambiguous.
    const exact = byId.get(id);
    if (exact) {
      items.push(projectTaskFields(exact, fields));
      continue;
    }
    const matches = tasks.filter((t) => t.id.startsWith(id));
    if (matches.length === 1) {
      items.push(projectTaskFields(matches[0], fields));
      continue;
    }
    // Per-item error, never a failed call: one stale id in a triage list must not
    // cost the caller the other rows.
    items.push({
      id,
      error: matches.length === 0
        ? 'not found'
        : `ambiguous id prefix — matches ${matches.length} tasks`,
    });
    errors += 1;
  }
  return { fields, items, errors };
}
