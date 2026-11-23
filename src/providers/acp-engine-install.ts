/**
 * An engine CLI's official installer on THIS host (`curl -fsSL <url> | bash`), for
 * acp-engine-sign-in.ts (`engine.signIn` op install / installStatus).
 *
 * The install outlives the daemon that started it: it runs detached, its output goes to a
 * file (never a pipe the daemon holds, which a restart would cut and the installer would die
 * of SIGPIPE), and its shell writes its exit code to a second file. Its start is kept in
 * `<stateDir>/engine-install/<engine>.json`, so a daemon after a restart reads the same
 * install: running while its pid lives, then done or failed from the exit file and whether
 * the CLI is there now. One install per engine at a time; past its deadline it is stopped,
 * by whichever daemon reads it then.
 *
 * Only Walnut's own fixed argv runs: the URL is the script's `$1`, never its text.
 * Compiled into acp-daemon.ts, which the daemon bundles; node builtins only.
 */
import fs from 'node:fs'
import path from 'node:path'
import type { ChildProcess, SpawnOptions } from 'node:child_process'

export type InstallState = { state: 'idle' | 'running' | 'done' | 'failed'; startedAt?: number; endedAt?: number; installed?: boolean; version?: string | null; path?: string; exitCode?: number | null; log?: string; error?: string }

export interface InstallSpec { binary: string; overrideEnv: string; installerUrl: string }

export interface EngineInstallDeps {
  spawn: (cmd: string, args: string[], opts: SpawnOptions) => ChildProcess
  findBinary: (spec: Pick<InstallSpec, 'binary' | 'overrideEnv'>, env: NodeJS.ProcessEnv) => { path?: string; reason?: string }
  version: (binary: string, env: NodeJS.ProcessEnv) => Promise<string | null>
  /** Where the install's record, output and exit code live (the daemon's own dir). */
  stateDir: string
  waitMs: number
  onInstalled?: () => void
  log?: (level: string, msg: string, data?: Record<string, unknown>) => void
  now?: () => number
  /** Whether a pid runs (default: signal 0). */
  pidAlive?: (pid: number) => boolean
}

const LOG_TAIL = 4096
const SCRIPT = 'set -o pipefail; curl -fsSL "$1" | bash; code=$?; echo "$code" > "$2"; exit "$code"'

function bashOf(env: NodeJS.ProcessEnv): string | null {
  for (const dir of [...String(env.PATH ?? '').split(path.delimiter), '/bin', '/usr/bin', '/usr/local/bin', '/opt/homebrew/bin']) {
    if (!dir || !path.isAbsolute(dir)) continue
    const p = path.join(dir, 'bash')
    try { fs.accessSync(p, fs.constants.X_OK); return p } catch { /* next */ }
  }
  return null
}

function cwdOf(env: NodeJS.ProcessEnv): string | undefined {
  try { return env.HOME && fs.statSync(env.HOME).isDirectory() ? env.HOME : undefined } catch { return undefined }
}

function tailOf(file: string): string {
  try {
    const size = fs.statSync(file).size
    const fd = fs.openSync(file, 'r')
    try {
      const len = Math.min(size, LOG_TAIL)
      const buf = Buffer.alloc(len)
      fs.readSync(fd, buf, 0, len, size - len)
      return buf.toString('utf8')
    } finally { fs.closeSync(fd) }
  } catch { return '' }
}

/** A process group's signal, never pid 1 or below (-1 is every process this user may signal). */
function killGroup(pid: number, signal: NodeJS.Signals): void {
  if (!Number.isInteger(pid) || pid <= 1) return
  try { process.kill(-pid, signal) } catch { /* gone */ }
}

export function createEngineInstaller(deps: EngineInstallDeps) {
  const now = deps.now ?? Date.now
  const log = deps.log ?? (() => {})
  const pidAlive = deps.pidAlive ?? ((pid: number) => { if (pid <= 1) return false; try { process.kill(pid, 0); return true } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM' } })
  const dir = path.join(deps.stateDir, 'engine-install')
  const files = (engine: string) => ({ record: path.join(dir, `${engine}.json`), log: path.join(dir, `${engine}.log`), exit: path.join(dir, `${engine}.exit`) })
  /** Ended installs this daemon already settled (with the version read), by engine. */
  const settled = new Map<string, InstallState>()

  function readRecord(engine: string): { pid: number; startedAt: number } | null {
    try {
      const r = JSON.parse(fs.readFileSync(files(engine).record, 'utf8')) as { pid?: unknown; startedAt?: unknown }
      return typeof r.pid === 'number' && typeof r.startedAt === 'number' ? { pid: r.pid, startedAt: r.startedAt } : null
    } catch { return null }
  }

  function exitCodeOf(engine: string): number | null {
    try {
      const n = Number(fs.readFileSync(files(engine).exit, 'utf8').trim())
      return Number.isInteger(n) ? n : null
    } catch { return null }
  }

  /** How the engine's install goes, from its files (any daemon's): idle when none ever ran here. */
  async function status(engine: string, spec: InstallSpec, env: NodeJS.ProcessEnv): Promise<InstallState> {
    const rec = readRecord(engine)
    if (!rec) return { state: 'idle' }
    const f = files(engine)
    const code = exitCodeOf(engine)
    if (code === null && pidAlive(rec.pid)) {
      if (now() - rec.startedAt > deps.waitMs) {
        killGroup(rec.pid, 'SIGTERM')
        setTimeout(() => killGroup(rec.pid, 'SIGKILL'), 2_000).unref?.()
        return finished(engine, spec, env, rec.startedAt, null, 'the installer did not finish in time')
      }
      return { state: 'running', startedAt: rec.startedAt, log: tailOf(f.log) }
    }
    const hit = settled.get(engine)
    if (hit && hit.startedAt === rec.startedAt) return hit
    return finished(engine, spec, env, rec.startedAt, code, code === null ? 'the installer stopped before it said how it ended' : undefined)
  }

  async function finished(engine: string, spec: InstallSpec, env: NodeJS.ProcessEnv, startedAt: number, code: number | null, why?: string): Promise<InstallState> {
    deps.onInstalled?.()
    const found = deps.findBinary(spec, env)
    const version = found.path ? await deps.version(found.path, env).catch(() => null) : null
    const state: InstallState = {
      state: found.path ? 'done' : 'failed', startedAt, endedAt: now(), exitCode: code, log: tailOf(files(engine).log), installed: !!found.path, version,
      ...(found.path ? { path: found.path } : { error: why ?? `the installer ended (exit ${code}) and ${found.reason ?? 'the CLI is still missing'}` }),
    }
    if (!settled.get(engine) || settled.get(engine)!.startedAt !== startedAt) log('info', 'engine install ended', { engine, exitCode: code, installed: !!found.path })
    settled.set(engine, state)
    return state
  }

  async function running(engine: string, spec: InstallSpec, env: NodeJS.ProcessEnv): Promise<boolean> {
    return (await status(engine, spec, env)).state === 'running'
  }

  /** Starts the installer; refused where the CLI is already there, the same install when one runs. */
  async function install(engine: string, spec: InstallSpec, env: NodeJS.ProcessEnv): Promise<{ ok: true } & InstallState | { ok: false; code: string; message: string }> {
    const now0 = await status(engine, spec, env)
    if (now0.state === 'running') return { ok: true, ...now0 }
    const found = deps.findBinary(spec, env)
    if (found.path) return { ok: false, code: 'installed', message: `already installed at ${found.path}` }
    const bash = bashOf(env)
    if (!bash) return { ok: false, code: 'no_bash', message: 'this host has no bash to run the installer' }
    const f = files(engine)
    let fd: number
    try {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
      fs.rmSync(f.exit, { force: true })
      fd = fs.openSync(f.log, 'w', 0o600)
    } catch (err) {
      return { ok: false, code: 'failed', message: `could not keep the installer's output in ${dir}: ${(err as Error).message}` }
    }
    const startedAt = now()
    let proc: ChildProcess
    try {
      proc = deps.spawn(bash, ['-c', SCRIPT, 'walnut-install', spec.installerUrl, f.exit], { env, cwd: cwdOf(env), detached: true, stdio: ['ignore', fd, fd] })
    } catch (err) {
      fs.closeSync(fd)
      return { ok: false, code: 'failed', message: `the installer could not start: ${(err as Error).message}` }
    }
    // The child holds its own copy of the log.
    try { fs.closeSync(fd) } catch { /* closed */ }
    if (!proc.pid) return { ok: false, code: 'failed', message: 'the installer did not start' }
    fs.writeFileSync(f.record, JSON.stringify({ pid: proc.pid, startedAt }), { mode: 0o600 })
    settled.delete(engine)
    proc.on('error', () => { /* its exit file says how it ended */ })
    proc.unref()
    log('info', 'engine install started', { engine, pid: proc.pid })
    return { ok: true, state: 'running', startedAt }
  }

  return { install, status, running }
}
