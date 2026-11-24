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
 * The link is also the one dial gate (drill round 4, R4-1): a host the person removed, turned off,
 * or a host found in ~/.ssh/config still waiting for the person's yes is never dialled from here.
 * Before it, only a host missing from config was refused (linkTarget), so a removed host that
 * ~/.ssh/config also names came back as a found row and every background caller (a session's
 * status question, its history read, a turn snapshot, a host probe) dialled it again: two seconds
 * after a Remove the leader was back on another Walnut's shared daemon, pushing its host slice,
 * triggers and replica there. The person's own Connect (host-connect-action.ts) asks the same
 * `dialRefusal` first.
 *
 * Ratchets: tests/core/hosts/link-ratchet.test.ts fails when a file outside the transports dials a
 * daemon with an SSH target of its own or spawns ssh; tests/core/hosts/link-dial-gate.test.ts fails
 * when a dial entry point skips the gate.
 */
import type { SshTarget } from '../../providers/session-io.js'
import type { DaemonConnection } from '../../providers/daemon-connection.js'
import type { Config } from '../types.js'
import { foundHostWaits, type FoundFlags } from './found-hosts.js'

const LOCAL_LINK = '__local__'

/** Why Walnut does not dial a host: not in config, turned off, or found and waiting for the yes. */
export type HostRefusal = 'unknown' | 'off' | 'waiting'

const REFUSAL_WORDS: Record<HostRefusal, (host: string) => string> = {
  unknown: (host) => `Unknown host: ${host}`,
  off: (host) => `${host} is turned off in Settings > Remote Hosts: Walnut does not connect to it`,
  waiting: (host) => `${host} was found in ~/.ssh/config and waits for a yes on Remote Hosts: Walnut does not connect to it`,
}

/** A host Walnut does not reach. One name for every reason, so a caller that stops on an unknown host stops on these too. */
export class UnknownHostError extends Error {
  constructor(public host: string, public why: HostRefusal = 'unknown') {
    super(REFUSAL_WORDS[why](host))
    this.name = 'UnknownHostError'
  }
}

/**
 * The dial gate's rule for one config row: null when Walnut may dial it. A found host waiting for the
 * person's yes reads as off anyway (found-hosts.ts applyFoundHostAnswers); it is named first so its
 * words say where the yes is given.
 */
export function dialRefusal(def: (FoundFlags & { enabled?: unknown }) | null | undefined): Exclude<HostRefusal, 'unknown'> | null {
  if (!def) return null
  if (foundHostWaits(def)) return 'waiting'
  if (def.enabled === false) return 'off'
  return null
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
  // A machine on the host network: no SSH target at all, only its network id.
  if (def.transport === 'net') {
    return {
      hostname, via: 'net',
      ...(typeof def.endpoint === 'string' ? { endpoint: def.endpoint.toLowerCase() } : {}),
      // Its sessions run the host's shell_setup too (each start carries it: start-shell-setup-v1).
      ...(def.shell_setup ? { shell_setup: def.shell_setup } : {}),
    }
  }
  // A found host is keyed by its ~/.ssh/config alias; only a plain token, never read as an ssh option.
  const sshAlias = def.discovered === true && /^[A-Za-z0-9_][A-Za-z0-9._-]*$/.test(host) ? host : undefined
  return {
    hostname,
    ...(sshAlias ? { sshAlias } : {}),
    ...(def.user ? { user: def.user } : {}),
    ...(def.port ? { port: def.port } : {}),
    ...(def.shell_setup ? { shell_setup: def.shell_setup } : {}),
  }
}

// getConfig reads and parses config.yaml on every call, and a file reader asks for
// its link once per read: a remote host's target (or its refusal) is reused for a few
// seconds. A host that leaves Settings forgets it at once (host-link-end.ts), and so does a
// person's Connect (host-connect-action.ts).
const TARGET_TTL_MS = 5_000
const targets = new Map<string, { target: SshTarget; refusal: HostRefusal | null; at: number }>()

async function remoteTarget(key: string): Promise<SshTarget> {
  let hit = targets.get(key)
  if (!hit || Date.now() - hit.at >= TARGET_TTL_MS) {
    const { getConfig } = await import('../config-manager.js')
    const config = await getConfig()
    const hosts = config.hosts ?? {}
    const target = linkTarget(key, config)
    hit = { target, refusal: dialRefusal(Object.hasOwn(hosts, key) ? hosts[key] : undefined), at: Date.now() }
    targets.set(key, hit)
  }
  if (hit.refusal) throw new UnknownHostError(key, hit.refusal)
  return hit.target
}

/**
 * The pooled daemon connection to `host`, dialled if it is not up. Rejects with a link failure when no
 * route answers, and with UnknownHostError, before any dial, for a host Walnut does not reach (dialRefusal).
 */
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

/** A transport change must not redial the alias using a cached SSH target. */
export function forgetLinkTarget(host: string): void {
  targets.delete(host)
}

/** Tests: forget the cached targets. */
export function resetLinkTargetsForTest(): void {
  targets.clear()
}
