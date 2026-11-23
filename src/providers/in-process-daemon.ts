/**
 * This computer's session daemon run inside the server's own process (experiment
 * `in_process_daemon`). The server creates the daemon runtime (createDaemonRuntime in
 * daemon-standalone.ts) on its main thread and calls it directly: LocalDaemon starts it in place
 * of spawning a daemon program, and DaemonConnection dials it through an InProcessDaemonSocket
 * (in-process-daemon-socket.ts) instead of a WebSocket. The runtime opens no WebSocket port; its
 * agent-gateway unix socket stays open (a running session's `walnut` command is bound to it).
 *
 * One runtime per process, for the default daemon dir only. Decided once, at the first ask (the
 * server's boot): turning the experiment on or off takes effect at the next start, which picks the
 * running sessions up from the registry either way (sessions.json is the same).
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { DaemonRuntime, DaemonRuntimeOptions } from './daemon-runtime-types.js'
import { IN_PROCESS_DAEMON_URL, type InProcessConnect } from './in-process-daemon-socket.js'
import { DAEMON_BINARIES_DIR } from '../constants.js'
import { log } from '../logging/index.js'
import os from 'node:os'
import { readDaemonInstanceOwner, type DaemonLockOwnerInfo } from './daemon-instance-lock.js'
import { serviceRuntime } from '../core/server-role.js'

export { IN_PROCESS_DAEMON_URL }

let wanted: Promise<boolean> | null = null
/** What inProcessDaemonWanted answered, once it has (undefined until then). */
let wantedNow: boolean | undefined

/**
 * Does this process run its daemon in process? WALNUT_IN_PROCESS_DAEMON=1 or 0 decides for one
 * process (a test, a person's own run); otherwise the experiment. Asked once per process.
 */
export function inProcessDaemonWanted(): Promise<boolean> {
  wanted ??= (async () => {
    // A host's one Walnut service holds the runtime by what it is (src/binary/service-entry.ts).
    if (serviceRuntime()) return true
    const forced = process.env.WALNUT_IN_PROCESS_DAEMON
    if (forced === '1' || forced === '0') return forced === '1'
    try {
      const [{ getConfig }, { experimentalEnabled }] = await Promise.all([import('../core/config-manager.js'), import('../core/experimental.js')])
      return experimentalEnabled((await getConfig()).experimental, 'in_process_daemon')
    } catch {
      return false
    }
  })().then((on) => { wantedNow = on; return on })
  return wanted
}

/** The answer without waiting (undefined until the first ask settled: the server's boot asks it). */
export function inProcessDaemonWantedNow(): boolean | undefined { return wantedNow }

/** Tests only: ask the switch again. */
export function resetInProcessDaemonWantedForTests(): void { wanted = null; wantedNow = undefined }

interface RuntimeModule { createDaemonRuntime(options: DaemonRuntimeOptions): DaemonRuntime | Promise<DaemonRuntime> }
let provided: (() => Promise<RuntimeModule>) | null = null

/**
 * The compiled Walnut file carries the daemon (src/binary/main.ts) and hands its module over here,
 * so the server takes the very build its `walnut __daemon` runs.
 */
export function provideDaemonRuntime(load: () => Promise<RuntimeModule>): void { provided = load }

/**
 * Where the runtime's code is, in the order asked: the compiled file's own (provideDaemonRuntime);
 * run from source, daemon-standalone.ts beside this file; a built server, the runtime bundle the
 * daemon build writes beside the daemon binaries (scripts/build-daemon.sh: daemon-runtime/). The
 * path is computed, never a literal import: the server's own bundle never takes the daemon in.
 */
export function daemonRuntimeCandidates(moduleUrl: string, binariesDir: string): string[] {
  const here = fileURLToPath(moduleUrl)
  if (/\.ts$/.test(here)) return [path.join(path.dirname(here), 'daemon-standalone.ts')]
  const bundle = (dir: string) => path.join(dir, 'daemon-runtime', 'daemon-standalone.js')
  // A built server's code sits in dist/ (dist/cli.js) or a folder below it (dist/<dir>/x.js).
  const dir = path.dirname(here)
  return [...new Set([binariesDir, path.join(dir, 'daemon-binaries'), path.join(dir, '..', 'daemon-binaries')].map(bundle))]
}

/**
 * The runtime's module, and the script that runs the same daemon as a program (its `walnut` PATH
 * shim and plugin jobs run `<execPath> <script> walnut ...`, as under a daemon program): the file
 * loaded, or the compiled file's own entry (argv[1], which the daemon reads as the binary itself).
 */
async function loadRuntimeModule(): Promise<{ module: RuntimeModule; script: string }> {
  if (provided) return { module: await provided(), script: process.argv[1] ?? '' }
  const candidates = daemonRuntimeCandidates(import.meta.url, DAEMON_BINARIES_DIR)
  const found = candidates.find((file) => fs.existsSync(file))
  if (!found) throw new Error(`no daemon runtime to run in process (looked at ${candidates.join(', ')}); build it with bun run build:daemon`)
  return { module: await import(pathToFileURL(found).href) as RuntimeModule, script: found }
}

/**
 * What runs this build's fold prewarm (fold-prewarm.ts) before the runtime starts in process: the
 * compiled file itself, or the runtime script; its version keys the prewarm's lock.
 */
export function inProcessRuntimeTarget(): { binaryPath: string; version: string } {
  if (provided) return { binaryPath: process.execPath, version: `compiled:${process.execPath}` }
  const candidates = daemonRuntimeCandidates(import.meta.url, DAEMON_BINARIES_DIR)
  const found = candidates.find((file) => fs.existsSync(file)) ?? candidates[0]!
  let version = `script:${found}`
  try { version = fs.readFileSync(`${found}.version`, 'utf8').trim() || version } catch { /* source: no version file */ }
  return { binaryPath: found, version }
}

interface Held { runtime: DaemonRuntime; dir: string; ended: boolean; service: boolean; port: number | null }
let held: Held | null = null
let starting: Promise<InProcessStart> | null = null
let startingDir: string | null = null
/** Set by the server's own stop (stopServer): no runtime starts in this process until it boots again. */
let closedForGood = false

/** A start asked for while the server stops: it never runs (and never falls back to a daemon program). */
export class InProcessDaemonClosedError extends Error {
  constructor() { super('the server is stopping: no in-process daemon starts now'); this.name = 'InProcessDaemonClosedError' }
}

/** startServer: the in-process daemon may start again (a server restarted in the same process, tests). */
export function reopenInProcessDaemon(): void { closedForGood = false }

export type InProcessStart = { kind: 'started'; dir: string } | { kind: 'existing'; port: string }

/**
 * Start the in-process runtime for `dir` with `env` (the env a daemon program would get,
 * LocalDaemon.buildSpawnEnv). `existing`: another daemon still serves the dir (its instance lock),
 * and nothing was started.
 *
 * `service`: this process is a host's one Walnut service (src/binary/service-entry.ts), the
 * follower of `home`. The runtime runs as the launcher's service (mode 'service', its state dir,
 * daemon.pid naming this process, hello `serves: 'walnut-serve'`) and never starts a follower child
 * for `home`: this server is that follower. When it ends itself (`service.update`, `service.handover`
 * from `walnut daemon update`, a follower spec the leader changed) the whole service ends, as a daemon
 * program would: SIGTERM to this process, whose handler stops the server (and writes the launcher's
 * leaving mark) before it exits.
 */
export function startInProcessDaemon(opts: { dir: string; env: NodeJS.ProcessEnv; service?: { home: string; leads?: string } }): Promise<InProcessStart> {
  if (closedForGood) return Promise.reject(new InProcessDaemonClosedError())
  if (held && !held.ended) {
    if (held.dir !== opts.dir) return Promise.reject(new Error(`an in-process daemon already serves ${held.dir}`))
    return Promise.resolve({ kind: 'started', dir: held.dir })
  }
  // One start at a time, for one dir: a second caller for another dir is refused, never handed this one.
  if (starting && startingDir !== opts.dir) return Promise.reject(new Error(`an in-process daemon is starting for ${startingDir}`))
  if (!starting) startingDir = opts.dir
  starting ??= (async (): Promise<InProcessStart> => {
    const { module: { createDaemonRuntime }, script } = await loadRuntimeModule()
    const service = opts.service
    const entry: Held = { runtime: null as unknown as DaemonRuntime, dir: opts.dir, ended: false, service: !!service, port: null }
    const launcherFacts = service ? (await import('../web/serve-launcher-beat.js')).serveLauncherFacts : undefined
    entry.runtime = await createDaemonRuntime({
      env: opts.env,
      mode: service ? 'service' : 'start',
      ...(service ? { pidFile: true, serves: 'walnut-serve' as const, selfHome: service.home, launcherFacts } : {}),
      ...(service?.leads ? { leadsWalnut: service.leads } : {}),
      listen: false,
      // The door stays open for everyone this server does not call directly (walnut-net, a
      // host's follower server, hub forwards, a leader's tunnel): turning the experiment on
      // takes none of them away. No daemon.pid: this pid is the server's, never a daemon's to signal.
      door: true,
      program: { script },
      // The runtime ended itself (another daemon took its dir, a stop it was asked for): the
      // server stays up; its next dial starts it again or finds the daemon that took the dir.
      exit: (code) => {
        entry.ended = true
        if (held === entry) held = null
        log.session.warn('in-process daemon ended itself', { dir: opts.dir, code, ...(service ? { service: true } : {}) })
        if (service) process.kill(process.pid, 'SIGTERM')
      },
    })
    let started: Awaited<ReturnType<DaemonRuntime['start']>>
    try { started = await entry.runtime.start() } catch (err) {
      // What start() got that far (the dir's lock, its listeners, its clocks) is given back.
      await entry.runtime.stop().catch(() => {})
      throw err
    }
    if (started.kind === 'existing') {
      await entry.runtime.stop().catch(() => {})
      return { kind: 'existing', port: started.port }
    }
    entry.port = started.port || null
    held = entry
    log.session.info('in-process daemon started', { dir: opts.dir, version: entry.runtime.version, ...(service ? { service: true, port: entry.port } : {}) })
    return { kind: 'started', dir: opts.dir }
  })().finally(() => { starting = null; startingDir = null })
  return starting
}

/** The running in-process runtime's connect, or null when none runs. */
export function inProcessDaemonConnect(): InProcessConnect | null {
  const runtime = held && !held.ended ? held.runtime : null
  if (!runtime) return null
  return (onFrame, onClose) => runtime.connect(onFrame, onClose)
}

export function inProcessDaemonRunning(): boolean { return !!held && !held.ended }

/**
 * The runtime this process holds while it runs, or null: a host's one Walnut service takes the
 * follower seat from it (replica/front.ts), which asks again until the runtime has started.
 */
export function inProcessDaemonRuntime(): DaemonRuntime | null { return held && !held.ended ? held.runtime : null }

/**
 * The launcher's readiness check for the runtime (service-launcher-beat.ts daemonServesCheck), asked
 * of the runtime itself through a client of its own: hello as this very runtime, then status.
 * null when it answers right, else why not.
 */
export async function inProcessDaemonServesCheck(): Promise<string | null> {
  const entry = held && !held.ended ? held : null
  if (!entry) return 'the in-process daemon is not running'
  const { askOwnPort, daemonServesCheck } = await import('./service-launcher-beat.js')
  // A host's one service is reached by its leaders through the door: ready only once that answers.
  if (entry.service) {
    if (!entry.port) return 'the service\'s door is not listening'
    const { WebSocket } = await import('#ws')
    const ask = askOwnPort(entry.port, WebSocket as unknown as Parameters<typeof askOwnPort>[1])
    return daemonServesCheck(ask, { instanceId: entry.runtime.instanceId, version: entry.runtime.version })
  }
  const client = entry.runtime.connect(() => {})
  try {
    return await daemonServesCheck((cmd) => client.request(String(cmd.cmd), cmd), { instanceId: entry.runtime.instanceId, version: entry.runtime.version })
  } finally { client.close() }
}

/**
 * Stop it the way a daemon program stops on SIGTERM: drain, save the registry, release the dir's
 * lock; an isolated dir's agents are ended, the production dir's keep running for the next start.
 * Returns the exit code a program would use (null when none ran).
 */
export async function stopInProcessDaemon(reason: string, budgetMs?: number, opts: { forGood?: boolean } = {}): Promise<number | null> {
  // The server's own stop: a request still served meanwhile (its ensureRunning) starts no new runtime.
  if (opts.forGood) closedForGood = true
  if (starting) await starting.catch(() => {})
  const entry = held
  if (!entry || entry.ended) return null
  held = null
  entry.ended = true
  log.session.info('in-process daemon stopping', { dir: entry.dir, reason })
  const stopping = entry.runtime.stop()
  if (budgetMs !== undefined) {
    // The server's own exit will not wait past its bail: what a stop saves last (the registry, the
    // fold checkpoints) is saved now when the drain is still running at the budget.
    let timer: ReturnType<typeof setTimeout> | undefined
    const late = await Promise.race([stopping.then(() => false), new Promise<true>((r) => { timer = setTimeout(() => r(true), budgetMs) })])
    clearTimeout(timer)
    if (late) {
      log.session.warn('in-process daemon stop ran past its budget; its registry and checkpoints are saved now', { dir: entry.dir, budgetMs })
      entry.runtime.saveNow()
      return null
    }
  }
  const code = await stopping
  log.session.info('in-process daemon stopped', { dir: entry.dir, code })
  return code
}

export type InProcessVerdict = { kind: 'in-process'; url: string } | { kind: 'declined'; why: string }

/**
 * One service per machine and daemon dir: another Walnut server already runs the session daemon of
 * this dir in its own process (its lock banner says inProcess). This one refuses, and never stops
 * it the way it stops a daemon program (its door answers on daemon.port, as a program's does).
 */
export class AnotherServiceError extends Error {
  constructor(readonly dir: string, readonly pid: number) {
    super(`Another Walnut service (pid ${pid}) runs the session daemon of ${dir}: one service per machine and data dir. `
      + 'Stop that one first, or give this one its own data and daemon dirs (OPEN_WALNUT_HOME, WALNUT_DAEMON_DIR).')
    this.name = 'AnotherServiceError'
  }
}

/** The other service that holds `dir` in its own process, or null (none, a daemon program, or this process). */
export async function anotherServiceHolds(dir: string, read: (o: { runtimeDir: string; uid: number }) => Promise<DaemonLockOwnerInfo | null> = readDaemonInstanceOwner): Promise<{ pid: number } | null> {
  const owner = await read({ runtimeDir: dir, uid: os.userInfo().uid }).catch(() => null)
  return owner?.inProcess && owner.pid !== process.pid ? { pid: owner.pid } : null
}

/**
 * LocalDaemon's way to its daemon in process: a daemon program that still serves the dir is
 * stopped first (stopProgram, which refuses one a service manager runs), then the runtime starts.
 * `declined`: the dir stays with the daemon that serves it, and the caller dials that one.
 */
export async function ensureInProcessDaemon(deps: {
  dir: string
  readPort: () => number | null
  alive: (port: number) => Promise<boolean>
  stopProgram: () => Promise<void>
  env: () => Promise<NodeJS.ProcessEnv>
  /** Who holds the dir's lock (anotherServiceHolds): tests hand their own. */
  otherService?: () => Promise<{ pid: number } | null>
  /** This process is a host's one Walnut service, the follower of `home` (startInProcessDaemon). */
  service?: { home: string; leads?: string }
  /**
   * Folds the registry's streams in a child process first (fold-prewarm.ts), so the start adopts
   * from fresh checkpoints: in process its re-fold holds the server's thread (A3b measure: about
   * 10 ms per MB not yet folded, 16 s for 30 sessions of 50 MB). A failure is logged, never fatal.
   */
  prewarm?: () => Promise<void>
}): Promise<InProcessVerdict> {
  if (inProcessDaemonRunning()) return { kind: 'in-process', url: IN_PROCESS_DAEMON_URL }
  if (closedForGood) throw new InProcessDaemonClosedError()
  const other = await (deps.otherService ?? (() => anotherServiceHolds(deps.dir)))()
  if (other) throw new AnotherServiceError(deps.dir, other.pid)
  const port = deps.readPort()
  if (port && await deps.alive(port)) {
    try {
      log.session.info('in-process daemon: stopping the daemon program that serves this dir first', { dir: deps.dir, port })
      await deps.stopProgram()
    } catch (err) {
      return { kind: 'declined', why: err instanceof Error ? err.message : String(err) }
    }
  }
  if (deps.prewarm) {
    const t0 = Date.now()
    await deps.prewarm().then(
      () => log.session.info('in-process daemon: fold prewarm done', { dir: deps.dir, ms: Date.now() - t0 }),
      (err: unknown) => log.session.warn('in-process daemon: fold prewarm failed; adopting without it', { dir: deps.dir, error: err instanceof Error ? err.message : String(err) }),
    )
  }
  let started: InProcessStart
  try {
    started = await startInProcessDaemon({ dir: deps.dir, env: await deps.env(), ...(deps.service ? { service: deps.service } : {}) })
  } catch (err) {
    // While the server stops nothing starts, a daemon program in its place neither.
    if (err instanceof InProcessDaemonClosedError) throw err
    return { kind: 'declined', why: err instanceof Error ? err.message : String(err) }
  }
  if (started.kind === 'existing') return { kind: 'declined', why: `another daemon holds the dir (port ${started.port || 'none'})` }
  return { kind: 'in-process', url: IN_PROCESS_DAEMON_URL }
}
