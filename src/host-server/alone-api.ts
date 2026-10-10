/**
 * What a host server answers itself while neither the Mac nor the companion
 * does (docs/plan/walnut-servers-everywhere.md, "Host server, leader away"):
 * this Walnut's sessions on this host, read from and written to through the
 * host's daemon (`follower.sessions`, `read-history`, `follower.send`,
 * `follower.permission`). The daemon keeps every write in its journal, which
 * the Mac drains when it is back, as it drains a session's own writes.
 *
 *   GET  /_alone/state                          route, and whether this browser's token holds (no names)
 *   GET  /_alone/sessions                       the list
 *   GET  /_alone/sessions/:sid/transcript       the last rows of a conversation
 *   POST /_alone/sessions/:sid/messages         {text, messageId?}
 *   POST /_alone/sessions/:sid/permission       {requestId, allow, message?, answers?}
 *
 * Everything but /state needs a device token the Mac's copy names
 * (device-copy.ts), and answers only while this server is alone: a request
 * that arrives while the Mac or the companion answers gets 409, and the page
 * opens the full console.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { DeviceCopy } from './device-copy.js'
import type { Route } from './route.js'

export const ALONE_PREFIX = '/_alone/'
/** How much of a conversation's file one transcript read takes. */
const TRANSCRIPT_TAIL_BYTES = 512 * 1024
const BODY_MAX_BYTES = 256 * 1024
const TEXT_MAX_CHARS = 100_000
const SID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{7,63}$/

export interface AloneApiDeps {
  label: string
  route: () => Route
  devices: DeviceCopy
  /** A command on the link to this host's daemon. */
  request: (cmd: string, params: Record<string, unknown>, timeoutMs?: number) => Promise<Record<string, unknown>>
  /** The transcript shape the phone reads, from a conversation file's tail. */
  transcript: (sid: string, jsonl: string) => Promise<Record<string, unknown>>
  log: (level: 'info' | 'warn', msg: string, data?: Record<string, unknown>) => void
}

class AloneError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message) }
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', 'content-length': Buffer.byteLength(text) })
  res.end(text)
}

function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let size = 0
    let over = false
    const parts: Buffer[] = []
    req.on('data', (c: Buffer) => {
      size += c.length
      // The rest is read and dropped, so the answer still reaches the browser.
      if (size > BODY_MAX_BYTES) { over = true; parts.length = 0; return }
      if (!over) parts.push(c)
    })
    req.on('end', () => {
      if (over) return reject(new AloneError(413, 'too_large', 'The message is too large.'))
      if (parts.length === 0) return resolve({})
      try {
        const v = JSON.parse(Buffer.concat(parts).toString('utf8'))
        resolve(v && typeof v === 'object' && !Array.isArray(v) ? v : {})
      } catch {
        reject(new AloneError(400, 'bad_request', 'The body is not JSON.'))
      }
    })
    req.on('error', reject)
  })
}

/** The daemon's refusal, as the Mac's API would say it. */
function daemonError(r: Record<string, unknown>, what: string): AloneError {
  const kind = typeof r.errorKind === 'string' ? r.errorKind : ''
  const message = String(r.error ?? `${what} failed`).replace(/^[\w.]+: /, '')
  if (kind === 'not_found') return new AloneError(404, 'not_found', message)
  if (kind === 'bad_request') return new AloneError(400, 'bad_request', message)
  if (kind === 'not_running') return new AloneError(409, 'not_running', message)
  if (kind === 'leader_answers') return new AloneError(409, 'leader_answers', message)
  if (kind === 'queue_full') return new AloneError(503, 'busy', message)
  if (kind === 'follower_refused') return new AloneError(503, 'daemon_needs_upgrade', 'This host\'s Walnut daemon is older than this server; your Mac upgrades it when it answers.')
  return new AloneError(502, 'daemon_error', message)
}

export function createAloneApi(deps: AloneApiDeps) {
  function tokenOf(req: IncomingMessage): string | null {
    const h = req.headers.authorization
    if (typeof h !== 'string') return null
    const m = /^Bearer\s+(\S+)$/i.exec(h.trim())
    return m ? m[1]! : null
  }

  function authState(req: IncomingMessage): 'ok' | 'no_token' | 'unknown_token' | 'no_copy' {
    const token = tokenOf(req)
    if (!token) return 'no_token'
    if (!deps.devices.held()) return 'no_copy'
    return deps.devices.verify(token) ? 'ok' : 'unknown_token'
  }

  function requireDevice(req: IncomingMessage): string {
    const token = tokenOf(req)
    if (!token) throw new AloneError(401, 'unauthorized', 'This browser is not signed in to Walnut.')
    if (!deps.devices.held()) {
      throw new AloneError(401, 'no_device_copy', 'This server has not received your signed-in devices from your Mac yet, so it cannot check this browser.')
    }
    const name = deps.devices.verify(token)
    if (!name) throw new AloneError(401, 'unauthorized', 'This browser\'s sign-in is not known here. Sign it in again while your Mac answers.')
    return name
  }

  async function call(cmd: string, params: Record<string, unknown>, what: string, timeoutMs?: number): Promise<Record<string, unknown>> {
    let r: Record<string, unknown>
    try {
      r = await deps.request(cmd, params, timeoutMs)
    } catch (err) {
      throw new AloneError(503, 'no_daemon', `This host's Walnut daemon did not answer (${err instanceof Error ? err.message : String(err)}).`)
    }
    if (r.ok !== true) throw daemonError(r, what)
    return r
  }

  async function sessions(): Promise<Record<string, unknown>> {
    const r = await call('follower.sessions', {}, 'the session list')
    return { host: r.host ?? deps.label, asOf: r.asOf ?? null, sessions: Array.isArray(r.sessions) ? r.sessions : [] }
  }

  async function transcript(sid: string): Promise<Record<string, unknown>> {
    const r = await call('read-history', { sid, tailBytes: TRANSCRIPT_TAIL_BYTES }, 'reading the conversation', 15_000)
    return deps.transcript(sid, typeof r.main === 'string' ? r.main : '')
  }

  async function message(sid: string, body: Record<string, unknown>, device: string): Promise<Record<string, unknown>> {
    const text = typeof body.text === 'string' ? body.text.trim() : ''
    if (!text) throw new AloneError(400, 'bad_request', 'Write a message first.')
    if (text.length > TEXT_MAX_CHARS) throw new AloneError(413, 'too_large', 'The message is too long.')
    // The daemon's message id shape (offline-host-core.ts messageId); another one gets a fresh id there.
    const messageId = typeof body.messageId === 'string' && /^qm-[A-Za-z0-9-]{1,64}$/.test(body.messageId) ? body.messageId : undefined
    const r = await call('follower.send', { sid, text, ...(messageId ? { messageId } : {}) }, 'sending', 20_000)
    deps.log('info', 'host server: a message sent while alone', { sid, device, messageId: r.messageId })
    return { status: 'delivered', sessionId: sid, messageId: r.messageId ?? messageId ?? null }
  }

  async function permission(sid: string, body: Record<string, unknown>, device: string): Promise<Record<string, unknown>> {
    const r = await call('follower.permission', {
      sid, requestId: body.requestId, allow: body.allow,
      ...(body.message !== undefined ? { message: body.message } : {}),
      ...(body.answers !== undefined ? { answers: body.answers } : {}),
    }, 'answering', 20_000)
    deps.log('info', 'host server: a prompt answered while alone', { sid, device, requestId: r.requestId, allow: r.allow })
    return { status: 'resolved', requestId: r.requestId, allow: r.allow }
  }

  /** True when the request was this API's (answered or refused here). */
  async function handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const url = new URL(req.url ?? '/', 'http://host')
    if (!url.pathname.startsWith(ALONE_PREFIX)) return false
    const rest = url.pathname.slice(ALONE_PREFIX.length).split('/').map((p) => { try { return decodeURIComponent(p) } catch { return '\u0000' } })
    try {
      const route = deps.route()
      if (req.method === 'GET' && rest.length === 1 && rest[0] === 'state') {
        send(res, 200, { route: route.kind, ...(route.kind === 'alone' ? { why: route.why } : {}), label: deps.label, auth: authState(req) })
        return true
      }
      const device = requireDevice(req)
      if (route.kind !== 'alone') throw new AloneError(409, 'leader_answers', 'Walnut answers again: open it.')
      if (req.method === 'GET' && rest.length === 1 && rest[0] === 'sessions') {
        send(res, 200, await sessions())
        return true
      }
      if (rest.length === 3 && rest[0] === 'sessions') {
        const sid = rest[1]!
        if (!SID_RE.test(sid)) throw new AloneError(400, 'bad_request', 'Invalid session id.')
        if (req.method === 'GET' && rest[2] === 'transcript') { send(res, 200, await transcript(sid)); return true }
        if (req.method === 'POST' && rest[2] === 'messages') { send(res, 200, await message(sid, await readBody(req), device)); return true }
        if (req.method === 'POST' && rest[2] === 'permission') { send(res, 200, await permission(sid, await readBody(req), device)); return true }
      }
      throw new AloneError(404, 'not_found', 'No such request here.')
    } catch (err) {
      const e = err instanceof AloneError ? err : new AloneError(500, 'internal', err instanceof Error ? err.message : String(err))
      if (e.status >= 500) deps.log('warn', 'host server: an alone request failed', { path: url.pathname, status: e.status, error: e.message })
      if (!res.headersSent) send(res, e.status, { error: { code: e.code, message: e.message } })
      return true
    }
  }

  return { handle }
}
