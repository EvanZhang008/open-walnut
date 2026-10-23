/**
 * The one host-server manager of this (primary) server, wired to the real
 * config, daemon connections, tunnel port and copy targets (manager.ts says
 * what it does). A replica runs none.
 */

import path from 'node:path'
import { CLOUD_MODE, WALNUT_HOME } from '../../constants.js'
import { log } from '../../logging/index.js'
import type { CloudReplicaReply } from '../cloud-ingest.js'
import { createHostServerManager, type HostServerHost, type HostServerManager, type HostServerSettings, type HostServerView } from './manager.js'
import { createHostFileSource, type HostFileSource } from './host-file.js'
import { getExposeProvider, onExposeProvidersChanged, type CommandProviderConfig } from '../expose/registry.js'
import { exposePlacement, tunnelKey, type PlacementHost } from '../expose/placement.js'
import { COMMAND_PROVIDER_ID, type ExposeProviderDefinition } from '../expose/types.js'

let manager: HostServerManager | null = null
let unsubscribe: (() => void) | null = null
let fileSource: HostFileSource | null = null

/** How long a burst of view changes waits before the tunnel handover looks again. */
const TUNNEL_RECHECK_MS = 500
/** Per host, the tunnel its server last reported, as the handover reads it. */
const tunnelSeen = new Map<string, string>()
let tunnelRecheck: ReturnType<typeof setTimeout> | null = null

/**
 * A host's view changed: when the tunnel its server reports did (its state, address, which
 * one, since when), this computer's tunnel runtime looks at the handover again
 * (web/expose-runtime.ts). Debounced, and the runtime's look changes no view: no loop.
 */
export function noteHostViewForTunnel(view: Pick<HostServerView, 'hostKey' | 'phase' | 'server'>): void {
  const e = view.phase === 'running' ? view.server?.expose : undefined
  const seen = e ? [e.provider, e.state, e.url ?? '', e.tunnelKey ?? '', e.since].join('|') : ''
  if ((tunnelSeen.get(view.hostKey) ?? '') === seen) return
  tunnelSeen.set(view.hostKey, seen)
  if (tunnelRecheck) return
  tunnelRecheck = setTimeout(() => {
    tunnelRecheck = null
    void import('../../web/expose-runtime.js')
      .then(({ getExposeRuntime }) => getExposeRuntime()?.reconcile())
      .catch((err) => log.web.warn('expose: the handover check failed', { error: err instanceof Error ? err.message : String(err) }))
  }, TUNNEL_RECHECK_MS)
  tunnelRecheck.unref?.()
}

/** The settings of one host's server, defaults filled in. */
export function hostServerSettingsFrom(raw: unknown, program?: unknown): HostServerSettings {
  // `node` and `build_env` of older configs are not read: the host runs the compiled walnut file.
  const s = (raw && typeof raw === 'object' ? raw : {}) as {
    enabled?: unknown
    expose?: { enabled?: unknown; provider?: unknown; options?: unknown }
    copies?: unknown
    ask_bypass?: unknown
  }
  const copies: Record<string, boolean> = {}
  for (const [k, v] of Object.entries(s.copies && typeof s.copies === 'object' ? s.copies : {})) {
    if (typeof v === 'boolean') copies[k] = v
  }
  const options: Record<string, string> = {}
  for (const [k, v] of Object.entries(s.expose?.options && typeof s.expose.options === 'object' ? s.expose.options : {})) {
    if (typeof v === 'string') options[k] = v
  }
  return {
    enabled: s.enabled === true,
    expose: {
      enabled: s.expose?.enabled === true,
      provider: typeof s.expose?.provider === 'string' && s.expose.provider ? s.expose.provider : null,
      options,
    },
    // The host's program: 'host-server' keeps the plain host server (the D13 rollback); unset runs the replica where the daemon can.
    ...(program === 'replica' || program === 'host-server' ? { program } : {}),
    // The host's choice of copied kinds (replication/kinds/copy-kind.ts fills the defaults).
    ...(Object.keys(copies).length > 0 ? { copies } : {}),
    // A new ask away may start in bypassPermissions there (WP12; off unless set).
    ...(s.ask_bypass === true ? { askBypass: true } : {}),
  }
}

/** The fields of config.yaml the tunnel placement reads. */
interface TunnelConfig {
  expose?: { enabled?: boolean; provider?: string; options?: Record<string, string>; run_on?: string; command?: CommandProviderConfig }
  hosts?: Record<string, PlacementHost>
}

/**
 * Whether `hostKey` may carry this Walnut's tunnel while its provider is not registered (so
 * its always-on pattern is unknown): the host it was placed on, or with no place picked, any
 * host it could be (not hidden, its server not turned off by hand). The built-in command
 * provider always runs here.
 */
function mayCarryUnknownTunnel(hostKey: string, e: NonNullable<TunnelConfig['expose']>, hosts: TunnelConfig['hosts']): boolean {
  if (e.provider === COMMAND_PROVIDER_ID) return false
  const chosen = typeof e.run_on === 'string' ? e.run_on.trim() : ''
  if (chosen) return chosen === hostKey
  const host = hosts && Object.hasOwn(hosts, hostKey) ? hosts[hostKey] : undefined
  return !!host && !host.cloud_box && host.enabled !== false && host.server?.enabled !== false
}

/**
 * One host's server settings with this Walnut's tunnel placed (expose/placement.ts):
 * the host that carries it runs a server (whatever its own switch says) and that
 * tunnel, with this computer's provider and options. Any other host's own tunnel
 * that would hold the same address is held back, wherever this one runs: the
 * service gives a name to whoever connected last, so the two would take it from
 * each other.
 */
export function withThisWalnutTunnel(
  hostKey: string,
  settings: HostServerSettings,
  config: TunnelConfig,
  lookup: (id: string, command?: CommandProviderConfig) => ExposeProviderDefinition | null = getExposeProvider,
): HostServerSettings {
  const e = config.expose
  if (e?.enabled !== true || !e.provider) return settings
  const def = lookup(e.provider, e.command)
  if (!def) {
    // Not registered now (a plugin still loading, or one that failed): where it runs is not
    // known, so a host that may carry it is left as it was, its tunnel with it.
    return mayCarryUnknownTunnel(hostKey, e, config.hosts) ? { ...settings, keepAsConfigured: `the tunnel provider "${e.provider}" is not registered` } : settings
  }
  const placed = exposePlacement(e.run_on, def, config.hosts)
  if (placed.where === 'host' && placed.hostKey === hostKey) {
    return { ...settings, enabled: true, carriesTunnel: true, expose: { enabled: true, provider: e.provider, options: { ...(e.options ?? {}) } } }
  }
  // Wherever this Walnut's tunnel runs (here, or on another host), this host's own must not take its address.
  const own = settings.expose
  if (settings.enabled && own.enabled && own.provider === def.id && tunnelKey(def, own.options) === tunnelKey(def, e.options ?? {})) {
    return { ...settings, expose: { ...own, enabled: false, blocked: 'It would use the same address as this computer\'s tunnel; give it another name.' } }
  }
  return settings
}

/**
 * The one source of this server's walnut file for a host's target (host-file.ts):
 * the host servers, the session daemon a compiled Mac deploys to a host
 * (providers/daemon-connection.ts), and the companion share its cache and batching.
 */
export function sharedHostFileSource(): HostFileSource {
  return (fileSource ??= createHostFileSource({ cacheDir: path.join(WALNUT_HOME, 'cache', 'host-server') }))
}

/** The root of a host's Walnut server install on the host (install.ts HOST_ROOT, or the WALNUT_HOST_SERVER_ROOT knob). */
export function hostServerRootSpec(): string | undefined {
  return process.env.WALNUT_HOST_SERVER_ROOT?.trim() || undefined
}

export function getHostServerManager(): HostServerManager | null {
  if (CLOUD_MODE) return null
  if (manager) return manager
  manager = createHostServerManager({
    settingsOf: async (hostKey) => {
      // A host can connect before the plugins load (or while one reloads): a tunnel provider
      // that is seconds away would read as gone, and the host's server would drop the tunnel it
      // carries, then start it again. Its settings wait for the plugin set to settle.
      const { registry } = await import('../integration-registry.js')
      await registry.waitForPlugins(60_000)
      const { getConfig } = await import('../config-manager.js')
      const config = await getConfig()
      const host = config.hosts?.[hostKey]
      return host ? withThisWalnutTunnel(hostKey, hostServerSettingsFrom(host.server, host.server_program), config) : null
    },
    label: async (hostKey) => {
      const { getConfig } = await import('../config-manager.js')
      return (await getConfig()).hosts?.[hostKey]?.label?.trim() || hostKey
    },
    walnutId: async () => (await import('../device-auth.js')).getInstanceId(),
    home: WALNUT_HOME,
    holdTunnelPort: async (holder) => {
      const { getExposeRuntime } = await import('../../web/expose-runtime.js')
      const runtime = getExposeRuntime()
      if (!runtime) throw new Error('this server has no tunnel port (it is still starting)')
      return runtime.holdTunnelPort(holder)
    },
    releaseTunnelPort: async (holder) => {
      const { getExposeRuntime } = await import('../../web/expose-runtime.js')
      await getExposeRuntime()?.releaseTunnelPort(holder)
    },
    hostFile: sharedHostFileSource(),
    stateFile: path.join(WALNUT_HOME, 'host-servers.json'),
    // Machine-local: local/ is never synced (another machine's counts would restart the hosts' tunnels).
    retryFile: path.join(WALNUT_HOME, 'local', 'host-server-tunnel-retries.json'),
    now: Date.now,
    // The tunnel handover follows what the host's server reports (expose-runtime.ts).
    changed: noteHostViewForTunnel,
    // Stopping: the plugins are disposed before the hosts' links close, and a host must keep its tunnel.
    frozen: async () => (await import('../integration-registry.js')).registry.isClosing(),
    // Test and safety knobs (docs/plan/walnut-replica-servers-impl.md, WP2): another root
    // on the host, and (tests only) a local tree run in place of an installed build.
    ...(hostServerRootSpec() ? { hostRoot: hostServerRootSpec() } : {}),
    ...(process.env.WALNUT_HOST_SERVER_APP_DIR?.trim() ? { appDir: process.env.WALNUT_HOST_SERVER_APP_DIR.trim() } : {}),
    registerTarget: (hostKey, post, copies) => {
      // One id for the target and its ready: a ready under another name reaches no target.
      const id = `host:${hostKey}`
      const targets = import('../replication/replica-targets.js')
      let unregister: () => void = () => {}
      void targets.then(({ registerReplicaTarget }) => {
        unregister = registerReplicaTarget({
          id,
          kind: 'host',
          label: hostKey,
          available: async () => manager?.view(hostKey).phase === 'running',
          ...(copies ? { copies } : {}),
          // Read at each round: a rollback to the host server, or the daemon's fallback, stops the copies.
          program: () => manager?.view(hostKey).program,
          post: async (payload, opts): Promise<CloudReplicaReply> => {
            try {
              const res = await post(payload, opts)
              const json = await res.json().catch(() => null) as Record<string, unknown> | null
              if (res.ok && json) return { ok: true, reply: json }
              if (res.status === 404 || res.status === 405) {
                return { ok: false, outcome: 'unsupported', status: res.status, ...(typeof json?.error === 'string' ? { error: json.error } : {}) }
              }
              return { ok: false, outcome: 'failed', status: res.status, error: typeof json?.error === 'string' ? json.error : undefined, ...(json ? { body: json } : {}) }
            } catch (err) {
              return { ok: false, outcome: 'failed', error: err instanceof Error ? err.message : String(err) }
            }
          },
        })
      })
      return {
        unregister: () => unregister(),
        // Registered first (the same promise, its callbacks in order), so the ready finds it.
        ready: (restarted) => { void targets.then(({ replicaTargetAvailable }) => replicaTargetAvailable(id, { restarted })) },
      }
    },
  })
  // A provider that arrives (a plugin loading after the hosts connected) may place the tunnel on a host.
  const offProviders = onExposeProvidersChanged(() => { void reconcileAllHostServers() })
  const name = 'host-server-settings'
  let offBus: (() => void) | null = null
  let stopped = false
  void import('../event-bus.js').then(({ bus, EventNames }) => {
    if (stopped) return
    bus.subscribe(name, () => { void reconcileAllHostServers() }, { global: true, interest: [EventNames.CONFIG_CHANGED] })
    offBus = () => bus.unsubscribe(name)
  })
  unsubscribe = () => { stopped = true; offProviders(); offBus?.() }
  return manager
}

/**
 * Every host config.yaml names, and every one the manager has seen: a host
 * turned off, or removed from config.yaml, is torn down if it ran.
 */
export async function reconcileAllHostServers(): Promise<void> {
  const m = getHostServerManager()
  if (!m) return
  const { getConfig } = await import('../config-manager.js')
  const hosts = new Set([...Object.keys((await getConfig()).hosts ?? {}), ...m.views().map((v) => v.hostKey)])
  await Promise.all([...hosts].map((key) => m.reconcile(key).catch((err) => {
    log.session.warn('host server: reconcile failed', { host: key, error: err instanceof Error ? err.message : String(err) })
  })))
}

export function hostServerConnected(host: HostServerHost): Promise<void> {
  return getHostServerManager()?.connected(host) ?? Promise.resolve()
}

export function hostServerDisconnected(hostKey: string): void {
  manager?.disconnected(hostKey)
}

export function _resetHostServerManagerForTesting(): void {
  manager?.stop()
  unsubscribe?.()
  manager = null
  unsubscribe = null
  fileSource = null
  tunnelSeen.clear()
  if (tunnelRecheck) clearTimeout(tunnelRecheck)
  tunnelRecheck = null
}

/** The host servers' views without making the manager (GET /api/replicas/status, WP14). */
export function peekHostServerViews(): ReturnType<HostServerManager['views']> {
  return manager ? manager.views() : []
}
