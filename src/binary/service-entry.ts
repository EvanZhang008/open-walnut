/**
 * What the launcher's `<exe> --service` runs (src/binary/main.ts): the session daemon, as every
 * host had, or the host's one Walnut service, in one of two roles:
 *   serve  the follower server of one Walnut holding the daemon runtime in its own process
 *          (experiment in_process_daemon, the leader's switch per host);
 *   lead   the leader server on this machine's own data dir, the runtime in its process (the
 *          leader switch made this machine the leader; the server's boot still asks the
 *          switch's records whether it may lead, and turns standby when refused).
 *
 * One small file decides: `<install root>/service-mode.json` (service-mode.ts: its format, its
 * writers). It names the version it was written for: a launcher that puts an older version back
 * runs that one as a daemon again, and an older binary never reads the file at all, so a rollback
 * is two programs with no extra step.
 *
 * The follower is the one the daemon would have started for that home, from the same spec
 * (`<install root>/host-server/server-<key>.json`, host-server-core.ts) and its token; nothing
 * else configures it. Any doubt (no file, unreadable, another version, no spec, a spec that is
 * not the replica program, a fallback running, a leader role that did not get ready last time)
 * answers `daemon`, with the reason.
 *
 * Reads only node:fs and node:path: main.ts asks it before anything else is imported, since the
 * server's modules read their env (the data dir, the run dir) once, at import.
 */
import fs from 'node:fs'
import path from 'node:path'
import { absolute, followerSpecsFor, followerSpecsOfWalnut, readServiceMode, readServiceRoleFallback, serviceRoleOf, type FsLike, type ServiceMode } from './service-mode.js'

interface ServiceRun {
  /** The server's whole env (never the runtime's state dir). */
  serverEnv: Record<string, string>
  /** The daemon runtime's env: what the launcher exported for the daemon, as a daemon program got it. */
  runtimeEnv: Record<string, string>
  /** The runtime's daemon dir and state dir (the install root), and the server's cwd (its data dir). */
  runtimeDir: string
  stateDir: string
  cwd: string
}

export type ServiceEntryDecision =
  | { kind: 'daemon'; why: string; quiet?: true }
  | ({
    kind: 'serve'
    /** The Walnut this service follows (the leader's data dir). */
    home: string
    /** The follower spec it runs, and the pid file of the follower child an older daemon started from it. */
    specFile: string
    pidFile: string
  } & ServiceRun)
  | ({
    kind: 'lead'
    /** This machine's data dir that leads. */
    home: string
    /** The version the mode names (this file): what a fallback marker is for. */
    exe: string
    /** The Walnut it leads (the mode's walnutId): no follower of it runs here meanwhile. */
    walnutId?: string
    /** The server's port when WALNUT_SERVICE_LEAD_PORT names one; else the server's own default (3456). */
    port?: number
    /** The pid files of the followers of this Walnut an older daemon may have started here: stopped first. */
    followerPidFiles: string[]
  } & ServiceRun)

/** The launcher's env vars that belong to the daemon runtime only, never to the server. */
const RUNTIME_ONLY = ['WALNUT_DAEMON_STATE_DIR', 'WALNUT_DAEMON_SUPERVISOR']
/** Another port for a leading service than the server's default (a second Walnut on the machine, a test). */
export const LEAD_PORT_ENV = 'WALNUT_SERVICE_LEAD_PORT'
/**
 * What would make the leader server a follower (server-role.ts resolveServerRole): never in a leading
 * service's env. The placement key is not here: only a follower spec's env sets it (host-server/manager.ts),
 * and a leading service never reads that spec's env.
 */
const FOLLOWER_ONLY = ['WALNUT_ROLE', 'WALNUT_HOST_SERVER', 'WALNUT_FOLLOWER_TOKEN', 'WALNUT_HOST_DAEMON_DIR']

function same(a: string, b: string, f: FsLike): boolean {
  if (path.resolve(a) === path.resolve(b)) return true
  try { return f.realpathSync(a) === f.realpathSync(b) } catch { return false }
}

/** The launcher's env as strings, and the runtime's: the same minus the launcher's marks, which are the server's to write. */
function launcherEnvs(env: NodeJS.ProcessEnv): { launcher: Record<string, string>; runtimeEnv: Record<string, string> } {
  const launcher: Record<string, string> = {}
  for (const [k, v] of Object.entries(env)) if (typeof v === 'string') launcher[k] = v
  const runtimeEnv = { ...launcher }
  // serve-launcher-beat.ts writes them: no session inherits them.
  delete runtimeEnv.WALNUT_LAUNCHER_DIR
  return { launcher, runtimeEnv }
}

/**
 * The decision for this `--service` start. `env` is the launcher's (WALNUT_DAEMON_DIR,
 * WALNUT_DAEMON_STATE_DIR = the install root, WALNUT_LAUNCHER_DIR), `execPath` this file.
 */
export function decideServiceEntry(env: NodeJS.ProcessEnv, execPath: string, f: FsLike = fs): ServiceEntryDecision {
  const stateDir = env.WALNUT_DAEMON_STATE_DIR ?? ''
  const runtimeDir = env.WALNUT_DAEMON_DIR ?? ''
  if (!absolute(stateDir)) return { kind: 'daemon', why: 'no absolute WALNUT_DAEMON_STATE_DIR', quiet: true }
  const read = readServiceMode(stateDir, f)
  if (!('mode' in read)) return { kind: 'daemon', why: read.why, ...(read.missing ? { quiet: true as const } : {}) }
  const { mode } = read
  if (!absolute(runtimeDir)) return { kind: 'daemon', why: 'no absolute WALNUT_DAEMON_DIR' }
  if (!absolute(env.WALNUT_LAUNCHER_DIR)) return { kind: 'daemon', why: 'not started by the service launcher (no WALNUT_LAUNCHER_DIR)' }
  if (!same(mode.exe, execPath, f)) return { kind: 'daemon', why: `service-mode.json is for ${mode.exe}, this is ${execPath}` }
  const role = serviceRoleOf(mode)
  const fallback = readServiceRoleFallback(stateDir, f)
  if (fallback && fallback.role === role && fallback.home === mode.home && same(fallback.exe, mode.exe, f)) {
    return { kind: 'daemon', why: `the ${role} role did not get ready in time at ${new Date(fallback.at).toISOString()}; the next mode write or version tries it again` }
  }
  if (role === 'leader') return decideLead(env, mode, runtimeDir, stateDir, f)

  const found = followerSpecsFor(stateDir, mode.home, f)
  if (!Array.isArray(found)) return { kind: 'daemon', why: found.why }
  if (found.length !== 1) return { kind: 'daemon', why: found.length ? `${found.length} follower specs name ${mode.home}` : `no follower spec for ${mode.home}` }
  const { file, saved } = found[0]!
  const spec = saved.spec!
  const specEnv = spec.env && typeof spec.env === 'object' ? spec.env as Record<string, unknown> : {}
  const str = (k: string): string => (typeof specEnv[k] === 'string' ? specEnv[k] as string : '')
  if (typeof saved.token !== 'string' || saved.token.length < 32) return { kind: 'daemon', why: 'the follower spec has no token' }
  if (saved.fallback) return { kind: 'daemon', why: 'the follower runs its fallback program (it crash-looped)' }
  if (str('WALNUT_ROLE') !== 'replica') return { kind: 'daemon', why: 'the follower spec is not the replica program' }
  if (!absolute(str('OPEN_WALNUT_HOME')) || !absolute(str('WALNUT_DAEMON_DIR'))) return { kind: 'daemon', why: 'the follower spec names no data dir and run dir of its own' }
  if (same(str('WALNUT_DAEMON_DIR'), runtimeDir, f)) return { kind: 'daemon', why: 'the follower run dir is the daemon dir' }
  if (!absolute(spec.cwd)) return { kind: 'daemon', why: 'the follower spec has no cwd' }
  for (const [k, v] of Object.entries(specEnv)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k) || typeof v !== 'string') return { kind: 'daemon', why: `the follower spec's env ${k} is not a string` }
  }

  const { launcher, runtimeEnv } = launcherEnvs(env)
  const serverEnv: Record<string, string> = {
    ...launcher, ...(specEnv as Record<string, string>),
    // As the daemon's supervisor starts the follower (host-server-core.ts start, baseEnv).
    WALNUT_FOLLOWER_TOKEN: saved.token, WALNUT_HOST_DAEMON_DIR: runtimeDir, WALNUT_NO_AUTO_UPDATE: '1',
  }
  for (const k of RUNTIME_ONLY) delete serverEnv[k]
  return {
    kind: 'serve', home: mode.home, specFile: file, pidFile: file.replace(/\.json$/, '.pid'),
    serverEnv, runtimeEnv, runtimeDir, stateDir, cwd: spec.cwd,
  }
}

/**
 * The leader on `home`: the launcher's env with this data dir, and nothing that makes a follower.
 * No follower spec is needed, and no follower of this Walnut runs here while it leads (the runtime's
 * supervisor is told, host-server-core.ts `leads`). Its versions
 * come from the launcher (walnut daemon update), never from the server's own update install.
 */
function decideLead(env: NodeJS.ProcessEnv, mode: ServiceMode, runtimeDir: string, stateDir: string, f: FsLike): ServiceEntryDecision {
  const { home, exe, walnutId } = mode
  let dir = false
  try { dir = absolute(home) && f.statSync(home).isDirectory() } catch { /* missing */ }
  if (!dir) return { kind: 'daemon', why: `the leader's data dir ${home} is not a directory` }
  const { launcher, runtimeEnv } = launcherEnvs(env)
  const port = Number(env[LEAD_PORT_ENV])
  const serverEnv: Record<string, string> = { ...launcher, OPEN_WALNUT_HOME: home, WALNUT_NO_AUTO_UPDATE: '1', WALNUT_LAUNCHER_UPDATES: '1' }
  for (const k of [...RUNTIME_ONLY, ...FOLLOWER_ONLY]) delete serverEnv[k]
  const followerPidFiles = walnutId ? followerSpecsOfWalnut(stateDir, walnutId, f).map((s) => s.file.replace(/\.json$/, '.pid')) : []
  return { kind: 'lead', home, exe, ...(walnutId ? { walnutId } : {}), ...(Number.isInteger(port) && port > 0 && port < 65536 ? { port } : {}), followerPidFiles, serverEnv, runtimeEnv, runtimeDir, stateDir, cwd: home }
}

type ServeDecision = Extract<ServiceEntryDecision, { kind: 'serve' }>
type LeadDecision = Extract<ServiceEntryDecision, { kind: 'lead' }>

/** Whether `<runtime dir>/daemon.standin` names `pid` (an update's stand-in daemon, which hands the dir back). */
function standInIs(runtimeDir: string, pid: number): boolean {
  try { return Number(fs.readFileSync(path.join(runtimeDir, 'daemon.standin'), 'utf8').trim()) === pid } catch { return false }
}

/**
 * The follower's env with the runtime tree this process already unpacked (main.ts unpacks it before
 * anything else, under the launcher's env). A program this service starts from its own file (the
 * search embed worker, an ACP adapter shipped as a file) finds its script in its own tree: with the
 * follower's OPEN_WALNUT_HOME alone it looked under the follower's data dir, the script the service
 * named was outside it, and the file answered "Unknown command" (2026-11-22 on a real host: the
 * search replica's semantic lane was turned off). WALNUT_RUNTIME_DIR decides the place alone
 * (runtime-tree.ts runtimeRootsFor).
 */
export function pinRuntimePlace(serverEnv: Record<string, string>, runtimeRoot: string): Record<string, string> {
  return { ...serverEnv, WALNUT_RUNTIME_DIR: path.dirname(runtimeRoot) }
}

/**
 * Ends this service the planned way, as the daemon program's trial does (runDaemonProcess): asked to
 * stop (the server's SIGTERM handler runs its stopServer), and 15 s later at the latest.
 */
export function endServicePlanned(): void {
  setTimeout(() => process.exit(1), 15_000).unref()
  process.kill(process.pid, 'SIGTERM')
}

/**
 * What both roles do before the server loads: this process takes the server's env (its modules read
 * it once, at import) and its cwd, a trial gets its lifetime, and a daemon that still holds the
 * runtime dir ends this start. False when it ended it (exitCode 1).
 */
async function enterService(d: ServeDecision | LeadDecision, runtimeRoot: string | undefined): Promise<boolean> {
  const serverEnv = runtimeRoot ? pinRuntimePlace(d.serverEnv, runtimeRoot) : d.serverEnv
  for (const key of Object.keys(process.env)) if (!(key in serverEnv)) delete process.env[key]
  Object.assign(process.env, serverEnv)
  fs.mkdirSync(d.cwd, { recursive: true, mode: 0o700 })
  process.chdir(d.cwd)
  // A trial (daemon-boot-proof.ts) ends by itself, as the daemon program's does.
  const lifetime = parseInt(process.env.WALNUT_DAEMON_LIFETIME_SECONDS || '', 10)
  if (Number.isFinite(lifetime) && lifetime > 0) setTimeout(endServicePlanned, lifetime * 1000).unref()
  // Imports no module that reads the runtime fact at import (local-daemon.ts DEFAULT_DAEMON_DIR
  // reads serviceRuntime()): holdServiceRuntime has not run yet.
  const { readDaemonInstanceOwner } = await import('../providers/daemon-instance-lock.js')
  // A daemon that still holds the runtime dir makes the runtime refuse this service ("service
  // handover is required"): leave what it keeps alone and end as the runtime would, never stop it
  // first (review A3b S34-L2: each launcher restart stopped its follower, and its daemon started it
  // again). A stand-in (daemon.standin names it) is waited out by the runtime: go on.
  const uid = typeof process.getuid === 'function' ? process.getuid() : -1
  const owner = uid >= 0 ? await readDaemonInstanceOwner({ runtimeDir: d.runtimeDir, uid }) : null
  if (owner && owner.pid !== process.pid && !standInIs(d.runtimeDir, owner.pid)) {
    // The words in-process-daemon.ts says for a second service, so both refusals read alike.
    const who = owner.service ? `Another Walnut service (pid ${owner.pid}) runs the session daemon of ${d.runtimeDir}: one service per machine and data dir` : `daemon ${owner.pid} still holds ${d.runtimeDir}`
    process.stderr.write(`walnut --service: ${who}${d.kind === 'serve' ? '; its follower is left running' : ''}\n`)
    process.exitCode = 1
    return false
  }
  return true
}

/** The server of either role, holding the daemon runtime in this process. */
async function serveWithRuntime(d: ServeDecision | LeadDecision, loadRuntime: () => Promise<unknown>): Promise<void> {
  const [{ holdServiceRuntime }, { provideDaemonRuntime }] = await Promise.all([
    import('../core/server-role.js'), import('../providers/in-process-daemon.js'),
  ])
  holdServiceRuntime({ dir: d.runtimeDir, home: d.home, env: d.runtimeEnv, ...(d.kind === 'lead' && d.walnutId ? { leads: d.walnutId } : {}) })
  provideDaemonRuntime(loadRuntime as Parameters<typeof provideDaemonRuntime>[0])
  const { runWeb } = await import('../commands/web.js')
  await runWeb(d.kind === 'serve' ? { replica: true } : { replica: false, ...(d.port ? { port: String(d.port) } : {}) })
}

/** Deps of stopOldFollowers (tests hand their own). */
export interface StopFollowerDeps {
  startTimeOf?: (pid: number) => string | null
  killGroup?: (pid: number, signal: 'SIGTERM' | 'SIGKILL') => void
  exists?: (pid: number) => boolean
  unknownRetryMs?: number
}

/**
 * Stops the follower children an older daemon started from these specs (their pid files): they hold
 * the data dir's lock and the port, or run on unmanaged. False when one did not stop, or may still
 * run (its start time did not read): its pid file is kept and this start ends.
 */
export async function stopOldFollowers(pidFiles: string[], deps: StopFollowerDeps = {}): Promise<boolean> {
  if (pidFiles.length === 0) return true
  const [{ stopRecordedServer }, { defaultReadStartTime }] = await Promise.all([
    import('../providers/host-server-core.js'), import('../providers/daemon-core.js'),
  ])
  for (const pidFile of pidFiles) {
    const stopped = await stopRecordedServer({
      pidFile, fs,
      startTimeOf: deps.startTimeOf ?? ((pid) => defaultReadStartTime(fs, pid)),
      killGroup: deps.killGroup ?? ((pid, signal) => { if (pid > 1) process.kill(-pid, signal) }),
      ...(deps.exists ? { exists: deps.exists } : {}),
      ...(deps.unknownRetryMs !== undefined ? { unknownRetryMs: deps.unknownRetryMs } : {}),
    })
    if (stopped !== 'none') {
      const what = stopped === 'stays' ? 'did not stop' : stopped === 'unknown' ? 'may still run (its start time did not read); its pid file is kept' : 'was stopped'
      process.stderr.write(`walnut --service: the follower an older daemon started ${what}\n`)
    }
    if (stopped === 'stays' || stopped === 'unknown') return false
  }
  return true
}

/**
 * Runs the host's one Walnut service as the follower (main.ts, after decideServiceEntry said `serve`):
 * the follower server `walnut web --replica` runs (runWeb, one entry for both), holding the daemon
 * runtime in this process (in-process-daemon.ts, its door open for every leader and walnut-net).
 * `loadRuntime` is the runtime module the compiled file carries (main.ts imports it; tsc never
 * follows it from here).
 */
export async function runHostService(d: ServeDecision, loadRuntime: () => Promise<unknown>, runtimeRoot?: string): Promise<void> {
  if (!(await enterService(d, runtimeRoot))) return
  if (!(await stopOldFollowers([d.pidFile]))) { process.exitCode = 1; return }
  // Not ready in time, or never ready in its last starts (a crash at boot): the marker, and the next
  // start runs the daemon, which starts the follower as its child (service-lead-ready.ts).
  const { armRoleReady } = await import('./service-lead-ready.js')
  let serving = false, left = false
  armRoleReady({ role: 'replica', home: d.home, exe: process.execPath, stateDir: d.stateDir, serverEnv: d.serverEnv }, {
    // Before the server loads there is nothing to stop: this start just ends.
    leave: () => { if (serving) endServicePlanned(); else left = true },
  })
  if (left) { process.exitCode = 1; return }
  serving = true
  await serveWithRuntime(d, loadRuntime)
}

/**
 * Runs this machine's leader as its one Walnut service (main.ts, after decideServiceEntry said
 * `lead`): the leader server `walnut serve` runs (runWeb), the daemon runtime in this process. The
 * entry never asks for the leader permit: the server does at boot (server.ts leaderPermitAtBoot)
 * and turns standby itself when refused. A SIGTERM is the server's own planned stop (web.ts
 * shutdown, its release record included), bounded by SHUTDOWN_BAIL_MS, well inside the launcher's
 * STOP_WAIT_SECONDS. Not ready in time (service-lead-ready.ts): the fallback marker, and the next
 * start runs the daemon.
 */
export async function runLeaderService(d: LeadDecision, loadRuntime: () => Promise<unknown>, runtimeRoot?: string): Promise<void> {
  if (!(await enterService(d, runtimeRoot))) return
  // A follower of this Walnut an older daemon started here (the machine went from the daemon to
  // leading) would run on unmanaged beside the leader: it ends first, or this start does.
  if (!(await stopOldFollowers(d.followerPidFiles))) { process.exitCode = 1; return }
  const { armLeadReady } = await import('./service-lead-ready.js')
  armLeadReady(d, { leave: endServicePlanned })
  await serveWithRuntime(d, loadRuntime)
}
