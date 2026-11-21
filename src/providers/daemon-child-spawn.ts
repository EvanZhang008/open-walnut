/**
 * How the session daemon starts a child process (an agent CLI, a host_exec
 * command, a terminal, `ps`), with the runtime's own defaults filled in.
 *
 * The daemon ran as a process of its own that set its umask to 077, moved its
 * cwd to the daemon dir and edited its own env, so every child got those three
 * by inheritance. A runtime created inside another process (createDaemonRuntime
 * in daemon-standalone.ts) may touch none of them, so each child is given them
 * here instead:
 *   - env: the runtime's env when the caller names none;
 *   - cwd: the runtime's dir (once started) when the caller names none;
 *   - umask: set for the instant the child is forked and put back at once. The
 *     fork happens inside the call, so nothing else on this thread runs with it;
 *     a call that does no fork (an error before it) restores it just the same.
 * A caller's own env and cwd always win. Pure wiring: the raw functions are passed in.
 */
import type * as cp from 'node:child_process'
import { promisify } from 'node:util'

export interface DaemonChildDefaults {
  /** The env a child gets when its caller names none. */
  env: NodeJS.ProcessEnv
  /** The cwd a child gets when its caller names none; undefined leaves the process's own. */
  cwd: () => string | undefined
  /** The umask a child is forked with; null leaves the process's own. */
  umask: number | null
}

interface RawChildProcess {
  spawn: typeof cp.spawn
  execFile: typeof cp.execFile
  execFileSync: typeof cp.execFileSync
  execSync: typeof cp.execSync
  /** Bun.spawn, where the runtime has it. */
  bunSpawn?: (...args: never[]) => unknown
  /** process.umask: injected so a test can watch it. */
  umask: (mask?: number) => number
}

type Opts = Record<string, unknown> & { cwd?: unknown; env?: unknown }

export interface DaemonChildSpawn {
  spawn: typeof cp.spawn
  execFile: typeof cp.execFile
  execFileSync: typeof cp.execFileSync
  execSync: typeof cp.execSync
  bunSpawn: (argv: string[], opts?: Record<string, unknown>) => unknown
}

/**
 * The child-process functions a module the runtime imports starts its children with. The
 * runtime passes its wrapped ones (env, cwd, umask 077 filled in); any other caller leaves
 * them out and gets node's own, so its behaviour stays as it was.
 */
export type ChildProcessFns = Pick<DaemonChildSpawn, 'spawn' | 'execFile' | 'execFileSync' | 'execSync'>

/**
 * What such a module is handed: the functions it uses and `env`, the env it builds a child's
 * env from where it would read process.env. Every field left out is node's own / process.env.
 * The runtime hands every module the same one (all four functions and its env).
 */
export type ChildProcessUse<K extends keyof ChildProcessFns = keyof ChildProcessFns> =
  Partial<Pick<ChildProcessFns, K>> & { env?: NodeJS.ProcessEnv }

const isObject = (v: unknown): v is Opts => !!v && typeof v === 'object' && !Array.isArray(v)

export function createDaemonChildSpawn(raw: RawChildProcess, defaults: DaemonChildDefaults): DaemonChildSpawn {
  const fill = (opts: Opts | undefined): Opts => {
    const out: Opts = { ...(opts ?? {}) }
    if (out.env == null) out.env = defaults.env
    if (out.cwd == null) {
      const cwd = defaults.cwd()
      if (cwd) out.cwd = cwd
    }
    return out
  }
  const underUmask = <T>(fork: () => T): T => {
    if (defaults.umask === null) return fork()
    const previous = raw.umask(defaults.umask)
    try { return fork() } finally { raw.umask(previous) }
  }

  // spawn(command, args?, options?)
  const spawn = ((command: string, ...rest: unknown[]) => {
    const args = Array.isArray(rest[0]) ? rest[0] as string[] : []
    const opts = isObject(rest[0]) ? rest[0] : isObject(rest[1]) ? rest[1] : undefined
    return underUmask(() => raw.spawn(command, args, fill(opts) as cp.SpawnOptions))
  }) as typeof cp.spawn

  // execFile(file, args?, options?, callback?): any of the three may be left out.
  const execFile = ((file: string, ...rest: unknown[]) => {
    let i = 0
    let args: string[] = []
    if (Array.isArray(rest[0])) args = rest[i++] as string[]
    else if (rest[0] == null && rest.length > 1) i++ // execFile(file, null, options?, callback?)
    let opts: Opts | undefined
    if (isObject(rest[i])) opts = rest[i++] as Opts
    else if (rest[i] == null && typeof rest[i + 1] === 'function') i++
    const callback = typeof rest[i] === 'function' ? rest[i] as (...a: unknown[]) => void : undefined
    return underUmask(() => (raw.execFile as unknown as (...a: unknown[]) => cp.ChildProcess)(
      file, args, fill(opts), ...(callback ? [callback] : []),
    ))
  }) as typeof cp.execFile
  // util.promisify(execFile) resolves { stdout, stderr }, as node's own does.
  ;(execFile as unknown as Record<symbol, unknown>)[promisify.custom] = (file: string, ...rest: unknown[]) =>
    new Promise((resolve, reject) => {
      ;(execFile as unknown as (...a: unknown[]) => void)(file, ...rest, (error: (Error & Record<string, unknown>) | null, stdout: unknown, stderr: unknown) => {
        if (error) reject(Object.assign(error, { stdout, stderr }))
        else resolve({ stdout, stderr })
      })
    })

  // execFileSync(file, args?, options?)
  const execFileSync = ((file: string, ...rest: unknown[]) => {
    const args = Array.isArray(rest[0]) ? rest[0] as string[] : []
    const opts = isObject(rest[0]) ? rest[0] : isObject(rest[1]) ? rest[1] : undefined
    return underUmask(() => raw.execFileSync(file, args, fill(opts) as cp.ExecFileSyncOptions))
  }) as typeof cp.execFileSync

  // execSync(command, options?)
  const execSync = ((command: string, opts?: Opts) =>
    underUmask(() => raw.execSync(command, fill(isObject(opts) ? opts : undefined) as cp.ExecSyncOptions))) as typeof cp.execSync

  // Bun.spawn(argv, options?) or Bun.spawn({ cmd, ...options })
  const bunSpawn = (argv: string[] | Opts, opts?: Record<string, unknown>): unknown => {
    if (!raw.bunSpawn) throw new Error('Bun.spawn is not available in this runtime')
    const call = raw.bunSpawn as unknown as (...a: unknown[]) => unknown
    if (Array.isArray(argv)) return underUmask(() => call(argv, fill(opts as Opts | undefined)))
    return underUmask(() => call(fill(argv)))
  }

  return { spawn, execFile, execFileSync, execSync, bunSpawn: bunSpawn as DaemonChildSpawn['bunSpawn'] }
}
