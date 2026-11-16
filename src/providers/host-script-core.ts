/**
 * One short POSIX sh script, run bounded, with its stdout and stderr apart: a plugin's
 * `walnut.hosts.run`. The server runs it here for this machine (src/core/plugins/plugin-hosts.ts),
 * and a host's daemon runs it for another machine (`exec.script`, host-exec-core.ts), reached
 * through the link (src/core/hosts/host-script.ts), so every host runs the same code.
 *
 * The script goes to `sh -s -- ARGS` on stdin (as `ssh host sh -s` did before 2026-11-16), each
 * argument a literal string. stdout is kept up to `maxOutputBytes`, and a run past it ends;
 * only the end of stderr is kept; a run past its deadline ends. Ending a run stops its process
 * group when the caller can signal one (`killGroup`), else the shell: SIGTERM, then SIGKILL.
 *
 * Bundled into host-exec-core (the binary daemon and the host-exec-core.cjs sidecar): it imports
 * nothing but node's types.
 */
import type { ChildProcess, SpawnOptions } from 'node:child_process'

export const SCRIPT_DEFAULT_TIMEOUT_MS = 60_000
export const SCRIPT_MAX_TIMEOUT_MS = 10 * 60_000
export const SCRIPT_DEFAULT_MAX_OUTPUT = 8 * 1024 * 1024
export const SCRIPT_MAX_OUTPUT = 64 * 1024 * 1024
/**
 * A host's run answers in one frame on the link, its stdout JSON-escaped (a control byte takes 6):
 * at most this much, so a frame stays far below the link's 100 MB cap and never holds the link long.
 */
export const SCRIPT_REMOTE_MAX_OUTPUT = 12 * 1024 * 1024
export const SCRIPT_MAX_BYTES = 1024 * 1024
/** The end of stderr a run keeps. */
export const SCRIPT_STDERR_TAIL = 4000
/** A stopped run that has not exited by then is SIGKILLed. */
const KILL_GRACE_MS = 5_000
/** After the shell exits, output still in the pipes gets this long to arrive. */
const EXIT_DRAIN_MS = 2_000

export interface ScriptInput {
  script: string
  args?: string[]
  timeoutMs?: number
  maxOutputBytes?: number
}

export interface ScriptResult {
  code: number | null
  stdout: string
  stderr: string
  timedOut: boolean
  truncated: boolean
}

export interface ScriptRun {
  spawn: (cmd: string, args: string[], opts: SpawnOptions) => ChildProcess
  /** The program and its arguments; the script arrives on its stdin. */
  command: string
  argv: string[]
  env?: NodeJS.ProcessEnv
  cwd?: string
  /** Signal a whole process group (the run starts as its own; 0 only asks whether it has a member); without it only the shell is signalled. */
  killGroup?: (pid: number, signal: NodeJS.Signals | 0) => void
  /**
   * The script goes to the child on fd 3 instead of stdin (its line reads it with `<&3`), so a
   * login profile that reads stdin never eats it (a daemon's run, host-exec-core.ts `script`).
   */
  scriptOnFd3?: boolean
  /** Told of the run's stop while it runs (a daemon update stops it), and of its end (null). */
  onStop?: (stop: (() => void) | null) => void
  /**
   * stdout starts after the first line that is exactly this: what a login profile printed before
   * the script began is not the script's output (a daemon's run, host-exec-core.ts `script`).
   */
  stdoutAfter?: string
}

/** What a login profile may print before the script starts; past it, everything is stdout. */
const PREAMBLE_MAX = 1024 * 1024

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.min(max, Math.max(min, Math.trunc(value))) : fallback
}

/** The input as a run takes it, or the sentence that refuses it. */
export function checkScriptInput(input: unknown): { script: string; args: string[]; timeoutMs: number; maxOutputBytes: number } | { error: string } {
  const i = (input ?? {}) as Partial<ScriptInput>
  if (typeof i.script !== 'string' || !i.script.trim()) return { error: 'hosts.run needs a script.' }
  if (Buffer.byteLength(i.script) > SCRIPT_MAX_BYTES) return { error: 'hosts.run scripts are at most 1 MB.' }
  const args = i.args ?? []
  if (!Array.isArray(args) || args.some((arg) => typeof arg !== 'string' || arg.includes('\0'))) {
    return { error: 'hosts.run args must be strings without NUL characters.' }
  }
  return {
    script: i.script,
    args: args as string[],
    timeoutMs: clampInt(i.timeoutMs, 1_000, SCRIPT_MAX_TIMEOUT_MS, SCRIPT_DEFAULT_TIMEOUT_MS),
    maxOutputBytes: clampInt(i.maxOutputBytes, 1, SCRIPT_MAX_OUTPUT, SCRIPT_DEFAULT_MAX_OUTPUT),
  }
}

/** Run one checked script. Never throws: a shell that cannot start is a failed run with the reason in stderr. */
export function runBoundedScript(run: ScriptRun, input: { script: string; timeoutMs: number; maxOutputBytes: number }): Promise<ScriptResult> {
  const { script, timeoutMs, maxOutputBytes } = input
  return new Promise<ScriptResult>((resolve) => {
    let child: ChildProcess
    try {
      child = run.spawn(run.command, run.argv, {
        stdio: run.scriptOnFd3 ? ['ignore', 'pipe', 'pipe', 'pipe'] : ['pipe', 'pipe', 'pipe'], ...(run.env ? { env: run.env } : {}), ...(run.cwd ? { cwd: run.cwd } : {}),
        // Its own process group, so a stop reaches what the script started too.
        ...(run.killGroup ? { detached: true } : {}),
      })
    } catch (err) {
      resolve({ code: null, stdout: '', stderr: (err as Error).message, timedOut: false, truncated: false })
      return
    }
    const out: Buffer[] = []
    let size = 0
    let stderr = ''
    let timedOut = false
    let truncated = false
    let settled = false
    let exitCode: number | null = null
    let drainTimer: ReturnType<typeof setTimeout> | undefined
    const signal = (sig: NodeJS.Signals) => {
      const pid = child.pid
      try {
        if (run.killGroup && typeof pid === 'number' && pid > 1) run.killGroup(pid, sig)
        else child.kill(sig)
      } catch { /* already gone */ }
    }
    const finish = () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (drainTimer) clearTimeout(drainTimer)
      run.onStop?.(null)
      // Anything the script left running (a background job holding its stdout) must not keep
      // this run, or the plugin waiting on it, open.
      child.stdout?.destroy()
      child.stderr?.destroy()
      // The mark never came: the login shell ended (an `exit` in a profile) or hung before the script.
      if (preamble && !timedOut) {
        resolve({ code: 255, stdout: '', stderr: `${stderr}walnut: the login shell never started the script`.slice(-SCRIPT_STDERR_TAIL), timedOut: false, truncated: false })
        return
      }
      resolve({
        code: timedOut || truncated ? null : exitCode,
        stdout: Buffer.concat(out).toString('utf8'),
        stderr: stderr.slice(-SCRIPT_STDERR_TAIL),
        timedOut,
        truncated,
      })
    }
    // Ends the run now: SIGTERM, then SIGKILL if it is still there after the grace.
    const stop = () => {
      signal('SIGTERM')
      const kill = setTimeout(() => {
        // The group's members, not only the shell: but only while the group still has one (its id is free again once it is empty).
        let alive = child.exitCode === null && child.signalCode === null
        if (run.killGroup && typeof child.pid === 'number') { try { run.killGroup(child.pid, 0); alive = true } catch { /* the group is empty */ } }
        if (alive) signal('SIGKILL')
      }, KILL_GRACE_MS)
      kill.unref?.()
      finish()
    }
    const timer = setTimeout(() => { timedOut = true; stop() }, timeoutMs)
    run.onStop?.(() => { if (!settled) { timedOut = true; stop() } })
    const mark = run.stdoutAfter ? Buffer.from(`${run.stdoutAfter}\n`) : null
    let preamble: Buffer | null = mark ? Buffer.alloc(0) : null
    child.stdout?.on('data', (data: Buffer) => {
      if (settled) return
      let chunk = data
      if (preamble && mark) {
        preamble = Buffer.concat([preamble, chunk])
        // Anywhere: a profile may print without a newline (a terminal title), and the mark is random.
        const at = preamble.indexOf(mark)
        if (at >= 0) {
          chunk = preamble.subarray(at + mark.length)
          preamble = null
        } else if (preamble.length > PREAMBLE_MAX) {
          chunk = preamble
          preamble = null
        } else return
      }
      if (size + chunk.length > maxOutputBytes) {
        truncated = true
        out.push(chunk.subarray(0, maxOutputBytes - size))
        size = maxOutputBytes
        stop()
        return
      }
      size += chunk.length
      out.push(chunk)
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      // Only the tail is kept, so a chatty script cannot grow this without bound.
      stderr = (stderr + chunk.toString('utf8')).slice(-SCRIPT_STDERR_TAIL * 2)
    })
    child.on('error', (error) => { stderr += `${stderr ? '\n' : ''}${error.message}`; finish() })
    // `close` waits for the pipes; after `exit`, give buffered output a moment and no more.
    child.on('exit', (code) => {
      exitCode = code
      drainTimer ??= setTimeout(finish, EXIT_DRAIN_MS)
    })
    child.on('close', (code) => { exitCode ??= code; finish() })
    const input = (run.scriptOnFd3 ? child.stdio[3] : child.stdin) as NodeJS.WritableStream | null | undefined
    input?.on('error', () => { /* the child exited before reading its script; close reports it */ })
    input?.end(script)
  })
}
