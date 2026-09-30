/**
 * `walnut.hosts` for plugins: the hosts Walnut knows (Settings, Hosts) and one way to run a
 * short script on one of them, so a plugin never reads Walnut's host list through the config
 * API or builds an ssh command line of its own.
 *
 * A run is a POSIX sh script on stdin (`sh -s`): over ssh for a remote host, directly for this
 * machine. Positional arguments are literal strings: remotely each is single-quoted for the
 * login shell that parses ssh's command, locally they are plain argv. Output and time are
 * bounded; a run past either cap ends and says so instead of filling memory or hanging.
 */

import { spawn } from 'node:child_process'
import { getConfig } from '../config-manager.js'

export const LOCAL_HOST_ALIAS = '__local__'

const DEFAULT_TIMEOUT_MS = 60_000
const MAX_TIMEOUT_MS = 10 * 60_000
const DEFAULT_MAX_OUTPUT = 8 * 1024 * 1024
const MAX_OUTPUT = 64 * 1024 * 1024
const MAX_SCRIPT_BYTES = 1024 * 1024
const STDERR_TAIL = 4000
/** A SIGTERM'd run that has not exited by then is SIGKILLed. */
const KILL_GRACE_MS = 5_000
/** After the script exits, output still in the pipes gets this long to arrive. */
const EXIT_DRAIN_MS = 2_000
/** A hostname or user as ssh takes them; anything else (a leading "-" above all) never
 *  reaches its command line. */
const SSH_WORD_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,252}$/

export interface PluginHostInfo {
  alias: string
  label?: string
  local: boolean
  enabled: boolean
  hostname?: string
  user?: string
  port?: number
}

export interface PluginHostRunInput {
  script: string
  args?: string[]
  timeoutMs?: number
  maxOutputBytes?: number
}

export interface PluginHostRunResult {
  code: number | null
  stdout: string
  stderr: string
  timedOut: boolean
  truncated: boolean
}

type HostDef = { hostname?: unknown; user?: unknown; port?: unknown; label?: unknown; enabled?: unknown }

function hostInfo(alias: string, def: HostDef): PluginHostInfo {
  const port = typeof def.port === 'number' && Number.isInteger(def.port) && def.port > 0 && def.port < 65536 ? def.port : undefined
  return {
    alias,
    ...(typeof def.label === 'string' && def.label.trim() ? { label: def.label.trim() } : {}),
    local: false,
    enabled: def.enabled !== false,
    ...(typeof def.hostname === 'string' && def.hostname.trim() ? { hostname: def.hostname.trim() } : {}),
    ...(typeof def.user === 'string' && def.user.trim() ? { user: def.user.trim() } : {}),
    ...(port ? { port } : {}),
  }
}

export async function listPluginHosts(): Promise<PluginHostInfo[]> {
  const hosts = ((await getConfig()).hosts ?? {}) as Record<string, HostDef>
  return [
    { alias: LOCAL_HOST_ALIAS, local: true, enabled: true },
    ...Object.entries(hosts).filter(([alias]) => alias !== LOCAL_HOST_ALIAS).map(([alias, def]) => hostInfo(alias, def ?? {})),
  ]
}

export async function getPluginHost(alias: string): Promise<PluginHostInfo | null> {
  return (await listPluginHosts()).find((host) => host.alias === alias) ?? null
}

/** One POSIX single-quoted word: the login shell hands the string through unchanged. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

/** The command and argv for a run: `sh -s` locally, ssh with key auth only for a remote host. */
export function hostRunCommand(host: PluginHostInfo, args: string[]): { command: string; argv: string[] } {
  if (host.local) return { command: 'sh', argv: ['-s', '--', ...args] }
  const hostname = host.hostname ?? ''
  if (!SSH_WORD_RE.test(hostname)) throw new Error(`Host "${host.alias}" has no hostname ssh can use.`)
  if (host.user !== undefined && !SSH_WORD_RE.test(host.user)) throw new Error(`Host "${host.alias}" has a user name ssh cannot use.`)
  const argv = [
    // Never prompt (a plugin has nobody to answer), give up on a dead link, and take a host
    // seen for the first time while still refusing one whose key changed.
    '-o', 'BatchMode=yes',
    '-o', 'ConnectTimeout=20',
    '-o', 'ServerAliveInterval=15',
    '-o', 'ServerAliveCountMax=3',
    '-o', 'StrictHostKeyChecking=accept-new',
    ...(host.port ? ['-p', String(host.port)] : []),
    host.user ? `${host.user}@${hostname}` : hostname,
    ['sh', '-s', '--', ...args.map(shellQuote)].join(' '),
  ]
  return { command: 'ssh', argv }
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.min(max, Math.max(min, Math.trunc(value))) : fallback
}

export type SpawnLike = typeof spawn

export async function runOnPluginHost(
  alias: string,
  input: PluginHostRunInput,
  spawnImpl: SpawnLike = spawn,
): Promise<PluginHostRunResult> {
  const script = input?.script
  if (typeof script !== 'string' || !script.trim()) throw new Error('hosts.run needs a script.')
  if (Buffer.byteLength(script) > MAX_SCRIPT_BYTES) throw new Error('hosts.run scripts are at most 1 MB.')
  const args = input.args ?? []
  if (!Array.isArray(args) || args.some((arg) => typeof arg !== 'string' || arg.includes('\0'))) {
    throw new Error('hosts.run args must be strings without NUL characters.')
  }
  const host = await getPluginHost(alias)
  if (!host) throw new Error(`Walnut has no host named "${alias}" (Settings, Hosts).`)
  const { command, argv } = hostRunCommand(host, args)
  const timeoutMs = clampInt(input.timeoutMs, 1_000, MAX_TIMEOUT_MS, DEFAULT_TIMEOUT_MS)
  const maxOutput = clampInt(input.maxOutputBytes, 1, MAX_OUTPUT, DEFAULT_MAX_OUTPUT)

  return await new Promise<PluginHostRunResult>((resolve) => {
    const child = spawnImpl(command, argv, { stdio: ['pipe', 'pipe', 'pipe'] })
    const out: Buffer[] = []
    let size = 0
    let stderr = ''
    let timedOut = false
    let truncated = false
    let settled = false
    let exitCode: number | null = null
    let drainTimer: ReturnType<typeof setTimeout> | undefined
    const finish = () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (drainTimer) clearTimeout(drainTimer)
      // Anything the script left running (a background job holding its stdout) must not keep
      // this run, or the plugin waiting on it, open.
      child.stdout?.destroy()
      child.stderr?.destroy()
      resolve({
        code: timedOut || truncated ? null : exitCode,
        stdout: Buffer.concat(out).toString('utf8'),
        stderr: stderr.slice(-STDERR_TAIL),
        timedOut,
        truncated,
      })
    }
    // Ends the run now: SIGTERM, then SIGKILL if it is still there after the grace.
    const stop = () => {
      child.kill('SIGTERM')
      const kill = setTimeout(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL') }, KILL_GRACE_MS)
      kill.unref?.()
      finish()
    }
    const timer = setTimeout(() => { timedOut = true; stop() }, timeoutMs)
    child.stdout?.on('data', (chunk: Buffer) => {
      if (settled) return
      if (size + chunk.length > maxOutput) {
        truncated = true
        out.push(chunk.subarray(0, maxOutput - size))
        size = maxOutput
        stop()
        return
      }
      size += chunk.length
      out.push(chunk)
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      // Only the tail is kept, so a chatty script cannot grow this without bound.
      stderr = (stderr + chunk.toString('utf8')).slice(-STDERR_TAIL * 2)
    })
    child.on('error', (error) => { stderr += `${stderr ? '\n' : ''}${error.message}`; finish() })
    // `close` waits for the pipes; after `exit`, give buffered output a moment and no more.
    child.on('exit', (code) => {
      exitCode = code
      drainTimer ??= setTimeout(finish, EXIT_DRAIN_MS)
    })
    child.on('close', (code) => { exitCode ??= code; finish() })
    child.stdin?.on('error', () => { /* the child exited before reading its script; close reports it */ })
    child.stdin?.end(script)
  })
}
