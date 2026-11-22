/**
 * What the launcher's `<exe> --service` runs (src/binary/main.ts): the session daemon, as every
 * host had, or the host's one Walnut service: the follower server of one Walnut holding the
 * daemon runtime in its own process (experiment in_process_daemon, the leader's switch per host).
 *
 * One small file decides: `<install root>/service-mode.json` (`{ v: 1, home, exe }`), written and
 * removed only by `walnut daemon install|update` on the owner leader's word (`--serve <home>`,
 * `--no-serve <home>`). It names the version it was written for: a launcher that puts an older
 * version back runs that one as a daemon again, and an older binary never reads the file at all,
 * so a rollback is two programs with no extra step.
 *
 * The service is the follower the daemon would have started for that home, from the same spec
 * (`<install root>/host-server/server-<key>.json`, host-server-core.ts) and its token; nothing
 * else configures it. Any doubt (no file, unreadable, another version, no spec, a spec that is
 * not the replica program, a fallback running) answers `daemon`, with the reason.
 *
 * Reads only node:fs and node:path: main.ts asks it before anything else is imported, since the
 * server's modules read their env (the data dir, the run dir) once, at import.
 */
import fs from 'node:fs'
import path from 'node:path'

export const SERVICE_MODE_FILE = 'service-mode.json'
const HOST_SERVER_DIR = 'host-server'

export interface ServiceMode { v: 1; home: string; exe: string }

export type ServiceEntryDecision =
  | { kind: 'daemon'; why: string; quiet?: true }
  | {
    kind: 'serve'
    /** The Walnut this service follows (the leader's data dir). */
    home: string
    /** The follower spec it runs, and the pid file of the follower child an older daemon started from it. */
    specFile: string
    pidFile: string
    /** The server's whole env: the launcher's, the spec's, the token; never the runtime's state dir. */
    serverEnv: Record<string, string>
    /** The daemon runtime's env: what the launcher exported for the daemon, as a daemon program got it. */
    runtimeEnv: Record<string, string>
    /** The runtime's daemon dir and state dir, and the server's cwd (its data dir). */
    runtimeDir: string
    stateDir: string
    cwd: string
  }

interface FsLike {
  readFileSync(file: string, encoding: 'utf8'): string
  readdirSync(dir: string): string[]
  realpathSync(file: string): string
}

/** The launcher's env vars that belong to the daemon runtime only, never to the server. */
const RUNTIME_ONLY = ['WALNUT_DAEMON_STATE_DIR', 'WALNUT_DAEMON_SUPERVISOR']

function same(a: string, b: string, f: FsLike): boolean {
  if (path.resolve(a) === path.resolve(b)) return true
  try { return f.realpathSync(a) === f.realpathSync(b) } catch { return false }
}

function absolute(v: unknown): v is string {
  return typeof v === 'string' && v.startsWith('/') && v.length <= 1024
}

/** The mode file, or null with why. */
export function readServiceMode(stateDir: string, f: FsLike = fs): { mode: ServiceMode } | { why: string; missing?: true } {
  let text: string
  try { text = f.readFileSync(path.join(stateDir, SERVICE_MODE_FILE), 'utf8') } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ENOENT' ? { why: 'no service-mode.json', missing: true } : { why: `service-mode.json unreadable: ${(err as Error).message}` }
  }
  let raw: Partial<ServiceMode> | null
  try { raw = JSON.parse(text) as Partial<ServiceMode> } catch { return { why: 'service-mode.json is not JSON' } }
  if (!raw || raw.v !== 1 || typeof raw.home !== 'string' || !raw.home || !absolute(raw.exe)) return { why: 'service-mode.json is not a v1 mode with a home and an exe' }
  return { mode: { v: 1, home: raw.home, exe: raw.exe } }
}

/** Writes the mode (temp file, rename; 0600), or removes it with null. */
export function writeServiceMode(stateDir: string, mode: ServiceMode | null): void {
  const file = path.join(stateDir, SERVICE_MODE_FILE)
  if (!mode) { fs.rmSync(file, { force: true }); return }
  const tmp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(mode) + '\n', { mode: 0o600 })
  fs.renameSync(tmp, file)
}

/**
 * The mode the version just staged runs with (service-mode.json, service-entry.ts), written before
 * the switch starts it: it names that version, so a version the launcher puts back runs as the
 * daemon. Only the Walnut whose home the file names may change it; any other update (no flag, an
 * older leader, another Walnut) carries the mode over to the new version. A note when refused.
 */
export function nextServiceMode(current: ServiceMode | null, ask: { home: string; on: boolean } | undefined, exe: string): { mode: ServiceMode | null; note?: string } {
  if (current && ask && ask.home !== current.home) {
    return { mode: { ...current, exe }, note: `not_service_owner: the service here follows ${current.home}; the mode stays as it is` }
  }
  if (ask) return { mode: ask.on ? { v: 1, home: ask.home, exe } : null }
  return { mode: current ? { ...current, exe } : null }
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
  const dir = path.join(stateDir, HOST_SERVER_DIR)
  let names: string[]
  try { names = f.readdirSync(dir) } catch { return { kind: 'daemon', why: `no follower spec dir ${dir}` } }
  const found: Array<{ file: string; saved: { spec?: Record<string, unknown>; token?: unknown; fallback?: unknown } }> = []
  for (const name of names) {
    if (!/^server-[A-Za-z0-9_-]+\.json$/.test(name)) continue
    const file = path.join(dir, name)
    try {
      const saved = JSON.parse(f.readFileSync(file, 'utf8')) as { spec?: Record<string, unknown> }
      if (saved?.spec?.home === mode.home) found.push({ file, saved })
    } catch { /* another Walnut's, or broken: not this one's */ }
  }
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

  const launcher: Record<string, string> = {}
  for (const [k, v] of Object.entries(env)) if (typeof v === 'string') launcher[k] = v
  const runtimeEnv = { ...launcher }
  // The launcher's marks are the server's to write (serve-launcher-beat.ts): no session inherits them.
  delete runtimeEnv.WALNUT_LAUNCHER_DIR
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

type ServeDecision = Extract<ServiceEntryDecision, { kind: 'serve' }>

/** Whether `<runtime dir>/daemon.standin` names `pid` (an update's stand-in daemon, which hands the dir back). */
function standInIs(runtimeDir: string, pid: number): boolean {
  try { return Number(fs.readFileSync(path.join(runtimeDir, 'daemon.standin'), 'utf8').trim()) === pid } catch { return false }
}

/**
 * Runs the host's one Walnut service (main.ts, after decideServiceEntry said `serve`): the follower
 * server `walnut web --replica` runs (runWeb, one entry for both), holding the daemon runtime in this
 * process (in-process-daemon.ts, its door open for every leader and walnut-net). `loadRuntime` is the
 * runtime module the compiled file carries (main.ts imports it; tsc never follows it from here).
 */
export async function runHostService(d: ServeDecision, loadRuntime: () => Promise<unknown>): Promise<void> {
  // The server's modules read their env once, at import: the follower's env first, then them.
  for (const key of Object.keys(process.env)) if (!(key in d.serverEnv)) delete process.env[key]
  Object.assign(process.env, d.serverEnv)
  fs.mkdirSync(d.cwd, { recursive: true, mode: 0o700 })
  process.chdir(d.cwd)
  // A trial (daemon-boot-proof.ts) ends by itself, as the daemon program's does (runDaemonProcess):
  // asked to stop the normal way, and 15 s later at the latest.
  const lifetime = parseInt(process.env.WALNUT_DAEMON_LIFETIME_SECONDS || '', 10)
  if (Number.isFinite(lifetime) && lifetime > 0) {
    setTimeout(() => { setTimeout(() => process.exit(1), 15_000).unref(); process.kill(process.pid, 'SIGTERM') }, lifetime * 1000).unref()
  }
  // These three import no module that reads the runtime fact at import (local-daemon.ts
  // DEFAULT_DAEMON_DIR reads serviceRuntime()): holdServiceRuntime has not run yet.
  const [{ stopRecordedServer }, { defaultReadStartTime }, { readDaemonInstanceOwner }] = await Promise.all([
    import('../providers/host-server-core.js'), import('../providers/daemon-core.js'), import('../providers/daemon-instance-lock.js'),
  ])
  // A daemon that still holds the runtime dir makes the runtime refuse this service ("service
  // handover is required"): leave the follower it keeps alone and end as the runtime would, never
  // stop it first (review A3b S34-L2: each launcher restart stopped it, and its daemon started it
  // again). A stand-in (daemon.standin names it) is waited out by the runtime: go on.
  const uid = typeof process.getuid === 'function' ? process.getuid() : -1
  const owner = uid >= 0 ? await readDaemonInstanceOwner({ runtimeDir: d.runtimeDir, uid }) : null
  if (owner && owner.pid !== process.pid && !standInIs(d.runtimeDir, owner.pid)) {
    // The words in-process-daemon.ts says for a second service, so both refusals read alike.
    const who = owner.service ? `Another Walnut service (pid ${owner.pid}) runs the session daemon of ${d.runtimeDir}: one service per machine and data dir` : `daemon ${owner.pid} still holds ${d.runtimeDir}`
    process.stderr.write(`walnut --service: ${who}; its follower is left running\n`)
    process.exitCode = 1
    return
  }
  // The follower child an older daemon started from this spec still holds the data dir's lock and the port.
  const stopped = await stopRecordedServer({
    pidFile: d.pidFile, fs,
    startTimeOf: (pid) => defaultReadStartTime(fs, pid),
    killGroup: (pid, signal) => { if (pid > 1) process.kill(-pid, signal) },
  })
  if (stopped !== 'none') {
    const what = stopped === 'stays' ? 'did not stop' : stopped === 'unknown' ? 'may still run (its start time did not read); its pid file is kept' : 'was stopped'
    process.stderr.write(`walnut --service: the follower an older daemon started ${what}\n`)
  }
  if (stopped === 'stays' || stopped === 'unknown') { process.exitCode = 1; return }
  const [{ holdServiceRuntime }, { provideDaemonRuntime }] = await Promise.all([
    import('../core/server-role.js'), import('../providers/in-process-daemon.js'),
  ])
  holdServiceRuntime({ dir: d.runtimeDir, home: d.home, env: d.runtimeEnv })
  provideDaemonRuntime(loadRuntime as Parameters<typeof provideDaemonRuntime>[0])
  const { runWeb } = await import('../commands/web.js')
  await runWeb({ replica: true })
}
