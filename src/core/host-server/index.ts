/**
 * The one host-server manager of this (primary) server, wired to the real
 * config, daemon connections, tunnel port and copy targets (manager.ts says
 * what it does). A replica runs none.
 */

import path from 'node:path'
import { IS_DEMO, WALNUT_HOME } from '../../constants.js'
import type { FollowerFact } from '../../providers/one-service-mode.js'
import { log } from '../../logging/index.js'
import { isFollower } from '../server-role.js'
import type { CloudReplicaReply } from '../cloud-ingest.js'
import { HOST_SERVERS_FILE } from './own-follower-dirs.js'
import { createHostServerManager, type HostServerHost, type HostServerManager, type HostServerSettings, type HostServerView } from './manager.js'
import { createHostFileSource, type HostFileSource } from './host-file.js'
import { resolveDaemonSourceVersion } from '../../providers/daemon-version-resolve.js'
import { DEFAULT_UPDATE_MAX_BEHIND_MS, DEFAULT_UPDATE_QUIET_MS, minutesFromEnv } from './update-hold.js'
import { getExposeProvider, onExposeProvidersChanged, type CommandProviderConfig } from '../expose/registry.js'
import { exposePlacement, tunnelKey, type PlacementHost } from '../expose/placement.js'
import { COMMAND_PROVIDER_ID, type ExposeProviderDefinition } from '../expose/types.js'
import { followerOnByDefault, followerOnEveryHost } from './follower-default.js'
import { onPluginsKeepingTasksChanged } from '../plugins/plugin-task-visibility.js'

let manager: HostServerManager | null = null
let unsubscribe: (() => void) | null = null
let fileSource: HostFileSource | null = null

/** How long a burst of view changes waits before the tunnel handover looks again. */
const TUNNEL_RECHECK_MS = 500
/** A burst of plugin loads changes the set of plugins that keep their tasks once per this wait. */
export const KEEPING_RECONCILE_MS = 2_000
/** And never later than this after the first change, however long the burst goes on. */
export const KEEPING_RECONCILE_MAX_MS = 10_000

/**
 * `fn` once a burst of kicks settles (`waitMs` with no new kick), and at the latest `maxWaitMs`
 * after the burst's first kick, so kicks that never stop cannot hold it back forever.
 */
export function settledCall(fn: () => void, waitMs: number, maxWaitMs: number): { kick(): void; cancel(): void } {
  let timer: ReturnType<typeof setTimeout> | null = null
  let firstAt = 0
  const cancel = () => { if (timer) clearTimeout(timer); timer = null; firstAt = 0 }
  return {
    kick() {
      const now = Date.now()
      if (!timer) firstAt = now
      else clearTimeout(timer)
      timer = setTimeout(() => { cancel(); fn() }, Math.max(0, Math.min(waitMs, firstAt + maxWaitMs - now)))
      timer.unref?.()
    },
    cancel,
  }
}
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

/**
 * The settings of one host's server, defaults filled in. `onByDefault` (follower-default.ts
 * followerOnByDefault): what a switch the person never set reads as.
 */
export function hostServerSettingsFrom(raw: unknown, program?: unknown, onByDefault = false): HostServerSettings {
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
  // Only a switch the person never set follows the default; a stored false stays off.
  const byDefault = typeof s.enabled !== 'boolean' && onByDefault
  return {
    enabled: s.enabled === true || byDefault,
    ...(byDefault ? { byDefault: true } : {}),
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
    // The tunnel puts it there, not the default: no gate keeps it off (manager.ts firstOnByDefault).
    const { byDefault: _byDefault, ...own } = settings
    return { ...own, enabled: true, carriesTunnel: true, expose: { enabled: true, provider: e.provider, options: { ...(e.options ?? {}) } } }
  }
  // Wherever this Walnut's tunnel runs (here, or on another host), this host's own must not take its address.
  const own = settings.expose
  if (settings.enabled && own.enabled && own.provider === def.id && tunnelKey(def, own.options) === tunnelKey(def, e.options ?? {})) {
    return { ...settings, expose: { ...own, enabled: false, blocked: 'It would use the same address as this computer\'s tunnel; give it another name.' } }
  }
  return settings
}

/**
 * Whether this host is dialled for its server: the person's own switch turned on, or this
 * computer's tunnel placed there. The server starts only on a connect to the host, so such a
 * host is dialled at startup even when it is known only from ~/.ssh/config (hosts/host-warmup.ts
 * `standing`). A follower that is on only by default (follower-default.ts) dials nothing: it
 * starts on the connect the host gets anyway.
 */
export function hostRunsServer(
  hostKey: string,
  config: TunnelConfig,
  lookup: (id: string, command?: CommandProviderConfig) => ExposeProviderDefinition | null = getExposeProvider,
): boolean {
  const host = config.hosts && Object.hasOwn(config.hosts, hostKey) ? config.hosts[hostKey] : undefined
  if (!host || host.enabled === false) return false
  return withThisWalnutTunnel(hostKey, hostServerSettingsFrom(host.server), config, lookup).enabled === true
}

/**
 * The one source of this server's walnut file for a host's target (host-file.ts):
 * the host servers, the session daemon a compiled Mac deploys to a host
 * (providers/daemon-connection.ts), and the companion share its cache and batching.
 */
export function sharedHostFileSource(): HostFileSource {
  return (fileSource ??= createHostFileSource({
    cacheDir: path.join(WALNUT_HOME, 'cache', 'host-server'),
    // The daemon a host gets must be the one this server expects of it, or the host refuses the upload.
    daemonVersion: () => resolveDaemonSourceVersion(),
  }))
}

/** The root of a host's Walnut server install on the host (install.ts HOST_ROOT, or the WALNUT_HOST_SERVER_ROOT knob). */
export function hostServerRootSpec(): string | undefined {
  return process.env.WALNUT_HOST_SERVER_ROOT?.trim() || undefined
}

const viewListeners = new Set<(view: HostServerView) => void>()

/** Every change of a host server's view (its phase, its last report). Returns the stop. */
export function onHostServerView(fn: (view: HostServerView) => void): () => void {
  viewListeners.add(fn)
  return () => { viewListeners.delete(fn) }
}

/** The connected link to `hostKey`'s daemon, through which its server's streams open; null when not connected. */
export function hostServerLink(hostKey: string): HostServerHost | null {
  return manager?.hostLink(hostKey) ?? null
}

export function getHostServerManager(): HostServerManager | null {
  // Only the leader manages hosts' servers: a replica (the companion, a host's own server) never does.
  // The Demo never installs a server on a remote host (demo-remote-host.ts): its host daemon is all it runs there.
  if (isFollower() || IS_DEMO) return null
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
      return host ? withThisWalnutTunnel(hostKey, hostServerSettingsFrom(host.server, host.server_program, followerOnByDefault(host, config)), config) : null
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
    stateFile: path.join(WALNUT_HOME, HOST_SERVERS_FILE),
    // Machine-local: local/ is never synced (another machine's counts would restart the hosts' tunnels).
    retryFile: path.join(WALNUT_HOME, 'local', 'host-server-tunnel-retries.json'),
    now: Date.now,
    // The tunnel handover follows what the host's server reports (expose-runtime.ts).
    changed: (view) => {
      noteHostViewForTunnel(view)
      for (const fn of viewListeners) {
        try { fn({ ...view }) } catch (err) { log.session.warn('host server: a view listener failed', { host: view.hostKey, error: err instanceof Error ? err.message : String(err) }) }
      }
    },
    // Stopping: the plugins are disposed before the hosts' links close, and a host must keep its tunnel.
    frozen: async () => (await import('../integration-registry.js')).registry.isClosing(),
    // A newer build waits for a quiet window before it goes to a host that works (update-hold.ts).
    // A newer deploy replaces this process, so the window counts from when it started.
    servingSince: Date.now() - Math.round(process.uptime() * 1000),
    updateQuietMs: minutesFromEnv(process.env.WALNUT_HOST_SERVER_UPDATE_QUIET_MIN, DEFAULT_UPDATE_QUIET_MS),
    updateMaxBehindMs: minutesFromEnv(process.env.WALNUT_HOST_SERVER_UPDATE_MAX_BEHIND_MIN, DEFAULT_UPDATE_MAX_BEHIND_MS),
    copiesNeedNewer: async (hostKey) => (await import('../replication/replica-status.js')).restedAsOlder(`host:${hostKey}`),
    // The experiment follower_on_every_host: a failed start tries again by itself, and goes to
    // Walnut Health, never to the person (health-item.ts).
    everyHost: async () => followerOnEveryHost(await (await import('../config-manager.js')).getConfig()),
    health: {
      failed: (hostKey, message, retries) => {
        void quietly(import('./health-item.js').then((m) => m.noteHostServerFailed(hostKey, message, retries)), 'raising the Walnut Health item', hostKey)
      },
      settled: (hostKey) => { void quietly(import('./health-item.js').then((m) => m.noteHostServerSettled(hostKey)), 'recovering the Walnut Health item', hostKey) },
    },
    // Test and safety knobs (docs/plan/walnut-replica-servers-impl.md, WP2): another root
    // on the host, and (tests only) a local tree run in place of an installed build.
    ...(hostServerRootSpec() ? { hostRoot: hostServerRootSpec() } : {}),
    ...(process.env.WALNUT_HOST_SERVER_APP_DIR?.trim() ? { appDir: process.env.WALNUT_HOST_SERVER_APP_DIR.trim() } : {}),
    registerTarget: (hostKey, post, copies) => {
      // One id for the target and its ready: a ready under another name reaches no target.
      const id = `host:${hostKey}`
      const targets = import('../replication/replica-targets.js')
      let unregister: () => void = () => {}
      void quietly(targets.then(({ registerReplicaTarget }) => {
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
      }), 'registering the copy target', hostKey)
      return {
        unregister: () => unregister(),
        // Registered first (the same promise, its callbacks in order), so the ready finds it.
        ready: (restarted) => { void quietly(targets.then(({ replicaTargetAvailable }) => replicaTargetAvailable(id, { restarted })), 'marking the copy target ready', hostKey) },
      }
    },
  })
  // A provider that arrives (a plugin loading after the hosts connected) may place the tunnel on a host.
  const offProviders = onExposeProvidersChanged(() => { void quietly(reconcileAllHostServers(), 'reconciling the hosts') })
  // The plugins that keep their tasks ride each follower's spec (manager.ts pluginsKeepTasks): a
  // change sends the new word, once for a burst of plugin loads.
  const keeping = settledCall(() => { void quietly(reconcileAllHostServers(), 'reconciling the hosts') }, KEEPING_RECONCILE_MS, KEEPING_RECONCILE_MAX_MS)
  const offKeeping = onPluginsKeepingTasksChanged(() => keeping.kick())
  const name = 'host-server-settings'
  let offBus: (() => void) | null = null
  let stopped = false
  void quietly(import('../event-bus.js').then(({ bus, EventNames }) => {
    if (stopped) return
    bus.subscribe(name, () => { void quietly(reconcileAllHostServers(), 'reconciling the hosts') }, { global: true, interest: [EventNames.CONFIG_CHANGED] })
    offBus = () => bus.unsubscribe(name)
  }), 'watching the config')
  unsubscribe = () => { stopped = true; offProviders(); offKeeping(); keeping.cancel(); offBus?.() }
  return manager
}

/** A promise nothing awaits: its failure is logged, never an unhandled rejection. */
function quietly(p: Promise<unknown>, what: string, host?: string): Promise<void> {
  return p.then(() => undefined, (err: unknown) => {
    log.session.warn(`host server: ${what} failed`, { ...(host ? { host } : {}), error: err instanceof Error ? err.message : String(err) })
  })
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
  // Soft: a setup that waits to try again keeps its pace unless this host's own settings changed.
  await Promise.all([...hosts].map((key) => m.reconcile(key, { soft: true }).catch((err) => {
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

/** This Walnut's follower on a host, as the one Walnut service needs it (manager.ts followerFact); unknown before the manager runs. */
export function hostFollowerFact(hostKey: string): FollowerFact {
  return manager ? manager.followerFact(hostKey) : { kind: 'unknown' }
}

/** The host servers' views without making the manager (GET /api/replicas/status, WP14). */
export function peekHostServerViews(): ReturnType<HostServerManager['views']> {
  return manager ? manager.views() : []
}
