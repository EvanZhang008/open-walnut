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
import { taskPatchRefusal, type TaskPatchRules } from './patch-rules-core.js';
import { PIN_TIER_POLICY, VALID_PRIORITIES, type Task } from '../types.js';
import type { FieldWrite } from './task-fields.js';

/** A queued write the server answered with a refusal (validation, a guard), not a Walnut failure. */
export class RefusedWrite extends Error {}

const STATUSES = new Set(['todo', 'in_progress', 'done']);
const DURATION_RE = /^\d+(?:\.\d+)?\s*(ms|s|m|h|d)$/i;
/** The tiers every board has (custom ones come from the registry). */
const BUILTIN_TIERS: string[] = PIN_TIER_POLICY.map((p) => p.tier as string);

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

/** The rule lists the route checks against (patch-rules-core.ts takes them as data). */
export function macTaskPatchRules(customTiers: readonly string[] = []): TaskPatchRules {
  return { phases: [...VALID_PHASES], statuses: [...STATUSES], priorities: VALID_PRIORITIES, tiers: [...BUILTIN_TIERS, ...customTiers] };
}

/**
 * Check the resolved patch against the row it lands on, the route's rules field by
 * field (patch-rules-core.ts, the one copy of them). Mutates `patch` for the two
 * normalizations; throws RefusedWrite otherwise.
 */
export function checkResolvedPatch(current: Readonly<Task>, patch: Record<string, unknown>, ctx: PatchCheckContext = {}): void {
  const refused = taskPatchRefusal(current as unknown as Record<string, unknown>, patch, macTaskPatchRules(ctx.customTiers), {
    ...(ctx.validateContent ? { validateContent: ctx.validateContent as unknown as (task: Record<string, unknown>, field: string, value: string) => void } : {}),
  });
  if (refused) throw new RefusedWrite(`${refused}; nothing of this write was applied`);
}
