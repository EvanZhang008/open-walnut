/**
 * A short POSIX sh script on another host Walnut knows, with its stdout and stderr apart: the
 * remote side of a plugin's `walnut.hosts.run` (src/core/plugins/plugin-hosts.ts).
 *
 * It goes the way every feature reaches a host (link.ts): the pooled link to the host's daemon,
 * dialled by host_exec's own `dial()` (the capability check, the quiet-link check), and the
 * daemon's `exec.script` ('host-script-v1', host-exec-core.ts), which runs it with the same
 * bounded runner the server uses for this machine (src/providers/host-script-core.ts). So a host
 * on the host network (`transport: net`, no SSH route at all) works exactly like an SSH one.
 * 2026-11-16: hosts.run built its own `ssh <hostname>`, and every run to a net host failed with
 * "Could not resolve hostname clouddev.walnut-net.invalid".
 *
 * Not exec.run: that keeps a job, a log file and an audit line per run, which a plugin polling
 * every few seconds would pile up on the host and use to push a task's own host_exec jobs out of
 * the daemon's job table.
 */
import type { ScriptResult } from '../../providers/host-script-core.js'

export const HOST_SCRIPT_CAPABILITY = 'host-script-v1'
/** The answer of a run beyond its own deadline: the host's kill grace and the way back. */
const REPLY_MARGIN_MS = 20_000

export interface HostScriptInput {
  script: string
  args: string[]
  timeoutMs: number
  maxOutputBytes: number
}

/** What this needs of a daemon link (DaemonConnection). */
export interface ScriptConn {
  send(cmd: string, params?: Record<string, unknown>, timeoutMs?: number): Promise<Record<string, unknown>>
}

/** The daemon's answer as a run result; its refusal as an Error with its words. */
export async function runScriptOverLink(conn: ScriptConn, input: HostScriptInput): Promise<ScriptResult> {
  const reply = await conn.send('exec.script', { ...input }, input.timeoutMs + REPLY_MARGIN_MS)
  if (reply.ok !== true) {
    throw new Error(typeof reply.error === 'string' ? reply.error.replace(/^exec\.script failed: /, '') : 'the host refused the script')
  }
  return {
    code: typeof reply.code === 'number' ? reply.code : null,
    stdout: typeof reply.stdout === 'string' ? reply.stdout : '',
    stderr: typeof reply.stderr === 'string' ? reply.stderr : '',
    timedOut: reply.timedOut === true,
    truncated: reply.truncated === true,
  }
}

/** The link to `host`, as host_exec dials it, then the run. */
export async function runScriptOnHost(host: string, input: HostScriptInput): Promise<ScriptResult> {
  const { dial } = await import('./host-exec.js')
  const conn = await dial(host, undefined, HOST_SCRIPT_CAPABILITY, 'run plugin scripts')
  return runScriptOverLink(conn as unknown as ScriptConn, input)
}
