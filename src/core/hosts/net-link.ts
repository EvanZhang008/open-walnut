/**
 * How DaemonConnection reaches a `transport: net` host (docs/reference/host-network.md):
 * this Mac's own walnut-net (supervised by its local daemon, providers/net-core.ts)
 * opens a loopback port that carries one connection to that machine's daemon, direct
 * or through the user's relay. The daemon on the far side only lets in members, so the
 * port is the whole route: no SSH, no tunnel of ours.
 */
import { log } from '../../logging/index.js'
import { link } from './link.js'

const FORWARD_TIMEOUT_MS = 30_000

/** A loopback port on this machine that reaches `endpoint`'s daemon. */
export async function netForwardPort(endpoint: string, host: string): Promise<number> {
  const local = await link('__local__')
  if (!local.hasCapability('net-v1')) {
    throw new Error(`${host} is on the host network, and this machine's Walnut daemon has no host network yet; restart Walnut to update it`)
  }
  const r = await local.send('net.forward', { to: endpoint }, FORWARD_TIMEOUT_MS) as { ok?: boolean; port?: number; error?: string }
  if (!r.ok || !Number.isInteger(r.port) || (r.port ?? 0) <= 0) {
    throw new Error(`Host network: ${host} did not answer (${r.error ?? 'no route'})`)
  }
  return r.port as number
}

const STATUS_TIMEOUT_MS = 5_000

/**
 * Whether this machine's walnut-net holds a live link to `endpoint` now (the rule net-seen.ts
 * reads), or null when it cannot say. The forward port opens before any dial: walnut-net dials
 * the machine when a connection comes in and drops that connection when the dial fails, so a
 * failed dial leaves no link behind.
 */
export async function netPeerLinked(endpoint: string): Promise<boolean | null> {
  try {
    const local = await link('__local__')
    const s = await local.send('net.status', {}, STATUS_TIMEOUT_MS) as { node?: { peers?: Array<{ id?: string; link?: { path?: string } }> } | null }
    if (!s.node) return null
    const l = s.node.peers?.find((p) => p.id === endpoint)?.link
    return !!l && l.path !== undefined && l.path !== 'none'
  } catch { return null }
}

/**
 * The words for a socket through the forward port that failed before the daemon's hello. All
 * the socket says is a reset on a 127.0.0.1 port (2026-11-04: an offline PC read "WebSocket
 * connection failed: ECONNRESET (url=ws://127.0.0.1:59788)", filed as "the session daemon did
 * not start"), so walnut-net is asked whether it reached the machine at all.
 */
export async function explainNetDialFailure(err: unknown, endpoint: string, host: string, linked = netPeerLinked): Promise<Error> {
  const raw = err instanceof Error ? err : new Error(String(err))
  const up = await linked(endpoint)
  // The socket's own words go to the log; the sentence is what every surface shows.
  if (up !== null) log.session.info('net: a dial through the forward port failed', { host, linked: up, error: raw.message })
  if (up === false) return new Error(`${host} is not online on the host network: this machine could not reach it`)
  if (up === true) return new Error(`Host network: ${host} is reachable, but the Walnut daemon there did not answer (is Walnut running there?)`)
  return raw
}
