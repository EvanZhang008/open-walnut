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
    opensWith: 'A host of this leader dialing in to run its session channel: only a door credential this leader issued that host over its own daemon link (auth.json, issuer leader, named host-<machineId>), as Authorization: Bearer or a walnut.bearer. subprotocol entry, never in the URL; the host\'s hello must then name this Walnut and the credential\'s machine. Open only on the leader while the experiment host_runs_sessions is on.',
    verifiedIn: 'src/core/session-channel/host-door.ts',
    check: 'await verifyHostCredential(presented.token)',
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
