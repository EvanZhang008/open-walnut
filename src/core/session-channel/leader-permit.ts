/**
 * The one read of the write permission's record number for the session channel (channel.ts
 * PermitPair): every leader-side place that tells a host its standing (the channel's resume, the
 * door's welcome, an issued credential, a doors update) reads it here, and nowhere else reads
 * `record.number` for the channel (tests/core/session-channel/leader-permit.test.ts).
 *
 * Today: the running permit's record number, 0 while the permit system is off. The switch's
 * modules load only when the permit really runs
 * (tests/core/leader/switch/flag-off-imports.test.ts, the rehearsal's no-witness check), so neither
 * this file nor the leader side (leader-boot.ts) imports any of them: the server hands this file the
 * switch's own reader once the permit booted (web/server.ts, beside leaderPermitAtBoot). The
 * leader switch will make this the last number this machine persisted when the system is off, so
 * a host that saw (n, e) never sees (0, e') from the same leader.
 */
import type { currentLeaderPermit } from '../leader/switch/boot.js'

let read: typeof currentLeaderPermit | null = null

/** The leader side's wiring (and tests): where the running permit is read from; null: none. */
export function setLeaderPermitReader(fn: typeof currentLeaderPermit | null): void {
  read = fn
}

/** The running permit, or null while none runs (the system off, or no witnesses set). */
export function runningLeaderPermit(): ReturnType<typeof currentLeaderPermit> {
  return read?.() ?? null
}

export function leaderPermitNumberForHosts(): number {
  return runningLeaderPermit()?.runtime.status().record?.number ?? 0
}
