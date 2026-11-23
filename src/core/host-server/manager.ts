/**
 * The Mac's side of the host servers (docs/plan/walnut-servers-everywhere.md,
 * "A server on a host"). Primary only.
 *
 * For each host whose settings turn it on (`hosts.<key>.server.enabled`, or the default:
 * follower-default.ts), on every connect to that host's daemon (after `leader.configure`, so
 * the daemon knows which Walnut speaks) and after a settings change:
 *
 *   0. a host on only by default, with no follower of this Walnut yet, is looked at first
 *      (eligibility.ts): a build that runs there, enough memory, room on its disk. One that
 *      lacks one stays without a follower, its view says why (`not-eligible`), and memory or
 *      disk is looked at again later (try-later.ts)
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
 * A newer build of this Mac does not go to a host whose working program reports
 * now until it has served here for a quiet window, at most a cap after the host
 * fell behind (update-hold.ts says when it goes at once); the 30 s report poll
 * sends it when the window passes.
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

import { followerPortTaken } from './follower-port.js'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { log } from '../../logging/index.js'
import { execNeedsBunBeBun } from '../../lib/runtime.js'
import type { HostServerStatus } from '../../providers/host-server-core.js'
import { getExposeProvider } from '../expose/registry.js'
import type { ExposeProviderDefinition } from '../expose/types.js'
import { parseHostTarget, targetProbeScript, type HostTarget } from './host-target.js'
import { NoHostFile } from './host-file.js'
import { validBuildId } from '../companion-build/wire.js'
import {
  checkHostRoot, fileInstallScript, freePortsScript, HOST_ROOT, installCannotRun, launchScript, legacyDataOwnerScript, parseFreePorts, parseInstallState, pruneScript, stateScript,
  walnutDirs, walnutDirsScript,
} from './install.js'
import { DEFAULT_UPDATE_MAX_BEHIND_MS, DEFAULT_UPDATE_QUIET_MS, heldNotice, updateHold } from './update-hold.js'
import { requestOver } from './request-over.js'
import { hostProgramRun, hostServerEnvOf } from './replica-run.js'
import { FOLLOWER_FLOORS, judgeFollowerRoom, roomProbeScript, type FollowerGateReason } from './eligibility.js'
import { createTryLater, inWords, type TryLaterKind } from './try-later.js'
import { FOLLOWER_GATEWAY_CAPABILITY } from '../../providers/follower-gateway-core.js'
import { pluginsKeepingTasks } from '../plugins/plugin-task-visibility.js'
import { servesThisWalnut, type FollowerFact } from '../../providers/one-service-mode.js'

export type {
  HostServerHost, HostServerSettings, HostServerPhase, HostServerView, HostCopyTarget, ManagerDeps,
} from './manager-types.js'
import type {
  HostServerHost, HostServerSettings, HostServerPhase, HostServerView, HostCopyTarget, ManagerDeps, WorkingProgram, HostRecord, HostProgram,
} from './manager-types.js'

/** Unpack, check and try the file once: seconds, minutes on a slow disk. */
const INSTALL_TIMEOUT_MS = 5 * 60_000
/** How long an install waits for a link that dropped to come back. */
const LINK_BACK_MS = 60_000
/** Leads the view while the link is down and an upload or install still goes on. */
const DROPPED_LINE = 'The link to the host dropped for a moment; the build keeps going over its own connection.'
const FIRST_REPORT_MS = 60_000
/** A report older than this says the server is not answering its daemon. */
const REPORT_STALE_MS = 20_000
const PORT_BASE = 41_000
const PORT_SPAN = 9_000

/** A file this server cannot make for the host waits for Retry or a newer build; any other failure of getting it is tried again later. */
function noFileYet(err: unknown): never {
  if (err instanceof NoHostFile) throw new UntilRetry(err.message, true)
  throw err
}

/** This server began to stop during a reconcile (ManagerDeps.frozen): it ends without a word. */
class StoppingHere extends Error {}

/**
 * A setup step that would fail the same way again, so it waits for Retry (or a newer build):
 * an install that failed on the host, a system no build is made for, a build this computer has
 * no file for. `noBuild`: there is no file that runs on that host (this server has none for its
 * system, or its proof boot failed there), not a passing problem.
 */
class UntilRetry extends Error {
  /** `proofBoot`: the file's own check failed on the host (a full disk or an out of memory end may pass). */
  constructor(message: string, readonly noBuild: boolean, readonly proofBoot = false) { super(message) }
}

export function createHostServerManager(deps: ManagerDeps) {
  const views = new Map<string, HostServerView>()
  const hosts = new Map<string, HostServerHost>()
  const running = new Map<string, Promise<void>>()
  const rerun = new Set<string>()
  const retries = new Set<string>()
  /** Reconciles that are more than a config change somewhere (a connect, a timer, a settings write, Retry). */
  const hard = new Set<string>()
  /** The settings each host's last reconcile read, so a config change elsewhere does not redo a setup that waits. */
  const lastSettings = new Map<string, string>()
  /** The host's setup failed in this pass: why, and whether it tries again by itself (Walnut Health is told once per pass). */
  const failedNow = new Map<string, { message: string; triesAgain: boolean }>()
  /** A setup that runs again by itself, later and later (try-later.ts: a refused login, a failed start, a gate). */
  const tryLater = createTryLater({
    ...(deps.tryLaterMs ? { schedules: deps.tryLaterMs } : {}),
    now: deps.now,
    // A failed proof boot is tried again as Retry does: the install is sent again.
    run: (hostKey, kind) => { if (hosts.get(hostKey)?.connected) void reconcile(hostKey, kind === 'proof' ? { retry: true } : {}) },
  })
  /** The view's sentence for a setup that runs again later, and when (none past the end of a ladder that stops). */
  function retryingLater(hostKey: string, kind: TryLaterKind, message: string, o: { stopAtEnd?: boolean } = {}): { message: string; at: number | undefined } {
    const next = tryLater.later(hostKey, kind, o)
    const end = /[.!?]$/.test(message) ? '' : '.'
    if (!next) return { message: `${message}${end} Walnut stopped trying by itself: a newer build, a reconnect or Retry tries again.`, at: undefined }
    return { message: `${message}${end} Walnut ${kind === 'gate' || kind === 'proof' ? 'looks' : 'tries'} again in ${inWords(next.ms)}.`, at: next.at }
  }
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
  /** The spawn template each host's daemon process holds, by hash (kept across a reconnect to the same process). */
  const templateSent = new Map<string, { instance: string; hash: string }>()
  /** Per host whose newer build is held (update-hold.ts): when it goes; the poll sends it then. */
  const heldUntil = new Map<string, number>()
  const servingSince = deps.servingSince ?? deps.now()
  const quietMs = deps.updateQuietMs ?? DEFAULT_UPDATE_QUIET_MS
  const maxBehindMs = deps.updateMaxBehindMs ?? DEFAULT_UPDATE_MAX_BEHIND_MS
  const isReplica = (p: WorkingProgram) => p.args.includes('--replica')
  /** The program the view shows: the daemon's own word wins (its fallback runs while the Mac sleeps too). */
  const programOf = (hostKey: string, status: HostServerStatus | undefined): HostServerView['program'] =>
    status?.program === 'fallback' ? 'fallback' : asked.get(hostKey)

  function view(hostKey: string): HostServerView {
    let v = views.get(hostKey)
    if (!v) { v = { hostKey, enabled: false, phase: 'off', since: deps.now() }; views.set(hostKey, v) }
    return v
  }

  function set(hostKey: string, patch: Partial<HostServerView>): void {
    // The link dropped while the reconcile installs: its next steps update the view it will
    // show when the link returns, and the view says the link dropped meanwhile. A phase that
    // ends the install (running, error, off, ...) ends that and shows as it is.
    const kept = resumeView.get(hostKey)
    if (kept) {
      if (patch.phase === undefined || patch.phase === 'installing') {
        if (patch.message !== undefined) kept.message = patch.message
        const { phase: _phase, message: _message, ...rest } = patch
        patch = { ...rest, message: kept.message ? `${DROPPED_LINE} ${kept.message}` : DROPPED_LINE }
      } else {
        resumeView.delete(hostKey)
      }
    }
    const v = view(hostKey)
    const phaseChanged = patch.phase !== undefined && patch.phase !== v.phase
    Object.assign(v, patch)
    if (phaseChanged) v.since = deps.now()
    if (patch.phase !== undefined && patch.message === undefined && phaseChanged) v.message = undefined
    // Each says something of one phase only.
    if (v.phase !== 'not-eligible') delete v.gate
    if (v.phase !== 'error') delete v.retryAt
    if (v.phase !== 'installing' && v.phase !== 'waiting-for-host') delete v.upload
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
    // A port forgotten after a collision (follower-port.ts) keeps the rest of the record.
    const rec: HostRecord = { ...kept, publicPort: free[0]! }
    all[host.hostKey] = rec
    writeState(all)
    return rec
  }

  /**
   * This Mac's build installed on the host: its id and how to run it. An install
   * that failed there is not sent again until `retry` (the person's Retry): the
   * same file would fail the same way, after the same upload.
   */
  async function ensureInstalled(host: HostServerHost, retry: boolean, known?: HostTarget, queued = false): Promise<{ id: string; root: string; rootSpec: string; program: HostProgram; dataDir: string; logFile: string; runDir: string }> {
    const rootSpec = checkHostRoot(deps.hostRoot ?? HOST_ROOT)
    const remoteHome = rootSpec.startsWith('$HOME') ? (await host.runRemoteScript('printf %s "$HOME"', 10_000)).trim() : ''
    if (rootSpec.startsWith('$HOME') && !remoteHome.startsWith('/')) throw new Error('the host did not say where its home is')
    const root = rootSpec.replace('$HOME', () => remoteHome)
    // Each Walnut's server keeps its own data, log and run dirs on a host it may share with
    // another Walnut. One this Walnut already ran in the shared dirs from before the split
    // stays there (a live data dir is not moved), unless another Walnut marked them since.
    const walnutId = await deps.walnutId()
    const legacy = walnutDirs(root, null)
    const ownsLegacy = readState()[host.hostKey]?.working?.cwd === legacy.dataDir
      && (await host.runRemoteScript(legacyDataOwnerScript(walnutId, rootSpec), 15_000)).trim() === 'MINE'
    const dirs = { root, rootSpec, ...(ownsLegacy ? legacy : walnutDirs(root, walnutId)) }
    // The server's cwd is its data dir: a spawn into a dir no one made fails (ENOENT). A daemon
    // with walnut-scope-v1 makes it itself before the spawn; this covers an older one.
    await host.runRemoteScript(walnutDirsScript(dirs), 15_000)
      .catch((err: Error) => log.session.warn('host server: making this Walnut\'s dirs on the host failed', { host: host.hostKey, error: err.message }))
    if (deps.appDir) {
      // Tests: a local tree stands in for an installed build.
      if (!deps.appDir.startsWith('/')) throw new Error('WALNUT_HOST_SERVER_APP_DIR must be an absolute path')
      if (!deps.appCommand && execNeedsBunBeBun()) {
        throw new Error('WALNUT_HOST_SERVER_APP_DIR runs a dist build, which needs bun; this Walnut runs as the compiled file')
      }
      set(host.hostKey, { build: 'local-app', install: { state: 'ready' } })
      return { id: 'local-app', program: { command: deps.appCommand ?? process.execPath, prefix: [`${deps.appDir}/dist/cli.js`], asBun: false }, ...dirs }
    }
    const { id } = await deps.hostFile.buildId().catch(noFileYet)
    const installed = { id, program: { command: `${root}/app/${id}/walnut`, prefix: [], asBun: true }, ...dirs }
    set(host.hostKey, { build: id })
    let state = parseInstallState(await host.runRemoteScript(stateScript(id, rootSpec), 15_000))
    if (state.state === 'ready') { set(host.hostKey, { install: state }); return installed }
    if (state.state === 'failed' && !retry) {
      set(host.hostKey, { install: state })
      throw new UntilRetry(`the install of Walnut ${id} on the host failed: ${state.message}. Press Retry to install it again.`, installCannotRun(state.message), installCannotRun(state.message))
    }
    // An install made for the default waits its turn: one host at a time, so a flag turned on (or a
    // restart with it) never sends the file to every host at once over links sessions share.
    let release: (() => void) | null = null
    try {
      if (state.state !== 'running') {
        if (queued) {
          set(host.hostKey, { phase: 'installing', message: 'Waiting for its turn: Walnut installs on one host at a time for hosts on by default.' })
          release = await installTurn()
          if (!hosts.get(host.hostKey)?.connected) throw new Error('the host went away while its install waited for its turn')
          host = hosts.get(host.hostKey) ?? host
        }
        // A system no build of the file is made for: nothing to send, until Retry.
        const probe = known ? null : await host.runRemoteScript(targetProbeScript(), 15_000)
        let target: HostTarget
        try { target = known ?? parseHostTarget(probe!) } catch (err) { throw new UntilRetry(err instanceof Error ? err.message : String(err), true) }
        set(host.hostKey, { phase: 'installing', message: `Getting Walnut ${id} for ${target.target}.`, install: { state: 'running' } })
        const file = await deps.hostFile.file(target.target, (message) => set(host.hostKey, { message }))
          .catch(noFileYet)
        const mb = (n: number) => Math.max(1, Math.round(n / 2 ** 20))
        const sending = (pct?: number) => `Sending Walnut ${id} for ${target.target} to the host (${pct === undefined ? '' : `${pct}%, `}${mb(file.gz.length)} MB).`
        set(host.hostKey, { message: sending() })
        // The daemon deploy's path: one SSH stream, small chunks over their own connections when a
        // proxy kills it; one already there (an earlier try) is not sent again. Those connections
        // are not the daemon link's, so the upload goes on while the link drops and comes back.
        const gzPath = `${root}/incoming/${id}.gz`
        let shown = -1
        const onProgress = (sent: number, total: number): void => {
          const pct = total > 0 ? Math.floor((sent / total) * 100) : 0
          if (pct === shown || (pct - shown < 2 && pct < 100)) return
          shown = pct
          set(host.hostKey, { message: sending(pct), upload: { sent, total } })
        }
        if (!(await host.seedFromDaemon?.(file.sha256, gzPath).catch(() => false))) await host.uploadFile(gzPath, file.gz, { sha256: file.gzSha256, onProgress })
        const script = fileInstallScript({ id, version: file.version, commit: file.commit, sha256: file.sha256, host: target.describe, dataDir: dirs.dataDir, ...(deps.hostRoot ? { root: rootSpec } : {}) })
        await host.uploadFile(`${root}/incoming/${id}.install.sh`, Buffer.from(script))
        await host.runRemoteScript(launchScript(id, rootSpec), 15_000)
        set(host.hostKey, { message: `Installing Walnut ${id} on the host.` })
      } else {
        set(host.hostKey, { phase: 'installing', message: `Installing Walnut ${id} on the host.`, install: state })
      }
      const until = deps.now() + INSTALL_TIMEOUT_MS
      for (;;) {
        await new Promise((r) => setTimeout(r, deps.installPollMs ?? 2_000))
        // The install runs on the host by itself: a link that drops for a moment is waited for.
        if (!(await linkBack(host.hostKey))) throw new Error('the host went away during the install')
        host = hosts.get(host.hostKey) ?? host
        state = parseInstallState(await host.runRemoteScript(stateScript(id, rootSpec), 15_000))
        if (state.state === 'ready') { set(host.hostKey, { install: state }); return installed }
        if (state.state === 'failed') { set(host.hostKey, { install: state }); throw new UntilRetry(`the install of Walnut ${id} on the host failed: ${state.message}`, installCannotRun(state.message), installCannotRun(state.message)) }
        if (state.state === 'absent') throw new Error(`the install on the host stopped without a word (see ${root}/incoming on the host)`)
        if (deps.now() > until) throw new Error('the install on the host took more than 5 minutes')
      }
    } finally {
      release?.()
    }
  }

  /** The turn of installs made for the default: resolves with the release once every earlier one ended. */
  let installTail: Promise<void> = Promise.resolve()
  async function installTurn(): Promise<() => void> {
    let release!: () => void
    const mine = new Promise<void>((r) => { release = r })
    const before = installTail
    installTail = before.then(() => mine)
    await before
    return release
  }

  async function exposeSettingsFor(settings: HostServerSettings): Promise<{ enabled: boolean; definition: ExposeProviderDefinition | null; options: Record<string, string> }> {
    const id = settings.expose.provider
    const definition = id ? getExposeProvider(id) : null
    return { enabled: settings.expose.enabled && !!definition, definition, options: settings.expose.options }
  }

  /** The server's report is recent, and from the process the daemon runs now. */
  function reportFresh(status: HostServerStatus | undefined): boolean {
    // The host's own clock says how old the report is; the two clocks may differ.
    const age = typeof status?.reportAgeMs === 'number' ? status.reportAgeMs : status?.reportedAt ? deps.now() - status.reportedAt : Infinity
    // A report is the program's that runs now only when it names that pid: the daemon files a
    // report under the Walnut it serves, and the process a configure just replaced reports on
    // until it is gone, which would read as the new build answering.
    const reportPid = (status?.report as { pid?: unknown } | undefined)?.pid
    const ours = typeof reportPid !== 'number' || typeof status?.pid !== 'number' || reportPid === status.pid
    return !!status?.report && age <= REPORT_STALE_MS && ours
  }

  /**
   * The last report to keep in the view: a newer one than the view holds (a fresh one, or an
   * old one the daemon still has, dated by its age), else nothing changes. A failed status
   * read or a stale report never takes the kept one away.
   */
  function keptReport(hostKey: string, status: HostServerStatus | undefined, fresh: HostServerView['server'], asked: number): Pick<HostServerView, 'lastReport' | 'lastReportAt'> {
    const report = (fresh ?? status?.report) as HostServerView['server'] | undefined
    if (!report) return {}
    const at = typeof status?.reportAgeMs === 'number' ? asked - status.reportAgeMs
      : typeof status?.reportedAt === 'number' ? status.reportedAt
        : fresh ? asked : null
    if (at === null) return {}
    const was = view(hostKey).lastReportAt
    return was !== undefined && at < was ? {} : { lastReport: report, lastReportAt: at }
  }

  /** The daemon's supervision of the server and the server's last report. */
  async function refreshStatus(host: HostServerHost): Promise<HostServerStatus | undefined> {
    const asked = deps.now()
    const daemon = await host.send('server.status', { home: deps.home }, 10_000).catch(() => null)
    const status = (daemon?.status ?? undefined) as HostServerStatus | undefined
    const server = reportFresh(status) ? (status!.report as HostServerView['server']) : null
    const phase: HostServerPhase = server ? 'running' : status?.state === 'running' || status?.state === 'starting' ? 'starting' : 'error'
    const message = server ? undefined
      : status?.state === 'retrying' ? `The server on the host stopped (${status.lastError ?? 'no reason given'}); its daemon starts it again shortly.`
        : status?.state === 'off' ? 'The host\'s daemon is not running the server.'
          : 'Waiting for the server on the host to answer.'
    const e = server?.expose
    const exposeSince = e && typeof e.since === 'number' && typeof status?.reportedAt === 'number' && typeof status.reportAgeMs === 'number'
      ? asked - status.reportAgeMs - Math.max(0, status.reportedAt - e.since)
      : undefined
    set(host.hostKey, { phase, message, daemon: status, server, exposeSince, program: programOf(host.hostKey, status), notice: server ? notices.get(host.hostKey) : undefined, ...keptReport(host.hostKey, status, server, asked) })
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

  /**
   * This Mac's newer build waits (update-hold.ts) while the host runs the program the state
   * file keeps as working and it reports now, as configured: that program, or null to install.
   */
  async function heldBuild(host: HostServerHost, replica: boolean, retry: boolean): Promise<{ rec: HostRecord; working: WorkingProgram } | null> {
    const hostKey = host.hostKey
    heldUntil.delete(hostKey)
    if (deps.appDir) return null
    const rec = readState()[hostKey]
    const working = rec?.working
    if (!rec || !Number.isInteger(rec.publicPort) || !working) return null
    const mine = await deps.hostFile.buildId().then((b) => b.id, () => null)
    // The same build, no build to send (ensureInstalled says why), or one refused until Retry (kept below).
    if (!mine || working.id === mine || (!retry && rec.refused?.id === mine)) return null
    const status = retry ? undefined
      : (await host.send('server.status', { home: deps.home }, 10_000).catch(() => null))?.status as HostServerStatus | undefined
    const workingReports = !!status && status.program !== 'fallback' && reportFresh(status) && reportedId(status) === working.id
    const tooOld = workingReports ? await deps.copiesNeedNewer?.(hostKey).catch(() => null) ?? null : null
    const decision = updateHold({
      now: deps.now(), servingSince, behindSince: rec.behindSince, quietMs, maxBehindMs,
      workingReports, retry, programChanged: isReplica(working) !== replica, tooOld,
    })
    if (!decision.hold) {
      if (rec.behindSince !== undefined || decision.why !== 'no-working-program') {
        log.session.info('host server: this computer\'s build goes to the host now', { host: hostKey, running: working.id, build: mine, why: decision.why, ...(tooOld ? { tooOld } : {}) })
      }
      return null
    }
    if (rec.behindSince === undefined) updateRecord(hostKey, (r) => { r.behindSince = decision.behindSince })
    heldUntil.set(hostKey, decision.until)
    notices.set(hostKey, heldNotice(working.id, mine, quietMs, decision.latest))
    set(hostKey, { build: mine })
    log.session.info('host server: this computer\'s newer build waits for a quiet window', {
      host: hostKey, running: working.id, build: mine, until: new Date(decision.until).toISOString(), latest: new Date(decision.latest).toISOString(),
    })
    return { rec, working }
  }

  /** The host runs as this Walnut's one service: the program last kept as working, sent as it is. */
  function serviceHolds(host: HostServerHost): { rec: HostRecord; working: WorkingProgram } | null {
    if (!servesThisWalnut(host.servesAs?.(), deps.home)) return null
    const rec = readState()[host.hostKey]
    if (!rec || !Number.isInteger(rec.publicPort) || !rec.working || !isReplica(rec.working)) return null
    heldUntil.delete(host.hostKey)
    notices.delete(host.hostKey)
    return { rec, working: rec.working }
  }

  async function reconcileOnce(hostKey: string, retry = false, soft = false): Promise<void> {
    let host = hosts.get(hostKey)
    if (await deps.frozen?.()) return
    // A daemon reached by several aliases keeps ONE server per Walnut: only the name it goes by
    // (daemonKeeperAlias) sets it up or takes it down. 2026-11-20: the found twin `newdev`, off by
    // default, took down the server `clouddev` runs on that same machine.
    // This computer's own daemon under another row keeps the this-computer branch below.
    const keeper = host?.connected && host.daemonKeeper ? await host.daemonKeeper().catch(() => hostKey) : hostKey
    if (keeper !== hostKey && keeper !== '__local__') {
      // Nothing is set up or taken down from here, even while the keeper's own link is down:
      // the server it set up keeps running, and a change reaches it when that link is back.
      const up = hosts.get(keeper)?.connected === true
      notEligible(hostKey, 'another-name', up
        ? `This host is another name of ${keeper}: its Walnut server is set up there.`
        : `This host is another name of ${keeper}: its Walnut server is set up there, and a change reaches it once Walnut connects to ${keeper} again.`)
      return
    }
    const settings = await deps.settingsOf(hostKey)
    // Read while this server began to stop (its plugins going): what they say is not the person's.
    if (await deps.frozen?.()) return
    const everyHost = (await deps.everyHost?.()) === true
    // Without the experiment only a refused login waits to run again by itself (as before it):
    // a wait the experiment set is cancelled when it goes off.
    const waits = tryLater.pending(hostKey)
    const lastWait = tryLater.lastKind(hostKey)
    if (!everyHost && lastWait && lastWait !== 'login') tryLater.clear(hostKey)
    // A reconnect or Retry after a ladder that stopped (no timer left) starts it from its first step.
    else if (!soft && !waits && lastWait === 'failed') tryLater.clear(hostKey)
    // A config change elsewhere (favorites, ordering) does not redo a setup that waits to try again
    // (try-later.ts), nor one that stopped trying by itself or is not eligible, while this host's own
    // settings and the experiment are the same: the wait keeps its pace, a stop waits for a connect or Retry.
    const print = JSON.stringify({ settings, everyHost })
    const resting = (waits && waits !== 'login') || lastWait === 'failed' || view(hostKey).phase === 'not-eligible'
    if (soft && everyHost && resting && lastSettings.get(hostKey) === print) return
    lastSettings.set(hostKey, print)
    // Whether the host follows the default only (fleet and replica lists read it: such a host waiting or not eligible is no problem).
    const v0 = view(hostKey)
    if (settings?.byDefault && !settings.carriesTunnel) v0.byDefault = true
    else delete v0.byDefault
    if (settings?.keepAsConfigured) {
      log.session.info('host server: left as configured', { host: hostKey, why: settings.keepAsConfigured })
      return
    }
    // The tunnel's definition as it is now, next to the settings: a provider that goes away
    // during the steps below (plugins stopping) must not turn the host's tunnel off.
    const exposeSettings = settings?.enabled === true ? await exposeSettingsFor(settings) : null
    const enabled = settings?.enabled === true
    if (!enabled) {
      if (!(await takeDown(hostKey, host))) return
      set(hostKey, { enabled: false, phase: 'off', server: null, daemon: undefined, lastReport: undefined, lastReportAt: undefined })
      return
    }
    if (!host?.connected) {
      set(hostKey, { enabled: true, phase: 'waiting-for-host', message: 'It starts once Walnut connects to this host.' })
      return
    }
    if (!host.hasCapability('host-server-v1') || !host.hasCapability('follower-v1') || !host.hasCapability('stream-relay-v1')) {
      set(hostKey, { enabled: true, phase: 'unsupported', message: 'This host\'s Walnut daemon is older than this feature; it updates on its next connect.' })
      return
    }
    // A host row that is really this computer (its link reaches this computer's own daemon) runs
    // no second Walnut by default: this server is the one there. The person's switch still can.
    // Not known yet (this computer's own daemon is not linked yet, as at a start): nothing is
    // installed on an unknown; it is looked at again soon.
    if (settings!.byDefault && !settings!.carriesTunnel) {
      const self = host.reachesThisComputer ? await host.reachesThisComputer().catch(() => null) : false
      if (self === true) {
        if (!(await takeDown(hostKey, host))) return
        notEligible(hostKey, 'this-computer', 'No Walnut server runs on this host by default: it is this computer, which runs Walnut already.')
        return
      }
      if (self === null) {
        const later = tryLater.later(hostKey, 'unsure')!
        set(hostKey, { enabled: true, phase: 'checking', message: `Waiting to tell whether this host is this computer (its own daemon is not linked yet). Walnut looks again in ${inWords(later.ms)}.` })
        return
      }
    }
    set(hostKey, { enabled: true, phase: 'checking', message: 'Checking the host.' })
    try {
      // The full program as this host's replica wherever the daemon can (D13: the default since
      // the WP14 release gate); `server_program: 'host-server'` keeps the plain host server.
      const replica = settings!.program !== 'host-server' && host.hasCapability('replica-host-v1')
      const specOf = async (p: WorkingProgram, port: number) => ({
        v: 1, home: deps.home, walnutId: await deps.walnutId(),
        command: p.command, args: p.args, cwd: p.cwd, env: p.env,
        ...(p.fallback ? { fallback: p.fallback } : {}),
        log: p.log, port,
        // Read by the server while it runs: a change here restarts nothing. `pluginsKeepTasks`: the
        // plugins that keep their tasks to their own view, which a follower that loads no plugin
        // manifest stamps its away creates by (plugin-task-visibility.ts).
        settings: { expose: exposeSettings, exposeRetry: retryCount(hostKey), pluginsKeepTasks: pluginsKeepingTasks() },
      })
      // A newer build of this Mac waits while the program that works there reports (update-hold.ts):
      // the host keeps it, with the settings of now, and nothing is sent.
      // A host on only by default, with nothing of this Walnut yet: one starts only where it runs
      // well (eligibility.ts). The person's own switch, the tunnel placed there, and a host where a
      // follower was ever set up (its port is kept, or its daemon runs one) skip it: a running
      // follower's own memory must never read as the host's lack of it.
      let known: HostTarget | undefined
      if (await firstOnByDefault(host, settings!)) {
        const judged = judgeFollowerRoom(await host.runRemoteScript(roomProbeScript(deps.hostRoot ?? HOST_ROOT), 15_000), deps.floors ?? FOLLOWER_FLOORS)
        if ('gate' in judged) {
          notEligible(hostKey, judged.gate.reason, judged.gate.message, { again: judged.gate.again ? 'gate' : null, room: judged.gate.room })
          return
        }
        known = judged.target
      }
      // A host's one Walnut service is this Walnut's follower itself (one-service-mode.ts): no app of
      // its own is installed there; the spec is still sent (the service starts from it, and a daemon
      // put back starts the follower from it), and its status is read over the same server.status.
      const held = (replica ? serviceHolds(host) : null) ?? await heldBuild(host, replica, retry)
      if (held) {
        set(hostKey, { phase: 'starting', message: 'Starting the server on the host.', port: held.rec.publicPort })
        await deps.holdTunnelPort(`host-server:${hostKey}`)
        host.keepStreamLane?.(true)
        await configure(host, await specOf(held.working, held.rec.publicPort), isReplica(held.working))
        await afterConfigure(host, isReplica(held.working))
        const missed = await firstReport(host, held.working.log)
        if (missed) throw new Error(missed)
        startPoll(hostKey)
        return
      }
      const install = await ensureInstalled(host, retry, known, settings!.byDefault === true && !settings!.carriesTunnel)
      // The link may have dropped and come back as a new connection during the install.
      host = hosts.get(hostKey) ?? host
      const rec = await portsFor(host, install.program)
      set(hostKey, { phase: 'starting', message: 'Starting the server on the host.', port: rec.publicPort })
      // The door its streams come in by (the tunnel port trusts nothing on loopback).
      await deps.holdTunnelPort(`host-server:${hostKey}`)
      host.keepStreamLane?.(true)
      const { command, prefix } = install.program
      const hostServerEnv = hostServerEnvOf({
        dataDir: install.dataDir, runDir: install.runDir, port: rec.publicPort, leaderHome: deps.home,
        walnutId: await deps.walnutId(), label: await deps.label(hostKey),
      })
      const run: Omit<WorkingProgram, 'id' | 'command' | 'cwd' | 'log'> = hostProgramRun({
        prefix, env: hostServerEnv, replica, hostKey, gateway: host.hasCapability(FOLLOWER_GATEWAY_CAPABILITY),
      })
      if (settings!.program !== 'host-server' && !replica) {
        log.session.info('host server: the host would run the replica, its daemon cannot run it yet', { host: hostKey })
      }
      const fresh: WorkingProgram = { id: install.id, command, cwd: install.dataDir, log: install.logFile, ...run }
      const working = rec.working && rec.working.id !== fresh.id ? rec.working : undefined
      let runs = fresh
      if (!retry && working && rec.refused?.id === fresh.id) {
        // This build did not answer before: until Retry, the host keeps the one that worked.
        runs = working
        notices.set(hostKey, olderNotice(fresh.id, working.id, rec.refused.message))
        await configure(host, await specOf(working, rec.publicPort), isReplica(working))
      } else {
        // What ran before this build, by the record or by its own report: kept on the host until this one answers.
        const before = reportedId((await host.send('server.status', { home: deps.home }, 10_000).catch(() => null))?.status as HostServerStatus | undefined)
        notices.delete(hostKey)
        await configure(host, await specOf(fresh, rec.publicPort), replica)
        await afterConfigure(host, replica)
        const missed = await firstReport(host, fresh.log)
        if (!missed) {
          updateRecord(hostKey, (r) => { r.working = fresh; delete r.refused; delete r.behindSince })
          if (!deps.appDir) {
            const keep = [...new Set([fresh.id, working?.id, before].filter((k): k is string => !!k && validBuildId(k)))]
            await host.runRemoteScript(pruneScript(keep, install.rootSpec, await deps.walnutId()), 60_000)
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
        await configure(host, await specOf(working, rec.publicPort), isReplica(working))
      }
      await afterConfigure(host, isReplica(runs))
      const missed = await firstReport(host, runs.log)
      if (missed) throw new Error(missed)
      startPoll(hostKey)
    } catch (err) {
      if (err instanceof StoppingHere) return
      const message = err instanceof Error ? err.message : String(err)
      log.session.warn('host server: setup failed', { host: hostKey, error: message })
      // Two Walnuts' followers on one machine (the experiment host_service_sets): a port the other one
      // took meanwhile is chosen again, free, at the next try (portsFor), never kept for good.
      if (followerPortTaken(message) && await (await import('../../providers/service-set-leader.js')).hostServiceSetsWanted()) {
        updateRecord(hostKey, (r) => { delete (r as { publicPort?: number }).publicPort })
        log.session.info('host server: the follower\'s port was taken on the host; the next try picks another', { host: hostKey })
      }
      const refused = err instanceof Error && err.name === 'SshLoginRefusedError'
      if (everyHost) failedNow.set(hostKey, { message, triesAgain: !(err instanceof UntilRetry) })
      if (err instanceof UntilRetry) {
        // The same file would fail the same way: it waits for Retry (or a newer build). On a host
        // that is on only by default, a file that does not run there means no follower there.
        if (err.noBuild && settings!.byDefault) {
          // A proof boot that failed may have met a passing problem (a full disk, a process ended
          // for memory): tried again at a slow pace. No build for the system waits for a connect.
          notEligible(hostKey, 'no-build', `No Walnut server runs on this host: ${message.replace(/\.? Press Retry to install it again\.$/, '').replace(/\.$/, '')}. Its sessions run as before; Retry tries again, and a newer build is tried by itself.`, { again: err.proofBoot ? 'proof' : null })
          return
        }
        tryLater.clear(hostKey)
        set(hostKey, { phase: 'error', message })
        return
      }
      // A refused login is no verdict on the host: it runs again by itself, soon. With the experiment,
      // anything else does too, later and later; without it, it waits for Retry as it always did.
      // Nothing else on the host waits for either.
      if (!refused && !everyHost) {
        tryLater.clear(hostKey)
        set(hostKey, { phase: 'error', message })
        return
      }
      // A host on only by default does not keep a server restarting under its daemon between tries,
      // and stops trying by itself at the end of the ladder.
      const byDefault = !refused && settings!.byDefault === true && !settings!.carriesTunnel
      if (byDefault) await takeDown(hostKey, hosts.get(hostKey), { keepWait: true })
      const later = retryingLater(hostKey, refused ? 'login' : 'failed', message, { stopAtEnd: byDefault })
      if (everyHost) failedNow.set(hostKey, { message, triesAgain: later.at !== undefined })
      set(hostKey, { phase: 'error', message: later.message, retryAt: later.at })
    }
  }

  /**
   * No server of this Walnut on the host: the daemon stops one it set up before (also one from
   * before a restart here), and the link, the door hold and the copy target go. False: this server
   * began to stop meanwhile, and the host stays as it was. `keepWait`: a failed start keeps its place
   * on the ladder (try-later.ts).
   */
  async function takeDown(hostKey: string, host: HostServerHost | undefined, o: { keepWait?: boolean } = {}): Promise<boolean> {
    stopPoll(hostKey)
    if (!o.keepWait) tryLater.clear(hostKey)
    if (host?.connected && host.hasCapability('host-server-v1')) {
      const st = await host.send('server.status', { home: deps.home }, 10_000).catch(() => null)
      const state = (st?.status as HostServerStatus | undefined)?.state
      if (state && state !== 'off') {
        if (await deps.frozen?.()) return false
        await host.send('server.configure', { home: deps.home, spec: null }, 15_000).catch(() => undefined)
        log.session.info('host server: turned off, stopped on the host', { host: hostKey })
      }
    }
    dropLink(hostKey)
    configured.delete(hostKey)
    notices.delete(hostKey)
    heldUntil.delete(hostKey)
    host?.keepStreamLane?.(false)
    await deps.releaseTunnelPort(`host-server:${hostKey}`)
    return true
  }

  /** Whether this host is on only by default and nothing of this Walnut runs or ran there: the gates apply. */
  async function firstOnByDefault(host: HostServerHost, settings: HostServerSettings): Promise<boolean> {
    if (!settings.byDefault || settings.carriesTunnel || readState()[host.hostKey]) return false
    const st = await host.send('server.status', { home: deps.home }, 10_000).catch(() => null)
    const state = (st?.status as HostServerStatus | undefined)?.state
    return !state || state === 'off'
  }

  /** A host on by default that cannot run a follower well now: its view says why, and when it is looked at again. */
  function notEligible(hostKey: string, reason: FollowerGateReason, message: string, o: { again?: 'gate' | 'proof' | null; room?: unknown } = {}): void {
    log.session.info('host server: no follower on this host by default', { host: hostKey, reason, ...(o.room ? { room: o.room } : {}) })
    const checkedAt = deps.now()
    if (!o.again) {
      // Waiting does not change it (no build for the system, too little memory in all, this
      // computer): the next connect or a Retry looks again.
      tryLater.clear(hostKey)
      set(hostKey, { enabled: true, phase: 'not-eligible', message, gate: { reason, checkedAt } })
      return
    }
    const later = retryingLater(hostKey, o.again, message)
    set(hostKey, { enabled: true, phase: 'not-eligible', message: later.message, gate: { reason, checkedAt, ...(later.at !== undefined ? { recheckAt: later.at } : {}) } })
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
        // The same daemon process holds the template it was sent on an earlier link: a
        // reconnect sent its 60 KB again in the link's first second (host-slice-pace.ts).
        const instance = host.daemonInstanceId ?? null
        const memo = templateSent.get(hostKey)
        const unlessHash = instance && memo?.instance === instance ? memo.hash : null
        const pushed = await pushHostSpawnTemplate(host, { home: deps.home, hostKey, cwd: dataDir, bypassAllowed: settings?.askBypass === true, unlessHash })
        if (pushed && instance) templateSent.set(hostKey, { instance, hash: pushed.hash })
        else templateSent.delete(hostKey)
        if (pushed && pushed.sent) log.session.info('host server: spawn template pushed', { host: hostKey, cwd: dataDir, bypass: settings?.askBypass === true })
      } catch (err) {
        templateSent.delete(hostKey)
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
    // A held build goes once its window passed, or once the program there is too old for the copies.
    // Once per hold: an install that then fails waits for the next connect, deploy or Retry.
    const until = heldUntil.get(hostKey)
    if (until === undefined) return
    const tooOld = deps.now() >= until ? null : await deps.copiesNeedNewer?.(hostKey).catch(() => null) ?? null
    if (deps.now() < until && !tooOld) return
    heldUntil.delete(hostKey)
    await reconcile(hostKey)
  }

  /**
   * Serialized per host; a call while one runs makes it run once more. `retry`:
   * the person asked (Retry): a failed install and a refused build are tried again.
   */
  /**
   * What a host's view said when its link dropped while a reconcile ran there (an upload or an
   * install goes on over its own connections): put back when the link returns, so the view
   * never reads "not connected" for the whole upload (2026-10-31: nine minutes).
   */
  const resumeView = new Map<string, { phase: HostServerPhase; message?: string }>()

  /** True once the host's link is up again, within LINK_BACK_MS. */
  async function linkBack(hostKey: string): Promise<boolean> {
    const until = deps.now() + LINK_BACK_MS
    while (!hosts.get(hostKey)?.connected) {
      if (deps.now() > until) return false
      await new Promise((r) => setTimeout(r, deps.installPollMs ?? 2_000))
    }
    return true
  }

  /**
   * This Walnut's follower on the host as the one Walnut service needs it (one-service-mode.ts): the
   * full follower program running (the spec the service starts from), none (why), or not settled.
   */
  function followerFact(hostKey: string): FollowerFact {
    const v = views.get(hostKey)
    if (!v || !lastSettings.has(hostKey)) return { kind: 'unknown' }
    if (v.phase === 'running') {
      if (v.program === 'replica') return { kind: 'replica' }
      return {
        kind: 'none',
        why: v.program === 'fallback' ? 'its Walnut server runs its fallback program after a crash loop' : 'its Walnut server is the plain host server, not the full follower',
      }
    }
    if (v.phase === 'off') return { kind: 'none', why: 'no Walnut server of this Walnut runs there' }
    if (v.phase === 'not-eligible' || v.phase === 'unsupported') return { kind: 'none', why: v.message ?? 'no Walnut server of this Walnut runs there' }
    return { kind: 'unknown' }
  }

  function reconcile(hostKey: string, opts: { retry?: boolean; soft?: boolean } = {}): Promise<void> {
    if (opts.retry) retries.add(hostKey)
    if (!opts.soft) hard.add(hostKey)
    const current = running.get(hostKey)
    if (current) { rerun.add(hostKey); return current }
    const run = (async () => {
      do {
        rerun.delete(hostKey)
        const retry = retries.delete(hostKey)
        const soft = !hard.delete(hostKey)
        failedNow.delete(hostKey)
        await reconcileOnce(hostKey, retry, soft)
        const { phase } = view(hostKey)
        // A setup that runs, or is off, waits no more (an error, a gate or an open question keeps its wait).
        if (phase === 'running' || phase === 'off') tryLater.clear(hostKey)
        // Walnut Health hears of a start that failed in this pass (never the person), and of one that
        // settled. A refused login is the person's sign-in, which the host's own problem line carries.
        const failed = failedNow.get(hostKey)
        failedNow.delete(hostKey)
        if (phase === 'error' && failed && tryLater.pending(hostKey) !== 'login') deps.health?.failed(hostKey, failed.message, failed.triesAgain)
        // Also with the experiment off: an item raised while it was on clears once nothing fails.
        else if (phase === 'running' || phase === 'off' || phase === 'not-eligible') deps.health?.settled(hostKey)
        // This Walnut's follower there is known now: the host's mode may be due a switch (one-service-mode.ts).
        if (followerFact(hostKey).kind !== 'unknown') hosts.get(hostKey)?.serviceModeChanged?.()
      } while (rerun.has(hostKey))
    })().finally(() => {
      running.delete(hostKey)
      // Ended while the link was down (stopping, frozen, left as configured): no step will
      // say so, and the next disconnect must not be read as the same drop.
      if (resumeView.delete(hostKey) && !hosts.get(hostKey)?.connected) {
        set(hostKey, { phase: 'waiting-for-host', message: 'The host is not connected right now.' })
      }
    })
    running.set(hostKey, run)
    return run
  }

  return {
    /** A host's daemon connected and was told which Walnut speaks. */
    connected(host: HostServerHost): Promise<void> {
      hosts.set(host.hostKey, host)
      const kept = resumeView.get(host.hostKey)
      resumeView.delete(host.hostKey)
      if (kept && running.has(host.hostKey)) set(host.hostKey, kept)
      return reconcile(host.hostKey)
    },
    disconnected(hostKey: string): void {
      stopPoll(hostKey)
      dropLink(hostKey)
      // Not awaited, so its failure is caught here: uncaught, it was an unhandled rejection (2026-10-28 CI).
      void deps.releaseTunnelPort(`host-server:${hostKey}`).catch((err: unknown) => {
        log.session.warn('host server: the tunnel port was not released on disconnect', { host: hostKey, error: err instanceof Error ? err.message : String(err) })
      })
      if (!view(hostKey).enabled) return
      const v = view(hostKey)
      if (running.has(hostKey) && v.phase === 'installing') {
        const was = { phase: v.phase, ...(v.message ? { message: v.message } : {}) }
        set(hostKey, { phase: 'waiting-for-host', message: was.message ? `${DROPPED_LINE} ${was.message}` : DROPPED_LINE })
        resumeView.set(hostKey, was)
        return
      }
      if (resumeView.has(hostKey)) return
      set(hostKey, { phase: 'waiting-for-host', message: 'The host is not connected right now.' })
    },
    reconcile,
    views: (): HostServerView[] => [...views.values()].map((v) => ({ ...v })),
    /** The link to a host's daemon while it is connected (its streams reach the server there), else null. */
    hostLink: (hostKey: string): HostServerHost | null => {
      const h = hosts.get(hostKey)
      return h?.connected ? h : null
    },
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
    followerFact,
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
      tryLater.clearAll()
    },
  }
}

export type HostServerManager = ReturnType<typeof createHostServerManager>
