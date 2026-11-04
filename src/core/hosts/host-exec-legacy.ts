/**
 * host_exec on a host whose Walnut daemon is older than 'host-exec-v2'
 * (src/providers/host-exec-core.ts). Such a daemon runs a line in the user's
 * login shell as it is and gives the child no WALNUT_TASK_DIR: on a Mac that is
 * zsh, where `log` is a builtin and `echo ===` fails, and `> $WALNUT_TASK_DIR/x`
 * writes `/x` (2026-11-03). A machine that joined the host network updates its
 * daemon only with its own Walnut, so the server shapes the run itself.
 *
 * It sends the line as argv the old daemon already runs (`exec 'a' 'b'` under
 * the login shell, which still sets up PATH and the environment):
 *
 *   /bin/sh -c '<LEGACY_RUNNER>' sh '<line>' '<task dir>'
 *
 * The runner exports the task directory, then bash (sh with none) runs the line.
 * Two limits of the old daemon: an argv word holds at most 8 KB, so a longer line
 * runs as it is (in the login shell, without WALNUT_TASK_DIR); and it keeps a
 * task's logs, and so its directory, only for ids it accepts (below).
 */
import path from 'node:path'
import { HostExecError, hostName, type Caller, type ExecParams, type dial } from './host-exec.js'

/** An older daemon's longest argv word (host-exec-core.ts ARG_MAX_CHARS). */
const OLD_ARG_MAX_CHARS = 8 * 1024
/** The task ids an older daemon keeps logs under, making `<root>/<task id>` (its TASK_ID_RE). */
const OLD_TASK_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/

/**
 * /bin/sh runs it: $1 the line, $2 the task directory ('' for none). The same bash a current daemon
 * picks (host-exec-core.ts findBash: BASH_CANDIDATES, a Homebrew or MacPorts bash before the system
 * one, then PATH), so a run reads the same on either side of an upgrade.
 */
export const LEGACY_RUNNER = '[ -n "$2" ] && export WALNUT_TASK_DIR="$2"; for b in /opt/homebrew/bin/bash /usr/local/bin/bash /opt/local/bin/bash /bin/bash /usr/bin/bash; do [ -x "$b" ] && exec "$b" -c "$1"; done; '
  + 'command -v bash >/dev/null 2>&1 && exec bash -c "$1"; exec /bin/sh -c "$1"'

/** A line that reads WALNUT_TASK_DIR. */
export const USES_TASK_DIR = /\bWALNUT_TASK_DIR\b/

/** The caller task's directory on the host (the daemon's hello `taskDirRoot`), null when it keeps none for it. */
export function taskDirThere(root: string | null | undefined, taskId: string): string | null {
  return typeof root === 'string' && root.startsWith('/') && OLD_TASK_ID_RE.test(taskId) ? path.posix.join(root, taskId) : null
}

/** The argv an older daemon runs for `line`, or null when the line is too long for one of its argv words. */
export function legacyArgv(line: string, taskDir: string | null): string[] | null {
  if (line.length > OLD_ARG_MAX_CHARS || (taskDir ?? '').length > OLD_ARG_MAX_CHARS) return null
  return ['/bin/sh', '-c', LEGACY_RUNNER, 'sh', line, taskDir ?? '']
}

/** What ran a job's line, as the answer names it: the host's own words (host-exec-v2), else what this server shaped. */
export interface RunShape { shell?: string | null; loginShell?: string | null; taskDir?: string | null }

export function shapeOf(reply: Record<string, unknown>, known: RunShape = {}): RunShape {
  const pick = (k: keyof RunShape): string | null | undefined => {
    const v = reply[k]
    return typeof v === 'string' || v === null ? v : known[k]
  }
  const out: RunShape = {}
  for (const k of ['shell', 'loginShell', 'taskDir'] as const) {
    const v = pick(k)
    if (v !== undefined) out[k] = v
  }
  return out
}

/** What exec.run sends for this line, and what the answer can say about it that the host will not. */
export async function runRequest(conn: Awaited<ReturnType<typeof dial>>, host: string, caller: Caller, params: ExecParams, line: string): Promise<{ send: Record<string, unknown>; known: RunShape; before?: () => void }> {
  const { WALNUT_HOME } = await import('../../constants.js')
  const original = typeof params.command === 'string' && params.command.trim() !== '' ? { command: params.command } : { argv: params.argv }
  // The host runs it in bash with WALNUT_TASK_DIR set, and names both (host-exec-core.ts).
  if (conn.hasCapability('host-exec-v2')) return { send: { ...original, home: WALNUT_HOME }, known: {} }
  const taskDir = taskDirThere(conn.taskDirRoot, caller.taskId)
  const argv = legacyArgv(line, taskDir)
  if (USES_TASK_DIR.test(line) && (!taskDir || !argv)) {
    throw new HostExecError(taskDir
      ? `This line is too long for the Walnut daemon on ${await hostName(host)} to get WALNUT_TASK_DIR (it is older); nothing ran. Write the path itself: ${taskDir}`
      : `The Walnut daemon on ${await hostName(host)} keeps no task directory for this task, so WALNUT_TASK_DIR would be empty there; nothing ran.`, 409, 'task_dir_unset', taskDir ? { taskDir } : {})
  }
  // Its marker, naming this Walnut, so the task directory is cleaned up like any other (task-dir-sweep.ts).
  // Sent by the caller right before the run, after its last look at the grant: nothing reaches a host first.
  const before = taskDir && argv && conn.hasCapability('task-dir-v1')
    ? () => { void conn.send('taskdir.ensure', { taskId: caller.taskId, home: WALNUT_HOME }, 10_000).catch(() => {}) }
    : undefined
  return argv
    ? { send: { argv }, known: { shell: 'bash', loginShell: null, taskDir }, ...(before ? { before } : {}) }
    : { send: original, known: { shell: null, loginShell: null, taskDir: null } }
}
