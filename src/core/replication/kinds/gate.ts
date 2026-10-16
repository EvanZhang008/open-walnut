/**
 * Who keeps the WP4 copies, and what a kind turned off by the host's choice
 * leaves behind (docs/plan/walnut-replica-servers-impl.md, section 4 and WP4).
 *
 *   keepsCopies()      only the full replica program on a host (D13's per-host
 *                      opt-in, server-role.ts isHostReplicaProgram). The plain
 *                      host server (the default program and the daemon's
 *                      crash-loop fallback), the companion and the leader answer
 *                      every step of these kinds `404 unknown_kind`, as before WP4.
 *   off markers        the leader's `purge` step (a kind the host's Settings row
 *                      turned off) removes that kind's store and leaves
 *                      `cache/replica/<kind>.json` as `{v:1, off:true}`: no copy
 *                      state, and the kind answers `needs_leader {why:'kind_not_copied'}`
 *                      while the Mac is away (copyKindOff). The next manifest round
 *                      (the kind turned on again) overwrites the marker.
 */

import fsp from 'node:fs/promises'
import path from 'node:path'
import { WALNUT_HOME } from '../../../constants.js'
import { isHostReplicaProgram } from '../../server-role.js'
import { writeCopyFile, type Refusal } from '../kind-follower.js'

export function keepsCopies(): boolean {
  return isHostReplicaProgram()
}

/** Every copy kind's refusal: off the replica program `404 unknown_kind`, else the leader's own refusal. */
export async function copyRefusal(): Promise<Refusal> {
  if (!keepsCopies()) return { status: 404, error: 'unknown_kind' }
  return (await import('../task-replica-store.js')).leaderRefusal()
}

/** A copy kind's state file (cache/replica/<kind>.json). */
export function copyStateFile(kind: string): string {
  return path.join(WALNUT_HOME, 'cache', 'replica', `${kind}.json`)
}

/** The kind's store is gone by the host's choice: no copy state, an off marker. */
export async function markCopyOff(kind: string, now = Date.now()): Promise<void> {
  await writeCopyFile(copyStateFile(kind), { v: 1, off: true, at: now })
}

/** True when the host's choice turned `kind` off here (its last purge, no round since). */
export async function copyKindOff(kind: string): Promise<boolean> {
  try {
    const raw = JSON.parse(await fsp.readFile(copyStateFile(kind), 'utf8')) as { off?: unknown } | null
    return raw?.off === true
  } catch { return false }
}

/**
 * True when this host holds a copy of `kind`: a round wrote its state (an empty
 * copy of an empty store counts), and the host's choice did not turn it off.
 * A read of a kind with no copy answers needs_leader {why:'kind_not_copied'},
 * never an empty list or the defaults as if they were the user's.
 */
export async function copyKindHeld(kind: string): Promise<boolean> {
  try {
    const raw = JSON.parse(await fsp.readFile(copyStateFile(kind), 'utf8')) as { v?: unknown; off?: unknown; hashes?: unknown } | null
    return raw?.v === 1 && raw.off !== true && !!raw.hashes && typeof raw.hashes === 'object'
  } catch { return false }
}

/** The why of a read that finds no copy of its kind here. */
export const KIND_NOT_COPIED = 'kind_not_copied'
