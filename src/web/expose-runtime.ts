/**
 * This server's exposure (docs/plan/walnut-servers-everywhere.md): the tunnel port
 * and the provider running in front of it.
 *
 * The tunnel port is a second HTTP listener on 127.0.0.1 serving the same app,
 * with WebSocket upgrades handed to the main server's handler. It is marked in
 * local-trust.ts, so nothing that arrives on it is ever this machine: a tunnel
 * connects from loopback. It is open while a provider is asked to run, and
 * while something holds it (a host server reaches this Mac through it).
 *
 * `reconcile()` brings both in line with config.yaml's `expose` section and the
 * registered providers; calls are serialized. It runs at start, after a settings
 * change, and when a plugin adds or removes a provider.
 *
 * While a host carries the tunnel (core/expose/placement.ts), none runs here: the
 * host's server runs it, and the status is that host's report. The port stays open
 * for the host server's way back to this Mac.
 */

import http, { type RequestListener, type Server as HttpServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { log } from '../logging/index.js'
import { getConfig } from '../core/config-manager.js'
import { ExposeSupervisor, httpProbe, nodeSpawn, resolveRun, type SupervisorDeps } from '../core/expose/supervisor.js'
import { getExposeProvider, onExposeProvidersChanged } from '../core/expose/registry.js'
import { exposePlacement, statusOnHost, type PlacementHostView } from '../core/expose/placement.js'
import { setExposeStatusSource } from '../core/expose/status.js'
import type { ExposeProviderDefinition, ExposeRunsOn, ExposeStatus } from '../core/expose/types.js'
import { getHostServerManager, peekHostServerViews } from '../core/host-server/index.js'
import { mcpServerEnv } from '../core/mcp-servers/env.js'
import { markTunnelPort, unmarkTunnelPort } from './middleware/local-trust.js'

export interface ExposeRuntimeOptions {
  app: RequestListener
  mainServer: HttpServer
  /** Tests: a fake child process and clock. */
  deps?: Partial<SupervisorDeps>
  /** Tests: the host server's view and tunnel retry (default: core/host-server). */
  hosts?: {
    view(hostKey: string): PlacementHostView | null
    retry(hostKey: string): Promise<void>
  }
}

export interface ExposeRuntime {
  reconcile(): Promise<ExposeStatus>
  status(): ExposeStatus
  retry(): void
  stop(): Promise<void>
  /**
   * Keep the tunnel port open for `holder` (a host server's way back to this Mac
   * reaches it), whether or not a tunnel runs here. Resolves to the port.
   */
  holdTunnelPort(holder: string): Promise<number>
  releaseTunnelPort(holder: string): Promise<void>
  /** The tunnel port while it is open, else null. */
  openPort(): number | null
}

let current: ExposeRuntime | null = null
/** Each runtime's own bus subscriber name: one stopping never removes another's. */
let runtimeSeq = 0

export function getExposeRuntime(): ExposeRuntime | null {
  return current
}

export function startExposeRuntime(opts: ExposeRuntimeOptions): ExposeRuntime {
  let listener: HttpServer | null = null
  let listenerPort: number | null = null
  let wantedPort = 0
  let enabled = false
  let providerId: string | null = null
  let providerTitle: string | undefined
  /** A runtime-level state that overrides the supervisor's (no provider, a bad option). */
  let override: { state: 'unavailable'; lastError: string; since: number } | null = null
  let chain: Promise<unknown> = Promise.resolve()
  let stopped = false
  /** Who keeps the tunnel port open apart from a running tunnel (host servers). */
  const holders = new Set<string>()
  /** The host that carries the tunnel instead of this computer, and its provider. */
  let elsewhere: { runsOn: ExposeRunsOn; def: ExposeProviderDefinition } | null = null
  const hostServers = opts.hosts ?? {
    view: (hostKey: string) => peekHostServerViews().find((v) => v.hostKey === hostKey) ?? null,
    retry: async (hostKey: string) => {
      const manager = getHostServerManager()
      if (!manager) return
      // Not set up yet (an install that failed, say): set it up again.
      await manager.retryExpose(hostKey).catch(() => manager.reconcile(hostKey))
    },
  }

  const deps: SupervisorDeps = {
    spawn: nodeSpawn,
    probe: httpProbe,
    now: Date.now,
    setTimer: (fn, ms) => { const t = setTimeout(fn, ms); t.unref?.(); return t },
    clearTimer: (t) => clearTimeout(t as ReturnType<typeof setTimeout>),
    log: {
      info: (message, meta) => log.web.info(message, meta),
      warn: (message, meta) => log.web.warn(message, meta),
    },
    ...opts.deps,
  }
  const supervisor = new ExposeSupervisor(deps, () => { /* status() reads the supervisor */ })

  function status(): ExposeStatus {
    if (!enabled || !providerId) return { enabled, provider: providerId, state: 'off', since: 0 }
    if (elsewhere) return statusOnHost(elsewhere.runsOn, elsewhere.def, hostServers.view(elsewhere.runsOn.hostKey))
    if (override) return { enabled, provider: providerId, ...(providerTitle ? { providerTitle } : {}), state: override.state, since: override.since, lastError: override.lastError }
    return { enabled, provider: providerId, ...(providerTitle ? { providerTitle } : {}), ...supervisor.status() }
  }

  async function openListener(port: number): Promise<number> {
    if (listener && (port === 0 || port === listenerPort)) return listenerPort!
    await closeListener()
    const server = http.createServer(opts.app)
    // One WebSocket handler for both ports: the main server's checks run, and they
    // see this socket's local port, which local-trust.ts never trusts.
    server.on('upgrade', (req, socket, head) => { opts.mainServer.emit('upgrade', req, socket, head) })
    server.on('error', (err) => log.web.error('tunnel port error', { error: err instanceof Error ? err.message : String(err) }))
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(port, '127.0.0.1', () => { server.off('error', reject); resolve() })
    })
    listener = server
    listenerPort = (server.address() as AddressInfo).port
    markTunnelPort(listenerPort)
    log.web.info('tunnel port open', { port: listenerPort })
    return listenerPort
  }

  async function closeListener(): Promise<void> {
    if (!listener) return
    const server = listener
    const port = listenerPort
    listener = null
    listenerPort = null
    server.closeAllConnections?.()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    // Unmarked only once closed: a request still in flight keeps its refusal.
    if (port !== null) unmarkTunnelPort(port)
    log.web.info('tunnel port closed', { port })
  }

  /** No tunnel runs: the port stays only for its holders. */
  async function settleListener(): Promise<void> {
    if (holders.size > 0) await openListener(listenerPort ?? wantedPort)
    else await closeListener()
  }

  async function reconcileNow(): Promise<ExposeStatus> {
    if (stopped) return status()
    const config = await getConfig().catch(() => null)
    const cfg = config?.expose ?? {}
    enabled = cfg.enabled === true
    providerId = typeof cfg.provider === 'string' && cfg.provider ? cfg.provider : null
    wantedPort = Number.isInteger(cfg.port) && cfg.port! > 0 && cfg.port! < 65536 ? cfg.port! : 0
    if (!enabled || !providerId) {
      elsewhere = null
      override = null
      providerTitle = undefined
      await supervisor.stop()
      await settleListener()
      return status()
    }
    const def = getExposeProvider(providerId, cfg.command)
    if (!def) {
      elsewhere = null
      await supervisor.stop()
      await settleListener()
      providerTitle = undefined
      if (override?.state !== 'unavailable') override = { state: 'unavailable', lastError: '', since: Date.now() }
      override.lastError = providerId === 'command'
        ? 'Set expose.command in config.yaml to the tunnel command to run.'
        : `No tunnel provider named "${providerId}" is installed. Install or turn on the plugin that provides it.`
      return status()
    }
    providerTitle = def.title
    const placed = exposePlacement(cfg.run_on, def, config?.hosts)
    if (placed.where === 'host') {
      // The host's server runs it; one here too would fight it for the same name.
      override = null
      await supervisor.stop()
      await settleListener()
      elsewhere = { runsOn: { hostKey: placed.hostKey, label: placed.label, auto: placed.auto }, def }
      notePlace(placed.hostKey, placed.auto, def.id)
      return status()
    }
    elsewhere = null
    notePlace(null, placed.auto, def.id)
    let port: number
    try {
      port = await openListener(wantedPort)
    } catch (err) {
      await supervisor.stop()
      override = { state: 'unavailable', lastError: `The tunnel port ${wantedPort} cannot be opened: ${err instanceof Error ? err.message : String(err)}`, since: Date.now() }
      return status()
    }
    let run
    try {
      run = resolveRun(def, port, cfg.options ?? {})
    } catch (err) {
      await supervisor.stop()
      override = { state: 'unavailable', lastError: err instanceof Error ? err.message : String(err), since: Date.now() }
      return status()
    }
    override = null
    run.env = mcpServerEnv(run.env)
    const now = supervisor.running()
    const same = now && now.providerId === run.providerId && now.command === run.command && now.port === port
      && JSON.stringify(now.args) === JSON.stringify(run.args)
    if (!same) await supervisor.start(run, port)
    return status()
  }

  let placeNoted = ''
  function notePlace(hostKey: string | null, auto: boolean, provider: string): void {
    const key = `${hostKey ?? ''}|${auto}|${provider}`
    if (key === placeNoted) return
    placeNoted = key
    log.web.info(hostKey ? 'expose: the tunnel runs on a host' : 'expose: the tunnel runs here', { ...(hostKey ? { host: hostKey } : {}), auto, provider })
  }

  function serialize<T>(fn: () => Promise<T>): Promise<T> {
    const next = chain.then(fn, fn)
    chain = next.catch(() => undefined)
    return next
  }

  function reconcile(): Promise<ExposeStatus> {
    return serialize(reconcileNow)
  }

  const offProviders = onExposeProvidersChanged(() => { void reconcile() })
  // Where it runs follows the hosts too (a host added, renamed, its server turned off).
  const busName = `expose-runtime-config-${++runtimeSeq}`
  let offConfig: (() => void) | null = null
  void import('../core/event-bus.js').then(({ bus, EventNames }) => {
    if (stopped) return
    bus.subscribe(busName, () => { void reconcile() }, { global: true, interest: [EventNames.CONFIG_CHANGED] })
    offConfig = () => bus.unsubscribe(busName)
  })
  const unsubscribe = () => { offProviders(); offConfig?.() }
  const runtime: ExposeRuntime = {
    reconcile,
    status,
    retry: () => {
      if (!elsewhere) { supervisor.retryNow(); return }
      const hostKey = elsewhere.runsOn.hostKey
      void hostServers.retry(hostKey).catch((err) => log.web.warn('expose: the host tunnel retry failed', { host: hostKey, error: err instanceof Error ? err.message : String(err) }))
    },
    holdTunnelPort: (holder) => serialize(async () => {
      if (stopped) throw new Error('the server is stopping')
      holders.add(holder)
      return openListener(listenerPort ?? wantedPort)
    }),
    releaseTunnelPort: (holder) => serialize(async () => {
      holders.delete(holder)
      if (holders.size === 0 && !supervisor.running()) await closeListener()
    }),
    openPort: () => listenerPort,
    async stop() {
      stopped = true
      holders.clear()
      unsubscribe()
      await supervisor.stop()
      await closeListener()
      if (current === runtime) {
        current = null
        setExposeStatusSource(null)
      }
    },
  }
  current = runtime
  setExposeStatusSource(status)
  return runtime
}
