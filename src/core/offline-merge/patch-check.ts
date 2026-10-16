/**
 * The Mac's own checks on a queued task write (docs/plan/walnut-replica-servers-impl.md
 * section 5: a refusal is "the Mac's own answer, the one an online call would get").
 * They mirror the field rules of `PATCH /api/v1/tasks/:id` (src/web/routes/api-v1.ts)
 * and run on the drain's ONE resolved patch, inside the row's write lock, before
 * anything is written. A violation throws RefusedWrite: nothing of the record lands.
 *
 * Two normalizations the route also makes: a wait_until duration ("6h") becomes a
 * time, counted from when the write was made (the record's time, so a replay gives
 * the same time), and clearing start_date clears an end_date left without one.
 */

import { VALID_PHASES } from '../phase.js';
import { PIN_TIER_POLICY, VALID_PRIORITIES, type Task } from '../types.js';
import type { FieldWrite } from './task-fields.js';

/** A queued write the server answered with a refusal (validation, a guard), not a Walnut failure. */
export class RefusedWrite extends Error {}

const STATUSES = new Set(['todo', 'in_progress', 'done']);
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:?\d{2})?)?$/;
const DURATION_RE = /^\d+(?:\.\d+)?\s*(ms|s|m|h|d)$/i;
const DATE_FIELDS = ['due_date', 'start_date', 'end_date'] as const;
const TEXT_FIELDS = ['description', 'note', 'summary', 'sprint'] as const;
/** The tiers every board has (custom ones come from the registry). */
const BUILTIN_TIERS: string[] = PIN_TIER_POLICY.map((p) => p.tier as string);

const isClear = (v: unknown): boolean => v === '' || v === null || v === undefined;

/** The route's ISO check: shape, parse, and no calendar rollover ('2030-02-30'). */
export function isIsoDate(s: unknown): boolean {
  if (typeof s !== 'string' || !ISO_DATE_RE.test(s) || Number.isNaN(Date.parse(s))) return false;
  const day = s.slice(0, 10);
  return new Date(`${day}T00:00:00Z`).toISOString().slice(0, 10) === day;
}

/**
 * Normalize a record's fields before they are merged: a wait_until duration becomes the
 * time it named, counted from the write's own time (`fieldAt`), and a status that rides
 * with a phase gives way to it (the phase decides the status; online they were two calls).
 */
export async function normalizeQueuedFields(
  fields: Record<string, FieldWrite>, fieldAt: (w: FieldWrite) => number,
): Promise<Record<string, FieldWrite>> {
  const out: Record<string, FieldWrite> = { ...fields };
  if (out.phase && out.status) delete out.status;
  const w = out.wait_until;
  if (w && typeof w.value === 'string' && DURATION_RE.test(w.value.trim())) {
    const { parseWaitUntil } = await import('../task-wait-clock.js');
    try {
      out.wait_until = { ...w, value: parseWaitUntil(w.value, fieldAt(w)) ?? '' };
    } catch (err) {
      throw new RefusedWrite(err instanceof Error ? err.message : String(err));
    }
  }
  return out;
}

export interface PatchCheckContext {
  /** Custom tier ids on this Mac (read before the lock). */
  customTiers?: readonly string[];
  /** The plugin content check (task-manager.ts runPluginContentValidation); throws on a rejection. */
  validateContent?: (task: Task, field: string, value: string) => void;
}

function refuse(message: string): never {
  throw new RefusedWrite(`${message}; nothing of this write was applied`);
}

/**
 * Check the resolved patch against the row it lands on, the route's rules field by
 * field. Mutates `patch` for the two normalizations; throws RefusedWrite otherwise.
 */
export function checkResolvedPatch(current: Readonly<Task>, patch: Record<string, unknown>, ctx: PatchCheckContext = {}): void {
  const has = (f: string): boolean => Object.prototype.hasOwnProperty.call(patch, f);
  if (has('phase') && !(typeof patch.phase === 'string' && VALID_PHASES.has(patch.phase))) refuse(`phase must be one of: ${[...VALID_PHASES].join(', ')}`);
  if (has('status') && !(typeof patch.status === 'string' && STATUSES.has(patch.status))) refuse('status must be one of: todo, in_progress, done');
  if (has('priority') && !(typeof patch.priority === 'string' && (VALID_PRIORITIES as readonly string[]).includes(patch.priority))) {
    refuse(`priority must be one of: ${VALID_PRIORITIES.join(', ')}`);
  }
  if (has('title')) {
    if (!(typeof patch.title === 'string' && patch.title.trim())) refuse('title must be a non-empty string');
    if ((patch.title as string).length > 500) refuse('title too long (max 500 chars)');
  }
  for (const f of TEXT_FIELDS) if (has(f) && !isClear(patch[f]) && typeof patch[f] !== 'string') refuse(`${f} must be a string`);
  for (const f of ['project', 'group_id', 'parent_task_id'] as const) {
    if (has(f) && !isClear(patch[f]) && typeof patch[f] !== 'string') refuse(`${f} must be a string`);
  }
  if (has('tags') && !isClear(patch.tags) && !(Array.isArray(patch.tags) && patch.tags.every((t) => typeof t === 'string'))) refuse('tags must be an array of strings');
  if (has('depends_on') && !isClear(patch.depends_on) && !(Array.isArray(patch.depends_on) && patch.depends_on.every((t) => typeof t === 'string'))) {
    refuse('depends_on must be an array of task ids');
  }
  for (const f of ['unread', 'pinned'] as const) if (has(f) && patch[f] !== undefined && typeof patch[f] !== 'boolean') refuse(`${f} must be a boolean`);
  if (has('pin_order') && !isClear(patch.pin_order) && !(typeof patch.pin_order === 'number' && Number.isFinite(patch.pin_order))) refuse('pin_order must be a number');
  if (has('focus_tier') && !isClear(patch.focus_tier)) {
    const tier = patch.focus_tier;
    if (typeof tier !== 'string' || ![...BUILTIN_TIERS, ...(ctx.customTiers ?? [])].includes(tier)) refuse(`focus_tier ${String(tier)} is not a tier on this board`);
  }
  for (const f of DATE_FIELDS) if (has(f) && !isClear(patch[f]) && !isIsoDate(patch[f])) refuse(`${f} must be an ISO-8601 date string, or "" to clear`);
  if (has('wait_until') && !isClear(patch.wait_until) && !isIsoDate(patch.wait_until)) refuse('wait_until must be an ISO-8601 datetime, or "" to clear');
  // wait_until belongs to WAITING alone: a clock the merge kept onto a task that is not
  // (the Mac moved it on later) is dropped, never written as a stray clock.
  const phase = has('phase') ? patch.phase : current.phase;
  if (has('wait_until') && !isClear(patch.wait_until) && phase !== 'WAITING') delete patch.wait_until;
  // The working block, judged on the EFFECTIVE row (one half may be all the patch has).
  const start = has('start_date') ? (isClear(patch.start_date) ? undefined : String(patch.start_date)) : current.start_date;
  let end = has('end_date') ? (isClear(patch.end_date) ? undefined : String(patch.end_date)) : current.end_date;
  if (has('start_date') && !start && end && !has('end_date')) { patch.end_date = null; end = undefined; }
  if (end && !start) refuse('end_date requires a start_date (it is the end of a start_date working block)');
  if (end && start && Date.parse(end) < Date.parse(start)) refuse('end_date must be greater than or equal to start_date');
  if (ctx.validateContent && current.source !== 'local') {
    for (const f of ['title', 'description', 'note'] as const) {
      if (has(f) && typeof patch[f] === 'string') {
        try { ctx.validateContent(current as Task, f, patch[f] as string); } catch (err) { refuse(err instanceof Error ? err.message : String(err)); }
      }
    }
  }
}
