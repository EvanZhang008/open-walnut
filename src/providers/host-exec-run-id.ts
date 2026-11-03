/**
 * A `host_exec` run's id, chosen by the CALLER before the call leaves this process.
 *
 * 2026-11-03: a session on another host called host_exec on the Mac; under load the
 * Mac's answer missed the gateway's 20 s and the call came back
 * `hub_timeout: primary server timed out`, with no job id, although the command had
 * started there. Its output was lost and host_exec_read had nothing to read. With the
 * id picked here and sent as `job_id`, the server runs the job under it (and answers
 * a second call with the same id from the same task with that run, never a new one),
 * so a lost answer still leaves an id to read.
 *
 * Used by every client that sends an op: the `walnut` CLI and the MCP stdio server on
 * any host (wn-cli.ts, walnut-mcp-stdio.ts, bundled into the daemon; the source twin's
 * small CLI mirrors it), and the Mac's own CLI (src/commands/tools.ts). A Walnut server
 * older than the field refuses it as an unknown key before anything runs (refusedRunId):
 * the client then calls once more without it, and that server picks the id.
 *
 * `hub_unreachable` is not a lost answer: the call never reached the server, so nothing
 * ran (awayLines says so, and that a job started before keeps running).
 */
import { randomUUID } from 'node:crypto'

/** Ops whose run a lost answer must not lose: the op, its id field, and the op that reads the run. */
const RUN_OPS: Record<string, { field: string; prefix: string; read: string; copy?: true }> = {
  host_exec: { field: 'job_id', prefix: 'hx-', read: 'host_exec_read' },
  // A copy between two hosts runs on the server (core/hosts/host-copy.ts), so its read names no host.
  host_copy: { field: 'copy_id', prefix: 'hc-', read: 'host_copy_result', copy: true },
}

/** The run's id for this call (the caller's own when it gave one), written into `args`; null for an op with none. */
export function callerRunId(name: string, args: Record<string, unknown>, newId: () => string = randomUUID): string | null {
  const op = Object.hasOwn(RUN_OPS, name) ? RUN_OPS[name] : undefined
  if (!op) return null
  const given = args[op.field]
  if (typeof given === 'string' && given) return given
  const id = `${op.prefix}${newId()}`
  args[op.field] = id
  return id
}

/**
 * Whether `message` is a Walnut server refusing the run id as an unknown argument (one older
 * than it): nothing ran, and the same call without the id is what that server takes.
 */
export function refusedRunId(name: string, message: string): boolean {
  const op = Object.hasOwn(RUN_OPS, name) ? RUN_OPS[name] : undefined
  if (!op || !message.includes(`Invalid arguments for ${name}:`)) return false
  return new RegExp(`Unrecognized keys?: [^;]*"${op.field}"`).test(message)
}

/** The ops whose jobs keep running while the server is away: host_exec_read, _stop and _list name a job or a host. */
const JOB_OPS = new Set(['host_exec_read', 'host_exec_stop', 'host_exec_list'])

/**
 * What a caller is told when its call never left: the server could not be reached (`hub_unreachable`),
 * or this host's daemon socket refused the connection (`missed` names it). Nothing ran, and jobs
 * started before still run.
 */
export function awayLines(name: string, args: Record<string, unknown>, missed = 'the Walnut server'): string[] {
  const host = String(args.host ?? 'that host')
  const short = missed.replace(' Walnut ', ' ')
  if (Object.hasOwn(RUN_OPS, name) && RUN_OPS[name].copy) return [`walnut: ${name} did not reach ${missed}, so nothing was copied; call it again once ${short} answers.`]
  if (Object.hasOwn(RUN_OPS, name)) return [`walnut: ${name} did not reach ${missed}, so nothing ran on ${host}; call it again once ${short} answers.`]
  if (!JOB_OPS.has(name)) return []
  const log = typeof args.job_id === 'string' ? ` (host-exec/${args.job_id}.log)` : ''
  return [`walnut: a job host_exec already started on ${host} keeps running meanwhile, and its log stays in your task's directory there${log}; read it once ${short} answers.`]
}

/** A socket error from before the request was written (nothing listens there): the call never left. */
export function neverSent(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code
  return code === 'ENOENT' || code === 'ECONNREFUSED' || code === 'EACCES' || code === 'ENOTSOCK'
}

/** Take the run id back out of `args` (for a server older than it, which refused it). */
export function dropRunId(name: string, args: Record<string, unknown>): void {
  if (Object.hasOwn(RUN_OPS, name)) delete args[RUN_OPS[name].field]
}

/** Single-quoted for a POSIX shell. */
function shellWord(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`
}

/**
 * What a caller is told when the call's answer did not come back (`hub_timeout`, its own
 * timeout, a socket that closed): the run may have started, under this id, and how to read it.
 */
export function lostRunLines(name: string, args: Record<string, unknown>, runId: string): string[] {
  const op = Object.hasOwn(RUN_OPS, name) ? RUN_OPS[name] : undefined
  if (!op) return []
  if (op.copy) {
    return [
      `walnut: ${name} may have started as copy ${runId}: do not start it again. Read it first:`,
      `  walnut tools call ${op.read} ${shellWord(JSON.stringify({ [op.field]: runId, wait_ms: 10_000 }))}`,
      `walnut: (if that read says unknown_copy, the copy never reached the Walnut server: call ${name} again)`,
    ]
  }
  const read = JSON.stringify({ host: args.host, [op.field]: runId, wait_ms: 10_000 })
  return [
    `walnut: ${name} may have started on ${String(args.host)} as job ${runId}: do not run it again. Read it first:`,
    `  walnut tools call ${op.read} ${shellWord(read)}`,
    `walnut: (if that read says unknown_job, the run never reached ${String(args.host)}: host_exec_list ${shellWord(JSON.stringify({ host: args.host }))} lists this task's jobs there)`,
  ]
}
