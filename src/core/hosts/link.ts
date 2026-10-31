/**
 * The link to a host: the one way a feature reaches another machine's daemon
 * (the user, 2026-10-31: "each connection is an abstraction ... SSH direct, or
 * through a middleman like the companion that the host dials itself, it does
 * not matter, as long as they connect").
 *
 * A feature asks `link(host)` by name and gets the pooled daemon connection;
 * it never builds an SSH target, spawns `ssh`, or knows which way the bytes go.
 * Which way is the link's business: today this Mac's own daemon over loopback
 * (`__local__`), a host replica's own follower link (replica/self-host.ts, inside
 * getDaemonConnection), or the SSH tunnel; the companion relay, where a host
 * dials out and nothing dials it, comes as one more route behind the same call.
 *
 * `linkTarget` is the one place a host's config becomes a transport target.
 * Before it, ~25 call sites each built their own `{hostname, user, port}`, some
 * without `shell_setup`, and the pool keeps the target of whichever caller
 * dialled first, so a host's daemon could be deployed without its shell setup
 * depending on which panel was opened first.
 *
 * Ratchet: tests/core/hosts/link-ratchet.test.ts fails when a file outside the
 * transports dials a daemon with an SSH target of its own or spawns ssh.
 */
import type { SshTarget } from '../../providers/session-io.js'
import type { DaemonConnection } from '../../providers/daemon-connection.js'
import type { Config } from '../types.js'

const LOCAL_LINK = '__local__'

export class UnknownHostError extends Error {
  constructor(public host: string) {
    super(`Unknown host: ${host}`)
    this.name = 'UnknownHostError'
  }
}

function isLocal(host: string | undefined | null): boolean {
  return !host || host === LOCAL_LINK || host === 'local'
}

/** The transport target for a host, from config: the only place one is built. */
export function linkTarget(host: string, config: Pick<Config, 'hosts'>): SshTarget {
  if (isLocal(host)) return { hostname: LOCAL_LINK }
  // hasOwn, not `hosts[host]`: `__proto__` / `constructor` are truthy lookups.
  const hosts = config.hosts ?? {}
  const def = (Object.hasOwn(hosts, host) ? hosts[host] : undefined) as (NonNullable<Config['hosts']>[string] & { ssh?: unknown }) | undefined
  if (!def) throw new UnknownHostError(host)
  // `ssh` is an older spelling of hostname some configs still carry; with neither,
  // the alias itself (an ~/.ssh/config Host entry resolves it), as most callers did.
  const hostname = def.hostname || (typeof def.ssh === 'string' && def.ssh ? def.ssh : host)
  return {
    hostname,
    ...(def.user ? { user: def.user } : {}),
    ...(def.port ? { port: def.port } : {}),
    ...(def.shell_setup ? { shell_setup: def.shell_setup } : {}),
  }
}

// getConfig reads and parses config.yaml on every call, and a file reader asks for
// its link once per read: a remote host's target is reused for a few seconds.
const TARGET_TTL_MS = 5_000
const targets = new Map<string, { target: SshTarget; at: number }>()

async function remoteTarget(key: string): Promise<SshTarget> {
  const hit = targets.get(key)
  if (hit && Date.now() - hit.at < TARGET_TTL_MS) return hit.target
  const { getConfig } = await import('../config-manager.js')
  const target = linkTarget(key, await getConfig())
  targets.set(key, { target, at: Date.now() })
  return target
}

/** The pooled daemon connection to `host`, dialled if it is not up. Rejects with a link failure when no route answers. */
export async function link(host: string): Promise<DaemonConnection> {
  const key = isLocal(host) ? LOCAL_LINK : host
  const [dc, { isSelfHost }] = await Promise.all([
    import('../../providers/daemon-connection.js'), import('../../replica/self-host.js'),
  ])
  // This machine's own daemon, over loopback: no config to read.
  if (key === LOCAL_LINK) return dc.getDaemonConnection(key, { hostname: LOCAL_LINK })
  // A host replica reaches its own host through its follower link (getDaemonConnection
  // answers that before any target is read), and its config copy may not list itself.
  if (isSelfHost(key)) return dc.getDaemonConnection(key, { hostname: key })
  return dc.getDaemonConnection(key, await remoteTarget(key))
}

/** Tests: forget the cached targets. */
export function resetLinkTargetsForTest(): void {
  targets.clear()
}
