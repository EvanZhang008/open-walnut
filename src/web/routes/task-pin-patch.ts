/**
 * `pinned` / `focus_tier` in a task PATCH body (the web PATCH and the v1 PATCH).
 *
 * updateTask has no such fields: the pinned board is its own write. So both PATCH
 * routes used to answer 200 and drop them, and the caller believed the task was
 * pinned (2026-10-09, an agent "moved" tasks to Focus that never moved). They now go
 * through the same core write the focus routes use (setPinTierBulk, one store
 * write for pin + tier), and every precondition is checked BEFORE the route writes
 * anything else, so a refusal means nothing changed.
 */

import { bus, EventNames } from '../../core/event-bus.js'
import { migrateFocusTier, PIN_TIER_POLICY, type Task } from '../../core/types.js'

export interface PinPatch {
  /** true pins (at the bottom, Satellite) when the task is not pinned yet; false unpins. */
  pinned?: boolean
  /** Pins when needed, then moves the task to this tier. */
  tier?: string
}

export type PinPatchParse =
  | { ok: true; patch: PinPatch | null }
  | { ok: false; status: number; error: string }

/** Validate the two fields. `""` / null focus_tier = not specified, as on create. */
export function parsePinPatch(body: Record<string, unknown> | undefined): PinPatchParse {
  const pinned = body?.pinned
  const tier = body?.focus_tier
  if (pinned !== undefined && typeof pinned !== 'boolean') {
    return { ok: false, status: 400, error: 'pinned must be a boolean' }
  }
  if (tier !== undefined && tier !== null && typeof tier !== 'string') {
    return { ok: false, status: 400, error: 'focus_tier must be a tier id string (focus, satellite, wait, or a custom tier)' }
  }
  const wantedTier = typeof tier === 'string' && tier.trim() ? tier.trim() : undefined
  if (pinned === false && wantedTier) {
    return { ok: false, status: 400, error: 'focus_tier puts a task on the pinned board, so it cannot go with pinned:false' }
  }
  if (pinned === undefined && !wantedTier) return { ok: true, patch: null }
  return { ok: true, patch: { ...(pinned !== undefined ? { pinned } : {}), ...(wantedTier ? { tier: wantedTier } : {}) } }
}

/** True when the body carries pin fields and nothing would ever apply them otherwise. */
export function hasPinFields(body: Record<string, unknown> | undefined): boolean {
  return body?.pinned !== undefined || (body?.focus_tier !== undefined && body?.focus_tier !== null && body?.focus_tier !== '')
}

/**
 * The refusal for this patch on this task, or null when it can be applied. Run before
 * any other write of the request. `completing`: the same PATCH moves the task to COMPLETE.
 */
export async function checkPinPatch(task: Task, patch: PinPatch, completing = false): Promise<{ status: number; error: string } | null> {
  if (patch.tier) {
    const { getCustomTiers } = await import('../../core/task-manager.js')
    const customIds = (await getCustomTiers()).map((t) => t.id)
    const builtins = PIN_TIER_POLICY.map((entry) => entry.tier as string)
    if (!customIds.includes(patch.tier) && !builtins.includes(migrateFocusTier(patch.tier))) {
      return { status: 400, error: `focus_tier must be one of: ${[...builtins, ...customIds].join(', ')}` }
    }
  }
  const pins = patch.pinned === true || patch.tier !== undefined
  const done = completing || task.phase === 'COMPLETE' || task.status === 'done'
  if (pins && !task.pinned && done) {
    return { status: 409, error: `Cannot pin a completed task: ${task.title}` }
  }
  return null
}

/** Apply a checked patch to a task (full id). Returns whether the board changed. */
export async function applyPinPatch(task: Task, patch: PinPatch): Promise<boolean> {
  const { setPinTierBulk } = await import('../../core/task-manager.js')
  let tier: string | null | undefined
  if (patch.pinned === false) tier = null
  else if (patch.tier) tier = patch.tier
  // pinned:true alone keeps the tier of a task that is already pinned.
  else if (patch.pinned === true && !task.pinned) tier = 'satellite'
  if (tier === undefined) return false
  const result = await setPinTierBulk([task.id], tier)
  const failure = result.failed[0]
  if (failure) throw new Error(failure.error === 'complete' ? `Cannot pin a completed task: ${task.title}` : `Task not found: ${task.id}`)
  if (result.changed.length > 0) bus.emit(EventNames.CONFIG_CHANGED, { key: 'focus_bar' }, ['web-ui'])
  return result.changed.length > 0
}
