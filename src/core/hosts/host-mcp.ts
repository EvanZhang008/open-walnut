/**
 * `host_mcp_*`: a task's session calls an MCP server configured on ANOTHER host
 * (the user, 2026-10-31: route the work "to the host that has it"; "it can call
 * this MCP across places"), through the link (link.ts). The server's config, its
 * sign-in and its env values stay on that host; the run itself is the host's
 * daemon's (src/providers/host-mcp-core.ts). This file is the gate, the same one
 * as host_exec's (host-exec.ts):
 *
 *   - only a task's session asks, never for its own host (its own MCP tools);
 *   - listing the server NAMES needs no grant (the host's capability card shows
 *     them already); its tools and every call need the user's grant for this task
 *     on this host, the one host_exec uses: one letter, kept until revoked;
 *   - at most 4 calls at once per task;
 *   - a call waits for its answer, from a session on another host at most about
 *     14 s (its gateway gives up at 20 s): a call still going comes back running
 *     with its call_id, and host_mcp_result reads it (never call it again);
 *   - text that looks like a credential is hidden before it leaves this server;
 *   - images become files in the calling task's directory (host-mcp-images.ts).
 */
import { randomUUID } from 'node:crypto'
import { log } from '../../logging/index.js'
import { HostExecError, budgetLeft, callerOf, dial, grantFor, redact, targetHost, type Caller } from './host-exec.js'
import { saveCallImages } from './host-mcp-images.js'

export const MAX_CALLS_PER_TASK = 4
const SAME_HOST = 'call the MCP server with your own tools'
const CAP = 'host-mcp-v1'
const WHAT = 'call its MCP servers'
const REPLY_MARGIN_MS = 5_000
const CALL_MAX_MS = 10 * 60_000
const LIST_MS = 15_000

/** In flight, by call: which task, until when (a call nobody reads again ends by its deadline). */
const inFlight = new Map<string, { taskId: string; until: number }>()

function countFor(taskId: string): number {
  const t = Date.now()
  let n = 0
  for (const [id, c] of inFlight) {
    if (c.until < t) { inFlight.delete(id); continue }
    if (c.taskId === taskId) n++
  }
  return n
}

/** How long the host may hold one answer for this caller (unbounded from the Mac, about 14 s from another host). */
function holdFor(caller: Caller, wanted: number, since: number): number {
  return Math.max(0, Math.min(wanted, budgetLeft(caller, since) - 2_000))
}

type Link = Awaited<ReturnType<typeof dial>>

async function ask(conn: Link, host: string, cmd: string, params: Record<string, unknown>, timeoutMs: number): Promise<Record<string, unknown>> {
  try {
    return await conn.send(cmd, params, timeoutMs) as Record<string, unknown>
  } catch (err) {
    throw new HostExecError(`Walnut lost ${host} while it answered (${err instanceof Error ? err.message : String(err)}).`, 503, 'host_offline', params.callId ? { callId: params.callId, mayHaveStarted: true } : {})
  }
}

/** The host's refusal; its words may quote the server's stderr, so a credential-looking line is hidden there too. */
async function daemonError(reply: Record<string, unknown>, fallback: string): Promise<HostExecError> {
  const code = typeof reply.code === 'string' ? reply.code : 'host_failed'
  const msg = typeof reply.error === 'string' ? (await redact(reply.error.replace(/^mcp\.\w+ failed: /, ''))).text : fallback
  const status = code === 'bad_request' || code === 'cwd_missing' || code === 'unsupported_transport' ? 400
    : code === 'unknown_server' || code === 'unknown_call' ? 404 : code === 'busy' ? 429 : 502
  return new HostExecError(msg, status, code)
}

/** A kept call as the agent reads it: still running, or its answer with credential-looking text hidden and its images saved. */
async function answerOf(caller: Caller, host: string, reply: Record<string, unknown>, t0: number): Promise<Record<string, unknown>> {
  if (reply.running === true) return { host, callId: reply.callId, running: true, ms: reply.ms }
  if (typeof reply.callId === 'string') inFlight.delete(reply.callId)
  if (reply.ok !== true) throw await daemonError(reply, 'the host could not call the server')
  const out: Record<string, unknown> = { host, callId: reply.callId, running: false, ms: reply.ms, server: reply.server }
  let redacted = 0
  if (Array.isArray(reply.tools)) {
    out.tools = reply.tools
  } else {
    const text = await redact(typeof reply.text === 'string' ? reply.text : '')
    redacted += text.redacted
    Object.assign(out, { tool: reply.tool, isError: reply.isError === true, text: text.text, truncated: reply.truncated === true,
      images: await saveCallImages(caller, String(reply.callId ?? ''), reply.images, t0) })
    if (reply.structured !== undefined) {
      // Structured data that carries a credential-looking line is dropped whole: its shape cannot hide one line.
      const s = await redact(JSON.stringify(reply.structured, null, 1))
      if (s.redacted) redacted += s.redacted
      else out.structured = reply.structured
    }
  }
  if (redacted) out.redactedLines = redacted
  return out
}

/**
 * The MCP servers Claude Code would see on that host: names only, with no grant (the host's
 * capability card shows them already). With `cwd` (that project's too) it needs the grant:
 * it says which folders exist there.
 */
export async function listHostMcp(params: { host: string; cwd?: string }, callerSid: string | undefined): Promise<Record<string, unknown>> {
  const t0 = Date.now()
  const caller = await callerOf(callerSid)
  const host = await targetHost(String(params.host ?? ''), caller, SAME_HOST)
  if (params.cwd) await grantFor(caller, host, `MCP: list the servers for ${params.cwd}`)
  const conn = await dial(host, budgetLeft(caller, t0) - 2_000, CAP, WHAT)
  const reply = await ask(conn, host, 'mcp.list', params.cwd ? { cwd: params.cwd } : {}, Math.min(LIST_MS, Math.max(1_000, budgetLeft(caller, t0) - 1_000)))
  if (reply.ok !== true) throw await daemonError(reply, 'the host could not list its MCP servers')
  return { host, servers: reply.servers ?? [] }
}

async function start(caller: Caller, host: string, cmd: 'mcp.tools' | 'mcp.call', params: Record<string, unknown>, preview: string, deadlineMs: number, t0: number): Promise<Record<string, unknown>> {
  const grantId = await grantFor(caller, host, preview)
  if (countFor(caller.taskId) >= MAX_CALLS_PER_TASK) {
    throw new HostExecError(`This task already has ${MAX_CALLS_PER_TASK} MCP calls running on other hosts; read one with host_mcp_result first.`, 429, 'busy')
  }
  const callId = `mc-${randomUUID()}`
  // The link first, then how long the host may hold the answer: a slow dial leaves less of the
  // relayed caller's budget, and an answer that cannot get back in time must not start anything.
  const conn = await dial(host, budgetLeft(caller, t0) - 4_000, CAP, WHAT)
  const wait = holdFor(caller, deadlineMs, t0)
  if (wait < 1_000) throw new HostExecError(`${host} answered too slowly to start the call in time; nothing ran. Try again.`, 503, 'host_offline')
  inFlight.set(callId, { taskId: caller.taskId, until: Date.now() + deadlineMs + REPLY_MARGIN_MS })
  let reply: Record<string, unknown>
  try {
    reply = await ask(conn, host, cmd, { ...params, callId, taskId: caller.taskId, wait }, wait + Math.min(REPLY_MARGIN_MS, Math.max(1_000, budgetLeft(caller, t0) - wait)))
  } catch (err) {
    if (err instanceof HostExecError) err.message += ` It may have started there as call ${callId}: read it with host_mcp_result before calling again.`
    throw err
  }
  if (reply.ok === false) inFlight.delete(callId)
  else void import('./exec-grants.js').then((g) => g.noteRun(grantId, preview))
  const out = await answerOf(caller, host, reply, t0)
  log.session.info('host mcp', {
    taskId: caller.taskId, fromHost: caller.host, host, cmd, callId, server: params.server, tool: params.tool ?? null,
    running: out.running, isError: out.isError ?? null, ms: Date.now() - t0, redacted: out.redactedLines ?? 0,
  })
  return out
}

/** The tools one MCP server on that host offers (the server starts when it is not running). */
export async function hostMcpTools(params: { host: string; server: string; cwd?: string }, callerSid: string | undefined): Promise<Record<string, unknown>> {
  const t0 = Date.now()
  if (!params.server) throw new HostExecError('server is required (host_mcp_list names them)', 400, 'bad_request')
  const caller = await callerOf(callerSid)
  const host = await targetHost(String(params.host ?? ''), caller, SAME_HOST)
  return start(caller, host, 'mcp.tools', { server: params.server, ...(params.cwd ? { cwd: params.cwd } : {}) }, `MCP ${params.server}: list its tools`, 2 * 60_000, t0)
}

/** Call one tool of an MCP server on that host. */
export async function hostMcpCall(params: { host: string; server: string; tool: string; arguments?: Record<string, unknown>; cwd?: string; timeout_ms?: number }, callerSid: string | undefined): Promise<Record<string, unknown>> {
  const t0 = Date.now()
  if (!params.server || !params.tool) throw new HostExecError('server and tool are required (host_mcp_tools names the tools)', 400, 'bad_request')
  if (params.arguments !== undefined && (typeof params.arguments !== 'object' || params.arguments === null || Array.isArray(params.arguments))) {
    throw new HostExecError('arguments must be an object', 400, 'bad_request')
  }
  const caller = await callerOf(callerSid)
  const host = await targetHost(String(params.host ?? ''), caller, SAME_HOST)
  const timeoutMs = Math.min(typeof params.timeout_ms === 'number' && params.timeout_ms > 0 ? params.timeout_ms : 60_000, CALL_MAX_MS)
  const args = JSON.stringify(params.arguments ?? {})
  const preview = `MCP ${params.server}: ${params.tool} ${args.length > 300 ? `${args.slice(0, 300)}…` : args}`
  return start(caller, host, 'mcp.call', {
    server: params.server, tool: params.tool, arguments: params.arguments ?? {}, timeoutMs, ...(params.cwd ? { cwd: params.cwd } : {}),
  }, preview, timeoutMs, t0)
}

/** A call's answer, waiting up to `wait_ms` for it; only the task that started it reads it. */
export async function hostMcpResult(params: { host: string; call_id: string; wait_ms?: number }, callerSid: string | undefined): Promise<Record<string, unknown>> {
  const t0 = Date.now()
  const caller = await callerOf(callerSid)
  const host = await targetHost(String(params.host ?? ''), caller, SAME_HOST)
  await grantFor(caller, host, null)
  const conn = await dial(host, budgetLeft(caller, t0) - 3_000, CAP, WHAT)
  const wait = holdFor(caller, typeof params.wait_ms === 'number' && params.wait_ms > 0 ? Math.min(params.wait_ms, 60_000) : 0, t0)
  const reply = await ask(conn, host, 'mcp.result', { callId: params.call_id, taskId: caller.taskId, wait }, wait + Math.min(REPLY_MARGIN_MS, Math.max(1_000, budgetLeft(caller, t0) - wait)))
  return answerOf(caller, host, reply, t0)
}

/** Tests: forget the in-flight calls. */
export function resetHostMcpForTest(): void {
  inFlight.clear()
}
