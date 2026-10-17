/**
 * The rows a host replica holds against the Mac's copy rounds
 * (docs/plan/walnut-replica-servers-impl.md, section 4 "Hold after ack" and
 * section 5): a row a journal record wrote while the Mac was away stays held
 * while the record is pending in this host's journal, so a copy round never
 * swaps the overlay's base under it (and the held count makes the Mac send its
 * manifest again 35 s later). The companion has its own held sources (its task
 * queue, delete tombstones, recent local writes: core/replication/task-replica-store.ts);
 * a host replica has the host daemon's journal, read by its overlay (overlay.ts).
 *
 * Once the Mac took a record (acked), the copy stores the Mac's row again; the
 * overlay keeps its mark as `awaiting copy` until a manifest later than the ack
 * stored the key (kind-follower.ts setCopyWatcher), or 10 minutes pass.
 */

import { NOTHING_HELD, type HeldSource } from '../core/replication/kind-follower.js'
import type { Overlay, OverlayKind } from './overlay.js'

let installed: Overlay | null = null

/** The overlay of this replica (away-wiring.ts); null: nothing is held (tests, any other server). */
export function installJournalOverlay(overlay: Overlay | null): void {
  installed = overlay
}

const KIND_OF: Readonly<Record<string, OverlayKind>> = { tasks: 'tasks', boards: 'boards' }

/** The keys of `kind` this host's journal holds pending now. */
export async function journalHeld(kind: string): Promise<HeldSource> {
  const k = KIND_OF[kind]
  if (!installed || !k) return NOTHING_HELD
  const held = installed.heldKeys(k)
  if (!held.size) return NOTHING_HELD
  return { has: (id) => held.has(id), orderWriteRecent: () => false }
}
