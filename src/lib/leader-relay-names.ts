/**
 * The names both ends of the leader relay share (src/core/leader/switch/leader-relay.ts): the stream
 * purpose the leader's DaemonConnection routes to its relay door, and where a host's service listens
 * for this machine's processes. No imports beyond node: the daemon connection and the host replica
 * load it with the experiment off, and it carries no switch code.
 */
import path from 'node:path'
import { createHash } from 'node:crypto'

/** The purpose of a relay stream: the leader takes only these into its relay door (never its tunnel port). */
export const LEADER_RELAY_PURPOSE = 'leader-relay'
/** Under the host daemon's dir, beside `host-call/`. */
export const LEADER_RELAY_SOCKET_DIR = 'leader-relay'

/** The socket of this Walnut's relay on this machine: one per Walnut id (its sha256, 16 hex). */
export function leaderRelaySocketPath(daemonDir: string, walnutId: string): string {
  const name = createHash('sha256').update(walnutId, 'utf8').digest('hex').slice(0, 16)
  return path.join(path.resolve(daemonDir), LEADER_RELAY_SOCKET_DIR, `${name}.sock`)
}
