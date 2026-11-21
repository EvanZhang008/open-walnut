/**
 * The Mac's door for the companion's forward on a stream ('bridge-stream-v1',
 * docs/plan/walnut-replica-servers-impl.md WP13; the companion's half is
 * stream-forward.ts). The companion asks the Mac's own daemon, over its bridge
 * socket, for a stream to the primary; the daemon hands it to this server's
 * link (providers/daemon-connection.ts), which plugs it in here.
 *
 * The same rules as the server.http forward (target.ts checkForwardCall and
 * settleKeptCall, the two steps checkForwardTarget runs: one check for both
 * doors), on bytes instead of one JSON frame, so no size cap: only /api/v1 (and
 * the console's task-store writes and its calls about what the companion's copy
 * does not keep, on the exact lists in policy.ts), never a route the companion
 * keeps for itself unless its copy cannot answer it, only the content and cache
 * headers cross (never a credential or a Walnut caller header), and every call
 * reaches this server's own routes over loopback labelled
 * `x-walnut-origin: remote-http`. Every route
 * then applies the rule it applies to a paired phone. A call refused here
 * answers with `x-walnut-forward-refused: 1`, so the companion answers it itself.
 *
 * No WebSocket crosses: this server serves none under /api/v1 (ws/handler.ts takes
 * /ws only, and the phone's /ws and /api/v1/events stay on the companion), so an
 * upgrade is refused here like any call the door would not run.
 *
 * A stream carries one call. One that sends no request, or stays open after its
 * answer, is closed by its own idle timer (a stream is no socket: the server's
 * header and keep-alive timeouts never run on it).
 */

import http, { type IncomingMessage, type ServerResponse } from 'node:http'
import type { Duplex } from 'node:stream'
import { getSelfApiRoot } from '../../lib/self-api-root.js'
import { ORIGIN_HEADER, REMOTE_HTTP_ORIGIN, lowerOrigin } from '../../lib/caller-origin.js'
import { controlRefusedForHost, controlRelayOrigin } from '../../core/sessions/control-host-policy.js'
import { bootPolicy } from '../../core/boot-policy.js'
import { forwardRequestHeaders, forwardResponseHeaders, noteForwardedTaskWrite } from './policy.js'
import { checkForwardCall, settleKeptCall, type Checked } from './target.js'

/** Set on an answer the door gave itself: nothing ran here, the companion may answer the call. */
export const FORWARD_REFUSED_HEADER = 'x-walnut-forward-refused'

/**
 * Set on the door's 502 when this server's own route could not be reached (its
 * listener closing in a shutdown): the companion treats the call as unanswered
 * (a read from its copy, a write told it may have applied), never as an answer.
 */
export const FORWARD_FAILED_HEADER = 'x-walnut-forward-failed'

/** A stream with no request this long, or open this long after its answer, is closed. */
const STREAM_IDLE_MS = 30_000
const STREAM_AFTER_ANSWER_MS = 5_000

export interface CompanionDoor {
  /**
   * A stream the companion opened to this server (through its daemon): served here.
   * `relayOrigin` is who the relaying daemon acts for (control-host-policy.ts
   * controlRelayOrigin); a call never acts above a client off this Mac.
   */
  accept(stream: Duplex, relayOrigin?: string): void
  close(): void
  /** Calls served and refused, for the forward status line. */
  stats(): { served: number; refused: number }
}

export interface CompanionDoorOptions {
  /** This server's own root (self-api-root.ts); a test passes its own. */
  root?: () => string | null
  log?: (level: 'info' | 'warn', msg: string, data?: Record<string, unknown>) => void
  /** A stream with no request this long is closed (tests pass a short one). */
  idleMs?: number
  /** A stream still open this long after its answer is closed. */
  afterAnswerMs?: number
}

function refuse(res: ServerResponse, status: number, message: string): void {
  const text = JSON.stringify({ error: { code: 'forward_refused', message } })
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text), [FORWARD_REFUSED_HEADER]: '1' })
  res.end(text)
}

/** Who each accepted stream's calls act for, as target.ts labels a server.http call. */
const streamOrigin = new WeakMap<object, string>()
function originOf(socket: object): string {
  return lowerOrigin(REMOTE_HTTP_ORIGIN, streamOrigin.get(socket))
}

/** The request headers that cross, the caller's class, and the body's framing. */
function crossingHeaders(req: IncomingMessage): http.OutgoingHttpHeaders {
  const out: http.OutgoingHttpHeaders = { ...forwardRequestHeaders(req.headers), [ORIGIN_HEADER]: originOf(req.socket) }
  const len = req.headers['content-length']
  if (typeof len === 'string' && /^\d+$/.test(len)) out['content-length'] = len
  else if (req.headers['transfer-encoding'] !== undefined) out['transfer-encoding'] = 'chunked'
  return out
}

export function createCompanionDoor(opts: CompanionDoorOptions = {}): CompanionDoor {
  const rootOf = opts.root ?? getSelfApiRoot
  const counts = { served: 0, refused: 0 }
  /** Each accepted stream's idle timer (a stream has no socket timeouts). */
  const idle = new WeakMap<object, ReturnType<typeof setTimeout>>()
  const arm = (stream: Duplex, ms: number): void => {
    const prev = idle.get(stream)
    if (prev) clearTimeout(prev)
    const t = setTimeout(() => stream.destroy(), ms)
    t.unref?.()
    idle.set(stream, t)
  }
  const disarm = (stream: object): void => {
    const prev = idle.get(stream)
    if (prev) clearTimeout(prev)
    idle.delete(stream)
  }
  const log = opts.log ?? (() => {})

  function ownPort(): number | null {
    const root = rootOf()
    if (!root) return null
    const port = Number(new URL(root).port)
    return Number.isInteger(port) && port > 0 ? port : null
  }

  const server = http.createServer((req, res) => {
    // A call came: no idle close while it runs; after its answer, a short one.
    const stream = req.socket as unknown as Duplex
    disarm(stream)
    res.on('close', () => { if (!stream.destroyed) arm(stream, opts.afterAnswerMs ?? STREAM_AFTER_ANSWER_MS) })
    // The check target.ts runs on a server.http frame, the same steps: one rule for both doors.
    // What the call says is checked at once, so a refusal goes out before the parser reads on
    // (bytes after a `Connection: close` request end the stream); only a call the companion
    // keeps waits for the config, its body unread until it is served or refused.
    const now = checkForwardCall(req.method, req.url)
    if (now.ok !== 'kept') { serve(req, res, now); return }
    void settleKeptCall(now)
      .catch((err): Checked => ({ ok: false, status: 500, message: `The call could not be checked: ${err instanceof Error ? err.message : String(err)}` }))
      .then((c) => serve(req, res, c))
  })

  function serve(req: IncomingMessage, res: ServerResponse, c: Checked): void {
    // The companion gave up while the call was checked: nothing to answer, nothing runs.
    if (res.destroyed) { req.resume(); return }
    const method = (req.method ?? '').toUpperCase()
    const port = ownPort()
    const bodyOnRead = (method === 'GET' || method === 'HEAD') && (Number(req.headers['content-length'] ?? 0) > 0 || req.headers['transfer-encoding'] !== undefined)
    if (!c.ok || !port || bodyOnRead) {
      counts.refused++
      req.resume()
      const status = !c.ok ? c.status : !port ? 503 : 400
      const message = !c.ok ? c.message : !port ? 'This server is not listening yet' : `${method} cannot have a body`
      log('info', 'companion door: refused a forwarded call', { method, url: req.url, status })
      refuse(res, status, message)
      return
    }
    counts.served++
    const up = http.request({ host: '127.0.0.1', port, method, path: c.path, headers: crossingHeaders(req) })
    up.on('response', (answer) => {
      const headers: http.OutgoingHttpHeaders = { ...forwardResponseHeaders(answer.headers) }
      const len = answer.headers['content-length']
      if (typeof len === 'string' && /^\d+$/.test(len) && !answer.headers['content-encoding']) headers['content-length'] = len
      res.writeHead(answer.statusCode ?? 502, headers)
      noteForwardedTaskWrite(method, c.rel, answer.statusCode ?? 502)
      answer.pipe(res)
      answer.on('error', () => res.destroy())
    })
    up.on('error', (err) => {
      if (res.headersSent) { res.destroy(); return }
      // The route was asked and broke off: never "refused", a write may have run. Marked,
      // so the companion counts it unanswered; the loopback error stays in this log.
      log('warn', 'companion door: this server\'s route could not be reached', { method, url: req.url, error: err.message })
      const text = JSON.stringify({ error: { code: 'forward_failed', message: 'Your Mac could not run this call right now' } })
      res.writeHead(502, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text), [FORWARD_FAILED_HEADER]: '1' })
      res.end(text)
    })
    // The companion gave up (its stream closed): the call here goes with it.
    res.on('close', () => { if (!res.writableFinished) up.destroy() })
    req.pipe(up)
  }
  // No WebSocket under /api/v1 on this server: an upgrade is refused before anything runs.
  server.on('upgrade', (req: IncomingMessage, socket: Duplex) => {
    socket.on('error', () => { /* the companion went away; its close ends this */ })
    disarm(socket)
    counts.refused++
    log('info', 'companion door: refused a forwarded upgrade', { url: req.url })
    socket.end(`HTTP/1.1 404 Not Found\r\n${FORWARD_REFUSED_HEADER}: 1\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`)
  })
  server.on('clientError', (_err, socket) => { try { socket.destroy() } catch { /* gone */ } })

  return {
    accept(stream, relayOrigin) {
      if (relayOrigin !== undefined) streamOrigin.set(stream, relayOrigin)
      stream.on('error', () => { /* a stream that broke ends its call */ })
      stream.on('close', () => disarm(stream))
      arm(stream, opts.idleMs ?? STREAM_IDLE_MS)
      server.emit('connection', stream)
    },
    close() { server.close() },
    stats: () => ({ ...counts }),
  }
}

// ── This server's one door ──

let door: CompanionDoor | null = null

export function companionDoor(): CompanionDoor {
  if (door) return door
  door = createCompanionDoor({
    log: (level, msg, data) => {
      void import('../../logging/index.js').then(({ log }) => { log.web[level](msg, data) }).catch(() => {})
    },
  })
  return door
}

/**
 * The Mac's accept for a companion stream that came through the daemon of
 * `hostKey` (providers/daemon-connection.ts), or null to refuse it at the open.
 * Only through the Mac's own daemon, as every server.http relay
 * (control-host-policy.ts): any process on a remote host could use that host's
 * daemon otherwise. Refused at the open, the companion's call goes as one
 * server.http frame, which the same rule then refuses.
 */
export function companionStreamAcceptor(hostKey: string, sid: string): ((stream: Duplex) => void) | null {
  const refused = controlRefusedForHost('stream.open', hostKey)
  const say = (level: 'info' | 'warn', msg: string, data: Record<string, unknown>) => {
    void import('../../logging/index.js').then(({ log }) => { log.web[level](msg, data) }).catch(() => {})
  }
  if (refused) {
    say('warn', 'companion door: a forward stream from another host refused', { hostKey, sid, error: refused })
    return null
  }
  // Decided before the open: refused there, the companion's call goes as one server.http
  // frame (never sent, no suspect), not as a request that gets no answer.
  if (!bootPolicy('companion-stream-door')) {
    say('info', 'companion door: this server takes no forward stream', { hostKey, sid })
    return null
  }
  return (stream) => {
    say('info', 'companion door: a forward stream', { hostKey, sid })
    companionDoor().accept(stream, controlRelayOrigin(hostKey))
  }
}

/** Tests only. */
export function _resetCompanionDoorForTesting(): void {
  door?.close()
  door = null
}
