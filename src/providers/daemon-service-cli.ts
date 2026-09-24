import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { WebSocket } from 'ws'
import { setTimeout as delay } from 'node:timers/promises'
import { daemonInstallRoot } from './daemon-service-config.js'
import { createDaemonServiceManager, DaemonServiceHandoverPendingError, DaemonServiceUpdateRefusedError, type DaemonServiceCommandResult, type DaemonServiceScope } from './daemon-service-manager.js'
import { stageDaemonServiceArtifact } from './daemon-service-artifact.js'
import { openDaemonServiceFiles, withDaemonServiceFiles, type DaemonServiceFiles } from './daemon-service-files.js'
import { createSystemServiceAccess } from './daemon-service-system.js'

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

export async function requestDaemonServiceHandover(runtimeDir: string, stateDir: string): Promise<boolean> {
  const hasPending = () => fs.lstat(path.join(stateDir, 'handover.json')).then(() => true, (error) => {
    if (error.code === 'ENOENT') return false
    throw new DaemonServiceHandoverPendingError(`Cannot inspect pending handover: ${String(error)}`)
  })
  const pending = await hasPending()
  try {
    return await requestRunningDaemonHandover(runtimeDir, stateDir, pending)
  } catch (error) {
    if (pending || await hasPending()) throw new DaemonServiceHandoverPendingError(`Service handover is unresolved: ${String(error)}`)
    throw error
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
    const [portText, instanceId] = await Promise.all(['daemon.port', 'daemon.instance']
      .map((name) => fs.readFile(path.join(runtimeDir, name), 'utf8').then((value) => value.trim())))
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
      const closed = () => finish(new Error('Daemon handover connection closed'))
      const timer = setTimeout(() => finish(new Error('Daemon handover connection timed out')), 1500)
      socket.once('open', opened)
      socket.once('close', closed)
      socket.on('error', finish)
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
    const hello = await rpc({ cmd: 'hello' }, 1500)
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

export async function runDaemonServiceArgs(args: string[]): Promise<number> {
  const action = args[0] ?? 'status'
  const options: DaemonServiceCliOptions = {}
  for (let i = 1; i < args.length; i++) {
    if (args[i] === '--yes') options.yes = true
    else if (args[i] === '--sudo') options.sudo = true
    else if (args[i] === '--scope') {
      if (!args[i + 1]) throw new Error('--scope requires user or system')
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
  if (options.scope && options.scope !== 'user' && options.scope !== 'system') throw new Error('Scope must be user or system')
  const systemScope = process.platform === 'linux' && options.scope === 'system'
  if (options.sudo && !systemScope) throw new Error('--sudo requires --scope system on Linux')
  if (systemScope && action !== 'status' && !options.sudo) throw new Error('System service changes require --sudo --yes; the daemon still runs as your current account')
  const home = os.homedir()
  const user = os.userInfo()
  if (action !== 'status' && user.uid === 0) throw new Error('Run as the original non-root account with --scope system --sudo --yes, not as root')
  if (action !== 'status' && (process.env.VITEST || process.env.NODE_ENV === 'test'
    || await fs.realpath(home) !== await fs.realpath(user.homedir))) {
    throw new Error('Service changes require the real host account, not a test or isolated home')
  }
  const root = daemonInstallRoot(process.platform, home)
  try {
    const stat = await fs.lstat(root)
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== user.uid || (stat.mode & 0o077)) {
      throw new Error('Daemon service directory is not private')
    }
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  const runtimeDir = '/tmp/open-walnut'
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
    const manager = createDaemonServiceManager({
      platform, home, uid: user.uid, user: user.username,
      path: (process.env.PATH ?? '/usr/bin:/bin').split(':').filter((part) => path.isAbsolute(part)).join(':'),
      stateDir: root, runtimeDir, run: system?.run ?? runDaemonServiceCommand,
      inspectConfig: (target) => files.inspectConfig(target),
      readConfig: (target) => files.readConfig(target),
      writeConfig: (target, text) => files.writeConfig(target, text),
      removeConfig: (target) => files.removeConfig(target),
      ready: (_status, executable) => daemonReady(runtimeDir, executable, 15_000, previousInstance),
      handover: () => requestDaemonServiceHandover(runtimeDir, root),
      prepareUpdate: async () => { await requestRunningDaemonHandover(runtimeDir, root, false, true) },
      prepareExecutable: async () => {
        if (!options.executable) throw new Error('No standalone daemon binary supplied; build the daemon before installing')
        return stageDaemonServiceArtifact({ sourceExecutable: options.executable, installRoot: root })
      },
    })
    if (action === 'status') {
      process.stdout.write(JSON.stringify(await manager.status({ scope: options.scope }), null, 2) + '\n')
      return 0
    }
    const result = await manager[action as 'install' | 'update' | 'uninstall' | 'restart']({ scope: options.scope })
    process.stdout.write(JSON.stringify(result, null, 2) + '\n')
    return result.ok ? 0 : 1
  }

  const where = { root, uid: user.uid, ...(system ? { configOwnerUid: system.configOwnerUid, configIo: system.configIo } : {}) }
  return action === 'status' ? act(await openDaemonServiceFiles(where)) : withDaemonServiceFiles(where, act)
}
