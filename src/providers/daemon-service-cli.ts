import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { WebSocket } from '#ws'
import { setTimeout as delay } from 'node:timers/promises'
import { daemonInstallRoot, readDaemonServiceExecutable } from './daemon-service-config.js'
import { accountInfo } from '../lib/account.js'
import { createDaemonServiceManager, DaemonServiceHandoverPendingError, DaemonServiceUpdateRefusedError, type DaemonServiceCommandResult, type DaemonServiceScope } from './daemon-service-manager.js'
import { pruneDaemonServiceVersions, stageDaemonServiceArtifact } from './daemon-service-artifact.js'
import { openDaemonServiceFiles, withDaemonServiceFiles, type DaemonServiceFiles } from './daemon-service-files.js'
import { createSystemServiceAccess } from './daemon-service-system.js'
import { createCronDaemonServiceManager } from './daemon-service-cron.js'
import { createCronServiceHost } from './daemon-service-cron-host.js'
import { resolveDaemonServiceScope } from './daemon-service-scope.js'
import { readDaemonBootExecutable } from './daemon-service-boot-script.js'
import { moveDaemonState, unmanagedStateRoot } from './daemon-service-state-move.js'
import { localProductionDaemonDir } from '../lib/daemon-dir.js'

export interface DaemonServiceCliOptions {
  scope?: DaemonServiceScope
  yes?: boolean
  executable?: string
  sudo?: boolean
}

export function runDaemonServiceCommand(program: string, args: string[], input?: string): Promise<DaemonServiceCommandResult> {
  return new Promise((resolve) => {
    let result: DaemonServiceCommandResult | undefined
    const controlsService = ['systemctl', 'launchctl'].includes(path.basename(program))
      || (program === 'sudo' && args.includes('/usr/bin/systemctl'))
    const runsUpdate = args[0] === 'walnut' && args[1] === 'daemon' && args[2] === 'update'
    const timeout = runsUpdate ? 600_000 : controlsService ? 75_000 : 15_000
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

export async function daemonReady(runtimeDir: string, expectedExecutable?: string, timeoutMs = 15_000, previousInstance?: string): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  const expected = expectedExecutable ? await fs.realpath(expectedExecutable) : undefined
  const markers = () => Promise.all(['daemon.port', 'daemon.instance', 'daemon.service']
    .map((name) => fs.readFile(path.join(runtimeDir, name), 'utf8').then((value) => value.trim())))
  do {
    try {
      const before = await markers()
      const [portText, instanceId, serviceId] = before
      const port = Number(portText)
      if (instanceId && instanceId !== previousInstance && instanceId === serviceId && Number.isInteger(port) && port > 0 && port <= 65535) {
        const reply = await new Promise<Record<string, unknown> | null>((resolve) => {
          const socket = new WebSocket(`ws://127.0.0.1:${port}`, { maxPayload: 128 * 1024 })
          let finished = false
          const finish = (value: Record<string, unknown> | null) => {
            if (finished) return
            finished = true
            clearTimeout(timer)
            socket.terminate()
            resolve(value)
          }
          const timer = setTimeout(() => finish(null), Math.max(1, Math.min(1500, deadline - Date.now())))
          socket.on('error', () => finish(null))
          socket.on('close', () => finish(null))
          socket.on('open', () => socket.send(JSON.stringify({ id: 1, cmd: 'hello' })))
          socket.on('message', (raw) => {
            try {
              const value = JSON.parse(raw.toString())
              if (value?.id === 1) finish(value)
            } catch { finish(null) }
          })
        })
        const managed = reply?.cronSupervision as { managed?: unknown } | undefined
        if (reply?.ok === true && reply.instanceId === instanceId && managed?.managed === true
          && Array.isArray(reply.capabilities) && reply.capabilities.includes('cron-supervision-v1')
          && (!expected || (typeof reply.serviceExecutable === 'string'
            && await fs.realpath(reply.serviceExecutable) === expected))) {
          const after = await markers()
          if (before.every((value, index) => value === after[index])) return true
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    if (Date.now() < deadline) await delay(Math.min(250, deadline - Date.now()))
  } while (Date.now() < deadline)
  return false
}

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
  return /must finish first|has active operations; retry after they finish/.test(text)
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
  const deadline = Date.now() + (wait.busyMs ?? HANDOVER_BUSY_WAIT_MS)
  let noted = false
  for (;;) {
    const pending = await hasPending()
    try {
      return await requestRunningDaemonHandover(runtimeDir, stateDir, pending)
    } catch (error) {
      if (pending || await hasPending()) throw new DaemonServiceHandoverPendingError(`Service handover is unresolved: ${String(error)}`)
      if (!handoverBusy(error) || Date.now() >= deadline) throw error
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
  wait: { busyMs?: number; pauseMs?: number; note?: (text: string) => void } = {},
): Promise<void> {
  const deadline = Date.now() + (wait.busyMs ?? UPDATE_BUSY_WAIT_MS)
  let noted = false
  for (;;) {
    try {
      await requestRunningDaemonHandover(runtimeDir, stateDir, false, true)
      return
    } catch (error) {
      if (!(error instanceof DaemonServiceUpdateRefusedError) || !handoverBusy(error) || Date.now() >= deadline) throw error
      if (!noted) {
        noted = true
        ;(wait.note ?? ((text) => process.stderr.write(`walnut daemon: ${text}\n`)))(`the running daemon is busy (${error.message}); asking again`)
      }
      await delay(wait.pauseMs ?? 2000)
    }
  }
}

export async function requestRunningDaemonHandover(runtimeDir: string, stateDir: string, pending: boolean, updating = false): Promise<boolean> {
  let connection: WebSocket | undefined
  let requested = false
  let refused = false
  let exited = false
  try {
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
    const result = await rpc({ cmd: updating ? 'service.update' : 'service.handover', instanceId, stateDir }, 60_000)
    if (result.ok !== true && !(updating && result.updateStarted === true)) {
      refused = true
      throw new Error(String(result.error ?? 'Daemon refused service handover'))
    }
    if (result.instanceId !== instanceId || (result.ok === true && result.prepared !== true)) throw new Error('Service handover was not confirmed')
    socket.close()
    const deadline = Date.now() + 30_000
    while (alive()) {
      if (Date.now() >= deadline) throw new Error('Previous daemon has not exited after preparing handover')
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

export async function runDaemonServiceArgs(args: string[]): Promise<number> {
  const action = args[0] ?? 'status'
  const options: DaemonServiceCliOptions = {}
  for (let i = 1; i < args.length; i++) {
    if (args[i] === '--yes') options.yes = true
    else if (args[i] === '--sudo') options.sudo = true
    else if (args[i] === '--scope') {
      if (!args[i + 1]) throw new Error('--scope requires user, system or cron')
      options.scope = args[++i] as DaemonServiceScope
    } else if (args[i] === '--executable') {
      if (!args[i + 1]) throw new Error('--executable requires a path')
      options.executable = args[++i]
    }
    else throw new Error(`Unknown daemon option: ${args[i]}`)
  }
  return runDaemonServiceCli(action, options)
}

export async function runDaemonServiceCli(action: string, options: DaemonServiceCliOptions): Promise<number> {
  if (!['status', 'install', 'update', 'uninstall', 'restart'].includes(action)) throw new Error('Expected daemon status, install, update, uninstall, or restart')
  if (process.platform !== 'linux' && process.platform !== 'darwin') throw new Error('Daemon services require Linux or macOS')
  if (action !== 'status' && !options.yes) throw new Error('This changes the host service. Repeat with --yes to confirm; running CLI sessions are not terminated.')
  if (options.scope && !['user', 'system', 'cron'].includes(options.scope)) throw new Error('Scope must be user, system or cron')
  if (options.scope === 'cron' && process.platform !== 'linux') throw new Error('The cron scope is for Linux; macOS starts the daemon as a login agent')
  if (options.sudo && (process.platform !== 'linux' || options.scope !== 'system')) throw new Error('--sudo requires --scope system on Linux')
  const home = os.homedir()
  const user = accountInfo()
  if (action !== 'status' && user.uid === 0) throw new Error('Run as the original non-root account with --scope system --sudo --yes, not as root')
  if (action !== 'status' && (process.env.VITEST || process.env.NODE_ENV === 'test'
    || await fs.realpath(home) !== await fs.realpath(user.homedir))) {
    throw new Error('Service changes require the real host account, not a test or isolated home')
  }
  // No --scope: the installed backend, or for a first install the first boot start this account can have without root.
  const resolved = await resolveDaemonServiceScope(action, options.scope, {
    platform: process.platform, home, user: user.username, run: runDaemonServiceCommand,
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
  const root = daemonInstallRoot(process.platform, home)
  try {
    const stat = await fs.lstat(root)
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== user.uid || (stat.mode & 0o077)) {
      throw new Error('Daemon service directory is not private')
    }
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  // The production daemon dir of this account: /tmp/open-walnut, or ~/.cache/open-walnut
  // when another user on this machine owns that one (src/lib/daemon-dir.ts).
  const runtimeDir = localProductionDaemonDir()
  const platform = process.platform
  const system = systemScope ? createSystemServiceAccess(runDaemonServiceCommand) : null
  if (system && action !== 'status') await system.preflight()

  // One action uses the same files from probe to verify (owners read once inside the lock), so its view never changes partway through.
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
      stateDir: root, runtimeDir,
      inspectConfig: (target: string) => files.inspectConfig(target),
      readConfig: (target: string) => files.readConfig(target),
      writeConfig: (target: string, text: string) => files.writeConfig(target, text),
      removeConfig: (target: string) => files.removeConfig(target),
      // The cron supervisor waits 5 s before it reads an updated script, then the daemon boots.
      ready: (_status: unknown, executable?: string) => daemonReady(runtimeDir, executable, scope === 'cron' ? 60_000 : 15_000, previousInstance),
      handover: async () => {
        const handedOver = await requestDaemonServiceHandover(runtimeDir, root)
        // The unmanaged daemon is gone: its durable state goes where the service daemon reads it.
        if (!(await runtimeDaemonAlive(runtimeDir))) await reportMoved(await moveDaemonState(unmanagedStateRoot(home), root), 'to the service')
        return handedOver
      },
      prepareUpdate: () => requestDaemonServiceUpdate(runtimeDir, root),
      prepareExecutable: async () => {
        if (!options.executable) throw new Error('No standalone daemon binary supplied; build the daemon before installing')
        return stageDaemonServiceArtifact({ sourceExecutable: options.executable, installRoot: root })
      },
    }
    const manager = scope === 'cron'
      ? createCronDaemonServiceManager({ ...common, run: runDaemonServiceCommand, ...createCronServiceHost({ home, stateDir: root, runtimeDir }) })
      : createDaemonServiceManager({ ...common, run: system?.run ?? runDaemonServiceCommand })
    if (action === 'status') {
      process.stdout.write(JSON.stringify(await manager.status({ scope }), null, 2) + '\n')
      return 0
    }
    const configPath = manager.configPath(scope)
    const before = action === 'install' || action === 'update' ? await files.readConfig(configPath).catch(() => null) : null
    const result = await manager[action as 'install' | 'update' | 'uninstall' | 'restart']({ scope })
    if (result.ok && (action === 'install' || action === 'update')) {
      // Each update stages a new ~100 MB version: keep the running one and the one before it (the rollback).
      const after = await files.readConfig(configPath).catch(() => null)
      const keep = [after, before].map((text) => serviceExecutableOf(platform, scope, text)).filter((exe): exe is string => !!exe)
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
      await reportMoved(await moveDaemonState(root, unmanagedStateRoot(home)).catch(() => []), 'back for the daemon Walnut starts over SSH')
    }
    if (result.ok && action === 'uninstall') {
      // Tells the server not to set it up again (remote-boot-start.ts BOOT_SETUP_MARKER); a later install wins.
      await fs.writeFile(path.join(root, 'boot-setup'), `v=uninstall at=${Date.now()} result=removed\n`, { mode: 0o600 }).catch(() => {})
    }
    process.stdout.write(JSON.stringify(result, null, 2) + '\n')
    return result.ok ? 0 : 1
  }

  const where = { root, uid: user.uid, ...(system ? { configOwnerUid: system.configOwnerUid, configIo: system.configIo } : {}) }
  return action === 'status' ? act(await openDaemonServiceFiles(where)) : withDaemonServiceFiles(where, act)
}
