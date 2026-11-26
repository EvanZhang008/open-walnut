/**
 * The names both ends of the leader relay and the witness relay share (src/core/leader/switch/leader-relay.ts): the stream
 * purpose the leader's DaemonConnection routes to its relay door, and where a host's service listens
 * for this machine's processes. No imports beyond node: the daemon connection and the host replica
 * load it with the experiment off, and it carries no switch code.
 */
import path from 'node:path'
import { createHash } from 'node:crypto'

/** A unix socket path's limit (sun_path): a host's service refuses to serve the relay on a longer one. */
export const RELAY_SOCKET_MAX_BYTES = 103

/** The purpose of a relay stream: the leader takes only these into its relay door (never its tunnel port). */
export const LEADER_RELAY_PURPOSE = 'leader-relay'
/**
 * The purpose of a witness relay stream (src/core/leader/switch/witness-relay.ts): a host's service parks it at the
 * companion over its bridge, and the companion takes it into its relay hub, never into its own port.
 */
export const WITNESS_RELAY_PURPOSE = 'witness-relay'

/** Under the host daemon's dir, beside `host-call/`. */
export const LEADER_RELAY_SOCKET_DIR = 'leader-relay'

/** The socket of this Walnut's relay on this machine: one per Walnut id (its sha256, 16 hex). */
export function leaderRelaySocketPath(daemonDir: string, walnutId: string): string {
  const name = createHash('sha256').update(walnutId, 'utf8').digest('hex').slice(0, 16)
  return path.join(path.resolve(daemonDir), LEADER_RELAY_SOCKET_DIR, `${name}.sock`)
}

/** Beside the socket: why this machine's service does not serve the relay (written when it refused, removed when it listens). */
export function leaderRelayWhyPath(socketPath: string): string {
  return `${socketPath}.why`
}
