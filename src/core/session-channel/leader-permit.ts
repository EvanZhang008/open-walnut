/**
 * The one read of the write permission's record number for the session channel (channel.ts
 * PermitPair): every leader-side place that tells a host its standing (the channel's resume, the
 * door's welcome, an issued credential, a doors update) reads it here, and nowhere else reads
 * `record.number` for the channel (tests/core/session-channel/leader-permit.test.ts).
 *
 * Today: the running permit's record number, 0 while the permit system is off. The switch's
 * modules load only behind the experiment switchable_leader
 * (tests/core/leader/switch/flag-off-imports.test.ts), so this file imports none of them: the
 * leader side (leader-boot.ts) hands it the switch's own reader, from its dynamic import. The
 * leader switch will make this the last number this machine persisted when the system is off, so
 * a host that saw (n, e) never sees (0, e') from the same leader.
 */
import type { currentLeaderPermit } from '../leader/switch/boot.js'

let read: typeof currentLeaderPermit | null = null

/** The leader side's wiring (and tests): where the running permit is read from; null: none. */
export function setLeaderPermitReader(fn: typeof currentLeaderPermit | null): void {
  read = fn
}

export function leaderPermitNumberForHosts(): number {
  return read?.()?.runtime.status().record?.number ?? 0
}
