/**
 * The primary's side of hub forwards ('hub-forward-v1', docs/reference/host-network.md, "Reaching
 * a port on the primary"). A joined machine's daemon carries a connection made on its own
 * 127.0.0.1 port (providers/hub-forward-core.ts) to this server as a stream over the link this
 * server already holds to that daemon, `stream-open {from: 'hub', port}`. Here it is taken only
 * when this Walnut's own config lists that port for that host:
 *
 *   net:
 *     hub_ports:
 *       - port: 18403
 *         hosts: [home-pc]
 *
 * or a plugin running here allowed that host on a port its manifest declares (`hubPorts`, granted
 * with `walnut.hosts.allowHubPort`, core/hosts/hub-port-grants.ts), and then the stream is plugged
 * into a connection to that port on THIS machine's 127.0.0.1. The
 * address is always 127.0.0.1: a stream that names any other is refused, and nothing a machine
 * sends picks one. The host is the link's own (the daemon this server dialled, its network key
 * proven by walnut-net), never a name the stream carries. Nothing listed: every hub stream is
 * refused, as an older Walnut refuses them. At most MAX_STREAMS_PER_HOST at once per host; every
 * open and refusal is logged with its host and port (a refusal storm at most once per 5 s, with
 * the count; a new reason always gets its line). Only the primary takes them (boot policy `hub-port-door`).
 *
 * `hubPortStatus(host)` says, per listed port, whether the machine's forward is up, when it last
 * connected and who allowed it (config.yaml or a plugin); `walnut.hosts.list()` / `get()` carry it
 * as `hub` (core/plugins/plugin-hosts.ts).
 */
import net from 'node:net'
import type { Duplex } from 'node:stream'
import { spliceStream, type IncomingStreamInfo, type StreamPlug } from '../../lib/link-stream.js'

export interface HubPortRule {
  port: number
  /** The host aliases (config.yaml `hosts`) whose machines may reach it. */
  hosts: string[]
  /** A plugin's grant (hub-port-grants.ts); absent: `net.hub_ports` in config.yaml. */
  pluginId?: string
}

/** Where a host's allowance on a port came from. */
export type HubPortAllowance = { kind: 'config' } | { kind: 'plugin'; pluginId: string }

/** The plugins' grants in force now (hub-port-grants.ts), never a reason to refuse every stream. */
async function grantRules(): Promise<HubPortRule[]> {
  try {
    return await (await import('./hub-port-grants.js')).hubPortGrantRules()
  } catch {
    return []
  }
}

/**
 * A plugin's grant counts only for a host still in Settings: one removed and added back under its
 * name is a new row the plugin has not allowed (the boot prune drops the stale grant).
 */
function forConfiguredHosts(rules: HubPortRule[], config: { hosts?: unknown } | null | undefined): HubPortRule[] {
  const hosts = (config?.hosts && typeof config.hosts === 'object' ? config.hosts : {}) as Record<string, unknown>
  return rules.map((r) => ({ ...r, hosts: r.hosts.filter((h) => Object.hasOwn(hosts, h)) })).filter((r) => r.hosts.length > 0)
}

/** `net.hub_ports` and the plugins' grants in force, together: what a stream is checked against. */
export async function allHubPortRules(config: { net?: { hub_ports?: unknown }; hosts?: unknown } | null | undefined): Promise<HubPortRule[]> {
  return [...hubPortRules(config).rules, ...forConfiguredHosts(await grantRules(), config)]
}

/** `net.hub_ports` as written, the entries it cannot use left out with why. */
export function hubPortRules(config: { net?: { hub_ports?: unknown } } | null | undefined): { rules: HubPortRule[]; problems: string[] } {
  const raw = config?.net?.hub_ports
  const rules: HubPortRule[] = []
  const problems: string[] = []
  if (raw === undefined || raw === null) return { rules, problems }
  if (!Array.isArray(raw)) return { rules, problems: ['net.hub_ports must be a list'] }
  raw.forEach((entry, i) => {
    const e = (entry && typeof entry === 'object' ? entry : {}) as { port?: unknown; hosts?: unknown }
    const port = e.port
    if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) {
      problems.push(`net.hub_ports[${i}]: port must be a TCP port (1 to 65535)`)
      return
    }
    const hosts = Array.isArray(e.hosts) ? e.hosts.filter((h): h is string => typeof h === 'string' && h.trim() !== '').map((h) => h.trim()) : []
    if (hosts.length === 0) {
      problems.push(`net.hub_ports[${i}]: hosts must name at least one host`)
      return
    }
    rules.push({ port, hosts })
  })
  return { rules, problems }
}

/** Why a hub stream from `host` must be refused, or null when the rules take it. */
export function hubStreamRefusal(rules: readonly HubPortRule[], host: string, info: Pick<IncomingStreamInfo, 'port' | 'host'>): string | null {
  const port = info.port
  if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) return 'a hub stream names a TCP port (1 to 65535)'
  if (info.host !== undefined && info.host !== '127.0.0.1') {
    return `a hub stream reaches only this Walnut's own 127.0.0.1, never ${info.host.slice(0, 80)}`
  }
  const forPort = rules.filter((r) => r.port === port)
  if (forPort.length === 0) return `port ${port} on this Walnut is not open to hub forwards (net.hub_ports, or a plugin grant)`
  if (!forPort.some((r) => r.hosts.includes(host))) return `port ${port} on this Walnut is not open to ${host} (net.hub_ports, or a plugin grant)`
  return null
}

/** What this server knows of one host's streams to one port. */
export interface HubPortRecord {
  active: number
  opened: number
  refused: number
  lastConnectedAt: number | null
  lastRefusedAt: number | null
  lastError: string | null
}

const MAX_STREAMS_PER_HOST = 32
const CONNECT_MS = 5_000
const REFUSAL_LOG_MS = 5_000

const records = new Map<string, Map<number, HubPortRecord>>()
const activeByHost = new Map<string, number>()
const refusalLog = new Map<string, { at: number; unlogged: number }>()

function recordOf(host: string, port: number): HubPortRecord {
  let byPort = records.get(host)
  if (!byPort) { byPort = new Map(); records.set(host, byPort) }
  let r = byPort.get(port)
  if (!r) {
    r = { active: 0, opened: 0, refused: 0, lastConnectedAt: null, lastRefusedAt: null, lastError: null }
    // Bounded: a host names at most this many ports here before the oldest is forgotten.
    if (byPort.size >= 64) byPort.delete(byPort.keys().next().value as number)
    byPort.set(port, r)
  }
  return r
}

export interface HubDoorDeps {
  /** This server's config (getConfig). */
  config: () => Promise<{ net?: { hub_ports?: unknown }; hosts?: unknown }>
  /** Whether this server takes hub streams at all (the primary only). */
  takes: () => boolean
  /** A connection to `port` on this machine's 127.0.0.1 (node:net, allowHalfOpen). */
  connect: (port: number, host: '127.0.0.1') => net.Socket
  log: (level: 'info' | 'warn', msg: string, data: Record<string, unknown>) => void
  now: () => number
  /**
   * Walnut's own ports on this machine (its server, its door for host servers, its session
   * daemon's socket): they trust a caller on loopback, so a hub stream never reaches one, even a
   * listed one.
   */
  walnutPorts: () => Promise<number[]>
  /** How long a connected port waits for its stream to be plugged in (the link may drop first). Default 10 s. */
  plugWaitMs?: number
  /** The plugins' grants in force (hub-port-grants.ts); default: the running plugins'. */
  pluginRules?: () => Promise<HubPortRule[]>
}

/** Walnut's own ports on this machine, which a hub stream never reaches (nor a plugin grants). */
export async function ownWalnutPorts(): Promise<number[]> {
  const [{ getSelfApiRoot }, { getExposeRuntime }, dirs, fsp, path] = await Promise.all([
    import('../../lib/self-api-root.js'), import('../../web/expose-runtime.js'), import('../../lib/daemon-dir.js'),
    import('node:fs/promises'), import('node:path'),
  ])
  const out = new Set<number>()
  const root = getSelfApiRoot()
  if (root) { try { const p = Number(new URL(root).port); if (p > 0) out.add(p) } catch { /* not a URL */ } }
  const door = getExposeRuntime()?.openPort() ?? null
  if (door) out.add(door)
  for (const dir of new Set([dirs.localDaemonDirChoice().dir, dirs.localProductionDaemonDir()])) {
    const p = Number.parseInt((await fsp.readFile(path.join(dir, 'daemon.port'), 'utf8').catch(() => '')).trim(), 10)
    if (Number.isInteger(p) && p > 0) out.add(p)
  }
  return [...out]
}

async function defaultDeps(): Promise<HubDoorDeps> {
  const [{ getConfig }, { bootPolicy }, { log }] = await Promise.all([
    import('../config-manager.js'), import('../boot-policy.js'), import('../../logging/index.js'),
  ])
  return {
    config: getConfig,
    takes: () => bootPolicy('hub-port-door'),
    connect: (port, host) => net.connect({ port, host, allowHalfOpen: true }),
    log: (level, msg, data) => log.session[level](msg, data),
    now: () => Date.now(),
    walnutPorts: ownWalnutPorts,
    pluginRules: grantRules,
  }
}

function refused(deps: HubDoorDeps, host: string, port: number | undefined, error: string): Error {
  const now = deps.now()
  if (typeof port === 'number' && Number.isInteger(port)) {
    const r = recordOf(host, port)
    r.refused += 1
    r.lastRefusedAt = now
    r.lastError = error
  }
  // A new reason always gets its line; the same one again within REFUSAL_LOG_MS is counted.
  const key = `${host}\u0000${String(port)}\u0000${error}`
  const seen = refusalLog.get(key)
  if (seen && now - seen.at < REFUSAL_LOG_MS) {
    seen.unlogged += 1
  } else {
    deps.log('warn', 'hub port: refused', { host, port, error, ...(seen?.unlogged ? { alsoRefused: seen.unlogged } : {}) })
    refusalLog.set(key, { at: now, unlogged: 0 })
    if (refusalLog.size > 512) refusalLog.delete(refusalLog.keys().next().value as string)
  }
  return new Error(error)
}

/** Connect `port` on this machine's 127.0.0.1, or the reason it could not. */
function connectLoopback(deps: HubDoorDeps, port: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    let sock: net.Socket
    try { sock = deps.connect(port, '127.0.0.1') } catch (err) { reject(err); return }
    const timer = setTimeout(() => { sock.destroy(); reject(new Error(`nothing answered on port ${port} on the primary within ${CONNECT_MS / 1000}s`)) }, CONNECT_MS)
    timer.unref?.()
    sock.once('connect', () => {
      clearTimeout(timer)
      sock.removeAllListeners('error')
      // Until the splice listens: a reset now must not throw in the server.
      sock.on('error', () => {})
      resolve(sock)
    })
    sock.once('error', (err: Error & { code?: string }) => {
      clearTimeout(timer)
      reject(new Error(err.code === 'ECONNREFUSED' ? `nothing is listening on port ${port} on the primary` : `port ${port} on the primary: ${String(err.message).slice(0, 160)}`))
    })
  })
}

/**
 * The acceptor DaemonConnection hands an incoming `from: 'hub'` stream of `host`'s link to
 * (link-stream.ts accept): it resolves to the plug once this machine's port answered, and
 * rejects with the reason the machine's daemon logs and counts otherwise.
 */
export async function acceptHubStream(host: string, info: IncomingStreamInfo, given?: HubDoorDeps): Promise<StreamPlug> {
  const deps = given ?? await defaultDeps()
  if (!deps.takes()) throw refused(deps, host, info.port, 'this Walnut server takes no hub streams (only the primary does)')
  let rules: HubPortRule[]
  let config: Awaited<ReturnType<HubDoorDeps['config']>> | null = null
  try {
    config = await deps.config()
    rules = hubPortRules(config).rules
  } catch {
    rules = []
  }
  // A config it cannot read lets no plugin grant in either.
  const granted = config ? await (deps.pluginRules ?? (async () => []))().catch(() => [] as HubPortRule[]) : []
  rules = [...rules, ...forConfiguredHosts(granted, config)]
  const why = hubStreamRefusal(rules, host, info)
  if (why) throw refused(deps, host, info.port, why)
  const port = info.port as number
  if ((await deps.walnutPorts().catch(() => [] as number[])).includes(port)) {
    throw refused(deps, host, port, `port ${port} is Walnut's own on this machine (its server or session daemon), which a hub stream never reaches`)
  }
  const active = activeByHost.get(host) ?? 0
  if (active >= MAX_STREAMS_PER_HOST) throw refused(deps, host, port, `more than ${MAX_STREAMS_PER_HOST} hub streams from ${host} at once`)
  activeByHost.set(host, active + 1)
  const r = recordOf(host, port)
  r.active += 1
  let released = false
  const release = () => {
    if (released) return
    released = true
    activeByHost.set(host, Math.max(0, (activeByHost.get(host) ?? 1) - 1))
    r.active = Math.max(0, r.active - 1)
  }
  let sock: net.Socket
  try {
    sock = await connectLoopback(deps, port)
  } catch (err) {
    release()
    throw refused(deps, host, port, (err as Error).message)
  }
  r.opened += 1
  r.lastConnectedAt = deps.now()
  deps.log('info', 'hub port: opened', { host, port, sid: info.sid })
  // The link dropped before the accept went out: the plug is never called, so nothing holds the socket.
  const unplugged = setTimeout(() => { sock.destroy(); release() }, deps.plugWaitMs ?? 10_000)
  unplugged.unref?.()
  return (stream: Duplex) => {
    clearTimeout(unplugged)
    sock.on('close', release)
    stream.on('close', release)
    spliceStream(stream, sock)
  }
}

/** One listed port of a host, as the plugin API shows it. */
export interface HubPortStatus {
  port: number
  /** This server's link to the host is up. */
  linked: boolean
  /**
   * The host's own forward to this port, from its daemon's `hub.status`; null while not known.
   * `waiting`: why it does not listen although nothing is wrong (no primary link would take its
   * connections, so its port refuses them); null from a daemon older than that.
   */
  forward: { localPort: number; listening: boolean; error: string | null; waiting: string | null } | null
  /** The host's daemon is older than hub forwards ('hub-forward-v1'): it needs an update first. */
  needsUpdate: boolean
  /** Who allowed the host on this port: config.yaml (`net.hub_ports`), a plugin's grant, or both. */
  allowedBy: HubPortAllowance[]
  /** Linked, and the host's forward listens: a connection there reaches this port now. */
  up: boolean
  active: number
  opened: number
  refused: number
  /** When a stream of the host last reached the port (ms since the epoch). */
  lastConnectedAt: number | null
  lastRefusedAt: number | null
  lastError: string | null
}

/** The part of a daemon link the status reads (DaemonConnection). */
export interface HubStatusLink {
  connected: boolean
  hasCapability(cap: string): boolean
  send(cmd: string, params?: Record<string, unknown>, timeoutMs?: number): Promise<unknown>
}

type DaemonForward = { local_port?: unknown; port?: unknown; listening?: unknown; error?: unknown; waiting?: unknown }
const VIEW_TTL_MS = 15_000
const VIEW_WAIT_MS = 1_500
const views = new Map<string, { at: number; forwards: DaemonForward[] | null; file: string | null; asking: Promise<void> | null }>()

/** The host daemon's forwards, asked at most every VIEW_TTL_MS, waited for at most VIEW_WAIT_MS. */
async function daemonForwards(host: string, link: HubStatusLink, now: number): Promise<DaemonForward[] | null> {
  let v = views.get(host)
  if (!v) { v = { at: -Infinity, forwards: null, file: null, asking: null }; views.set(host, v) }
  const view = v
  if (now - view.at >= VIEW_TTL_MS && !view.asking) {
    view.asking = link.send('hub.status', {}, 5_000).then((res) => {
      const list = (res as { forwards?: unknown } | null)?.forwards
      view.forwards = Array.isArray(list) ? list as DaemonForward[] : []
      const file = (res as { file?: unknown } | null)?.file
      view.file = typeof file === 'string' && file.startsWith('/') ? file : null
      view.at = Date.now()
    }, () => { view.at = Date.now() }).finally(() => { view.asking = null })
  }
  if (view.asking) await Promise.race([view.asking, new Promise((r) => setTimeout(r, VIEW_WAIT_MS).unref?.())])
  return view.forwards
}

/**
 * The host's own forwards file, as its daemon named it in its last `hub.status` (asked by
 * hubPortStatus for a host with a port open to it); null before that, or from a daemon that did
 * not say. A plugin that sets the host up writes this file there with `walnut.hosts.run`.
 */
export function hubForwardsFileOf(host: string): string | null {
  return views.get(host)?.file ?? null
}

/**
 * Per port `net.hub_ports` or a plugin's grant opens to `host`: whether its forward is up, its
 * last connection, and who allowed it. Reads no daemon that lacks 'hub-forward-v1' (an older one
 * says it needs an update), dials nothing, and waits at most VIEW_WAIT_MS for the daemon's own
 * word (the last one it had after).
 */
export async function hubPortStatus(host: string, opts: { config?: { net?: { hub_ports?: unknown } }; rules?: HubPortRule[]; link?: HubStatusLink | null; now?: number } = {}): Promise<HubPortStatus[]> {
  const rules = opts.rules ?? await allHubPortRules(opts.config ?? await (await import('../config-manager.js')).getConfig())
  const mine = rules.filter((r) => r.hosts.includes(host))
  const ports = mine.map((r) => r.port)
  if (ports.length === 0) return []
  const link = opts.link !== undefined ? opts.link : (await import('../../providers/daemon-connection.js')).getConnectedDaemonConnection(host)
  const linked = !!link?.connected
  const needsUpdate = linked && !link!.hasCapability('hub-forward-v1')
  const forwards = linked && !needsUpdate ? await daemonForwards(host, link!, opts.now ?? Date.now()) : null
  return [...new Set(ports)].map((port) => {
    const r = records.get(host)?.get(port)
    const f = forwards?.find((x) => x.port === port) ?? null
    const forward = f && typeof f.local_port === 'number'
      ? { localPort: f.local_port, listening: f.listening === true, error: typeof f.error === 'string' ? f.error : null, waiting: typeof f.waiting === 'string' ? f.waiting : null }
      : null
    const allowedBy: HubPortAllowance[] = []
    for (const rule of mine.filter((x) => x.port === port)) {
      const a: HubPortAllowance = rule.pluginId ? { kind: 'plugin', pluginId: rule.pluginId } : { kind: 'config' }
      if (!allowedBy.some((b) => b.kind === a.kind && (b.kind === 'config' || b.pluginId === (a as { pluginId: string }).pluginId))) allowedBy.push(a)
    }
    return {
      port, linked, forward, needsUpdate, allowedBy,
      up: linked && forward?.listening === true,
      active: r?.active ?? 0, opened: r?.opened ?? 0, refused: r?.refused ?? 0,
      lastConnectedAt: r?.lastConnectedAt ?? null, lastRefusedAt: r?.lastRefusedAt ?? null, lastError: r?.lastError ?? null,
    }
  })
}

/** Tests: forget every record. */
export function resetHubPortsForTest(): void {
  records.clear()
  activeByHost.clear()
  refusalLog.clear()
  views.clear()
}
