/**
 * The socket doors a leader opens that are no capability's: a capability is what a replica offers
 * (capabilities.ts), and the leader (the Mac) has none. Each door here is declared with the one
 * credential that opens it, as a manifest's door is (capabilities/manifest.ts Entrance), and is
 * shut until the code that serves it opens it in this process (setLeaderDoorOpen): the upgrade
 * handler finds it through openSocketDoor like any other door, and
 * tests/core/capability-manifests.test.ts holds its declaration exact against the code.
 */
import type { Entrance } from './capabilities/manifest.js'

export const LEADER_DOORS: readonly Entrance[] = [
  {
    path: '/host-door',
    opensWith: 'A host of this leader dialing in to run its session channel. The upgrade carries no secret; the host and this leader each prove they hold the key S this leader issued that host over its own daemon link (auth.json, issuer leader, named host-<machineId>, bound to a host still in the config) with an HMAC over both sides\' fresh nonces, and nothing else is taken from the socket until the host\'s proof passed. Open only on the leader while the experiment host_runs_sessions is on.',
    verifiedIn: 'src/core/session-channel/host-door.ts',
    check: 'proofsEqual(expected, f.proof)',
  },
]

const open = new Set<string>()

/** Open or shut a leader door in this process (the code that serves it). */
export function setLeaderDoorOpen(path: string, on: boolean): void {
  if (!LEADER_DOORS.some((d) => d.path === path)) throw new Error(`${path} is not a leader door`)
  if (on) open.add(path)
  else open.delete(path)
}

/** The leader door at `path` when it is open in this process, else null. */
export function openLeaderDoor(path: string): Entrance | null {
  return open.has(path) ? LEADER_DOORS.find((d) => d.path === path) ?? null : null
}
