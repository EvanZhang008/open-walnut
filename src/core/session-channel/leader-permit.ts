/**
 * The one read of the write permission's record number for the session channel (channel.ts
 * PermitPair): every leader-side place that tells a host its standing (the channel's resume, the
 * door's welcome, an issued credential, a doors update) reads it here, and nowhere else reads
 * `record.number` for the channel (tests/core/session-channel/leader-permit.test.ts).
 *
 * Today: the running permit's record number, 0 while the permit system is off. The leader switch
 * will make it the last number this machine persisted when the system is off, so a host that saw
 * (n, e) never sees (0, e') from the same leader.
 */
import { currentLeaderPermit } from '../leader/switch/boot.js'

export function leaderPermitNumberForHosts(): number {
  return currentLeaderPermit()?.runtime.status().record?.number ?? 0
}
