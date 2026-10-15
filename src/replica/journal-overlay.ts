/**
 * The rows a host replica holds against the Mac's copy rounds
 * (docs/plan/walnut-replica-servers-impl.md, section 4 "Hold after ack" and
 * section 5): a row a journal record wrote while the Mac was away stays held
 * until the Mac's manifest has it back. The companion has its own held sources
 * (its task queue, delete tombstones, recent local writes:
 * core/replication/task-replica-store.ts); a host replica has the host
 * daemon's journal instead.
 *
 * Until WP10 lets a host replica write while the Mac is away, nothing is ever
 * journaled from here, so this overlay holds nothing. WP10 replaces the body
 * of `journalHeld` with the journal's keys for the kind (and the 10 minute
 * "awaiting copy" hold after an ack); its callers do not change.
 */

import { NOTHING_HELD, type HeldSource } from '../core/replication/kind-follower.js'

/** The keys of `kind` this host's journal holds (none until WP10). */
export async function journalHeld(_kind: string): Promise<HeldSource> {
  return NOTHING_HELD
}
