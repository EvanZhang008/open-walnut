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
import { randomUUID } from 'node:crypto'
import type { ScriptResult } from '../../providers/host-script-core.js'
import { linkFailureKind } from '../../providers/link-failure.js'
import { HOST_SCRIPT_DETACH_CAPABILITY, workSurvives } from './work-survives.js'

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
  hasCapability?(name: string): boolean
}

/** A detached run ('host-script-detach-v1'): its id, the same on every ask, and how long to wait now. */
export interface DetachedAsk { scriptId: string; waitMs: number }

/** The daemon's answer as a run result; its refusal as an Error with its words. */
export async function runScriptOverLink(conn: ScriptConn, input: HostScriptInput, detached?: DetachedAsk): Promise<ScriptResult> {
  const reply = detached
    ? await conn.send('exec.script', { ...input, scriptId: detached.scriptId, detach: true }, detached.waitMs)
    : await conn.send('exec.script', { ...input }, input.timeoutMs + REPLY_MARGIN_MS)
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

/** Between two asks of a detached run whose link went: the host's daemon restarting. */
const REASK_MS = 1_000

/**
 * The link to `host`, as host_exec dials it, then the run. A run that outlives the host's daemon
 * (work-survives.ts) is asked again by its id when the link went while it ran (a restart there):
 * the daemon that answers gives that run's result, never a second run (host-script-detached.ts).
 */
export async function runScriptOnHost(host: string, input: HostScriptInput, o: { dial?: (host: string) => Promise<ScriptConn>; reaskMs?: number } = {}): Promise<ScriptResult> {
  const dialHost = o.dial ?? (async (h: string) => {
    const { dial } = await import('./host-exec.js')
    return (await dial(h, undefined, HOST_SCRIPT_CAPABILITY, 'run plugin scripts')) as unknown as ScriptConn
  })
  let conn = await dialHost(host)
  if (!(await workSurvives(conn, HOST_SCRIPT_DETACH_CAPABILITY))) return runScriptOverLink(conn, input)
  const scriptId = `hs-${randomUUID()}`
  const until = Date.now() + input.timeoutMs + REPLY_MARGIN_MS
  for (;;) {
    try {
      return await runScriptOverLink(conn, input, { scriptId, waitMs: Math.max(1_000, until - Date.now()) })
    } catch (err) {
      // Only a link that went (or none yet, while asking again) is asked again; the run's own failure,
      // or no answer by its deadline, is the answer.
      const kind = linkFailureKind(err)
      if ((kind !== 'lost' && kind !== 'no-link') || Date.now() + (o.reaskMs ?? REASK_MS) >= until) throw err
    }
    for (;;) {
      await new Promise((r) => setTimeout(r, o.reaskMs ?? REASK_MS))
      try { conn = await dialHost(host); break } catch (err) { if (Date.now() >= until) throw err }
    }
    // The host came back as a version that cannot follow the run: it ended it (a rollback).
    if (typeof conn.hasCapability === 'function' && !conn.hasCapability(HOST_SCRIPT_DETACH_CAPABILITY)) {
      throw new Error('Walnut on the host was put back to an older version while the script ran, which stopped it; run it again if it is still needed')
    }
  }
}
