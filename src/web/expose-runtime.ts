/**
 * This server's exposure (docs/plan/walnut-servers-everywhere.md): the tunnel port
 * and the provider running in front of it.
 *
 * The tunnel port is a second HTTP listener on 127.0.0.1 serving the same app,
 * with WebSocket upgrades handed to the main server's handler. It is marked in
 * local-trust.ts, so nothing that arrives on it is ever this machine: a tunnel
 * connects from loopback. It is open only while a provider is asked to run.
 *
 * `reconcile()` brings both in line with config.yaml's `expose` section and the
 * registered providers; calls are serialized. It runs at start, after a settings
 * change, and when a plugin adds or removes a provider.
 */

import http, { type RequestListener, type Server as HttpServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { log } from '../logging/index.js'
import { getConfig } from '../core/config-manager.js'
import { ExposeSupervisor, httpProbe, nodeSpawn, resolveRun, type SupervisorDeps } from '../core/expose/supervisor.js'
import { getExposeProvider, onExposeProvidersChanged } from '../core/expose/registry.js'
import { setExposeStatusSource } from '../core/expose/status.js'
import type { ExposeStatus } from '../core/expose/types.js'
import { mcpServerEnv } from '../core/mcp-servers/env.js'
import { markTunnelPort, unmarkTunnelPort } from './middleware/local-trust.js'

export interface ExposeRuntimeOptions {
  app: RequestListener
  mainServer: HttpServer
  /** Tests: a fake child process and clock. */
  deps?: Partial<SupervisorDeps>
}

export interface ExposeRuntime {
  reconcile(): Promise<ExposeStatus>
  status(): ExposeStatus
  retry(): void
  stop(): Promise<void>
}

let current: ExposeRuntime | null = null

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

  async function reconcileNow(): Promise<ExposeStatus> {
    if (stopped) return status()
    const cfg = (await getConfig().catch(() => null))?.expose ?? {}
    enabled = cfg.enabled === true
    providerId = typeof cfg.provider === 'string' && cfg.provider ? cfg.provider : null
    wantedPort = Number.isInteger(cfg.port) && cfg.port! > 0 && cfg.port! < 65536 ? cfg.port! : 0
    if (!enabled || !providerId) {
      override = null
      providerTitle = undefined
      await supervisor.stop()
      await closeListener()
      return status()
    }
    const def = getExposeProvider(providerId, cfg.command)
    if (!def) {
      await supervisor.stop()
      await closeListener()
      providerTitle = undefined
      if (override?.state !== 'unavailable') override = { state: 'unavailable', lastError: '', since: Date.now() }
      override.lastError = providerId === 'command'
        ? 'Set expose.command in config.yaml to the tunnel command to run.'
        : `No tunnel provider named "${providerId}" is installed. Install or turn on the plugin that provides it.`
      return status()
    }
    providerTitle = def.title
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

  function reconcile(): Promise<ExposeStatus> {
    const next = chain.then(reconcileNow, reconcileNow)
    chain = next.catch(() => undefined)
    return next
  }

  const unsubscribe = onExposeProvidersChanged(() => { void reconcile() })
  const runtime: ExposeRuntime = {
    reconcile,
    status,
    retry: () => supervisor.retryNow(),
    async stop() {
      stopped = true
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
