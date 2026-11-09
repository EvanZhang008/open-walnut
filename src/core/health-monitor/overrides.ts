/**
 * Overrides of an alarm (threshold, Turn off, Mute, the task that owns it), by a
 * person or an agent, and how one instance reads its alarm's and its own.
 */

import type { AlarmOverride } from './types.js'

export interface OverridePatch { threshold?: number | null; enabled?: boolean; mutedUntil?: number | null; ownerTask?: string | null }

/**
 * What applies to one instance: its own override on top of its alarm's, field by
 * field, so a threshold set for one host keeps the alarm's own Turn off or Mute.
 */
export function effectiveOverride(
  overrides: Readonly<Record<string, AlarmOverride>>, instanceId: string, defId: string,
): AlarmOverride | undefined {
  const parent = overrides[defId]
  const own = instanceId === defId ? undefined : overrides[instanceId]
  if (!own) return parent
  if (!parent) return own
  const out: AlarmOverride = { ...parent, by: own.by, at: own.at }
  if (own.threshold !== undefined) out.threshold = own.threshold
  if (own.enabled !== undefined) out.enabled = own.enabled
  if (own.mutedUntil !== undefined) out.mutedUntil = Math.max(own.mutedUntil, parent.mutedUntil ?? 0)
  return out
}

/** Actions are held: turned off, or muted until a time still to come. */
export function overrideHolds(o: AlarmOverride | undefined, now: number): boolean {
  return o?.enabled === false || (o?.mutedUntil !== undefined && o.mutedUntil > now)
}

/** The override after a patch, or null when nothing is left in it. */
export function patchOverride(prev: AlarmOverride | undefined, patch: OverridePatch, by: string, at: number): AlarmOverride | null {
  const next: AlarmOverride = { ...(prev ?? {}), by, at }
  if (patch.threshold === null) delete next.threshold
  else if (patch.threshold !== undefined) next.threshold = patch.threshold
  if (patch.enabled !== undefined) next.enabled = patch.enabled
  if (patch.mutedUntil === null) delete next.mutedUntil
  else if (patch.mutedUntil !== undefined) next.mutedUntil = patch.mutedUntil
  if (patch.ownerTask === null) delete next.ownerTask
  else if (patch.ownerTask !== undefined) next.ownerTask = patch.ownerTask
  const empty = next.threshold === undefined && next.enabled === undefined && next.mutedUntil === undefined && next.ownerTask === undefined
  return empty ? null : next
}
