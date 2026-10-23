/**
 * This server's exposure (docs/plan/walnut-servers-everywhere.md): the tunnel port
 * and the provider running in front of it.
 *
 * The tunnel port is a second HTTP listener on 127.0.0.1 serving the same app,
 * with WebSocket upgrades handed to the main server's handler. It is marked in
 * local-trust.ts, so nothing that arrives on it is ever this machine: a tunnel
 * connects from loopback. It is open while a provider is asked to run, and
 * while something holds it (a host server reaches this Mac through it). It
 * answers the tunnel probe path itself (core/expose/probe.ts), so a check through
 * the address tells this computer's listener from a host's.
 *
 * `reconcile()` brings both in line with config.yaml's `expose` section and the
 * registered providers; calls are serialized. It runs at start, after a settings
 * change, and when a plugin adds or removes a provider.
 *
 * While a host carries the tunnel (core/expose/placement.ts), none runs here: the
 * host's server runs it, and the status is that host's report. The port stays open
 * for the host server's way back to this Mac.
 *
 * Moving it to a host hands over without a fight. The tunnel service gives a name
 * to whoever connected last, and an older connection keeps saying "connected" while
 * it gets nothing, so one name runs on one machine at a time:
 *
 *   placed on H, not handed over   the one here keeps running (or starts), the
 *                                  status says `movingTo`, until H reports this
 *                                  same tunnel connected (placement.ts hostHolds)
 *   H is up                        the one here stops, THEN H is asked to connect
 *                                  again (its connection is the newest, whatever
 *                                  the clocks or a reconnect here said), then the
 *                                  handover is recorded; the status is H's report
 *   recorded, this Mac restarts    nothing starts here: a newer connection here
 *                                  would take the name from H silently
 *   recorded, H stops holding it   kept while a Walnut answers at the address;
 *                                  released when nobody does (expose-handover.ts),
 *                                  and it runs here again until H holds it again
 *
 * The record (`local/expose-handover.json`) also clears when the tunnel moves back
 * here or to another host, its provider or options change, or it is turned off. Host
 * views that change re-check it (core/host-server/index.ts noteHostViewForTunnel), and
 * so does a timer while a check waits on a clock.
 */

import http, { type RequestListener, type Server as HttpServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import path from 'node:path'
import { WALNUT_HOME } from '../constants.js'
import { log } from '../logging/index.js'
import { getConfig } from '../core/config-manager.js'
import { ExposeSupervisor, PROBE_TIMEOUT_MS, nodeSpawn, resolveRun, type SupervisorDeps } from '../core/expose/supervisor.js'
import { answerTunnelProbe, httpProbe, probeAnswer } from '../core/expose/probe.js'
import { getExposeProvider, onExposeProvidersChanged } from '../core/expose/registry.js'
import { exposePlacement, hostHolds, reportedTunnel, statusOnHost, tunnelKey, type LocalHold, type PlacementHostView } from '../core/expose/placement.js'
import { setExposeStatusSource } from '../core/expose/status.js'
import type { ExposeProviderDefinition, ExposeRunsOn, ExposeStatus } from '../core/expose/types.js'
import { getHostServerManager, peekHostServerViews } from '../core/host-server/index.js'
import { mcpServerEnv } from '../core/mcp-servers/env.js'
import { markTunnelPort, unmarkTunnelPort } from './middleware/local-trust.js'
import { RELEASE_GRACE_MS, RELEASE_RECHECK_MS, handoverStore, stillServed, type ExposeHandover } from './expose-handover.js'

export type { ExposeHandover } from './expose-handover.js'

export interface ExposeRuntimeOptions {
  app: RequestListener
  mainServer: HttpServer
  /** Tests: a fake child process, clock and probe. */
  deps?: Partial<SupervisorDeps>
  /** Where the handover to a host is recorded (default WALNUT_HOME/local/expose-handover.json). */
  handoverFile?: string
  /** Tests: the host server's view, tunnel retry and reconnect (default: core/host-server). */
  hosts?: {
    view(hostKey: string): PlacementHostView | null
    retry(hostKey: string): Promise<void>
    /** Start the host's tunnel again (its connection becomes the newest). */
    reconnect?(hostKey: string): Promise<void>
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
  /** The host that carries the tunnel instead of this computer, its provider and the tunnel's key. */
  let elsewhere: { runsOn: ExposeRunsOn; def: ExposeProviderDefinition; key: string } | null = null
  /** The host it is moving to: it runs here until that host holds it. */
  let moving: { runsOn: ExposeRunsOn; def: ExposeProviderDefinition; key: string } | null = null
  /** When this computer first saw the host's connection (`host|url|since`), for a view without the host's clock. */
  let firstSeen: { id: string; at: number } | null = null
  /** When this computer last saw the recorded host hold the tunnel (`host|key`; from the first look after a start). */
  let lastHeld: { id: string; at: number } | null = null
  let recheckTimer: ReturnType<typeof setTimeout> | null = null
  /** Which tunnel the run here is (tunnelKey): one with other options holds another name. */
  let runningKey: string | null = null
  const handover = handoverStore(opts.handoverFile ?? path.join(WALNUT_HOME, 'local', 'expose-handover.json'))
  const hostServers = {
    view: (hostKey: string) => peekHostServerViews().find((v) => v.hostKey === hostKey) ?? null,
    retry: async (hostKey: string) => {
      const manager = getHostServerManager()
      if (!manager) return
      // Not set up yet (an install that failed, say): set it up again.
      await manager.retryExpose(hostKey).catch(() => manager.reconcile(hostKey))
    },
    reconnect: async (hostKey: string) => { await getHostServerManager()?.retryExpose(hostKey) },
    ...opts.hosts,
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
    if (elsewhere) return statusOnHost(elsewhere.runsOn, elsewhere.def, hostServers.view(elsewhere.runsOn.hostKey), elsewhere.key)
    if (override) return { enabled, provider: providerId, ...(providerTitle ? { providerTitle } : {}), state: override.state, since: override.since, lastError: override.lastError }
    const here: ExposeStatus = { enabled, provider: providerId, ...(providerTitle ? { providerTitle } : {}), ...supervisor.status() }
    if (moving) {
      // What the host is doing meanwhile: installing Walnut, its tunnel, or already up.
      const there = statusOnHost(moving.runsOn, moving.def, hostServers.view(moving.runsOn.hostKey), moving.key)
      const note = there.state === 'connected' ? 'Switching over.' : there.activity ?? there.lastError
      here.movingTo = { hostKey: moving.runsOn.hostKey, label: moving.runsOn.label, ...(note ? { note } : {}) }
    }
    return here
  }

  function recheckIn(ms: number): void {
    if (recheckTimer) clearTimeout(recheckTimer)
    recheckTimer = setTimeout(() => { recheckTimer = null; void reconcile() }, Math.max(1_000, ms))
    recheckTimer.unref?.()
  }

  function noRecheck(): void {
    if (recheckTimer) clearTimeout(recheckTimer)
    recheckTimer = null
  }

  /** When this computer first saw the host's current connection of the tunnel. */
  function seenAt(hostKey: string, view: PlacementHostView | null): number | undefined {
    const r = view?.phase === 'running' ? view.server?.expose : undefined
    if (r?.state !== 'connected' || !r.url) return undefined
    const id = `${hostKey}|${r.url}|${r.since}`
    if (firstSeen?.id !== id) firstSeen = { id, at: deps.now() }
    return firstSeen.at
  }

  function clearHandover(why: string): void {
    const rec = handover.read()
    if (!rec) return
    handover.clear()
    lastHeld = null
    log.web.info('expose: the handover record is cleared', { host: rec.hostKey, why })
  }

  /**
   * The host is up with this tunnel: the one here stops, then the host connects again, so
   * its connection is the newest whatever happened here meanwhile; then it is recorded.
   */
  async function handOver(hostKey: string, key: string, url: string | undefined): Promise<ExposeHandover> {
    await supervisor.stop()
    runningKey = null
    await hostServers.reconnect(hostKey).catch((err) => {
      // Recorded all the same: the host's own check restarts a connection the service no longer
      // routes to, and the record is let go when nobody answers at the address (stillHolds).
      log.web.warn('expose: the host was not asked to connect again', { host: hostKey, error: err instanceof Error ? err.message : String(err) })
    })
    const rec: ExposeHandover = { hostKey, key, ...(url ? { url } : {}) }
    handover.write(rec)
    lastHeld = { id: `${hostKey}|${key}`, at: deps.now() }
    log.web.info('expose: the host holds the tunnel; the one here stopped first and the host connected again', { host: hostKey })
    return rec
  }

  /** The record holds while the host keeps holding, or while a Walnut answers at the address (expose-handover.ts). */
  async function stillHolds(rec: ExposeHandover, view: PlacementHostView | null, def: ExposeProviderDefinition, key: string): Promise<boolean> {
    const id = `${rec.hostKey}|${rec.key}`
    const now = deps.now()
    const there = reportedTunnel(view, def, key)
    if (there) {
      lastHeld = { id, at: now }
      noRecheck()
      if (there.url !== rec.url) handover.write({ ...rec, url: there.url })
      return true
    }
    // The clock starts at the first look (after a restart here too).
    if (lastHeld?.id !== id) lastHeld = { id, at: now }
    const left = lastHeld.at + RELEASE_GRACE_MS - now
    if (left > 0) { recheckIn(left); return true }
    const answer = rec.url ? probeAnswer(await deps.probe(rec.url, PROBE_TIMEOUT_MS, supervisor.probeToken).catch(() => false)) : 'down'
    if (stillServed(answer, view)) { recheckIn(RELEASE_RECHECK_MS); return true }
    log.web.warn('expose: the host has not held the tunnel for a while and nobody answers at its address; it runs here again', {
      host: rec.hostKey, answer, phase: view?.phase ?? null, hostState: view?.server?.expose?.state ?? null,
    })
    clearHandover('the host stopped holding it')
    return false
  }

  async function openListener(port: number): Promise<number> {
    if (listener && (port === 0 || port === listenerPort)) return listenerPort!
    await closeListener()
    // The probe path is this listener's own answer (core/expose/probe.ts), never the app's.
    const server = http.createServer((req, res) => { if (!answerTunnelProbe(req, res, supervisor.probeToken)) opts.app(req, res) })
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
      moving = null
      override = null
      providerTitle = undefined
      noRecheck()
      // Off: no machine holds it any more (a config that could not be read says nothing).
      if (config) clearHandover('off')
      await supervisor.stop()
      await settleListener()
      return status()
    }
    // A provider not registered yet (a plugin still loading after a restart) keeps the record.
    const def = getExposeProvider(providerId, cfg.command)
    if (!def) {
      elsewhere = null
      moving = null
      noRecheck()
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
      const runsOn = { hostKey: placed.hostKey, label: placed.label, auto: placed.auto }
      const key = tunnelKey(def, cfg.options ?? {})
      let rec = handover.read()
      if (rec && (rec.hostKey !== placed.hostKey || rec.key !== key)) {
        clearHandover(rec.hostKey !== placed.hostKey ? 'another place' : 'another tunnel')
        rec = null
      }
      const view = hostServers.view(placed.hostKey)
      if (rec) {
        if (!(await stillHolds(rec, view, def, key))) rec = null
      } else {
        // A run here of another tunnel (other options) holds another name: none of this one runs here.
        const local: LocalHold = supervisor.running() && runningKey === key ? supervisor.hold() : {}
        const step = hostHolds(view, def, key, local, { now: deps.now(), firstSeenAt: seenAt(placed.hostKey, view) })
        if (step.held) rec = await handOver(placed.hostKey, key, reportedTunnel(view, def, key)?.url)
        else if (step.recheckInMs !== undefined) recheckIn(step.recheckInMs)
      }
      if (rec) {
        // The host's server runs it; one here too would fight it for the same name.
        override = null
        moving = null
        await supervisor.stop()
        runningKey = null
        await settleListener()
        elsewhere = { runsOn, def, key }
        notePlace('host', placed.hostKey, placed.auto, def.id)
        return status()
      }
      // Not up there yet (or let go again): it runs here meanwhile.
      moving = { runsOn, def, key }
    } else {
      moving = null
      noRecheck()
      clearHandover('here')
    }
    elsewhere = null
    notePlace(moving ? 'moving' : 'here', moving?.runsOn.hostKey ?? null, placed.auto, def.id)
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
    runningKey = tunnelKey(def, cfg.options ?? {})
    return status()
  }

  let placeNoted = ''
  function notePlace(where: 'here' | 'host' | 'moving', hostKey: string | null, auto: boolean, provider: string): void {
    const key = `${where}|${hostKey ?? ''}|${auto}|${provider}`
    if (key === placeNoted) return
    placeNoted = key
    const message = where === 'host' ? 'expose: the tunnel runs on a host'
      : where === 'moving' ? 'expose: the tunnel runs here until the host holds it' : 'expose: the tunnel runs here'
    log.web.info(message, { ...(hostKey ? { host: hostKey } : {}), auto, provider })
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
      if (!elsewhere) supervisor.retryNow()
      // On a host, or moving to one (whose server may wait on something too: an install that failed).
      const hostKey = elsewhere?.runsOn.hostKey ?? moving?.runsOn.hostKey
      if (!hostKey) return
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
      noRecheck()
      unsubscribe()
      // Also an install of the tunnel CLI still running (its own process group).
      await supervisor.shutdown()
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
