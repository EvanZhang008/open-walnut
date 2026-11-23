import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { WebSocket } from '#ws'
import { ADOPTED_WORK_CAPABILITIES } from './detached-registry.js'
import { setTimeout as delay } from 'node:timers/promises'
import { performance } from 'node:perf_hooks'
import { readDaemonServiceExecutable } from './daemon-service-config.js'
import { serviceSet, serviceSetIdOf, serviceSetLine, type ServiceSet } from './service-set.js'
import { chooseServiceSet } from './service-set-choice.js'
import { removeServiceSetDir } from './service-set-remove.js'
import { NET_ROUTE_ACTION, runNetRouteArgs } from './net-route.js'
import { accountInfo } from '../lib/account.js'
import { readDaemonInstanceOwner } from './daemon-instance-lock.js'
import { createDaemonServiceManager, daemonServiceConfigPath, DaemonServiceHandoverPendingError, DaemonServiceUpdateRefusedError, type DaemonServiceCommandResult, type DaemonServiceScope } from './daemon-service-manager.js'
import { pruneDaemonServiceVersions, stageDaemonServiceArtifact } from './daemon-service-artifact.js'
import { openDaemonServiceFiles, withDaemonServiceFiles, type DaemonServiceFiles } from './daemon-service-files.js'
import { createSystemServiceAccess } from './daemon-service-system.js'
import { createCronDaemonServiceManager } from './daemon-service-cron.js'
import { createCronServiceHost } from './daemon-service-cron-host.js'
import { resolveDaemonServiceScope } from './daemon-service-scope.js'
import { readDaemonBootExecutable } from './daemon-service-boot-script.js'
import { moveDaemonState, unmanagedStateRoot } from './daemon-service-state-move.js'
import { localProductionDaemonDir } from '../lib/daemon-dir.js'
import { RESTART_MARK_NAME } from './daemon-restart-mark.js'
import { OVER_BUSY_FLAG, OVER_BUSY_PLAIN_MS, OVER_BUSY_WAIT_MS } from './daemon-over-busy.js'
import { proveStagedBoot } from './daemon-boot-proof.js'
import { launchdSpawnsJobs } from './daemon-service-launchd.js'
import { DAEMON_BUSY_WORDS } from './daemon-busy-words.js'
import { handBackStandIn } from './daemon-service-handback.js'
import { daemonReady, daemonStays } from './daemon-service-ready.js'
import { createLauncherControl } from './service-launcher-control.js'
import { LAUNCHER_DIR_NAME, LAUNCHER_SCRIPT_NAME } from './service-launcher-script.js'
import { launcherKeeps, readLauncherFacts } from './service-launcher-beat.js'
import { readServiceMode, type ServiceMode } from '../binary/service-mode.js'
import { dropServiceMode, removeServiceMode, restoreServiceMode, stageServiceMode } from '../binary/service-mode-update.js'

export { daemonReady, daemonStays, SERVICE_STAY_MS } from './daemon-service-ready.js'

export interface DaemonServiceCliOptions {
  scope?: DaemonServiceScope
  yes?: boolean
  executable?: string
  sudo?: boolean
  /** update: go over the daemon's own work (an overdue update, daemon-over-busy.ts). */
  overBusy?: boolean
  /** install, update: run the daemon under the launcher (the experiment service_launcher, service-launcher-script.ts). */
  launcher?: boolean
  /**
   * install, update: what `--service` runs for the Walnut of this home (src/binary/service-entry.ts):
   * the host's one Walnut service (`--serve <home>`), or the session daemon again (`--no-serve <home>`).
   * Unset: the mode stays as it is, carried over to the new version.
   */
  serve?: { home: string; on: boolean }
  /**
   * install, update, status, uninstall, restart, handback: the Walnut (its walnut id) the service is for,
   * which picks its service set on this host (service-set-choice.ts). Unset: the default set, as before.
   */
  walnut?: string
  /**
   * install, update, status: the data dir of the Walnut `walnut` names, for the set choice alone (its key in the
   * default daemon's serves file, service-set-choice.ts step 4). Unlike `serve` it changes no mode; `serve`'s home wins.
   */
  walnutHome?: string
}

export function runDaemonServiceCommand(program: string, args: string[], input?: string, timeoutMs?: number): Promise<DaemonServiceCommandResult> {
  return new Promise((resolve) => {
    let result: DaemonServiceCommandResult | undefined
    const controlsService = ['systemctl', 'launchctl'].includes(path.basename(program))
      || (program === 'sudo' && args.includes('/usr/bin/systemctl'))
    const runsUpdate = args[0] === 'walnut' && args[1] === 'daemon' && args[2] === 'update'
    const timeout = timeoutMs ?? (runsUpdate ? 600_000 : controlsService ? 75_000 : 15_000)
    const child = execFile(program, args, { encoding: 'utf8', timeout, maxBuffer: 128 * 1024 }, (error, stdout, stderr) => {
      result = { code: error ? (typeof error.code === 'number' ? error.code : 1) : 0, stdout, stderr: stderr || error?.message || '' }
    })
    // When termination is refused, execFile calls back first but the process can still write; do not release the install lock before close.
    const warning = setTimeout(() => process.stderr.write('Service command is still exiting; waiting before releasing the installation lock.\n'), timeout + 1000)
    warning.unref()
    child.once('close', () => {
      clearTimeout(warning)
      resolve(result ?? { code: 1, stdout: '', stderr: 'Service command exited without a result' })
    })
    if (input !== undefined) { child.stdin?.on('error', () => {}); child.stdin?.end(input) }
  })
}


/**
 * How long a started service has to answer, in every scope. The first start of a new build
 * reads the login shell's PATH (host-runtime-core.ts), which on a slow machine (an Intel
 * Mac, 2026-11-04) took longer than the 15 s this was, and a readiness timeout starts the
 * rollback, the riskiest step of an update. The cron supervisor also waits 5 s first.
 */
export const SERVICE_READY_WAIT_MS = 60_000

/** How long an install waits for a busy daemon (its relays, a slow answer) before giving up. */
export const HANDOVER_BUSY_WAIT_MS = 90_000
/**
 * How long an update does: a relay ends within a second, and the server asks again
 * later anyway, while a longer wait holds its swap open (daemon-connection.ts).
 */
export const UPDATE_BUSY_WAIT_MS = 30_000

/**
 * A handover the daemon refused before it changed anything, so asking again is safe: it
 * had a command or a relay of its server still open (every daemon since 0.6.5 says so in
 * these words, at once), or it did not answer the connection or the hello in time. A server
 * that just started keeps its daemon busy, and the join's install gave up on the first such
 * answer (2026-11-02, the existing-Mac CI job). Not the 15 s drain timeout: each try of that
 * holds every command of the daemon for 15 s.
 */
export function handoverBusy(error: unknown): boolean {
  if (error instanceof DaemonServiceHandoverPendingError) return false
  const text = error instanceof Error ? error.message : String(error)
  return DAEMON_BUSY_WORDS.test(text)
    || (error as { beforeRequest?: boolean })?.beforeRequest === true
}

export async function requestDaemonServiceHandover(
  runtimeDir: string, stateDir: string,
  wait: { busyMs?: number; pauseMs?: number; note?: (text: string) => void } = {},
): Promise<boolean> {
  const hasPending = () => fs.lstat(path.join(stateDir, 'handover.json')).then(() => true, (error) => {
    if (error.code === 'ENOENT') return false
    throw new DaemonServiceHandoverPendingError(`Cannot inspect pending handover: ${String(error)}`)
  })
  const deadline = performance.now() + (wait.busyMs ?? HANDOVER_BUSY_WAIT_MS)
  let noted = false
  for (;;) {
    const pending = await hasPending()
    try {
      return await requestRunningDaemonHandover(runtimeDir, stateDir, pending)
    } catch (error) {
      if (pending || await hasPending()) throw new DaemonServiceHandoverPendingError(`Service handover is unresolved: ${String(error)}`)
      if (!handoverBusy(error) || performance.now() >= deadline) throw error
      if (!noted) {
        noted = true
        ;(wait.note ?? ((text) => process.stderr.write(`walnut daemon: ${text}\n`)))(`the running daemon is busy (${error instanceof Error ? error.message : String(error)}); asking again`)
      }
      await delay(wait.pauseMs ?? 2000)
    }
  }
}

/**
 * Prepare a managed daemon's update, asking again (every 2 s, up to UPDATE_BUSY_WAIT_MS)
 * while it refuses as busy before it changed anything: a relay or a command of its server
 * in flight lasts a second or so, and a deploy's update that met one gave up at once
 * (2026-11-03). Nothing else is asked again, a refusal of any other kind included.
 */
export async function requestDaemonServiceUpdate(
  runtimeDir: string, stateDir: string,
  wait: { busyMs?: number; pauseMs?: number; note?: (text: string) => void; force?: boolean; plainMs?: number } = {},
): Promise<'prepared' | 'unprepared'> {
  const started = performance.now()
  const deadline = started + (wait.busyMs ?? UPDATE_BUSY_WAIT_MS)
  const say = wait.note ?? ((text: string) => process.stderr.write(`walnut daemon: ${text}\n`))
  let noted = false
  for (;;) {
    try {
      // An overdue update forces only after asking plainly for a while (daemon-over-busy.ts).
      const force = wait.force === true && performance.now() - started >= (wait.plainMs ?? OVER_BUSY_PLAIN_MS)
      // Overdue, an answer is waited for only until the deadline, not the plain 60 s.
      const replyMs = wait.force === true ? Math.max(5_000, deadline - performance.now()) : undefined
      await requestRunningDaemonHandover(runtimeDir, stateDir, false, true, force, replyMs)
      return 'prepared'
    } catch (error) {
      // Overdue, a daemon that took the update and never answered, or prepared and never exited,
      // is restarted by its service too (daemon-over-busy.ts step 3); it may never come back otherwise.
      if (wait.force === true && error instanceof DaemonServiceHandoverPendingError) {
        say(`the running daemon did not finish the update (${error.message}); restarting it instead, and the CLI sessions keep running`)
        return 'unprepared'
      }
      // Overdue, a drain that ran out (it resumed and changed nothing) is asked again too, and so is
      // a daemon that does not answer before the request (its hello): both end in a restart.
      const busy = error instanceof DaemonServiceUpdateRefusedError
        && (handoverBusy(error) || (wait.force === true && /Service preparation timed out|Daemon handover (connection|response) (timed out|closed)/.test(error.message)))
      if (!busy) throw error
      if (performance.now() >= deadline) {
        if (wait.force !== true) throw error
        // Bounded: the service is restarted without the daemon's preparation (daemon-over-busy.ts step 3).
        say(`the running daemon is still busy (${error.message}); restarting it instead, and the CLI sessions keep running`)
        return 'unprepared'
      }
      if (!noted) {
        noted = true
        say(`the running daemon is busy (${error.message}); asking again`)
      }
      await delay(wait.pauseMs ?? 2000)
    }
  }
}

/**
 * Refuses when the dir's lock is held by a daemon inside a Walnut server's process, unless that
 * server is the launcher's own service (a host's one Walnut service, its banner says `service`):
 * that one an update hands over to and from as it does a daemon program.
 */
export async function refuseInProcessOwner(runtimeDir: string, read = readDaemonInstanceOwner): Promise<void> {
  const owner = await read({ runtimeDir, uid: os.userInfo().uid }).catch(() => null)
  if (owner?.inProcess && !owner.service) {
    throw new Error('A Walnut server runs the session daemon inside its own process for this dir (experiment in_process_daemon, pid '
      + `${owner.pid}). Turn the experiment off in Settings and restart Walnut, then install the service.`)
  }
}

export async function requestRunningDaemonHandover(runtimeDir: string, stateDir: string, pending: boolean, updating = false, force = false, replyMs = 60_000): Promise<boolean> {
  let connection: WebSocket | undefined
  let requested = false
  let refused = false
  let exited = false
  try {
    // A server that runs the daemon in its own process (experiment in_process_daemon) holds the
    // dir's lock with no door and no daemon.pid: nothing here could hand it over, and a service
    // daemon started anyway would meet that lock at every start of its manager's loop.
    await refuseInProcessOwner(runtimeDir)
    let pid: number
    try { pid = Number(await fs.readFile(path.join(runtimeDir, 'daemon.pid'), 'utf8')) }
    catch (error) {
      if (!updating && (error as NodeJS.ErrnoException).code === 'ENOENT') return pending
      throw error
    }
    if (!Number.isSafeInteger(pid) || pid <= 1) throw new Error('Invalid daemon PID; service handover was not attempted')
    const alive = () => {
      try { process.kill(pid, 0); return true }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false; throw error }
    }
    if (!alive()) {
      if (updating) throw new Error('The managed daemon is not running; update was not attempted')
      return pending
    }
    // A daemon still starting has its pid and port written before its instance.
    const [portText, instanceId] = await Promise.all(['daemon.port', 'daemon.instance']
      .map((name) => fs.readFile(path.join(runtimeDir, name), 'utf8').then((value) => value.trim(), (error: NodeJS.ErrnoException) => {
        throw error.code === 'ENOENT' ? Object.assign(error, { beforeRequest: true }) : error
      })))
    const port = Number(portText)
    if (!Number.isInteger(port) || port <= 0 || port > 65535 || !instanceId) throw new Error('Invalid daemon handover endpoint')
    const socket = connection = new WebSocket(`ws://127.0.0.1:${port}`, { maxPayload: 128 * 1024 })
    await new Promise<void>((resolve, reject) => {
      const finish = (error?: Error) => {
        clearTimeout(timer)
        socket.off('open', opened)
        socket.off('close', closed)
        if (error) reject(error)
        else resolve()
      }
      const opened = () => finish()
      const closed = () => finish(Object.assign(new Error('Daemon handover connection closed'), { beforeRequest: true }))
      const timer = setTimeout(() => finish(Object.assign(new Error('Daemon handover connection timed out'), { beforeRequest: true })), 5000)
      socket.once('open', opened)
      socket.once('close', closed)
      socket.on('error', (error) => finish(Object.assign(error, { beforeRequest: true })))
    })
    let nextId = 0
    const rpc = (command: Record<string, unknown>, timeout: number) => new Promise<Record<string, unknown>>((resolve, reject) => {
      const id = ++nextId
      const finish = (error: Error | null, value?: Record<string, unknown>) => {
        clearTimeout(timer)
        socket.off('message', receive)
        socket.off('close', closed)
        socket.off('error', failed)
        if (error) reject(error)
        else resolve(value!)
      }
      const receive = (raw: unknown) => {
        try { const value = JSON.parse(String(raw)); if (value?.id === id) finish(null, value) }
        catch { finish(new Error('Invalid daemon handover response')) }
      }
      const closed = () => finish(new Error('Daemon handover connection closed'))
      const failed = (error: Error) => finish(error)
      const timer = setTimeout(() => finish(new Error('Daemon handover response timed out')), timeout)
      socket.on('message', receive)
      socket.once('close', closed)
      socket.once('error', failed)
      socket.send(JSON.stringify({ ...command, id }))
    })
    const hello = await rpc({ cmd: 'hello' }, 5000).catch((error: Error) => { throw Object.assign(error, { beforeRequest: true }) })
    if (hello.ok !== true || hello.instanceId !== instanceId) throw new Error('Daemon instance changed before service handover')
    const managed = (hello.cronSupervision as { managed?: unknown })?.managed === true
    if (updating && !managed) throw new Error('Only a managed daemon can prepare a service update')
    if (!updating && managed) return false
    if (!Array.isArray(hello.capabilities) || !hello.capabilities.includes(updating ? 'service-update-v1' : 'service-handover-v1')) {
      throw new Error('This daemon cannot hand over running sessions; update the unmanaged daemon before installing its service')
    }
    requested = true
    // `force` (an update only): the daemon goes over its own requests and runs instead of refusing as busy.
    // `adopts`: the detached work this (newer) program follows after the swap; a daemon asked by an
    // older one, which names none, ends its detached work first (a rollback, detached-registry.ts).
    const result = await rpc({ cmd: updating ? 'service.update' : 'service.handover', instanceId, stateDir, adopts: [...ADOPTED_WORK_CAPABILITIES], ...(updating && force ? { force: true } : {}) }, replyMs)
    if (result.ok !== true && !(updating && result.updateStarted === true)) {
      refused = true
      throw new Error(String(result.error ?? 'Daemon refused service handover'))
    }
    if (result.instanceId !== instanceId || (result.ok === true && result.prepared !== true)) throw new Error('Service handover was not confirmed')
    socket.close()
    const deadline = performance.now() + 30_000
    while (alive()) {
      if (performance.now() >= deadline) throw new Error('Previous daemon has not exited after preparing handover')
      await delay(100)
    }
    exited = true
    if (result.ok !== true) throw new Error(String(result.error ?? 'Service update preparation failed'))
    return true
  } catch (error) {
    if (updating && (!requested || refused)) throw new DaemonServiceUpdateRefusedError(String(error))
    if (requested && !refused && !exited) throw new DaemonServiceHandoverPendingError(`Service handover is unresolved: ${String(error)}`)
    throw error
  } finally { connection?.terminate() }
}

/**
 * After an uninstall with no daemon left running: the stopped service daemon wrote the restart
 * mark for a successor that is not coming, and every walnut call here would wait its 45 s for
 * one (daemon-restart-mark.ts). A symlink in its place goes, never what it points at.
 */
export async function forgetRestartMark(runtimeDir: string): Promise<void> {
  await fs.rm(path.join(runtimeDir, RESTART_MARK_NAME), { force: true }).catch(() => {})
}

async function runtimeDaemonAlive(runtimeDir: string): Promise<boolean> {
  const pid = Number((await fs.readFile(path.join(runtimeDir, 'daemon.pid'), 'utf8').catch(() => '')).trim())
  if (!Number.isSafeInteger(pid) || pid <= 1) return false
  try { process.kill(pid, 0); return true } catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM' }
}

async function reportMoved(names: string[], where: string): Promise<void> {
  if (names.length) process.stderr.write(`walnut daemon: moved the daemon's ${names.join(', ')} ${where}\n`)
}

/** The executable a service config runs, or null when it cannot be read. */
function serviceExecutableOf(platform: 'linux' | 'darwin', scope: DaemonServiceScope, text: string | null): string | null {
  if (!text) return null
  try { return scope === 'cron' ? readDaemonBootExecutable(text) : readDaemonServiceExecutable(platform, text) } catch { return null }
}

/**
 * The PATH a service runs with: this shell's absolute entries, then the usual
 * places for a user's own tools. An install over ssh runs with the server's
 * bare PATH, and a boot start has only cron's, so neither alone finds a
 * `claude` the user installed under their home.
 */
export function servicePath(current: string | undefined, home: string): string {
  const extra = [path.join(home, '.local', 'bin'), path.join(home, 'bin'), path.join(home, '.bun', 'bin'), '/usr/local/bin', '/usr/bin', '/bin']
  const parts = [...(current ?? '').split(':'), ...extra].filter((part) => path.isAbsolute(part) && part === part.trim() && !/[\u0000-\u001f\u007f]/.test(part))
  return [...new Set(parts)].join(':')
}

/** The server passes it when the experiment service_launcher is on (daemon-service-update.ts). */
export const LAUNCHER_FLAG = '--launcher'
/** The leader of `<home>` switches this host to its one Walnut service, or back (service-mode.ts). */
export const SERVE_FLAG = '--serve'
export const NO_SERVE_FLAG = '--no-serve'
/** The Walnut a service is for: its own set when another Walnut holds the default (the experiment host_service_sets). */
export const WALNUT_FLAG = '--walnut'
/** The data dir of that Walnut, for the set choice only (no mode word): the leader sends it with --walnut. */
export const WALNUT_HOME_FLAG = '--walnut-home'


export async function runDaemonServiceArgs(args: string[]): Promise<number> {
  // `net-route` has words of its own and changes walnut-net's config, never the service (net-route.ts).
  if (args[0] === NET_ROUTE_ACTION) return runNetRouteArgs(args.slice(1))
  const { action, options } = parseDaemonServiceArgs(args)
  return runDaemonServiceCli(action, options)
}

/** `walnut daemon <action> [options]` as words, read the one way (the leader writes them: daemon-service-update.ts). */
export function parseDaemonServiceArgs(args: string[]): { action: string; options: DaemonServiceCliOptions } {
  const action = args[0] ?? 'status'
  const options: DaemonServiceCliOptions = {}
  for (let i = 1; i < args.length; i++) {
    if (args[i] === '--yes') options.yes = true
    else if (args[i] === '--sudo') options.sudo = true
    else if (args[i] === OVER_BUSY_FLAG) options.overBusy = true
    else if (args[i] === LAUNCHER_FLAG) options.launcher = true
    else if (args[i] === SERVE_FLAG || args[i] === NO_SERVE_FLAG) {
      const home = args[i + 1]
      if (!home || !path.isAbsolute(home)) throw new Error(`${args[i]} requires the absolute data dir of the Walnut it is for`)
      options.serve = { home, on: args[i] === SERVE_FLAG }
      i++
    }
    else if (args[i] === WALNUT_FLAG) {
      const id = args[i + 1]
      if (!id) throw new Error(`${WALNUT_FLAG} requires the walnut id of the Walnut the service is for`)
      serviceSetIdOf(id)
      options.walnut = id
      i++
    }
    else if (args[i] === WALNUT_HOME_FLAG) {
      const home = args[i + 1]
      if (!home || !path.isAbsolute(home)) throw new Error(`${WALNUT_HOME_FLAG} requires the absolute data dir of the Walnut it is for`)
      options.walnutHome = home
      i++
    }
    else if (args[i] === '--scope') {
      if (!args[i + 1]) throw new Error('--scope requires user, system or cron')
      options.scope = args[++i] as DaemonServiceScope
    } else if (args[i] === '--executable') {
      if (!args[i + 1]) throw new Error('--executable requires a path')
      options.executable = args[++i]
    }
    else throw new Error(`Unknown daemon option: ${args[i]}`)
  }
  return { action, options }
}

export async function runDaemonServiceCli(action: string, options: DaemonServiceCliOptions): Promise<number> {
  if (!['status', 'install', 'update', 'uninstall', 'restart', 'handback'].includes(action)) throw new Error('Expected daemon status, install, update, uninstall, restart, handback, or net-route')
  if (process.platform !== 'linux' && process.platform !== 'darwin') throw new Error('Daemon services require Linux or macOS')
  if (action !== 'status' && !options.yes) throw new Error('This changes the host service. Repeat with --yes to confirm; running CLI sessions are not terminated.')
  if (options.scope && !['user', 'system', 'cron'].includes(options.scope)) throw new Error('Scope must be user, system or cron')
  if (options.scope === 'cron' && process.platform !== 'linux') throw new Error('The cron scope is for Linux; macOS starts the daemon as a login agent')
  if (options.sudo && (process.platform !== 'linux' || options.scope !== 'system')) throw new Error('--sudo requires --scope system on Linux')
  // A service set is the account's own (user unit, LaunchAgent, cron): refused before any sudo preflight (review round 1, low 2).
  if (options.walnut && options.scope === 'system' && action !== 'status') throw new Error('A Walnut\'s own service set runs as a user service: --walnut takes --scope user or cron, never system')
  const home = os.homedir()
  const user = accountInfo()
  if (action !== 'status' && user.uid === 0) throw new Error('Run as the original non-root account with --scope system --sudo --yes, not as root')
  if (action !== 'status' && (process.env.VITEST || process.env.NODE_ENV === 'test'
    || await fs.realpath(home) !== await fs.realpath(user.homedir))) {
    throw new Error('Service changes require the real host account, not a test or isolated home')
  }
  // The production daemon dir of this account: /tmp/open-walnut, or ~/.cache/open-walnut
  // when another user on this machine owns that one (src/lib/daemon-dir.ts).
  const defaultRuntimeDir = localProductionDaemonDir()
  // Which set the action is for: the default, or this Walnut's own beside another's (service-set.ts).
  const set: ServiceSet = options.walnut
    ? (await chooseServiceSet({
        platform: process.platform, home, walnutId: options.walnut, serveHome: options.serve?.home ?? options.walnutHome,
        defaultRuntimeDir, uid: user.uid, claim: action === 'install' || action === 'update',
      })).set
    : serviceSet(process.platform, home, '', { runtimeDir: defaultRuntimeDir })
  // Before the answer, on stdout: a leader that asked reads it there (its status run drops stderr).
  if (options.walnut) process.stdout.write(`${serviceSetLine(set.id)}\n`)
  if (action === 'handback') return handBackCli(home, user.uid, set)
  // No --scope: the installed backend, or for a first install the first boot start this account can have without root.
  const resolved = await resolveDaemonServiceScope(action, options.scope, {
    platform: process.platform, home, user: user.username, run: runDaemonServiceCommand, set,
    present: (file) => fs.lstat(file).then(() => true, (error) => (error as NodeJS.ErrnoException).code !== 'ENOENT'),
  })
  if ('failure' in resolved) {
    process.stdout.write(JSON.stringify({ ok: false, failure: resolved.failure }, null, 2) + '\n')
    return 1
  }
  const scope = resolved.scope
  for (const note of resolved.notes) process.stderr.write(`walnut daemon: ${note}\n`)
  const systemScope = process.platform === 'linux' && scope === 'system'
  if (systemScope && action !== 'status' && !options.sudo) throw new Error('System service changes require --sudo --yes; the daemon still runs as your current account')
  const root = set.installRoot
  try {
    const stat = await fs.lstat(root)
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== user.uid || (stat.mode & 0o077)) {
      throw new Error('Daemon service directory is not private')
    }
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  const runtimeDir = set.runtimeDir
  const platform = process.platform
  const system = systemScope ? createSystemServiceAccess(runDaemonServiceCommand) : null
  if (system && action !== 'status') await system.preflight()

  // One action uses the same files from probe to verify (owners read once inside the lock), so its view never changes partway through.
  // The mode before this action staged a version (prepareExecutable): back in place when it failed.
  let modeBefore: ServiceMode | null | undefined
  // What this action last wrote: a put-back restores the mode before only over its own write.
  // Every mode write here holds the mode's lock (service-mode-update.ts), as setServiceRole does.
  let modeWritten: ServiceMode | null = null
  const act = async (files: DaemonServiceFiles): Promise<number> => {
    const previousInstance = action === 'restart' || action === 'install' || action === 'update'
      ? await fs.readFile(path.join(runtimeDir, 'daemon.instance'), 'utf8').then((value) => value.trim()).catch((error) => {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
          return undefined
        })
      : undefined
    const common = {
      platform, home, uid: user.uid, user: user.username,
      path: servicePath(process.env.PATH, home),
      stateDir: root, runtimeDir, set,
      inspectConfig: (target: string) => files.inspectConfig(target),
      readConfig: (target: string) => files.readConfig(target),
      writeConfig: (target: string, text: string) => files.writeConfig(target, text),
      removeConfig: (target: string) => files.removeConfig(target),
      ready: (_status: unknown, executable?: string) => daemonReady(runtimeDir, executable, SERVICE_READY_WAIT_MS, previousInstance),
      ...(action === 'update' ? { stay: () => daemonStays(runtimeDir) } : {}),
      // A version that will run as the host's one Walnut service is proven as one (daemon-boot-proof.ts).
      proveBoot: async (prepared: { executable: string; args: string[] }) => {
        const read = readServiceMode(root)
        const mode = 'mode' in read && read.mode.exe === prepared.executable ? read.mode : null
        return proveStagedBoot({
          ...prepared, path: servicePath(process.env.PATH, home),
          // Asked: its own Walnut said --serve with this update; else the mode came over from the version before.
          mode: !mode ? null : options.serve?.on && options.serve.home === mode.home ? 'asked' : 'carried',
          dropMode: async () => {
            // A leading machine's role only the leader switch changes: the mode stays, and a later
            // version that can lead takes it up again (the entry reads another version's mode as the daemon).
            const dropped = await dropServiceMode(root, prepared.executable)
            if (dropped === 'leader') process.stderr.write(`walnut daemon: ${prepared.executable} runs only as the session daemon; the leader mode stays for the next version that can lead\n`)
            if (dropped === 'dropped') {
              process.stderr.write(`walnut daemon: ${prepared.executable} runs only as the session daemon; the service mode it was carried over with is dropped\n`)
              modeWritten = null
            }
          },
        })
      },
      launchdSpawns: () => launchdSpawnsJobs((program, args, timeout) => runDaemonServiceCommand(program, args, undefined, timeout), user.uid, set.label),
      handover: async () => {
        const handedOver = await requestDaemonServiceHandover(runtimeDir, root)
        // The unmanaged daemon is gone: its durable state goes where the service daemon reads it.
        // ~/.open-walnut/tmp is the machine's one copy: only the default set's service takes it.
        if (!set.id && !(await runtimeDaemonAlive(runtimeDir))) await reportMoved(await moveDaemonState(unmanagedStateRoot(home), root), 'to the service')
        return handedOver
      },
      prepareUpdate: () => requestDaemonServiceUpdate(runtimeDir, root, options.overBusy ? { busyMs: OVER_BUSY_WAIT_MS, force: true } : {}),
      prepareExecutable: async () => {
        if (!options.executable) throw new Error('No standalone daemon binary supplied; build the daemon before installing')
        const staged = await stageDaemonServiceArtifact({ sourceExecutable: options.executable, installRoot: root })
        const next = await stageServiceMode(root, options.serve, staged.executable)
        modeBefore = next.before
        modeWritten = next.written
        if (next.note) process.stderr.write(`walnut daemon: ${next.note}\n`)
        return staged
      },
    }
    const backend = scope === 'cron' ? 'cron' : platform === 'darwin' ? 'launchd' : 'systemd'
    // The launcher runs a user unit, a LaunchAgent or the cron start; a system unit keeps the plain config.
    const launcher = options.launcher && scope !== 'system' && (action === 'install' || action === 'update')
      ? { launcher: createLauncherControl({ stateDir: root, backend }) } : {}
    const manager = scope === 'cron'
      ? createCronDaemonServiceManager({ ...common, ...launcher, run: runDaemonServiceCommand, ...createCronServiceHost({ home, stateDir: root, runtimeDir }) })
      : createDaemonServiceManager({ ...common, ...launcher, run: system?.run ?? runDaemonServiceCommand })
    if (action === 'status') {
      const facts = await readLauncherFacts(path.join(root, LAUNCHER_DIR_NAME)).catch(() => null)
      const named = options.walnut ? { serviceSet: set.id || 'default' } : {}
      process.stdout.write(JSON.stringify({ ...(await manager.status({ scope })), ...(facts ? { launcher: facts } : {}), ...named }, null, 2) + '\n')
      return 0
    }
    const configPath = manager.configPath(scope)
    const before = action === 'install' || action === 'update' ? await files.readConfig(configPath).catch(() => null) : null
    // The version that runs on after a failure is the one before: so is its mode (service-mode.ts).
    // Only over this action's own write (compare and swap): a role the switch wrote since stays.
    const restoreMode = async () => {
      if (modeBefore === undefined) return
      const restored = await restoreServiceMode(root, modeBefore, modeWritten).catch(() => null /* the entry reads a doubt as the daemon */)
      if (restored === 'changed') process.stderr.write('walnut daemon: the service mode changed since this update wrote it; it stays as it is\n')
    }
    const result = await manager[action as 'install' | 'update' | 'uninstall' | 'restart']({ scope }).catch(async (error: unknown) => { await restoreMode(); throw error })
    if (!result.ok) await restoreMode()
    if (result.ok && (action === 'install' || action === 'update')) {
      // Each update stages a new ~100 MB version: keep the running one and the one before it (the rollback).
      const after = await files.readConfig(configPath).catch(() => null)
      // With the launcher, also what it runs, goes back to and was asked for (its state names them, not the config).
      const keep = [after, before].map((text) => serviceExecutableOf(platform, scope, text)).filter((exe): exe is string => !!exe)
      keep.push(...await launcherKeeps(root).catch(() => []))
      if (keep.length) {
        await pruneDaemonServiceVersions(root, keep).catch((error) => {
          process.stderr.write(`walnut daemon: old daemon versions were not pruned: ${String(error)}\n`)
        })
      }
    }
    if (result.ok && action === 'install') {
      const marker = path.join(root, 'boot-setup')
      if ((await fs.readFile(marker, 'utf8').catch(() => '')).includes('result=removed')) await fs.rm(marker, { force: true }).catch(() => {})
    }
    if (result.ok && action === 'uninstall' && !(await runtimeDaemonAlive(runtimeDir))) {
      await forgetRestartMark(runtimeDir)
      if (!set.id) await reportMoved(await moveDaemonState(root, unmanagedStateRoot(home)).catch(() => []), 'back for the daemon Walnut starts over SSH')
    }
    if (result.ok && action === 'uninstall') {
      // The launcher's own files: its script (systemd, launchd; cron's is the boot script, removed above) and its dir.
      await fs.rm(path.join(root, LAUNCHER_SCRIPT_NAME), { force: true }).catch(() => {})
      await fs.rm(path.join(root, LAUNCHER_DIR_NAME), { recursive: true, force: true }).catch(() => {})
      // No launcher, no service: a later install starts as the daemon unless its leader says otherwise.
      await removeServiceMode(root).catch(() => { /* the entry reads a doubt as the daemon */ })
    }
    if (result.ok && action === 'uninstall') {
      // Tells the server not to set it up again (remote-boot-start.ts BOOT_SETUP_MARKER); a later install wins.
      await fs.writeFile(path.join(root, 'boot-setup'), `v=uninstall at=${Date.now()} result=removed\n`, { mode: 0o600 }).catch(() => {})
    }
    if (result.ok && action === 'uninstall' && set.id) {
      // A set's own dir goes once nothing of it runs (service-set-remove.ts); else it says why it stays.
      const gone = await removeServiceSetDir(home, set, user.uid).catch((error: unknown) => ({ removed: false as const, dir: root, why: String(error) }))
      process.stderr.write(gone.removed ? `walnut daemon: removed the service set's dir ${gone.dir}\n` : `walnut daemon: kept the service set's dir ${gone.dir}: ${gone.why}\n`)
      process.stdout.write(JSON.stringify({ ...result, setDir: gone }, null, 2) + '\n')
      return 0
    }
    process.stdout.write(JSON.stringify(result, null, 2) + '\n')
    return result.ok ? 0 : 1
  }

  const where = { root, uid: user.uid, ...(system ? { configOwnerUid: system.configOwnerUid, configIo: system.configIo } : {}) }
  return action === 'status' ? act(await openDaemonServiceFiles(where)) : withDaemonServiceFiles(where, act)
}

/**
 * `walnut daemon handback --yes`: the stand-in an update's tail started outside launchd hands
 * its sessions to the LaunchAgent's job (daemon-service-handback.ts), under the install lock.
 * Run by the stand-in's own loop (daemon-update-standin.ts) once launchd starts jobs again.
 */
async function handBackCli(home: string, uid: number, set: ServiceSet): Promise<number> {
  if (process.platform !== 'darwin') throw new Error('handback is for a macOS LaunchAgent')
  const root = set.installRoot
  const runtimeDir = set.runtimeDir
  const plist = daemonServiceConfigPath('darwin', home, 'user', set)
  const job = `gui/${uid}/${set.label}`
  return withDaemonServiceFiles({ root, uid }, async (files) => {
    const result = await handBackStandIn({
      platform: process.platform, runtimeDir,
      ours: async () => { const found = await files.inspectConfig(plist); return found.present && found.owned },
      spawns: () => launchdSpawnsJobs((program, args, timeout) => runDaemonServiceCommand(program, args, undefined, timeout), uid, set.label),
      prepareUpdate: () => requestDaemonServiceUpdate(runtimeDir, root),
      job: async () => {
        const out = await runDaemonServiceCommand('launchctl', ['print', job])
        return out.code === 0 ? { runs: Number(/^\s*runs = (\d+)/m.exec(out.stdout)?.[1] ?? 0) } : null
      },
      kickstart: async () => { await runDaemonServiceCommand('launchctl', ['kickstart', job]) },
      ready: (previous) => daemonReady(runtimeDir, undefined, SERVICE_READY_WAIT_MS, previous),
      alive: (pid) => { try { process.kill(pid, 0); return true } catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM' } },
    })
    process.stdout.write(JSON.stringify(result, null, 2) + '\n')
    return result.ok ? 0 : 1
  })
}
