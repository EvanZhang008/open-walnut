/**
 * exec.script ('host-script-v1'): a plugin's short script (`walnut.hosts.run`, through
 * src/core/hosts/host-script.ts), run as host_exec runs a line (the login shell first, then
 * bash) but bounded in memory with its stdout and stderr apart: no job, no log file, no audit
 * line, so a plugin that polls neither fills the disk nor pushes a task's jobs out of host_exec's.
 *
 * Bundled into host-exec-core (the binary daemon and the host-exec-core.cjs sidecar).
 */
import { randomBytes } from 'node:crypto'
import type { ChildProcess, SpawnOptions } from 'node:child_process'
import { permissionMessage, permissionRisk } from './host-exec-guards.js'
import { bad, resolveCwd, shellPlan, shellQuote, type ExecError } from './host-exec-line.js'
import { checkScriptInput, runBoundedScript, SCRIPT_REMOTE_MAX_OUTPUT, type ScriptResult } from './host-script-core.js'

export interface ScriptRunnerDeps {
  spawn: (cmd: string, args: string[], opts: SpawnOptions) => ChildProcess
  killGroup: (pid: number, signal: NodeJS.Signals | 0) => void
  /** The user's login shell; the line runs in `bash()` after it (null: sh). */
  shell: string
  bash: () => string | null
  home: string
  env: NodeJS.ProcessEnv
  /** The macOS guards apply. */
  mac: boolean
}

export function createScriptRunner(deps: ScriptRunnerDeps) {
  // Each running script's stop: a handover waits for them, and a forced update or close stops them.
  const running = new Set<() => void>()
  async function script(req: Record<string, unknown>): Promise<ScriptResult | ExecError> {
    const input = checkScriptInput(req)
    if ('error' in input) return bad(input.error)
    const cwd = resolveCwd(req.cwd, deps.home)
    if (typeof cwd !== 'string') return cwd
    // A place macOS guards shows a dialog on this Mac's screen, and the script waits on it.
    if (deps.mac && req.allowPrompts !== true) {
      const risk = permissionRisk(input.script, cwd, deps.home)
      if (risk) return bad(permissionMessage(risk, 'this Mac'), 'may_prompt')
    }
    // What the login profile prints comes before the mark, and is not the script's stdout.
    const mark = `walnut-script-${randomBytes(9).toString('hex')}`
    const login = deps.shell || '/bin/sh'
    // The script comes on fd 3, so the profile, which has no stdin, never reads it; the script reads it as its stdin, as with ssh.
    const plan = shellPlan(login, deps.bash(), `printf '%s\\n' ${mark}; exec sh -s --${input.args.map((a) => ` ${shellQuote(a)}`).join('')} <&3 3<&-`)
    let stopIt: (() => void) | null = null
    const run = runBoundedScript({
      spawn: deps.spawn, command: login, argv: plan.args, env: { ...deps.env, ...plan.env }, cwd,
      killGroup: deps.killGroup, stdoutAfter: mark, scriptOnFd3: true, onStop: (s) => { stopIt = s },
    }, { ...input, maxOutputBytes: Math.min(input.maxOutputBytes, SCRIPT_REMOTE_MAX_OUTPUT) })
    const stopper = () => stopIt?.()
    running.add(stopper)
    try { return await run } finally { running.delete(stopper) }
  }
  return {
    script,
    /** Scripts running now. */
    count: () => running.size,
    /** Stop every running script (its answer says timedOut); returns how many. */
    stopAll: (): number => { const all = [...running]; for (const s of all) s(); return all.length },
  }
}
