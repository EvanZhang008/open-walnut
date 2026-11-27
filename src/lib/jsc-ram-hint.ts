/**
 * The JS engine's RAM hint for Walnut's server (BUN_JSC_forceRAMSize).
 *
 * JavaScriptCore sizes its collections from the machine's RAM, so on a 48 GB Mac it
 * lets the heap grow far before it collects. The server then stepped from a 650 to
 * 850 MB footprint to 1.3 to 2 GB 10 to 60 minutes after each start and stayed
 * there: a burst of allocation expanded the heap and its pages stayed dirty, which
 * no collection gives back (2026-11-27). Told the machine has 4 GiB, the engine
 * collects sooner: on a churn workload the peak fell from 1059 to 842 MB and the
 * settled footprint from 809 to 609 MB, for about 3% more CPU.
 *
 * The engine reads its options only when its VM starts, so the server re-runs
 * itself once, as early as possible (the compiled file's main.ts, before it loads
 * the CLI; entry-runtime.ts too), with the variable set: same file, same argv[0] and
 * arguments, same env plus the variable and a marker (process.execve: the same pid,
 * the same command line in `ps`). The run it becomes takes both out of process.env
 * again, so no child (the agent CLIs are bun programs too) gets a hint Walnut chose:
 * Walnut never sets an engine's own defaults. That reaches every child started
 * through child_process, Bun.$, or Bun.spawn with an explicit env (src/lib/pty.ts and
 * the daemon runtime's spawns always pass one); a Bun.spawn or Bun.spawnSync without
 * `env` would hand on the process's original environ, the hint included (none in
 * src/ did on 2026-11-27). A hint the person set themselves stays theirs, children
 * included.
 *
 * Only the compiled walnut file: run from a script (`bun dist/cli.js web`, the bin
 * link of an npm install), bun resolves argv[1] to the script's real path, so a
 * re-run would show another command line (links resolved, a relative path made
 * absolute) and the Mac app, which finds its server by that line, could miss it and
 * start a second one. Only the server: `web` and its alias `serve` (normal,
 * replica, ephemeral child, restore trial), never the `--ephemeral` launcher (a
 * short-lived parent), `--help`, any other command, the daemon, Node, or Windows
 * (no execve). WALNUT_JSC_RAM_HINT=0 turns it off; WALNUT_JSC_RAM_HINT=<bytes> picks
 * another value.
 *
 * Keep this file free of Walnut imports: entry-runtime.ts runs it before them.
 */
import os from 'node:os'

/** The engine's own variable: the RAM size it plans its collections for, in bytes. */
export const JSC_RAM_ENV = 'BUN_JSC_forceRAMSize'
/** The person's choice: `0` turns the hint off, a positive byte count replaces the default. */
export const RAM_HINT_ENV = 'WALNUT_JSC_RAM_HINT'
/** Set beside JSC_RAM_ENV by the re-exec: the variable is Walnut's, not the person's. */
export const RAM_HINT_APPLIED_ENV = 'WALNUT_JSC_RAM_HINT_APPLIED'
/** The default hint: 4 GiB, or the machine's RAM or the process's memory limit when that is less. */
export const DEFAULT_RAM_HINT_BYTES = 4 * 1024 ** 3

/**
 * The hint in bytes for this machine, or null when the person turned it off.
 * `constrainedMem` is process.constrainedMemory(): a cgroup or container limit on
 * Linux, counted only when it is below the machine's RAM (no limit reads as 0, the
 * RAM itself, or a huge number).
 */
export function ramHintBytes(env: NodeJS.ProcessEnv, totalMem: number, constrainedMem = 0): number | null {
  const chosen = env[RAM_HINT_ENV]?.trim()
  if (chosen === '0') return null
  if (chosen && /^[1-9]\d*$/.test(chosen)) return Number(chosen)
  const limits = [DEFAULT_RAM_HINT_BYTES]
  if (totalMem > 0) limits.push(totalMem)
  if (constrainedMem > 0 && (totalMem <= 0 || constrainedMem < totalMem)) limits.push(constrainedMem)
  return Math.min(...limits)
}

/** Is this command line (argv from index 2: the user's arguments) the server's own start? */
export function isServerStart(args: readonly string[]): boolean {
  const command = args.find((a) => !a.startsWith('-'))
  if (command !== 'web' && command !== 'serve') return false
  // The ephemeral launcher only copies data and starts the child, which takes the hint itself.
  return !args.some((a) => a === '--ephemeral' || a === '--help' || a === '-h')
}

/** A virtual entry inside a compiled bun file: `/$bunfs/root/walnut`, or `B:/~BUN/root/...` on Windows. */
function inCompiledEntry(entry: string | undefined): boolean {
  return !!entry && (entry.startsWith('/$bunfs/') || entry.includes('~BUN'))
}

export interface RamHintInput {
  argv: readonly string[]
  /** The program name as the process was started (a link's path, say): kept as the re-run's argv[0], so `ps` shows the same command line. */
  argv0?: string
  execPath: string
  env: NodeJS.ProcessEnv
  platform: NodeJS.Platform
  versions: NodeJS.ProcessVersions
  totalMem: number
  /** process.constrainedMemory(), where the runtime has it. */
  constrainedMem?: number
  hasExecve: boolean
}

export type RamHintDecision =
  | { kind: 'reexec'; file: string; args: string[]; env: NodeJS.ProcessEnv; bytes: number }
  | { kind: 'skip'; reason: string }

/** Whether this start re-runs itself with the hint, and exactly how. Pure: the caller execs. */
export function decideRamHintReexec(i: RamHintInput): RamHintDecision {
  if (!isServerStart(i.argv.slice(2))) return { kind: 'skip', reason: 'not a server start' }
  if (typeof (i.versions as { bun?: string }).bun !== 'string') return { kind: 'skip', reason: 'not on bun' }
  if (i.platform === 'win32') return { kind: 'skip', reason: 'no execve on Windows' }
  if (!inCompiledEntry(i.argv[1])) return { kind: 'skip', reason: 'run from a script: its command line cannot be kept' }
  // Also the loop guard: the run the re-exec starts has it.
  if (i.env[JSC_RAM_ENV] !== undefined) return { kind: 'skip', reason: `${JSC_RAM_ENV} is already set` }
  const bytes = ramHintBytes(i.env, i.totalMem, i.constrainedMem)
  if (bytes === null) return { kind: 'skip', reason: `${RAM_HINT_ENV}=0` }
  if (!i.hasExecve) return { kind: 'skip', reason: 'this runtime has no process.execve' }
  // The compiled file adds its own entry (argv[1]) again: the user's arguments follow argv[0].
  // execPath is the resolved file; a launcher (the Mac app's link, a service file) may have named a
  // link, and tools that recognise the server by its command line read argv[0] as it was started.
  // Its runtime flags (compile-exec-argv, BUN_OPTIONS) come back from the file and the env.
  return { kind: 'reexec', file: i.execPath, args: [i.argv0 || i.execPath, ...i.argv.slice(2)], env: { ...i.env, [JSC_RAM_ENV]: String(bytes), [RAM_HINT_APPLIED_ENV]: String(bytes) }, bytes }
}

export type RamHintState =
  | { on: true; bytes: number; by: 'walnut' | 'person' }
  | { on: false; reason: string }

/**
 * Takes Walnut's hint out of this env (the run the re-exec started): the engine
 * read it already, and no child may inherit it. A variable the person set (no
 * marker, or a marker naming another value) stays. Returns what this process runs with.
 */
export function takeRamHint(env: NodeJS.ProcessEnv): RamHintState | null {
  const value = env[JSC_RAM_ENV]
  const marker = env[RAM_HINT_APPLIED_ENV]
  delete env[RAM_HINT_APPLIED_ENV]
  if (value === undefined) return null
  if (marker !== undefined && marker === value) {
    delete env[JSC_RAM_ENV]
    return { on: true, bytes: Number(value), by: 'walnut' }
  }
  return { on: true, bytes: Number(value), by: 'person' }
}

type Execve = (file: string, args: string[], env: NodeJS.ProcessEnv) => never

export interface RamHintDeps {
  proc?: Pick<NodeJS.Process, 'argv' | 'execPath' | 'env' | 'platform' | 'versions'> & { argv0?: string; execve?: Execve; constrainedMemory?: () => number }
  totalMem?: () => number
}

/** process.constrainedMemory() where the runtime has it, else 0 (no limit known). */
function constrainedMemoryOf(proc: { constrainedMemory?: () => number }): number {
  try {
    const limit = typeof proc.constrainedMemory === 'function' ? proc.constrainedMemory() : 0
    return Number.isFinite(limit) && limit > 0 ? limit : 0
  } catch {
    return 0
  }
}

const STATE_KEY = '__WALNUT_JSC_RAM_HINT__'
const g = globalThis as Record<string, unknown>

/** What this process runs with, as startWithRamHint found it (null before it ran). */
export function ramHintState(): RamHintState | null {
  return (g[STATE_KEY] as RamHintState | undefined) ?? null
}

/** The server's start line: whether the hint is on, its value and who chose it, or why not. */
export function ramHintSummary(state: RamHintState | null = ramHintState()): Record<string, string | number | boolean> {
  if (!state) return { on: false, reason: 'not started through a server command' }
  if (!state.on) return { on: false, reason: state.reason }
  return { on: true, bytes: state.bytes, mb: Math.round(state.bytes / 1024 ** 2), by: state.by }
}

/**
 * Runs once per process, first thing: either takes the hint the re-exec set out of
 * the env, or re-runs this server start with it (never returns then), or goes on
 * without it. An execve that throws leaves the start as it was.
 */
export function startWithRamHint(deps: RamHintDeps = {}): RamHintState {
  const known = ramHintState()
  if (known && !deps.proc) return known
  const proc = deps.proc ?? process
  const record = (s: RamHintState): RamHintState => { if (!deps.proc) g[STATE_KEY] = s; return s }
  const taken = takeRamHint(proc.env)
  if (taken) return record(taken)
  const execve = (proc as { execve?: Execve }).execve
  const d = decideRamHintReexec({
    argv: proc.argv, argv0: (proc as { argv0?: string }).argv0, execPath: proc.execPath, env: proc.env,
    platform: proc.platform, versions: proc.versions,
    totalMem: (deps.totalMem ?? os.totalmem)(), constrainedMem: constrainedMemoryOf(proc as { constrainedMemory?: () => number }), hasExecve: typeof execve === 'function',
  })
  if (d.kind === 'skip') return record({ on: false, reason: d.reason })
  try {
    execve!.call(proc, d.file, d.args, d.env)
  } catch (err) {
    return record({ on: false, reason: `execve failed: ${err instanceof Error ? err.message : String(err)}` })
  }
  // A stub in a test returns; the real one never does.
  return record({ on: false, reason: 'execve returned' })
}
