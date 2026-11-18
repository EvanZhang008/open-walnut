/**
 * A host as the person knows it, for Settings lines that are read often: where the tunnel runs
 * (GET /api/expose) and the Walnut servers this Mac keeps (GET /api/host-servers).
 *
 * One machine can sit in config.yaml under two aliases that reach one daemon: a row found in
 * ~/.ssh/config and the row the machine joined the host network as, which the person named. The
 * tunnel's always-on host is picked by hostname, so it can be the found row, and Settings said
 * "runs on <found alias>", a name the person never picked. credentialHost (credential-host.ts)
 * already answers "which alias and which name" from the daemon's own word, for the certificate
 * letters; this keeps its answer a minute, since each lookup reads host profiles and can run
 * `ssh -G`, and these routes are polled.
 */
import type { Config } from '../types.js'
import { credentialHost } from './credential-host.js'

const TTL_MS = 60_000

const kept = new Map<string, { at: number; value: { host: string; label: string } }>()
const inflight = new Map<string, Promise<{ host: string; label: string }>>()

/** What the answer depends on in config.yaml: the rows' names, whether each is on or found, and where each connects. */
function rowsKey(config: Config): string {
  return JSON.stringify(Object.entries(config.hosts ?? {}).map(([k, h]) => {
    const row = h as { label?: unknown; enabled?: unknown; discovered?: unknown; hostname?: unknown; user?: unknown; port?: unknown; endpoint?: unknown } | undefined
    return [k, row?.label ?? null, row?.enabled ?? null, row?.discovered ?? null, row?.hostname ?? null, row?.user ?? null, row?.port ?? null, row?.endpoint ?? null]
  }))
}

/** `host` as the person knows it: the alias they use for its daemon, and that alias's name. */
export async function knownHost(host: string, config: Config, now = Date.now()): Promise<{ host: string; label: string }> {
  const key = `${host}\0${rowsKey(config)}`
  const hit = kept.get(key)
  if (hit && now - hit.at < TTL_MS) return hit.value
  // Polls that miss together share one lookup (each can run `ssh -G`).
  let pending = inflight.get(key)
  if (!pending) {
    pending = credentialHost(host, config).finally(() => inflight.delete(key))
    inflight.set(key, pending)
  }
  const value = await pending
  if (kept.size > 200) kept.clear()
  kept.set(key, { at: now, value })
  return value
}

/** Test seam: forget the kept answers. */
export function resetKnownHostsForTest(): void {
  kept.clear()
  inflight.clear()
}
