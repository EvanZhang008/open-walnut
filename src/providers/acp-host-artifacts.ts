/**
 * ACP engines on a host other than the primary (2026-10-30, the user: "why clouddev no
 * codex? ... but it should have it"). The primary knows the worker bundle and the
 * adapter only as paths in its own install, which do not exist on another host. So
 * for a session on another host the primary sends the adapter's DESCRIPTION
 * (`AcpHostAdapterSpec`, from the engine registry) and the host's daemon builds the
 * commands from what that host has:
 *   - the worker bundle and a bundled adapter: files the remote deploy put beside
 *     the daemon (`ACP_HOST_FILES`), run by the daemon's own runtime (bun or node);
 *   - the engine's CLI (codex, opencode, goose, ...): found on the daemon's PATH
 *     (the user's login-shell PATH, host-runtime-core.ts) and the usual per-user
 *     install dirs, never inside the walnut install.
 * `probeHostEngines` answers the same question for the picker: which engines this
 * host can run, and why not.
 *
 * Compiled into acp-daemon.ts, so both daemon twins carry it through the
 * acp-daemon-core.cjs sidecar; node builtins only.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'

/** What the primary sends for an adapter that must be resolved on the host. */
export interface AcpHostAdapterSpec {
  engine: string
  displayName?: string
  source: 'bundled' | 'cli'
  /** The engine's own CLI on that host (`codex`, `opencode`, `pi`). */
  binary: string
  /** argv after the binary, for a `cli` adapter. */
  args?: string[] | null
  /** A bundled adapter's file beside the daemon (`ACP_HOST_FILES`). */
  bundle?: string
  /** The env var a bundled adapter reads the found binary from (`CODEX_PATH`). */
  binaryEnv?: string
  /** The host's own override for the binary (`WALNUT_CODEX_PATH`). */
  overrideEnv?: string
  versionArgs?: string[]
}

/** The files a remote deploy puts beside the daemon for ACP engines (name on the host → name in dist/daemon-binaries). */
export const ACP_HOST_FILES: Readonly<Record<string, string>> = {
  'acp-worker.mjs': 'acp-worker.js',
  'codex-acp.mjs': 'codex-acp.mjs',
  'pi-acp.mjs': 'pi-acp.js',
}
export const ACP_HOST_WORKER = 'acp-worker.mjs'

export interface HostEngineAvailability {
  installed: boolean
  version: string | null
  reason: string | null
  /** Where the engine's CLI was found. */
  path?: string
}

export interface AcpHostResolveDeps {
  /** The directory holding ACP_HOST_FILES; undefined = this daemon has none. */
  artifactDir?: string
  /** The runtime that runs the worker and bundled adapters (the daemon's own). */
  execPath?: string
  env?: NodeJS.ProcessEnv
  home?: string
  /** The dirs searched after PATH (tests); default the per-user install dirs under home and the system bins. */
  extraDirs?: readonly string[]
}

function isExecutableFile(p: string): boolean {
  try {
    if (!fs.statSync(p).isFile()) return false
    fs.accessSync(p, fs.constants.X_OK)
    return true
  } catch { return false }
}

/** Per-user install dirs an engine CLI lands in, after the daemon's PATH. */
function extraDirs(home: string): string[] {
  return [
    path.join(home, '.local/bin'), path.join(home, '.bun/bin'),
    path.join(home, '.npm-global/bin'), path.join(home, '.opencode/bin'), path.join(home, '.cargo/bin'),
    path.join(home, 'bin'), '/usr/local/bin', '/opt/homebrew/bin', '/usr/bin',
  ]
}

/** The engine CLI on this host, or why there is none. Never a file inside node_modules (a bundled copy is not the user's install). */
export function findHostBinary(spec: Pick<AcpHostAdapterSpec, 'binary' | 'overrideEnv'>, deps: AcpHostResolveDeps = {}): { path?: string; reason?: string } {
  const env = deps.env ?? process.env
  const override = spec.overrideEnv ? env[spec.overrideEnv] : undefined
  if (override) {
    return isExecutableFile(override) ? { path: override } : { reason: `${spec.overrideEnv} names ${override}, which is not an executable file` }
  }
  const home = deps.home ?? os.homedir()
  const seen = new Set<string>()
  for (const dir of [...String(env.PATH ?? '').split(path.delimiter), ...(deps.extraDirs ?? extraDirs(home))]) {
    if (!dir || !path.isAbsolute(dir) || seen.has(dir) || dir.split(path.sep).includes('node_modules')) continue
    seen.add(dir)
    const p = path.join(dir, spec.binary)
    if (isExecutableFile(p)) return { path: p }
  }
  return { reason: `${spec.binary} is not installed` }
}

export type HostResolveResult =
  | { ok: true; workerCmd: string[]; adapterCmd: string[]; env: Record<string, string> }
  | { ok: false; error: string; errorKind: 'provider_missing' | 'acp_unsupported' }

/** The worker and adapter commands for a session on this host. */
/** A bare command name: no path, no `..`, nothing a shell would read. */
const BARE_NAME = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/
/** Env keys a bundled adapter may be handed the binary in. */
const BINARY_ENV_KEYS = new Set(['CODEX_PATH', 'PI_ACP_PI_COMMAND'])

/** Why a spec from the primary is not one this daemon runs, or null. */
function specProblem(spec: AcpHostAdapterSpec): string | null {
  if (!spec || typeof spec.binary !== 'string' || !BARE_NAME.test(spec.binary)) return 'the engine CLI is not a bare command name'
  if (spec.source === 'bundled' && (!spec.bundle || !Object.hasOwn(ACP_HOST_FILES, spec.bundle))) return 'its adapter is not one the daemon ships'
  if (spec.binaryEnv && !BINARY_ENV_KEYS.has(spec.binaryEnv)) return `${spec.binaryEnv} is not an adapter binary variable`
  if (spec.source !== 'bundled' && spec.source !== 'cli') return 'its adapter kind is unknown'
  return null
}

export function resolveHostAcpArtifacts(spec: AcpHostAdapterSpec, deps: AcpHostResolveDeps = {}): HostResolveResult {
  const name = spec.displayName ?? spec.engine
  const problem = specProblem(spec)
  if (problem) return { ok: false, error: `${name} cannot run on this host: ${problem}`, errorKind: 'acp_unsupported' }
  const dir = deps.artifactDir
  const exec = deps.execPath ?? process.execPath
  if (!dir || !fs.existsSync(path.join(dir, ACP_HOST_WORKER))) {
    return { ok: false, error: `${name} cannot run on this host: its daemon has no ACP worker (it updates on the next connect)`, errorKind: 'acp_unsupported' }
  }
  const workerCmd = [exec, path.join(dir, ACP_HOST_WORKER)]
  const found = findHostBinary(spec, deps)
  if (!found.path) return { ok: false, error: `${name} cannot run on this host: ${found.reason}`, errorKind: 'provider_missing' }
  if (spec.source === 'bundled') {
    const bundle = spec.bundle ? path.join(dir, spec.bundle) : ''
    if (!bundle || !fs.existsSync(bundle)) {
      return { ok: false, error: `${name} cannot run on this host: its adapter was not deployed with the daemon`, errorKind: 'acp_unsupported' }
    }
    return { ok: true, workerCmd, adapterCmd: [exec, bundle], env: spec.binaryEnv ? { [spec.binaryEnv]: found.path } : {} }
  }
  return { ok: true, workerCmd, adapterCmd: [found.path, ...(spec.args ?? [])], env: {} }
}

function firstLine(s: string): string | null {
  const line = String(s ?? '').split('\n').map((l) => l.trim()).find(Boolean)
  return line ? line.slice(0, 200) : null
}

function runVersion(binary: string, args: readonly string[], env: NodeJS.ProcessEnv, ms: number): Promise<string | null> {
  return new Promise((resolve) => {
    try {
      execFile(binary, [...args], { env, timeout: ms, killSignal: 'SIGKILL', maxBuffer: 256 * 1024 }, (err, stdout, stderr) => {
        if (err && !String(stdout ?? '').trim()) return resolve(null)
        resolve(firstLine(String(stdout ?? '')) ?? firstLine(String(stderr ?? '')))
      })
    } catch { resolve(null) }
  })
}

const PROBE_TTL_MS = 60_000
const VERSION_MS = 5_000

/** Which engines this host can run (cached a minute), and why not. */
export function createHostEngineProbe(deps: AcpHostResolveDeps = {}) {
  const cache = new Map<string, { at: number; value: HostEngineAvailability }>()
  async function one(spec: AcpHostAdapterSpec): Promise<HostEngineAvailability> {
    const key = JSON.stringify([spec.engine, spec.binary, spec.bundle ?? '', spec.overrideEnv ?? ''])
    const hit = cache.get(key)
    if (hit && Date.now() - hit.at < PROBE_TTL_MS) return hit.value
    const resolved = resolveHostAcpArtifacts(spec, deps)
    let value: HostEngineAvailability
    if (!resolved.ok) {
      value = { installed: false, version: null, reason: resolved.error.replace(/^.*? cannot run on this host: /, '') }
    } else {
      const bin = findHostBinary(spec, deps).path!
      const version = spec.versionArgs?.length ? await runVersion(bin, spec.versionArgs, deps.env ?? process.env, VERSION_MS) : null
      value = { installed: true, version, reason: null, path: bin }
    }
    cache.set(key, { at: Date.now(), value })
    return value
  }
  return {
    async probe(specs: readonly AcpHostAdapterSpec[]): Promise<Record<string, HostEngineAvailability>> {
      const out: Record<string, HostEngineAvailability> = {}
      await Promise.all(specs.map(async (spec) => { out[spec.engine] = await one(spec) }))
      return out
    },
  }
}
