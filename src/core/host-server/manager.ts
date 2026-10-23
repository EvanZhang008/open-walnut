/**
 * The Mac's side of the host servers (docs/plan/walnut-servers-everywhere.md,
 * "A server on a host"). Primary only.
 *
 * For each host whose settings turn it on (`hosts.<key>.server.enabled`), on
 * every connect to that host's daemon (after `leader.configure`, so the daemon
 * knows which Walnut speaks) and after a settings change:
 *
 *   1. this Mac's build installed there as the compiled walnut file for the
 *      host's system (host-target.ts probes it, host-file.ts builds or
 *      downloads the file here, install.ts installs it): the host needs nothing
 *      installed, no Node, no npm, no compiler, no network
 *   2. its port (kept in the data dir, so the tunnel's target stays put), asked
 *      of the installed file itself
 *   3. this Mac's tunnel port held open: the door the host server's streams
 *      come in by (the daemon passes them from its link to ours)
 *   4. `server.configure` on the daemon (`<app>/walnut host-server`, or
 *      `web --replica`), with the server's tunnel in its settings; the daemon
 *      keeps it running
 *   5. its first report, through the daemon (`server.status`); only then are the
 *      older builds on the host removed (pruneScript), and the program is kept
 *      in the state file as the one that works
 *
 * A new build that misses its first report is not left in place of one that
 * worked: the program that last reported is configured again, the new build is
 * marked refused (the state file), and no connect tries it again until Retry.
 * An install that failed on the host is not sent again either until Retry.
 *
 * Which program: a daemon with `replica-host-v1` runs the full server program as a
 * follower (`web --replica`, docs/plan/walnut-replica-servers-impl.md WP2, the
 * default since D13), with the plain host server as the daemon's own crash-loop
 * `fallback`; `hosts.<key>.server_program: 'host-server'` (the rollback) and an
 * older daemon run `host-server` as before.
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
import { execNeedsBunBeBun } from '../../lib/runtime.js'
import type { HostServerStatus } from '../../providers/host-server-core.js'
import { getExposeProvider } from '../expose/registry.js'
import type { ExposeProviderDefinition, ExposeStatus } from '../expose/types.js'
import type { HostFileSource } from './host-file.js'
import { parseHostTarget, targetProbeScript } from './host-target.js'
import { validBuildId } from '../companion-build/wire.js'
import {
  checkHostRoot, fileInstallScript, freePortsScript, HOST_ROOT, launchScript, parseFreePorts, parseInstallState, pruneScript, stateScript,
  type InstallState,
} from './install.js'

/** What the manager needs of a host's daemon connection (DaemonConnection has it). */
export interface HostServerHost {
  hostKey: string
  connected: boolean
  hasCapability(cap: string): boolean
  send(cmd: string, params?: Record<string, unknown>, timeoutMs?: number): Promise<Record<string, unknown>>
  runRemoteScript(script: string, timeoutMs?: number): Promise<string>
  /** `sha256` of `data`: a file already there with it is not sent again (DaemonConnection.uploadFile). */
  uploadFile(remotePath: string, data: Buffer, opts?: { sha256?: string }): Promise<unknown>
  /** A byte stream to the server on that host that follows this Walnut, through its daemon. */
  openStream(to: 'follower', purpose?: string): Promise<Duplex>
  /** Carry those streams on a link of their own while the server runs (providers/stream-lane.ts). */
  keepStreamLane?(on: boolean): void
}

export interface HostServerSettings {
  enabled: boolean
  expose: {
    enabled: boolean; provider: string | null; options: Record<string, string>
    /** Why the host's own tunnel does not run although it is on (it would take this computer's address). */
    blocked?: string
  }
  /** This Walnut's tunnel (Open from a browser) runs here, instead of on this computer (expose/placement.ts). */
  carriesTunnel?: boolean
  /**
   * Whether this host carries this Walnut's tunnel is not known now (its provider is not
   * registered: a plugin still loading, or one that failed): the host is left as it was
   * last configured, so the tunnel it may carry keeps running.
   */
  keepAsConfigured?: string
  /** The host's choice (`hosts.<key>.server_program`): 'host-server' keeps the plain host server; else `web --replica` where the daemon can (D13). */
  program?: 'replica' | 'host-server'
  /**
   * Which kinds the Mac copies to this host's replica (`hosts.<key>.server.copies`,
   * the host's Settings row): sessions, requests, boards, inbox, inbox bodies.
   * Unset: replication/kinds/copy-kind.ts DEFAULT_COPY_CHOICE (every kind on).
   */
  copies?: Record<string, boolean>
  /** `hosts.<key>.server.ask_bypass`: a new ask on the host while the Mac is away may start in bypass (WP12). */
  askBypass?: boolean
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
    /** The host's journal (its daemon's follower.status line), a replica's report only (WP14). */
    journal?: Record<string, unknown> | null
  } | null
  /**
   * The reported tunnel's `since` on this computer's clock (the host's clock may differ): its
   * age by the host's clock, counted back from before this computer asked, so never later than
   * it was. A tunnel handover reads it (expose/placement.ts hostHolds).
   */
  exposeSince?: number
  port?: number
  /**
   * Which program runs: what the daemon was told (the replica only where the host
   * opted in and its daemon can), or 'fallback' while the daemon runs the plain
   * host server after the replica crash-looped (`daemon.fallback` says since, until, why).
   */
  program?: 'replica' | 'host-server' | 'fallback'
  /** While it runs: why it runs an older build than this Mac's (that one did not answer; Retry tries it again). */
  notice?: string
}

/** A program the host ran that reported, as configured (the settings are always the current ones). */
interface WorkingProgram {
  id: string
  command: string
  args: string[]
  env: Record<string, string>
  fallback?: { args: string[]; env: Record<string, string> }
  cwd: string
  log: string
}

/** Per host, in the state file: its port, the program that last worked, a build that did not. */
interface HostRecord {
  publicPort: number
  working?: WorkingProgram
  refused?: { id: string; message: string }
}

/** A host's copy target: `ready` when its server answers, `restarted` when another process answers than last time. */
export interface HostCopyTarget { unregister(): void; ready(restarted: boolean): void }

export interface ManagerDeps {
  settingsOf(hostKey: string): Promise<HostServerSettings | null>
  label(hostKey: string): Promise<string>
  walnutId(): Promise<string>
  home: string
  /** This Mac's tunnel port, held open: host servers' streams come in by it. */
  holdTunnelPort(holder: string): Promise<number>
  releaseTunnelPort(holder: string): Promise<void>
  /** This Mac's build as the walnut file for a host's target (host-file.ts). */
  hostFile: HostFileSource
  stateFile: string
  /**
   * Machine-local (never synced): the tunnel retry count each host was last given. The server
   * there restarts its tunnel when the count changes, so a count that started over at 0 after
   * a restart here would restart it. Unset: kept in memory only.
   */
  retryFile?: string
  now(): number
  /** Copies for the follower (core/replication/replica-targets.ts); `ready` once its server answers. */
  registerTarget?(
    hostKey: string,
    post: (body: Record<string, unknown>, opts?: { timeoutMs?: number }) => Promise<Response>,
    /** The host's choice of copied kinds, read at each round (its Settings row). */
    copies?: () => Promise<Record<string, boolean> | undefined>,
  ): HostCopyTarget
  /** A view changed (the settings page listens). */
  changed?(view: HostServerView): void
  /**
   * True while this server is stopping: a reconcile then changes nothing on a host. Its plugins
   * go first, and a tunnel provider gone with them must not take the tunnel off the host that
   * carries it; the host's daemon keeps that server running, and the next server sets it again.
   */
  frozen?(): boolean | Promise<boolean>
  pollMs?: number
  installPollMs?: number
  /** How long a started server has to send its first report. */
  firstReportMs?: number
  /** The root on the host (WALNUT_HOST_SERVER_ROOT; default HOST_ROOT). */
  hostRoot?: string
  /**
   * Tests only (WALNUT_HOST_SERVER_APP_DIR): run `<appCommand> <appDir>/dist/cli.js`
   * on the host instead of installing the file. Meant for a "host" that is this
   * machine, so appCommand defaults to this process's own bun. A walnut file is
   * no default: it would run the dist build only told to be bun (BUN_BE_BUN=1),
   * which every child of that server (its daemon, each `claude`) would inherit.
   */
  appDir?: string
  appCommand?: string
}

/** How the host runs Walnut: `<command> ...prefix <subcommand>`; `asBun` when the command is the walnut file. */
interface HostProgram { command: string; prefix: string[]; asBun: boolean }

/** Unpack, check and try the file once: seconds, minutes on a slow disk. */
const INSTALL_TIMEOUT_MS = 5 * 60_000
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

/** This server began to stop during a reconcile (ManagerDeps.frozen): it ends without a word. */
class StoppingHere extends Error {}

export function createHostServerManager(deps: ManagerDeps) {
  const views = new Map<string, HostServerView>()
  const hosts = new Map<string, HostServerHost>()
  const running = new Map<string, Promise<void>>()
  const rerun = new Set<string>()
  const retries = new Set<string>()
  const polls = new Map<string, ReturnType<typeof setInterval>>()
  /** Per host set up: the copy target, the spec last sent (for a tunnel retry), the server pid the target last heard of. */
  const links = new Map<string, { target?: HostCopyTarget; spec?: Record<string, unknown>; ranAs?: number }>()
  /** Bumped by "retry the tunnel": the server retries when it sees it change. */
  const exposeRetries = new Map<string, number>()
  /** The program each host's daemon was told to run. */
  const asked = new Map<string, 'replica' | 'host-server'>()
  /**
   * The program last configured per host (WP12: the walnut MCP mount of a session
   * there). Kept across a disconnect, unlike `links`: the drain that adopts a host's away ask
   * runs on the reconnect, before this host's reconcile has configured it again.
   */
  const configured = new Map<string, { command: string; args: string[] }>()
  /** Per host running an older build than this Mac's: why (the view's `notice`). */
  const notices = new Map<string, string>()
  /** The program the view shows: the daemon's own word wins (its fallback runs while the Mac sleeps too). */
  const programOf = (hostKey: string, status: HostServerStatus | undefined): HostServerView['program'] =>
    status?.program === 'fallback' ? 'fallback' : asked.get(hostKey)

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
    // The copy target is registered while the server still starts; its first
    // round (and the one after a restart) waits for this, not for a task event;
    // a reconcile cycles the phase of the same process (same pid): no restart.
    const link = links.get(hostKey)
    if (phaseChanged && v.phase === 'running' && link?.target) {
      link.target.ready(v.daemon?.pid === undefined || v.daemon.pid !== link.ranAs)
      link.ranAs = v.daemon?.pid
    }
  }

  function readState(): Record<string, HostRecord> {
    try { return JSON.parse(fs.readFileSync(deps.stateFile, 'utf8')) as Record<string, HostRecord> } catch { return {} }
  }

  /** Change one host's record (its port must be there already). */
  function updateRecord(hostKey: string, patch: (r: HostRecord) => void): void {
    const all = readState()
    const r = all[hostKey]
    if (!r) return
    patch(r)
    writeState(all)
  }

  function readRetries(): Record<string, unknown> {
    if (!deps.retryFile) return {}
    try { return JSON.parse(fs.readFileSync(deps.retryFile, 'utf8')) as Record<string, unknown> } catch { return {} }
  }

  /** The tunnel retry count the host was last given (kept across restarts here). */
  function retryCount(hostKey: string): number {
    const kept = exposeRetries.get(hostKey) ?? readRetries()[hostKey]
    return typeof kept === 'number' && Number.isInteger(kept) && kept >= 0 ? kept : 0
  }

  function keepRetryCount(hostKey: string, n: number): void {
    if (!deps.retryFile) return
    try {
      fs.mkdirSync(path.dirname(deps.retryFile), { recursive: true, mode: 0o700 })
      const tmp = `${deps.retryFile}.${process.pid}.tmp`
      fs.writeFileSync(tmp, JSON.stringify({ ...readRetries(), [hostKey]: n }), { mode: 0o600 })
      fs.renameSync(tmp, deps.retryFile)
    } catch (err) {
      log.session.warn('host server: the tunnel retry count was not kept', { host: hostKey, error: err instanceof Error ? err.message : String(err) })
    }
  }

  function writeState(all: Record<string, HostRecord>): void {
    fs.mkdirSync(path.dirname(deps.stateFile), { recursive: true })
    const tmp = `${deps.stateFile}.${process.pid}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(all, null, 2), { mode: 0o600 })
    fs.renameSync(tmp, deps.stateFile)
  }

  async function portsFor(host: HostServerHost, program: HostProgram): Promise<HostRecord> {
    const all = readState()
    const kept = all[host.hostKey]
    if (kept && Number.isInteger(kept.publicPort)) return kept
    const candidates = Array.from({ length: 8 }, () => PORT_BASE + crypto.randomInt(PORT_SPAN))
    const free = [...parseFreePorts(await host.runRemoteScript(freePortsScript(program, candidates), 20_000))]
    if (free.length < 1) throw new Error('could not find a free port on the host')
    const rec: HostRecord = { publicPort: free[0]! }
    all[host.hostKey] = rec
    writeState(all)
    return rec
  }

  /**
   * This Mac's build installed on the host: its id and how to run it. An install
   * that failed there is not sent again until `retry` (the person's Retry): the
   * same file would fail the same way, after the same upload.
   */
  async function ensureInstalled(host: HostServerHost, retry: boolean): Promise<{ id: string; root: string; rootSpec: string; program: HostProgram; dataDir: string; logFile: string; runDir: string }> {
    const rootSpec = checkHostRoot(deps.hostRoot ?? HOST_ROOT)
    const remoteHome = rootSpec.startsWith('$HOME') ? (await host.runRemoteScript('printf %s "$HOME"', 10_000)).trim() : ''
    if (rootSpec.startsWith('$HOME') && !remoteHome.startsWith('/')) throw new Error('the host did not say where its home is')
    const root = rootSpec.replace('$HOME', remoteHome)
    const dirs = { root, rootSpec, dataDir: `${root}/data`, logFile: `${root}/logs/server.log`, runDir: `${root}/run` }
    if (deps.appDir) {
      // Tests: a local tree stands in for an installed build.
      if (!deps.appDir.startsWith('/')) throw new Error('WALNUT_HOST_SERVER_APP_DIR must be an absolute path')
      if (!deps.appCommand && execNeedsBunBeBun()) {
        throw new Error('WALNUT_HOST_SERVER_APP_DIR runs a dist build, which needs bun; this Walnut runs as the compiled file')
      }
      set(host.hostKey, { build: 'local-app', install: { state: 'ready' } })
      return { id: 'local-app', program: { command: deps.appCommand ?? process.execPath, prefix: [`${deps.appDir}/dist/cli.js`], asBun: false }, ...dirs }
    }
    const { id } = await deps.hostFile.buildId()
    const installed = { id, program: { command: `${root}/app/${id}/walnut`, prefix: [], asBun: true }, ...dirs }
    set(host.hostKey, { build: id })
    let state = parseInstallState(await host.runRemoteScript(stateScript(id, rootSpec), 15_000))
    if (state.state === 'ready') { set(host.hostKey, { install: state }); return installed }
    if (state.state === 'failed' && !retry) {
      set(host.hostKey, { install: state })
      throw new Error(`the install of Walnut ${id} on the host failed: ${state.message}. Press Retry to install it again.`)
    }
    if (state.state !== 'running') {
      const target = parseHostTarget(await host.runRemoteScript(targetProbeScript(), 15_000))
      set(host.hostKey, { phase: 'installing', message: `Getting Walnut ${id} for ${target.target}.`, install: { state: 'running' } })
      const file = await deps.hostFile.file(target.target, (message) => set(host.hostKey, { message }))
      set(host.hostKey, { message: `Sending Walnut ${id} for ${target.target} to the host (${Math.max(1, Math.round(file.gz.length / 2 ** 20))} MB).` })
      // The daemon deploy's path: one SSH stream, small chunks over their own connections when a
      // proxy kills it; one already there (an earlier try) is not sent again.
      await host.uploadFile(`${root}/incoming/${id}.gz`, file.gz, { sha256: file.gzSha256 })
      const script = fileInstallScript({ id, version: file.version, commit: file.commit, sha256: file.sha256, host: target.describe, ...(deps.hostRoot ? { root: rootSpec } : {}) })
      await host.uploadFile(`${root}/incoming/${id}.install.sh`, Buffer.from(script))
      await host.runRemoteScript(launchScript(id, rootSpec), 15_000)
      set(host.hostKey, { message: `Installing Walnut ${id} on the host.` })
    } else {
      set(host.hostKey, { phase: 'installing', message: `Installing Walnut ${id} on the host.`, install: state })
    }
    const until = deps.now() + INSTALL_TIMEOUT_MS
    for (;;) {
      await new Promise((r) => setTimeout(r, deps.installPollMs ?? 2_000))
      if (!host.connected) throw new Error('the host went away during the install')
      state = parseInstallState(await host.runRemoteScript(stateScript(id, rootSpec), 15_000))
      if (state.state === 'ready') { set(host.hostKey, { install: state }); return installed }
      if (state.state === 'failed') { set(host.hostKey, { install: state }); throw new Error(`the install of Walnut ${id} on the host failed: ${state.message}`) }
      if (state.state === 'absent') throw new Error(`the install on the host stopped without a word (see ${root}/incoming on the host)`)
      if (deps.now() > until) throw new Error('the install on the host took more than 5 minutes')
    }
  }

  async function exposeSettingsFor(settings: HostServerSettings): Promise<{ enabled: boolean; definition: ExposeProviderDefinition | null; options: Record<string, string> }> {
    const id = settings.expose.provider
    const definition = id ? getExposeProvider(id) : null
    return { enabled: settings.expose.enabled && !!definition, definition, options: settings.expose.options }
  }

  /** The daemon's supervision of the server and the server's last report. */
  async function refreshStatus(host: HostServerHost): Promise<HostServerStatus | undefined> {
    const asked = deps.now()
    const daemon = await host.send('server.status', { home: deps.home }, 10_000).catch(() => null)
    const status = (daemon?.status ?? undefined) as HostServerStatus | undefined
    // The host's own clock says how old the report is; the two clocks may differ.
    const age = typeof status?.reportAgeMs === 'number' ? status.reportAgeMs : status?.reportedAt ? deps.now() - status.reportedAt : Infinity
    // A report is the program's that runs now only when it names that pid: the daemon files a
    // report under the Walnut it serves, and the process a configure just replaced reports on
    // until it is gone, which would read as the new build answering.
    const reportPid = (status?.report as { pid?: unknown } | undefined)?.pid
    const ours = typeof reportPid !== 'number' || typeof status?.pid !== 'number' || reportPid === status.pid
    const fresh = !!status?.report && age <= REPORT_STALE_MS && ours
    const server = fresh ? (status!.report as HostServerView['server']) : null
    const phase: HostServerPhase = server ? 'running' : status?.state === 'running' || status?.state === 'starting' ? 'starting' : 'error'
    const message = server ? undefined
      : status?.state === 'retrying' ? `The server on the host stopped (${status.lastError ?? 'no reason given'}); its daemon starts it again shortly.`
        : status?.state === 'off' ? 'The host\'s daemon is not running the server.'
          : 'Waiting for the server on the host to answer.'
    const e = server?.expose
    const exposeSince = e && typeof e.since === 'number' && typeof status?.reportedAt === 'number' && typeof status.reportAgeMs === 'number'
      ? asked - status.reportAgeMs - Math.max(0, status.reportedAt - e.since)
      : undefined
    set(host.hostKey, { phase, message, daemon: status, server, exposeSince, program: programOf(host.hostKey, status), notice: server ? notices.get(host.hostKey) : undefined })
    return status
  }

  function dropLink(hostKey: string): void {
    links.get(hostKey)?.target?.unregister()
    links.delete(hostKey)
  }

  function stopPoll(hostKey: string): void {
    const t = polls.get(hostKey)
    if (t) { clearInterval(t); polls.delete(hostKey) }
  }

  /** Tell the daemon to run `spec`, and remember what it runs. */
  async function configure(host: HostServerHost, spec: Record<string, unknown> & { command: string; args: string[] }, replica: boolean): Promise<void> {
    const hostKey = host.hostKey
    // Stopping since the settings were read (the steps before take a while): the host stays as it was.
    if (await deps.frozen?.()) throw new StoppingHere()
    const reply = await host.send('server.configure', { home: deps.home, spec }, 15_000)
    if (reply.ok !== true) throw new Error(`the host's daemon refused the server: ${String(reply.error ?? '')}`)
    asked.set(hostKey, replica ? 'replica' : 'host-server')
    configured.set(hostKey, { command: spec.command, args: [...spec.args] })
    set(hostKey, { daemon: reply.status as HostServerStatus, program: programOf(hostKey, reply.status as HostServerStatus) })
    const link = links.get(hostKey) ?? {}
    link.spec = spec
    links.set(hostKey, link)
  }

  /** Wait for the server's first report through its daemon: null once it reports, else why not. */
  async function firstReport(host: HostServerHost, logFile: string): Promise<string | null> {
    const until = deps.now() + (deps.firstReportMs ?? FIRST_REPORT_MS)
    for (;;) {
      const status = await refreshStatus(host)
      if (view(host.hostKey).phase === 'running') return null
      if (deps.now() > until) {
        return `the server on the host did not answer within a minute${status?.lastError ? ` (${status.lastError})` : ''}; its log is ${logFile} on the host`
      }
      await new Promise((r) => setTimeout(r, deps.installPollMs ?? 2_000))
    }
  }

  /** The id of the build the host server reports it runs, when it says (`<version>-<commit>`). */
  function reportedId(status: HostServerStatus | undefined): string | null {
    const r = status?.report as { version?: unknown; commit?: unknown } | undefined
    return typeof r?.version === 'string' && typeof r.commit === 'string' && r.commit ? `${r.version}-${r.commit}` : null
  }

  async function reconcileOnce(hostKey: string, retry = false): Promise<void> {
    const host = hosts.get(hostKey)
    if (await deps.frozen?.()) return
    const settings = await deps.settingsOf(hostKey)
    // Read while this server began to stop (its plugins going): what they say is not the person's.
    if (await deps.frozen?.()) return
    if (settings?.keepAsConfigured) {
      log.session.info('host server: left as configured', { host: hostKey, why: settings.keepAsConfigured })
      return
    }
    // The tunnel's definition as it is now, next to the settings: a provider that goes away
    // during the steps below (plugins stopping) must not turn the host's tunnel off.
    const exposeSettings = settings?.enabled === true ? await exposeSettingsFor(settings) : null
    const enabled = settings?.enabled === true
    if (!enabled) {
      stopPoll(hostKey)
      // Also after a restart of this server: the host may still run one it set up before.
      if (host?.connected && host.hasCapability('host-server-v1')) {
        const st = await host.send('server.status', { home: deps.home }, 10_000).catch(() => null)
        const state = (st?.status as HostServerStatus | undefined)?.state
        if (state && state !== 'off') {
          if (await deps.frozen?.()) return
          await host.send('server.configure', { home: deps.home, spec: null }, 15_000).catch(() => undefined)
          log.session.info('host server: turned off, stopped on the host', { host: hostKey })
        }
      }
      dropLink(hostKey)
      configured.delete(hostKey)
      notices.delete(hostKey)
      host?.keepStreamLane?.(false)
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
      const install = await ensureInstalled(host, retry)
      const rec = await portsFor(host, install.program)
      set(hostKey, { phase: 'starting', message: 'Starting the server on the host.', port: rec.publicPort })
      // The door its streams come in by (the tunnel port trusts nothing on loopback).
      await deps.holdTunnelPort(`host-server:${hostKey}`)
      host.keepStreamLane?.(true)
      const { command, prefix } = install.program
      const hostServerArgs = [...prefix, 'host-server']
      const hostServerEnv: Record<string, string> = {
        OPEN_WALNUT_HOME: install.dataDir,
        // Its own run dir (logs, scratch): never the host daemon's /tmp/open-walnut.
        WALNUT_DAEMON_DIR: install.runDir,
        WALNUT_HOST_SERVER: '1',
        WALNUT_HOST_SERVER_PORT: String(rec.publicPort),
        WALNUT_LEADER_HOME: deps.home,
        WALNUT_WALNUT_ID: await deps.walnutId(),
        WALNUT_HOST_LABEL: await deps.label(hostKey),
        WALNUT_NO_AUTO_UPDATE: '1',
      }
      // The full program as this host's replica wherever the daemon can (D13: the default since
      // the WP14 release gate); `server_program: 'host-server'` keeps the plain host server.
      const replica = settings!.program !== 'host-server' && host.hasCapability('replica-host-v1')
      const run: Omit<WorkingProgram, 'id' | 'command' | 'cwd' | 'log'> = replica
        ? {
            args: [...prefix, 'web', '--replica'],
            // Its own run dir (hostServerEnv): a replica never writes the daemon's dir or /tmp/open-walnut.
            // WALNUT_HOST_KEY: this Mac's name for the host, the `host` of the sessions that run there:
            // the replica reads them and their files itself (replica/self-host.ts, WP6), and the
            // console tells a session here from one on the Mac (WP7).
            env: { ...hostServerEnv, WALNUT_ROLE: 'replica', WALNUT_PLACEMENT: 'host', WALNUT_HOST_KEY: hostKey },
            // The daemon runs this by itself after a crash loop (it works while the Mac sleeps).
            fallback: { args: hostServerArgs, env: hostServerEnv },
          }
        : { args: hostServerArgs, env: hostServerEnv }
      if (settings!.program !== 'host-server' && !replica) {
        log.session.info('host server: the host would run the replica, its daemon cannot run it yet', { host: hostKey })
      }
      const fresh: WorkingProgram = { id: install.id, command, cwd: install.dataDir, log: install.logFile, ...run }
      const specOf = async (p: WorkingProgram) => ({
        v: 1, home: deps.home, walnutId: await deps.walnutId(),
        command: p.command, args: p.args, cwd: p.cwd, env: p.env,
        ...(p.fallback ? { fallback: p.fallback } : {}),
        log: p.log, port: rec.publicPort,
        // Read by the server while it runs: a change here restarts nothing.
        settings: { expose: exposeSettings, exposeRetry: retryCount(hostKey) },
      })
      const isReplica = (p: WorkingProgram) => p.args.includes('--replica')
      const working = rec.working && rec.working.id !== fresh.id ? rec.working : undefined
      let runs = fresh
      if (!retry && working && rec.refused?.id === fresh.id) {
        // This build did not answer before: until Retry, the host keeps the one that worked.
        runs = working
        notices.set(hostKey, olderNotice(fresh.id, working.id, rec.refused.message))
        await configure(host, await specOf(working), isReplica(working))
      } else {
        // What ran before this build, by the record or by its own report: kept on the host until this one answers.
        const before = reportedId((await host.send('server.status', { home: deps.home }, 10_000).catch(() => null))?.status as HostServerStatus | undefined)
        notices.delete(hostKey)
        await configure(host, await specOf(fresh), replica)
        await afterConfigure(host, replica)
        const missed = await firstReport(host, fresh.log)
        if (!missed) {
          updateRecord(hostKey, (r) => { r.working = fresh; delete r.refused })
          if (!deps.appDir) {
            const keep = [...new Set([fresh.id, working?.id, before].filter((k): k is string => !!k && validBuildId(k)))]
            await host.runRemoteScript(pruneScript(keep, install.rootSpec), 60_000)
              .catch((err: Error) => log.session.warn('host server: removing older builds on the host failed', { host: hostKey, error: err.message }))
          }
          startPoll(hostKey)
          return
        }
        if (!working) throw new Error(missed)
        // Back to the program that worked; this build waits for Retry.
        log.session.warn('host server: the new build did not answer, running the one before it', { host: hostKey, build: fresh.id, previous: working.id, error: missed })
        updateRecord(hostKey, (r) => { r.refused = { id: fresh.id, message: missed } })
        runs = working
        notices.set(hostKey, olderNotice(fresh.id, working.id, missed))
        await configure(host, await specOf(working), isReplica(working))
      }
      await afterConfigure(host, isReplica(runs))
      const missed = await firstReport(host, runs.log)
      if (missed) throw new Error(missed)
      startPoll(hostKey)
    } catch (err) {
      if (err instanceof StoppingHere) return
      const message = err instanceof Error ? err.message : String(err)
      log.session.warn('host server: setup failed', { host: hostKey, error: message })
      set(hostKey, { phase: 'error', message })
    }
  }

  function olderNotice(id: string, older: string, why: string): string {
    return `It runs Walnut ${older}, the build before this computer's: ${id} did not answer on the host (${why}). Try again to start ${id}.`
  }

  function startPoll(hostKey: string): void {
    if (polls.has(hostKey)) return
    const t = setInterval(() => { void poll(hostKey) }, deps.pollMs ?? 30_000)
    t.unref?.()
    polls.set(hostKey, t)
  }

  /** What follows a configure: the replica's spawn template, the copy target. */
  async function afterConfigure(host: HostServerHost, replica: boolean): Promise<void> {
    const hostKey = host.hostKey
    const settings = await deps.settingsOf(hostKey)
    const dataDir = (links.get(hostKey)?.spec as { cwd?: string } | undefined)?.cwd
    // A new ask on the host while the Mac is away (WP12): the spawn template its daemon
    // fills from validated fields only (spawn-template.ts, host-start-core.ts). Asks run in
    // the replica's data dir, the host's counterpart of this Mac's WALNUT_HOME.
    if (replica && dataDir) {
      try {
        const { pushHostSpawnTemplate } = await import('../../providers/spawn-template.js')
        const pushed = await pushHostSpawnTemplate(host, { home: deps.home, hostKey, cwd: dataDir, bypassAllowed: settings?.askBypass === true })
        if (pushed) log.session.info('host server: spawn template pushed', { host: hostKey, cwd: dataDir, bypass: settings?.askBypass === true })
      } catch (err) {
        log.session.warn('host server: the spawn template was not pushed; a new ask there needs this Mac', { host: hostKey, error: err instanceof Error ? err.message : String(err) })
      }
    }
    // The copies (task store, search index) for this follower, on a stream through its daemon.
    const link = links.get(hostKey) ?? {}
    links.set(hostKey, link)
    if (deps.registerTarget && !link.target) {
      link.target = deps.registerTarget(hostKey, async (body, opts) => {
        const h = hosts.get(hostKey)
        if (!h?.connected) throw new Error('the host is not connected')
        const stream = await h.openStream('follower', 'replica')
        return requestOver(stream, 'POST', '/bridge/replica', Buffer.from(JSON.stringify(body)), opts?.timeoutMs ?? 60_000)
      }, async () => (await deps.settingsOf(hostKey))?.copies)
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

  /**
   * Serialized per host; a call while one runs makes it run once more. `retry`:
   * the person asked (Retry): a failed install and a refused build are tried again.
   */
  function reconcile(hostKey: string, opts: { retry?: boolean } = {}): Promise<void> {
    if (opts.retry) retries.add(hostKey)
    const current = running.get(hostKey)
    if (current) { rerun.add(hostKey); return current }
    const run = (async () => {
      do {
        rerun.delete(hostKey)
        const retry = retries.delete(hostKey)
        await reconcileOnce(hostKey, retry)
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
    /**
     * The program this Mac configured on a host (the walnut file there and its arguments), or
     * null: the walnut MCP mount of a session that runs there (WP12), so a cold resume on
     * the host never mounts this Mac's execPath.
     */
    programOf: (hostKey: string): { command: string; args: string[] } | null => {
      const p = configured.get(hostKey)
      return p ? { command: p.command, args: [...p.args] } : null
    },
    view: (hostKey: string): HostServerView => ({ ...view(hostKey) }),
    /** Ask the host server to start its tunnel again now (a new retry count in its settings). */
    async retryExpose(hostKey: string): Promise<void> {
      const host = hosts.get(hostKey)
      const spec = links.get(hostKey)?.spec
      if (!host?.connected || !spec) throw new Error('the server on that host is not set up')
      const n = retryCount(hostKey) + 1
      exposeRetries.set(hostKey, n)
      keepRetryCount(hostKey, n)
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
