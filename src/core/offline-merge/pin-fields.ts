/**
 * `pinned` / `focus_tier` in a queued task write, applied the way the online PATCH applies
 * them (src/web/routes/task-pin-patch.ts: parsePinPatch + checkPinPatch, then
 * applyPinPatch -> setPinTierBulk), never as two plain columns: the pinned board is its
 * own write. A focus_tier pins the task (at the bottom of the board), pinned:true alone
 * pins it as a Satellite or keeps the tier of a pinned task, pinned:false unpins it and
 * drops its tier and order, and a NEW pin on a completed task is refused (409 online).
 *
 * It runs on the drain's ONE resolved patch inside the row's write lock (apply-fields.ts),
 * so the pin lands in the same row write as the rest of the record and its op key: a crash
 * can never keep the fields and lose the pin, and a refusal means nothing landed. The one
 * difference from setPinTierBulk: an unpin leaves the other pins' order with a gap (the
 * order still sorts the same; the next pin from the board compacts it).
 */

import { migrateFocusTier, PIN_TIER_POLICY, type Task } from '../types.js';
import { RefusedWrite } from './patch-check.js';

/** The tiers a pinned task stores (satellite is stored as no tier): task-manager.ts BUILTIN_TIER_VALUES. */
const STORED_BUILTIN_TIERS = ['focus', 'wait'];

export interface PinFieldsContext {
  /** Custom tier ids on this Mac (read before the lock). */
  customTiers: readonly string[];
  /** The pin order a NEW pin takes (after every pinned task, read before the lock). */
  nextPinOrder: number;
  /** The same write moves the task to COMPLETE. */
  completing: boolean;
}

function refuse(message: string): never {
  throw new RefusedWrite(`${message}; nothing of this write was applied`);
}

/** True when the patch names a pin field (the caller then reads the next pin order). */
export function hasPinFields(fields: Record<string, unknown>): boolean {
  return 'pinned' in fields || 'focus_tier' in fields;
}

/**
 * Replace `pinned` / `focus_tier` in `stored` with the row fields the online pin write
 * sets on this task (pinned, pin_order, focus_tier; null clears). Returns true when the
 * board changes. Throws RefusedWrite with the PATCH's own answer.
 */
export function applyPinFields(cur: Readonly<Task>, stored: Record<string, unknown>, ctx: PinFieldsContext): boolean {
  const has = (f: string): boolean => Object.prototype.hasOwnProperty.call(stored, f);
  if (!has('pinned') && !has('focus_tier')) return false;
  const pinned = stored.pinned;
  const rawTier = stored.focus_tier;
  delete stored.pinned;
  delete stored.focus_tier;
  if (pinned !== undefined && pinned !== null && typeof pinned !== 'boolean') refuse('pinned must be a boolean');
  if (rawTier !== undefined && rawTier !== null && typeof rawTier !== 'string') {
    refuse('focus_tier must be a tier id string (focus, satellite, wait, or a custom tier)');
  }
  // "" / null focus_tier = not specified, as online.
  const tier = typeof rawTier === 'string' && rawTier.trim() ? rawTier.trim() : undefined;
  if (pinned === false && tier) refuse('focus_tier puts a task on the pinned board, so it cannot go with pinned:false');
  const builtins = PIN_TIER_POLICY.map((p) => p.tier as string);
  if (tier && !ctx.customTiers.includes(tier) && !builtins.includes(migrateFocusTier(tier))) {
    refuse(`focus_tier must be one of: ${[...builtins, ...ctx.customTiers].join(', ')}`);
  }
  const pins = pinned === true || tier !== undefined;
  const done = ctx.completing || cur.phase === 'COMPLETE' || cur.status === 'done';
  if (pins && !cur.pinned && done) refuse(`Cannot pin a completed task: ${cur.title}`);

  // applyPinPatch's target: null unpins, a tier moves, pinned:true alone keeps a pinned task's tier.
  let target: string | null | undefined;
  if (pinned === false) target = null;
  else if (tier) target = tier;
  else if (pinned === true && !cur.pinned) target = 'satellite';
  if (target === undefined) return false;

  // setPinTierBulk for this one row.
  if (target === null) {
    if (!cur.pinned) return false;
    stored.pinned = false;
    if (cur.pin_order !== undefined) stored.pin_order = null;
    if (cur.focus_tier !== undefined) stored.focus_tier = null;
    return true;
  }
  const custom = (t: string | undefined): boolean => t !== undefined && ctx.customTiers.includes(t);
  const resolved = custom(target) ? target : migrateFocusTier(target);
  const storedTier = STORED_BUILTIN_TIERS.includes(resolved) || custom(resolved) ? resolved : undefined;
  if (cur.pinned) {
    const now = migrateFocusTier(cur.focus_tier);
    const effective = now && (STORED_BUILTIN_TIERS.includes(now) || custom(now)) ? now : undefined;
    if (effective === storedTier) return false;
  } else {
    stored.pinned = true;
    stored.pin_order = ctx.nextPinOrder;
  }
  if (storedTier !== undefined) stored.focus_tier = storedTier;
  else if (cur.focus_tier !== undefined) stored.focus_tier = null;
  return true;
}
