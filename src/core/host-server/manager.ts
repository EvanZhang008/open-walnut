/**
 * The Mac's side of the host servers (docs/plan/walnut-servers-everywhere.md,
 * "A server on a host"). Primary only.
 *
 * For each host whose settings turn it on (`hosts.<key>.server.enabled`), on
 * every connect to that host's daemon (after `leader.configure`, so the daemon
 * knows which Walnut speaks) and after a settings change:
 *
 *   1. a Node that runs there (the setting, else the one the host's preflight found)
 *   2. this Mac's build installed there (core/host-server/install.ts)
 *   3. its port (kept in the data dir, so the tunnel's target stays put)
 *   4. this Mac's tunnel port held open: the door the host server's streams
 *      come in by (the daemon passes them from its link to ours)
 *   5. `server.configure` on the daemon, with the server's tunnel in its
 *      settings; the daemon keeps it running
 *   6. its first report, through the daemon (`server.status`)
 *
 * There is no other connection: the host server links to its daemon only, and
 * everything between it and this Mac is a stream on the two links
 * (docs/plan/walnut-servers-everywhere.md, "One kind of link"). Then every 30 s
 * while connected: the server's last report. Turning it off removes the spec
 * (the daemon stops the server), the door hold and the copy target.
 */

import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import type { Duplex } from 'node:stream'
import { log } from '../../logging/index.js'
import type { HostServerStatus } from '../../providers/host-server-core.js'
import { getExposeProvider } from '../expose/registry.js'
import type { ExposeProviderDefinition, ExposeStatus } from '../expose/types.js'
import {
  freePortsScript, HOST_ROOT, installScript, launchScript, MIN_NODE_MAJOR, nodeCheckScript, nodeMajor,
  parseFreePorts, parseInstallState, stateScript, type InstallState,
} from './install.js'
import type { HostAppPackage } from './package.js'

/** What the manager needs of a host's daemon connection (DaemonConnection has it). */
export interface HostServerHost {
  hostKey: string
  connected: boolean
  hasCapability(cap: string): boolean
  send(cmd: string, params?: Record<string, unknown>, timeoutMs?: number): Promise<Record<string, unknown>>
  runRemoteScript(script: string, timeoutMs?: number): Promise<string>
  uploadFile(remotePath: string, data: Buffer): Promise<void>
  /** A byte stream to the server on that host that follows this Walnut, through its daemon. */
  openStream(to: 'follower', purpose?: string): Promise<Duplex>
}

export interface HostServerSettings {
  enabled: boolean
  node?: string
  buildEnv: Record<string, string>
  expose: { enabled: boolean; provider: string | null; options: Record<string, string> }
}

export type HostServerPhase =
  | 'off' | 'waiting-for-host' | 'unsupported' | 'checking' | 'installing' | 'starting' | 'running' | 'error'

export interface HostServerView {
  hostKey: string
  enabled: boolean
  phase: HostServerPhase
  /** One sentence for the person: what is happening, or what went wrong. */
  message?: string
  since: number
  build?: string
  install?: InstallState
  /** The daemon's supervision of it. */
  daemon?: HostServerStatus
  /** What the server last reported through its daemon (its route, its daemon link, its tunnel). */
  server?: {
    route?: { kind: string; why?: string }
    expose?: ExposeStatus
    version?: string
    commit?: string | null
    daemon?: { state?: string; lastError?: string | null }
  } | null
  port?: number
}

interface PortsRecord { publicPort: number }

export interface ManagerDeps {
  settingsOf(hostKey: string): Promise<HostServerSettings | null>
  label(hostKey: string): Promise<string>
  walnutId(): Promise<string>
  home: string
  /** This Mac's tunnel port, held open: host servers' streams come in by it. */
  holdTunnelPort(holder: string): Promise<number>
  releaseTunnelPort(holder: string): Promise<void>
  buildPackage(): Promise<HostAppPackage>
  stateFile: string
  now(): number
  /** Copies for the follower (core/replication/replica-targets.ts). */
  registerTarget?(hostKey: string, post: (body: Record<string, unknown>, opts?: { timeoutMs?: number }) => Promise<Response>): () => void
  /** A view changed (the settings page listens). */
  changed?(view: HostServerView): void
  pollMs?: number
  installPollMs?: number
  /** How long a started server has to send its first report. */
  firstReportMs?: number
}

const INSTALL_TIMEOUT_MS = 20 * 60_000
const FIRST_REPORT_MS = 60_000
/** A report older than this says the server is not answering its daemon. */
const REPORT_STALE_MS = 20_000
const PORT_BASE = 41_000
const PORT_SPAN = 9_000

/** One HTTP request to the host server over a stream, answered as a fetch Response. */
function requestOver(stream: Duplex, method: string, route: string, body: Buffer | null, timeoutMs: number): Promise<Response> {
  return new Promise((resolve, reject) => {
    const req = http.request({
      method, path: route,
      headers: { host: 'host-server', ...(body ? { 'content-type': 'application/json', 'content-length': body.length } : {}) },
      createConnection: () => stream,
      timeout: timeoutMs,
    } as http.RequestOptions, (res) => {
      const parts: Buffer[] = []
      res.on('data', (c: Buffer) => parts.push(c))
      res.on('end', () => {
        const headers = new Headers()
        for (const [k, v] of Object.entries(res.headers)) if (typeof v === 'string') headers.set(k, v)
        resolve(new Response(Buffer.concat(parts), { status: res.statusCode ?? 502, headers }))
      })
      res.on('error', reject)
    })
    req.on('timeout', () => req.destroy(new Error(`the host server did not answer within ${Math.round(timeoutMs / 1000)}s`)))
    req.on('error', reject)
    req.end(body ?? undefined)
  })
}

export function createHostServerManager(deps: ManagerDeps) {
  const views = new Map<string, HostServerView>()
  const hosts = new Map<string, HostServerHost>()
  const running = new Map<string, Promise<void>>()
  const rerun = new Set<string>()
  const polls = new Map<string, ReturnType<typeof setInterval>>()
  /** Per host set up: the copy target's unregister, the spec last sent (for a tunnel retry). */
  const links = new Map<string, { unregister?: () => void; spec?: Record<string, unknown> }>()
  /** Bumped by "retry the tunnel": the server retries when it sees it change. */
  const exposeRetries = new Map<string, number>()

  function view(hostKey: string): HostServerView {
    let v = views.get(hostKey)
    if (!v) { v = { hostKey, enabled: false, phase: 'off', since: deps.now() }; views.set(hostKey, v) }
    return v
  }

  function set(hostKey: string, patch: Partial<HostServerView>): void {
    const v = view(hostKey)
    const phaseChanged = patch.phase !== undefined && patch.phase !== v.phase
    Object.assign(v, patch)
    if (phaseChanged) v.since = deps.now()
    if (patch.phase !== undefined && patch.message === undefined && phaseChanged) v.message = undefined
    deps.changed?.({ ...v })
  }

  function readPorts(): Record<string, PortsRecord> {
    try { return JSON.parse(fs.readFileSync(deps.stateFile, 'utf8')) as Record<string, PortsRecord> } catch { return {} }
  }

  function writePorts(all: Record<string, PortsRecord>): void {
    fs.mkdirSync(path.dirname(deps.stateFile), { recursive: true })
    const tmp = `${deps.stateFile}.${process.pid}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(all, null, 2), { mode: 0o600 })
    fs.renameSync(tmp, deps.stateFile)
  }

  async function portsFor(host: HostServerHost, node: string): Promise<PortsRecord> {
    const all = readPorts()
    const kept = all[host.hostKey]
    if (kept && Number.isInteger(kept.publicPort)) return kept
    const candidates = Array.from({ length: 8 }, () => PORT_BASE + crypto.randomInt(PORT_SPAN))
    const free = [...parseFreePorts(await host.runRemoteScript(freePortsScript(node, candidates), 20_000))]
    if (free.length < 1) throw new Error('could not find a free port on the host')
    const rec: PortsRecord = { publicPort: free[0]! }
    all[host.hostKey] = rec
    writePorts(all)
    return rec
  }

  async function resolveNode(host: HostServerHost, settings: HostServerSettings): Promise<string> {
    let node = settings.node?.trim()
    if (!node) {
      const pre = await host.send('host.preflight', {}, 30_000).catch(() => null) as { result?: { nodeDir?: string }; nodeDir?: string } | null
      const dir = pre?.result?.nodeDir ?? pre?.nodeDir
      if (dir) node = `${dir}/node`
    }
    if (!node) node = 'node'
    const line = await host.runRemoteScript(nodeCheckScript(node), 15_000).catch((err: Error) => err.message)
    const major = nodeMajor(line)
    if (major === null || major < MIN_NODE_MAJOR) {
      throw new Error(`a host server needs Node ${MIN_NODE_MAJOR} or newer on the host; ${node} answered "${line.trim().slice(0, 120)}". Set hosts.${host.hostKey}.server.node to one that runs there.`)
    }
    if (!node.startsWith('/')) {
      const abs = (await host.runRemoteScript(`command -v ${node}`, 10_000)).trim()
      if (!abs.startsWith('/')) throw new Error(`cannot find ${node} on the host`)
      node = abs
    }
    return node
  }

  async function ensureInstalled(host: HostServerHost, node: string, settings: HostServerSettings): Promise<{ appDir: string; dataDir: string; logFile: string; pkg: HostAppPackage }> {
    const pkg = await deps.buildPackage()
    const remoteHome = (await host.runRemoteScript('printf %s "$HOME"', 10_000)).trim()
    if (!remoteHome.startsWith('/')) throw new Error('the host did not say where its home is')
    const root = HOST_ROOT.replace('$HOME', remoteHome)
    const paths = { appDir: `${root}/app/${pkg.id}`, dataDir: `${root}/data`, logFile: `${root}/logs/server.log`, pkg }
    set(host.hostKey, { build: pkg.id })
    let state = parseInstallState(await host.runRemoteScript(stateScript(pkg.id), 15_000))
    if (state.state === 'ready') { set(host.hostKey, { install: state }); return paths }
    if (state.state !== 'running') {
      set(host.hostKey, { phase: 'installing', message: `Installing Walnut ${pkg.id} on the host.`, install: { state: 'running' } })
      await host.uploadFile(`${root}/incoming/${pkg.id}.tgz`, pkg.tgz)
      const script = installScript({ id: pkg.id, depsHash: pkg.depsHash, dependencies: pkg.dependencies, appPackageJson: pkg.appPackageJson, node, buildEnv: settings.buildEnv })
      await host.uploadFile(`${root}/incoming/${pkg.id}.install.sh`, Buffer.from(script))
      await host.runRemoteScript(launchScript(pkg.id), 15_000)
    } else {
      set(host.hostKey, { phase: 'installing', message: `Installing Walnut ${pkg.id} on the host.`, install: state })
    }
    const until = deps.now() + INSTALL_TIMEOUT_MS
    for (;;) {
      await new Promise((r) => setTimeout(r, deps.installPollMs ?? 5_000))
      if (!host.connected) throw new Error('the host went away during the install')
      state = parseInstallState(await host.runRemoteScript(stateScript(pkg.id), 15_000))
      if (state.state === 'ready') { set(host.hostKey, { install: state }); return paths }
      if (state.state === 'failed') { set(host.hostKey, { install: state }); throw new Error(`the install on the host failed: ${state.message}`) }
      if (state.state === 'absent') throw new Error('the install on the host stopped without a word (see ~/.open-walnut-host/incoming on the host)')
      if (deps.now() > until) throw new Error('the install on the host took more than 20 minutes')
    }
  }

  async function exposeSettingsFor(settings: HostServerSettings): Promise<{ enabled: boolean; definition: ExposeProviderDefinition | null; options: Record<string, string> }> {
    const id = settings.expose.provider
    const definition = id ? getExposeProvider(id) : null
    return { enabled: settings.expose.enabled && !!definition, definition, options: settings.expose.options }
  }

  /** The daemon's supervision of the server and the server's last report. */
  async function refreshStatus(host: HostServerHost): Promise<HostServerStatus | undefined> {
    const daemon = await host.send('server.status', { home: deps.home }, 10_000).catch(() => null)
    const status = (daemon?.status ?? undefined) as HostServerStatus | undefined
    // The host's own clock says how old the report is; the two clocks may differ.
    const age = typeof status?.reportAgeMs === 'number' ? status.reportAgeMs : status?.reportedAt ? deps.now() - status.reportedAt : Infinity
    const fresh = !!status?.report && age <= REPORT_STALE_MS
    const server = fresh ? (status!.report as HostServerView['server']) : null
    const phase: HostServerPhase = server ? 'running' : status?.state === 'running' || status?.state === 'starting' ? 'starting' : 'error'
    const message = server ? undefined
      : status?.state === 'retrying' ? `The server on the host stopped (${status.lastError ?? 'no reason given'}); its daemon starts it again shortly.`
        : status?.state === 'off' ? 'The host\'s daemon is not running the server.'
          : 'Waiting for the server on the host to answer.'
    set(host.hostKey, { phase, message, daemon: status, server })
    return status
  }

  function dropLink(hostKey: string): void {
    links.get(hostKey)?.unregister?.()
    links.delete(hostKey)
  }

  function stopPoll(hostKey: string): void {
    const t = polls.get(hostKey)
    if (t) { clearInterval(t); polls.delete(hostKey) }
  }

  async function reconcileOnce(hostKey: string): Promise<void> {
    const host = hosts.get(hostKey)
    const settings = await deps.settingsOf(hostKey)
    const enabled = settings?.enabled === true
    if (!enabled) {
      stopPoll(hostKey)
      // Also after a restart of this server: the host may still run one it set up before.
      if (host?.connected && host.hasCapability('host-server-v1')) {
        const st = await host.send('server.status', { home: deps.home }, 10_000).catch(() => null)
        const state = (st?.status as HostServerStatus | undefined)?.state
        if (state && state !== 'off') {
          await host.send('server.configure', { home: deps.home, spec: null }, 15_000).catch(() => undefined)
          log.session.info('host server: turned off, stopped on the host', { host: hostKey })
        }
      }
      dropLink(hostKey)
      await deps.releaseTunnelPort(`host-server:${hostKey}`)
      set(hostKey, { enabled: false, phase: 'off', server: null, daemon: undefined })
      return
    }
    if (!host?.connected) {
      set(hostKey, { enabled: true, phase: 'waiting-for-host', message: 'Walnut connects to this host when a session or a check needs it; the server starts then.' })
      return
    }
    if (!host.hasCapability('host-server-v1') || !host.hasCapability('follower-v1') || !host.hasCapability('stream-relay-v1')) {
      set(hostKey, { enabled: true, phase: 'unsupported', message: 'This host\'s Walnut daemon is older than this feature; it updates on its next connect.' })
      return
    }
    set(hostKey, { enabled: true, phase: 'checking', message: 'Checking the host.' })
    try {
      const node = await resolveNode(host, settings!)
      const install = await ensureInstalled(host, node, settings!)
      const rec = await portsFor(host, node)
      set(hostKey, { phase: 'starting', message: 'Starting the server on the host.', port: rec.publicPort })
      // The door its streams come in by (the tunnel port trusts nothing on loopback).
      await deps.holdTunnelPort(`host-server:${hostKey}`)
      const spec = {
        v: 1, home: deps.home, walnutId: await deps.walnutId(),
        command: node,
        args: [`${install.appDir}/dist/cli.js`, 'host-server'],
        cwd: install.dataDir,
        env: {
          OPEN_WALNUT_HOME: install.dataDir,
          WALNUT_HOST_SERVER: '1',
          WALNUT_HOST_SERVER_PORT: String(rec.publicPort),
          WALNUT_LEADER_HOME: deps.home,
          WALNUT_WALNUT_ID: await deps.walnutId(),
          WALNUT_HOST_LABEL: await deps.label(hostKey),
          WALNUT_NO_AUTO_UPDATE: '1',
        },
        log: install.logFile,
        port: rec.publicPort,
        // Read by the server while it runs: a change here restarts nothing.
        settings: { expose: await exposeSettingsFor(settings!), exposeRetry: exposeRetries.get(hostKey) ?? 0 },
      }
      const reply = await host.send('server.configure', { home: deps.home, spec }, 15_000)
      if (reply.ok !== true) throw new Error(`the host's daemon refused the server: ${String(reply.error ?? '')}`)
      set(hostKey, { daemon: reply.status as HostServerStatus })
      const link = links.get(hostKey) ?? {}
      link.spec = spec
      links.set(hostKey, link)
      // The copies (task store, search index) for this follower, on a stream through its daemon.
      if (deps.registerTarget && !link.unregister) {
        link.unregister = deps.registerTarget(hostKey, async (body, opts) => {
          const h = hosts.get(hostKey)
          if (!h?.connected) throw new Error('the host is not connected')
          const stream = await h.openStream('follower', 'replica')
          return requestOver(stream, 'POST', '/bridge/replica', Buffer.from(JSON.stringify(body)), opts?.timeoutMs ?? 60_000)
        })
      }
      // Up once it reports through its daemon.
      const until = deps.now() + (deps.firstReportMs ?? FIRST_REPORT_MS)
      for (;;) {
        const status = await refreshStatus(host)
        if (view(hostKey).phase === 'running') break
        if (deps.now() > until) {
          throw new Error(`the server on the host did not answer within a minute${status?.lastError ? ` (${status.lastError})` : ''}; its log is ${install.logFile} on the host`)
        }
        await new Promise((r) => setTimeout(r, deps.installPollMs ?? 2_000))
      }
      if (!polls.has(hostKey)) {
        const t = setInterval(() => { void poll(hostKey) }, deps.pollMs ?? 30_000)
        t.unref?.()
        polls.set(hostKey, t)
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      log.session.warn('host server: setup failed', { host: hostKey, error: message })
      set(hostKey, { phase: 'error', message })
    }
  }

  async function poll(hostKey: string): Promise<void> {
    const host = hosts.get(hostKey)
    if (!host?.connected || running.has(hostKey)) return
    try {
      await refreshStatus(host)
    } catch (err) {
      set(hostKey, { phase: 'error', message: err instanceof Error ? err.message : String(err) })
    }
  }

  /** Serialized per host; a call while one runs makes it run once more. */
  function reconcile(hostKey: string): Promise<void> {
    const current = running.get(hostKey)
    if (current) { rerun.add(hostKey); return current }
    const run = (async () => {
      do {
        rerun.delete(hostKey)
        await reconcileOnce(hostKey)
      } while (rerun.has(hostKey))
    })().finally(() => { running.delete(hostKey) })
    running.set(hostKey, run)
    return run
  }

  return {
    /** A host's daemon connected and was told which Walnut speaks. */
    connected(host: HostServerHost): Promise<void> {
      hosts.set(host.hostKey, host)
      return reconcile(host.hostKey)
    },
    disconnected(hostKey: string): void {
      stopPoll(hostKey)
      dropLink(hostKey)
      void deps.releaseTunnelPort(`host-server:${hostKey}`)
      if (view(hostKey).enabled) set(hostKey, { phase: 'waiting-for-host', message: 'The host is not connected right now.' })
    },
    reconcile,
    views: (): HostServerView[] => [...views.values()].map((v) => ({ ...v })),
    view: (hostKey: string): HostServerView => ({ ...view(hostKey) }),
    /** Ask the host server to start its tunnel again now (a new retry count in its settings). */
    async retryExpose(hostKey: string): Promise<void> {
      const host = hosts.get(hostKey)
      const spec = links.get(hostKey)?.spec
      if (!host?.connected || !spec) throw new Error('the server on that host is not set up')
      const n = (exposeRetries.get(hostKey) ?? 0) + 1
      exposeRetries.set(hostKey, n)
      const next = { ...spec, settings: { ...(spec.settings as Record<string, unknown>), exposeRetry: n } }
      const reply = await host.send('server.configure', { home: deps.home, spec: next }, 15_000)
      if (reply.ok !== true) throw new Error(`the host's daemon refused it: ${String(reply.error ?? '')}`)
      links.get(hostKey)!.spec = next
      await refreshStatus(host)
    },
    stop(): void {
      for (const key of [...polls.keys()]) stopPoll(key)
    },
  }
}

export type HostServerManager = ReturnType<typeof createHostServerManager>
