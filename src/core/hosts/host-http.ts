/**
 * `host_http`: a task's session makes one HTTP request FROM another host (the
 * user, 2026-10-31: "a web service ... we can call it directly"), so it reaches a
 * service only that machine can: a dev server on its localhost, a service on its
 * network. The request itself is the host's daemon's (src/providers/host-http-core.ts);
 * this file is the gate, the same as host_exec's (host-exec.ts): a task's session
 * only, never its own host (its own curl), under the user's grant for this task on
 * this host, at most 4 at once per task, and a body that looks like a credential
 * line by line is hidden before it leaves this server. From a session on another
 * host a request gets about 12 s (its gateway gives up at 20 s).
 */
import { log } from '../../logging/index.js'
import { HostExecError, assertStillGranted, budgetLeft, callerOf, dial, grantFor, redact, targetHost } from './host-exec.js'

export const MAX_REQUESTS_PER_TASK = 4
const DEFAULT_MS = 30_000
const MAX_MS = 5 * 60_000

const running = new Map<string, number>()

export interface HttpParams {
  host: string
  url: string
  method?: string
  headers?: Record<string, string>
  body?: string
  body_base64?: string
  timeout_ms?: number
}

export async function httpOnHost(params: HttpParams, callerSid: string | undefined): Promise<Record<string, unknown>> {
  const t0 = Date.now()
  if (typeof params.url !== 'string' || !/^https?:\/\//i.test(params.url)) throw new HostExecError('url must be an absolute http:// or https:// address', 400, 'bad_request')
  const caller = await callerOf(callerSid)
  const host = await targetHost(String(params.host ?? ''), caller, 'make the request with your own tools (curl)')
  const method = (params.method || 'GET').toUpperCase()
  const preview = `${method} ${params.url}`.slice(0, 1500)
  const grantId = await grantFor(caller, host, preview)
  if ((running.get(caller.taskId) ?? 0) >= MAX_REQUESTS_PER_TASK) {
    throw new HostExecError(`This task already has ${MAX_REQUESTS_PER_TASK} requests running on other hosts; wait for one.`, 429, 'busy')
  }
  const left = budgetLeft(caller, t0) - 3_000
  const wanted = Math.min(typeof params.timeout_ms === 'number' && params.timeout_ms > 0 ? params.timeout_ms : DEFAULT_MS, MAX_MS)
  const timeoutMs = Math.min(wanted, left - 2_000)
  if (timeoutMs < 1_000) throw new HostExecError(`${host} answered too slowly to send the request in time; nothing was sent. Try again.`, 503, 'host_offline')
  // Counted before the dial, so requests that arrive together cannot all pass the cap.
  running.set(caller.taskId, (running.get(caller.taskId) ?? 0) + 1)
  let reply: Record<string, unknown>
  let used = grantId
  try {
    const conn = await dial(host, left - timeoutMs, 'host-http-v1', 'make web requests')
    // The dial took time: a revoke or the host's stop since the grant sends nothing.
    used = await assertStillGranted(caller.taskId, host, grantId)
    reply = await conn.send('http.request', {
      url: params.url, method, ...(params.headers ? { headers: params.headers } : {}),
      ...(typeof params.body === 'string' ? { body: params.body } : {}), ...(typeof params.body_base64 === 'string' ? { bodyBase64: params.body_base64 } : {}),
      timeoutMs,
    }, timeoutMs + 3_000) as Record<string, unknown>
  } catch (err) {
    if (err instanceof HostExecError) throw err
    throw new HostExecError(`Walnut lost ${host} while it answered (${err instanceof Error ? err.message : String(err)}); the request may have been sent.`, 503, 'host_offline')
  } finally {
    const n = (running.get(caller.taskId) ?? 1) - 1
    if (n > 0) running.set(caller.taskId, n)
    else running.delete(caller.taskId)
  }
  if (reply.ok !== true) {
    const code = typeof reply.code === 'string' ? reply.code : 'host_failed'
    throw new HostExecError(typeof reply.error === 'string' ? reply.error.replace(/^http\.request failed: /, '') : 'the host could not make the request',
      code === 'bad_request' ? 400 : code === 'timeout' ? 504 : 502, code)
  }
  void import('./exec-grants.js').then((g) => g.noteRun(used, preview))
  const headers = (reply.headers ?? {}) as Record<string, string>
  const headerText = await redact(Object.entries(headers).map(([k, v]) => `${k}: ${v}`).join('\n'))
  const safeHeaders: Record<string, string> = {}
  headerText.text.split('\n').forEach((line, i) => {
    const k = Object.keys(headers)[i]
    if (k) safeHeaders[k] = line.startsWith('[Walnut hid') ? '[hidden by Walnut: it looks like a credential]' : headers[k]
  })
  const body = typeof reply.body === 'string' ? await redact(reply.body) : null
  const redacted = headerText.redacted + (body?.redacted ?? 0)
  const out: Record<string, unknown> = {
    host, url: reply.url, status: reply.status, statusText: reply.statusText, headers: safeHeaders, contentType: reply.contentType,
    ...(body ? { body: body.text } : { bodyBase64: reply.bodyBase64 }),
    bodyBytes: reply.bodyBytes, truncated: reply.truncated === true, ms: reply.ms, ...(redacted ? { redactedLines: redacted } : {}),
  }
  log.session.info('host http', {
    taskId: caller.taskId, fromHost: caller.host, host, method, url: params.url.slice(0, 300), status: reply.status,
    bytes: reply.bodyBytes, ms: Date.now() - t0, redacted,
  })
  return out
}

/** Tests: forget the in-flight counts. */
export function resetHostHttpForTest(): void {
  running.clear()
}
