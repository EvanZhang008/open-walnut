/**
 * Default probes for the doctor's LOCAL half: this machine's claude, PATHs,
 * compiler, dtach and SQLite. Every one reuses an existing probe rather than
 * re-deriving it:
 *   - claude (with sign-in and version floor): the daemon's own `host.preflight`
 *     (createHostRuntime + createClaudeCheck). The server asks the local daemon
 *     first (host-probes.ts localDaemonPreflight); this in-process run is the
 *     fallback, with the PATH a local session starts with (buildDaemonPath:
 *     login-shell PATH, the daemon fallbacks, then inherited).
 *   - compiler and dtach: the runtime's resolveOnPath on that PATH, separately,
 *     so they stay right when the claude preflight runs out of time.
 *   - the login-shell PATH: the runtime's own script and parser. The daemon
 *     captures it with execFileSync, which would freeze the server's event loop
 *     for up to 5s, so this file runs the same script through async execFile.
 *
 * Every child goes through `trackedExecFile`, so the CLI can end the ones a
 * deadline left running (`killLeftoverProbes`) and exit at once. Nothing here
 * reads a credential or returns an environment variable's value other than
 * PATH and SHELL, and nothing writes: the CLI reads config.yaml read-only.
 */

import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { execFile, type ChildProcess } from 'node:child_process'
import { createRequire } from 'node:module'
import {
  buildDaemonPath,
  createHostRuntime,
  defaultDaemonExtraPaths,
  type HostPreflightResult,
  type HostRuntimeDeps,
} from '../../providers/host-runtime-core.js'
import { createClaudeCheck } from '../../providers/claude-check-core.js'
import { resolveClaudeCliExecutable } from '../claude-cli-detect.js'
import type { ConfigDiagnostics, LocalDiagnostics, PathSummary } from './types.js'
import type { Config } from '../types.js'

type Env = Record<string, string | undefined>
type Exec = NonNullable<HostRuntimeDeps['execFile']>

/** PATH entries shown before the count takes over. */
export const PATH_ENTRIES_SHOWN = 12
/** The daemon's own budget for the login-shell capture (captureLoginShellPathSync). */
export const LOGIN_SHELL_TIMEOUT_MS = 5_000

/** Pure methods only (no fs/exec): the login-shell script and its parser. */
const PURE_RUNTIME = createHostRuntime({ env: {} })
/** fs only: resolveOnPath for the cheap compiler and dtach lookups. */
const FS_RUNTIME = createHostRuntime({ fs, env: {} })

// ── children ──

const liveChildren = new Set<ChildProcess>()

/** execFile that remembers the child until it exits, so a deadline can end it. */
export const trackedExecFile: Exec = (file, args, opts, cb) => {
  let child: ChildProcess
  try {
    child = execFile(file, args, opts, (err, stdout, stderr) => {
      liveChildren.delete(child)
      cb(err as Parameters<typeof cb>[0], stdout, stderr)
    })
  } catch (err) {
    cb(err as Parameters<typeof cb>[0], '', '')
    return undefined
  }
  liveChildren.add(child)
  child.once('exit', () => liveChildren.delete(child))
  return child
}

/** End every probe child still running (a deadline gave up on it). Returns how many. */
export function killLeftoverProbes(): number {
  let n = 0
  for (const child of liveChildren) {
    try { child.kill('SIGKILL'); n++ } catch { /* already gone */ }
    child.unref()
    child.stdin?.destroy()
    child.stdout?.destroy()
    child.stderr?.destroy()
  }
  liveChildren.clear()
  return n
}

export function liveProbeChildren(): number {
  return liveChildren.size
}

// ── PATH ──

export function summarizePath(value: string | null | undefined): PathSummary {
  const all = (value ?? '').split(path.delimiter).filter(Boolean)
  return { entries: all.slice(0, PATH_ENTRIES_SHOWN), count: all.length }
}

/** The PATH the local daemon gives a session: see buildDaemonPath in host-runtime-core.ts. */
export function sessionPath(loginPath: string | null, env: Env): string {
  const home = env.HOME || os.homedir()
  return buildDaemonPath(loginPath ?? '', defaultDaemonExtraPaths(home), env.PATH ?? '')
}

/**
 * The user's login-shell PATH, captured in a clean environment exactly like the
 * daemon's captureLoginShellPathSync (same script, same kept variables, same
 * 5s budget), but without blocking: a slow rc file costs this request, not
 * every route.
 */
export function captureLoginShellPath(env: Env, timeoutMs: number): Promise<string | null> {
  const shell = env.SHELL
  const script = shell ? PURE_RUNTIME.loginShellScript(shell) : null
  if (!shell || !script) return Promise.resolve(null)
  const clean: Record<string, string> = { PATH: '/usr/bin:/bin', TERM: 'dumb' }
  for (const key of ['HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'TMPDIR']) {
    const v = env[key]
    if (v) clean[key] = v
  }
  return new Promise((resolve) => {
    // The kill reaches the shell only; a child it left behind can hold stdout
    // open, and execFile's callback waits for that. The deadline must not.
    const timer = setTimeout(() => resolve(null), timeoutMs + 250)
    timer.unref?.()
    const done = (value: string | null) => { clearTimeout(timer); resolve(value) }
    const child = trackedExecFile(shell, ['-lc', script], {
      env: clean, encoding: 'utf-8', timeout: timeoutMs, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024,
    }, (_err, stdout) => done(PURE_RUNTIME.parseLoginShellPath(String(stdout ?? ''))))
    // An rc file that reads stdin must see EOF, not wait for the timeout.
    ;(child as ChildProcess | undefined)?.stdin?.end()
  })
}

// ── claude, compiler, dtach ──

/**
 * host.preflight on this machine, with `pathStr` as the PATH, including the
 * sign-in and version check (claude-check-core.ts) the same way
 * local-readiness.ts runs it in process. `minVersion` is the configured
 * model's floor (claude-version-floor.ts).
 */
export function localPreflight(pathStr: string, env: Env, minVersion?: string): Promise<HostPreflightResult> {
  const runEnv = { ...env, PATH: pathStr }
  const runtime = createHostRuntime({
    fs, execFile: trackedExecFile, env: runEnv, platform: process.platform, arch: process.arch,
    claudeCheck: createClaudeCheck({ fs, execFile: trackedExecFile, env: runEnv }),
  })
  return runtime.preflight(minVersion ? { minClaudeVersion: minVersion } : {})
}

/** Where `claude` resolves without running it: the answer when preflight runs out of time. */
export function localClaudePath(pathStr: string, env: Env): string | null {
  return resolveClaudeCliExecutable({ ...env, PATH: pathStr })
}

/** The preflight's compiler rule (cc, gcc, clang on PATH), on its own: a few stat calls. */
export function localCompiler(pathStr: string): { found: boolean; name: string | null } {
  for (const cc of ['cc', 'gcc', 'clang']) {
    if (FS_RUNTIME.resolveOnPath(cc, pathStr)) return { found: true, name: cc }
  }
  return { found: false, name: null }
}

/**
 * Read-only dtach answer for the CLI and a cloud replica (a primary server
 * passes the terminal's own resolveLocalDtach instead). Walnut's local copy
 * lives at <WALNUT_HOME>/tmp/bin/walnut-dtach (LOCAL_BIN in
 * web/terminal/dtach-provision.ts), then the preflight's own rule
 * (~/.local/bin/walnut-dtach, then dtach on PATH). Never builds or installs.
 */
export async function readOnlyLocalDtach(tmpDir: string, pathStr: string, home: string): Promise<LocalDiagnostics['dtach']> {
  const own = path.join(tmpDir, 'bin', 'walnut-dtach')
  if (FS_RUNTIME.resolveOnPath(own, '')) return { found: true, path: own, source: 'walnut' }
  const userCopy = path.join(home, '.local', 'bin', 'walnut-dtach')
  if (FS_RUNTIME.resolveOnPath(userCopy, '')) return { found: true, path: userCopy, source: 'walnut' }
  const onPath = FS_RUNTIME.resolveOnPath('dtach', pathStr)
  return onPath ? { found: true, path: onPath, source: 'system' } : { found: false, path: null, source: null }
}

/** Open an in-memory database: proves the native addon loads under this node. */
export async function probeSqlite(): Promise<{ ok: boolean; version?: string }> {
  const req = createRequire(import.meta.url)
  const Database = req('better-sqlite3') as new (p: string) => {
    prepare(sql: string): { get(): unknown }
    close(): void
  }
  const db = new Database(':memory:')
  try {
    const row = db.prepare('select sqlite_version() as v').get() as { v?: unknown } | undefined
    return typeof row?.v === 'string' ? { ok: true, version: row.v } : { ok: true }
  } finally {
    db.close()
  }
}

// ── config ──

/**
 * config.yaml as it is on disk, for the CLI: no defaults, no migration, and
 * above all no recovery. getConfig() puts config.yaml back from its .bak when
 * the primary is missing, which is the server's call to make, not a doctor's.
 * null = no readable, non-empty config.yaml.
 */
export async function readConfigReadOnly(file: string): Promise<Config | null> {
  let text: string
  try {
    text = await fsp.readFile(file, 'utf-8')
  } catch {
    return null
  }
  if (!text.trim()) return null
  const { default: yaml } = await import('js-yaml')
  const parsed = yaml.load(text)
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Config : null
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

/**
 * The provider and model picture, picked field by field (an allowlist): a
 * config spread would carry keys, tokens and header values along with it.
 */
export function summarizeConfig(config: Config, env: Env): ConfigDiagnostics {
  const providers = Object.entries(config.providers ?? {}).map(([name, p]) => {
    const api = text((p as { api?: unknown } | undefined)?.api)
    return api ? `${name} (${api})` : name
  })
  return {
    provider: text(config.provider?.type),
    mainProvider: text(config.agent?.main_provider),
    mainModel: text(config.agent?.main_model) ?? text(config.provider?.model),
    fastModel: text(config.agent?.fast_model),
    providers,
    engine: text(config.defaults?.engine) ?? 'claude',
    hostsConfigured: Object.keys(config.hosts ?? {}).filter((k) => k !== '__local__').length,
    searchDisabled: env.WALNUT_DISABLE_SEARCH === '1' || env.WALNUT_CLOUD_MODE === '1',
  }
}
