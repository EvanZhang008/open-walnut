/**
 * How DaemonConnection reaches a `transport: net` host (docs/reference/host-network.md):
 * this Mac's own walnut-net (supervised by its local daemon, providers/net-core.ts)
 * opens a loopback port that carries one connection to that machine's daemon, direct
 * or through the user's relay. The daemon on the far side only lets in members, so the
 * port is the whole route: no SSH, no tunnel of ours.
 */
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
