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

export { IN_PROCESS_DAEMON_URL }

let wanted: Promise<boolean> | null = null

/**
 * Does this process run its daemon in process? WALNUT_IN_PROCESS_DAEMON=1 or 0 decides for one
 * process (a test, a person's own run); otherwise the experiment. Asked once per process.
 */
export function inProcessDaemonWanted(): Promise<boolean> {
  wanted ??= (async () => {
    const forced = process.env.WALNUT_IN_PROCESS_DAEMON
    if (forced === '1' || forced === '0') return forced === '1'
    try {
      const [{ getConfig }, { experimentalEnabled }] = await Promise.all([import('../core/config-manager.js'), import('../core/experimental.js')])
      return experimentalEnabled((await getConfig()).experimental, 'in_process_daemon')
    } catch {
      return false
    }
  })()
  return wanted
}

/** Tests only: ask the switch again. */
export function resetInProcessDaemonWantedForTests(): void { wanted = null }

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

interface Held { runtime: DaemonRuntime; dir: string; ended: boolean }
let held: Held | null = null
let starting: Promise<InProcessStart> | null = null

export type InProcessStart = { kind: 'started'; dir: string } | { kind: 'existing'; port: string }

/**
 * Start the in-process runtime for `dir` with `env` (the env a daemon program would get,
 * LocalDaemon.buildSpawnEnv). `existing`: another daemon still serves the dir (its instance lock),
 * and nothing was started.
 */
export function startInProcessDaemon(opts: { dir: string; env: NodeJS.ProcessEnv }): Promise<InProcessStart> {
  if (held && !held.ended) {
    if (held.dir !== opts.dir) return Promise.reject(new Error(`an in-process daemon already serves ${held.dir}`))
    return Promise.resolve({ kind: 'started', dir: held.dir })
  }
  starting ??= (async (): Promise<InProcessStart> => {
    const { module: { createDaemonRuntime }, script } = await loadRuntimeModule()
    const entry: Held = { runtime: null as unknown as DaemonRuntime, dir: opts.dir, ended: false }
    entry.runtime = await createDaemonRuntime({
      env: opts.env,
      mode: 'start',
      listen: false,
      program: { script },
      // The runtime ended itself (another daemon took its dir, a stop it was asked for): the
      // server stays up; its next dial starts it again or finds the daemon that took the dir.
      exit: (code) => {
        entry.ended = true
        if (held === entry) held = null
        log.session.warn('in-process daemon ended itself', { dir: opts.dir, code })
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
    held = entry
    log.session.info('in-process daemon started', { dir: opts.dir, version: entry.runtime.version })
    return { kind: 'started', dir: opts.dir }
  })().finally(() => { starting = null })
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
 * The launcher's readiness check for the runtime (service-launcher-beat.ts daemonServesCheck), asked
 * of the runtime itself through a client of its own: hello as this very runtime, then status.
 * null when it answers right, else why not.
 */
export async function inProcessDaemonServesCheck(): Promise<string | null> {
  const entry = held && !held.ended ? held : null
  if (!entry) return 'the in-process daemon is not running'
  const { daemonServesCheck } = await import('./service-launcher-beat.js')
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
export async function stopInProcessDaemon(reason: string): Promise<number | null> {
  if (starting) await starting.catch(() => {})
  const entry = held
  if (!entry || entry.ended) return null
  held = null
  entry.ended = true
  log.session.info('in-process daemon stopping', { dir: entry.dir, reason })
  const code = await entry.runtime.stop()
  log.session.info('in-process daemon stopped', { dir: entry.dir, code })
  return code
}

export type InProcessVerdict = { kind: 'in-process'; url: string } | { kind: 'declined'; why: string }

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
}): Promise<InProcessVerdict> {
  if (inProcessDaemonRunning()) return { kind: 'in-process', url: IN_PROCESS_DAEMON_URL }
  const port = deps.readPort()
  if (port && await deps.alive(port)) {
    try {
      log.session.info('in-process daemon: stopping the daemon program that serves this dir first', { dir: deps.dir, port })
      await deps.stopProgram()
    } catch (err) {
      return { kind: 'declined', why: err instanceof Error ? err.message : String(err) }
    }
  }
  let started: InProcessStart
  try {
    started = await startInProcessDaemon({ dir: deps.dir, env: await deps.env() })
  } catch (err) {
    return { kind: 'declined', why: err instanceof Error ? err.message : String(err) }
  }
  if (started.kind === 'existing') return { kind: 'declined', why: `another daemon holds the dir (port ${started.port || 'none'})` }
  return { kind: 'in-process', url: IN_PROCESS_DAEMON_URL }
}
