/**
 * A host's local call entry ('host-call-entry-v1'): `POST /api/host/call` on a unix socket of this
 * host's own Walnut server, `<daemon dir>/host-call/<16 hex>.sock` (0600 in a 0700 dir: only this
 * uid can connect, as with the daemon's gateway socket), never on the listener the host's tunnel
 * reaches (that one answers 404 there). A session or plugin job its daemon started posts the very
 * request line it would write on the gateway socket ({v:1, op, sid, args:{name, args, callId}, waitMs?}),
 * with the token the daemon gave its run (WALNUT_CALL_TOKEN, host-call-token-core.ts) as its Bearer.
 *
 * This server decides nothing of the call: it hands the line to its daemon over the follower link
 * (`follower.gateway`), which checks the token against that sid's current run and runs the line
 * through the same function a socket line takes (handleGatewayLine: sid resolution, plugin job run
 * ids, trigger check callers, the leader's relay or the hand-off to this server). ONE rule for who
 * may call and where a call goes, whichever door it came in by.
 *
 * It is an op-level door, not a route-level API: a session's route call could not be forwarded
 * to the leader with an identity the leader can check.
 *
 * Every answer carries HOST_CALL_ANSWER_HEADER, so a client tells the entry's word from a server
 * that has no entry (host-call-client-core.ts):
 *   200  the daemon's answer to the call, exactly what the socket would have written
 *   401  no token, or one the daemon did not take for that sid's current run
 *   403  a request that came through a proxy (forwarding headers): no caller of this host does that
 *   503/501 `entry_unavailable`: nothing ran (off, no daemon link, an older daemon, an approval that
 *        needs the gateway socket's kernel peer for its caller proof); use the socket
 * A line the daemon took whose answer never came back is a `hub_timeout` answer: it may have run.
 *
 * No limit on refused tokens: only this uid reaches the socket, and this uid can read the key
 * itself, so a limit stops no one and would only let one stray process turn every caller away.
 */

import fs from 'node:fs/promises'
import http, { type IncomingMessage, type ServerResponse } from 'node:http'
import path from 'node:path'
import { HOST_CALL_ANSWER_HEADER, HOST_CALL_PATH } from '../providers/host-call-client-core.js'
import { GATEWAY_HUB_TIMEOUT_MS, GATEWAY_MAX_LINE_BYTES, GATEWAY_MIN_RELAY_MS, GATEWAY_WAIT_MAX_MS, parseGatewayLine, wantsCallerProof } from '../providers/gateway-core.js'
import { isDaemonDrainRefusal } from '../providers/daemon-drain-resend.js'
import { wasNotSent } from '../host-server/daemon-link.js'
import { HOST_CALL_SOCKET_MAX_BYTES } from '../providers/host-call-token-core.js'

/** The daemon capability that carries `follower.gateway` (daemon-capabilities.ts). */
export const HOST_CALL_CAPABILITY = 'host-call-entry-v1'
/** Headers a proxy adds: a request carrying one did not come from a process of this host. */
const FORWARDING_HEADERS = ['forwarded', 'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'x-real-ip', 'cf-connecting-ip', 'true-client-ip', 'via']
/** What the daemon is given beyond the call's own time to answer it (a proof lookup, a busy resend). */
const ANSWER_SPARE_MS = 15_000

export interface HostCallEntryDeps {
  /** A command on the follower link (front.ts link.request). */
  request(cmd: string, params: Record<string, unknown>, timeoutMs: number): Promise<Record<string, unknown>>
  /** What the daemon advertised, or null before its hello. */
  capabilities(): readonly string[] | null
  /** The follower link follows its daemon. */
  linked(): boolean
  /** The experiment is on (`host_call_entry`, from this server's copy of the settings). */
  enabled(): boolean
  log(level: 'info' | 'warn', msg: string, data?: Record<string, unknown>): void
  now?(): number
}

export interface HostCallEntry {
  /** Whether this request is the entry's (POST to its path). */
  takes(req: IncomingMessage): boolean
  handle(req: IncomingMessage, res: ServerResponse): Promise<void>
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text), 'cache-control': 'no-store', [HOST_CALL_ANSWER_HEADER]: '1' })
  res.end(text)
}

function unavailable(res: ServerResponse, status: 501 | 503, why: string, message: string): void {
  send(res, status, { code: 'entry_unavailable', why, error: message })
}

/** The body, or null past `max` bytes (the rest is drained, never kept). */
function readBody(req: IncomingMessage, max: number): Promise<Buffer | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    let over = false
    req.on('data', (c: Buffer) => {
      size += c.length
      if (size > max) { over = true; chunks.length = 0; return }
      if (!over) chunks.push(c)
    })
    req.on('end', () => resolve(over ? null : Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

/** How long the daemon may take on this line: the call's own time (gatewayCallPlan) and a spare. */
export function answerBudgetMs(waitMs: unknown): number {
  const call = typeof waitMs === 'number' && Number.isFinite(waitMs) && waitMs > 0
    ? Math.min(GATEWAY_WAIT_MAX_MS, Math.max(GATEWAY_MIN_RELAY_MS, Math.floor(waitMs)))
    : GATEWAY_HUB_TIMEOUT_MS
  return call + ANSWER_SPARE_MS
}

export function createHostCallEntry(deps: HostCallEntryDeps): HostCallEntry {
  const now = deps.now ?? Date.now

  return {
    takes(req) {
      return req.method === 'POST' && (req.url ?? '').split('?')[0] === HOST_CALL_PATH
    },
    async handle(req, res) {
      const openedAt = now()
      if (FORWARDING_HEADERS.some((h) => req.headers[h] !== undefined)) {
        req.resume()
        return send(res, 403, { code: 'forwarded', error: 'this entry takes only a process of this host, never a request through a proxy' })
      }
      const auth = req.headers.authorization
      const token = typeof auth === 'string' && auth.startsWith('Bearer ') ? auth.slice(7).trim() : ''
      if (!/^[0-9a-f]{64}$/.test(token)) {
        req.resume()
        return send(res, 401, { code: 'no_token', error: 'this entry takes only a token this host\'s daemon gave (WALNUT_CALL_TOKEN)' })
      }
      if (!deps.enabled()) { req.resume(); return unavailable(res, 503, 'off', 'the host call entry is off here; use the daemon socket') }
      if (!deps.linked()) { req.resume(); return unavailable(res, 503, 'no_daemon_link', 'this server is not linked to its daemon now; use the daemon socket') }
      if (!(deps.capabilities() ?? []).includes(HOST_CALL_CAPABILITY)) {
        req.resume()
        return unavailable(res, 501, 'daemon_needs_upgrade', 'this host\'s daemon has no host-call-entry-v1; use the daemon socket')
      }
      let raw: Buffer | null
      try { raw = await readBody(req, GATEWAY_MAX_LINE_BYTES) } catch { return }
      // The answers a socket line gets for the same faults (gateway-core.ts parseGatewayLine).
      if (raw === null) return send(res, 200, { ok: false, error: { code: 'bad_request', message: 'request line too large' } })
      const line = raw.toString('utf8')
      const parsed = parseGatewayLine(line)
      if (!parsed.ok) return send(res, 200, { ok: false, error: parsed.error })
      const request = JSON.parse(line) as Record<string, unknown>
      // An approval's caller proof is the kernel's word on the asking process, which the daemon
      // reads on its gateway socket (SO_PEERCRED / LOCAL_PEERPID); this socket cannot give it.
      if (wantsCallerProof(parsed.request.op, parsed.request.args)) {
        return unavailable(res, 503, 'caller_proof_on_socket', 'an approval proves its caller on the daemon socket; use it')
      }
      let reply: Record<string, unknown>
      try {
        reply = await deps.request('follower.gateway', { request, token, openedAt }, answerBudgetMs(parsed.request.waitMs))
      } catch (err) {
        if (wasNotSent(err)) return unavailable(res, 503, 'no_daemon_link', 'the line never reached this host\'s daemon; use the daemon socket')
        deps.log('warn', 'host call entry: no answer from the daemon', { op: parsed.request.op, error: (err as Error).message })
        return send(res, 200, { ok: false, error: { code: 'hub_timeout', message: 'this host\'s daemon did not answer in time; the call may have run, read it before trying again' } })
      }
      if (reply.ok === true && reply.response && typeof reply.response === 'object') return send(res, 200, reply.response)
      if (reply.errorKind === 'bad_token') {
        deps.log('warn', 'host call entry: a token the daemon did not take', { sid: parsed.request.sid })
        return send(res, 401, { code: 'token_refused', error: 'the daemon did not take this token for this caller\'s current run' })
      }
      // The link closed under it: the daemon may have taken the line.
      if (reply.ok === false && reply.error === 'closed') {
        return send(res, 200, { ok: false, error: { code: 'hub_timeout', message: 'the link to this host\'s daemon closed before its answer; the call may have run, read it before trying again' } })
      }
      // Any other refusal comes before the line ran (a draining daemon, a link not hello'd yet).
      const why = isDaemonDrainRefusal(reply) ? 'daemon_draining' : typeof reply.errorKind === 'string' ? reply.errorKind : 'refused'
      return unavailable(res, 503, why, typeof reply.error === 'string' ? reply.error : 'the daemon did not take the line; use the daemon socket')
    },
  }
}

export interface HostCallListener {
  socketPath: string
  close(): Promise<void>
}

/**
 * Serve `entry` on its own unix socket at `socketPath`: the dir made 0700 (refused when it is not
 * this uid's private dir, or a link), a stale socket file replaced, the socket chmod 0600. Any
 * other request there is 404. Null when it cannot be served; callers then use the daemon socket.
 */
export async function listenHostCallEntry(entry: HostCallEntry, opts: { socketPath: string; uid: number | null; log: HostCallEntryDeps['log'] }): Promise<HostCallListener | null> {
  const { socketPath } = opts
  const dir = path.dirname(socketPath)
  const refuse = (why: string): null => { opts.log('warn', 'host call entry: not served', { socket: socketPath, why }); return null }
  if (!path.isAbsolute(socketPath) || Buffer.byteLength(socketPath) > HOST_CALL_SOCKET_MAX_BYTES) return refuse('the socket path is not absolute or too long for a unix socket')
  try {
    await fs.mkdir(dir, { recursive: true, mode: 0o700 })
    const st = await fs.lstat(dir)
    if (!st.isDirectory() || (opts.uid !== null && st.uid !== opts.uid)) return refuse('its dir is not this user\'s own dir')
    if ((st.mode & 0o077) !== 0) await fs.chmod(dir, 0o700)
    const old = await fs.lstat(socketPath).catch(() => null)
    if (old && !old.isSocket()) return refuse('something that is not a socket is at its path')
    if (old) await fs.unlink(socketPath)
  } catch (err) {
    return refuse((err as Error).message)
  }
  const server = http.createServer((req, res) => {
    if (entry.takes(req)) { void entry.handle(req, res); return }
    req.resume()
    res.writeHead(404, { 'content-type': 'text/plain' })
    res.end('not found')
  })
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(socketPath, () => { server.off('error', reject); resolve() })
    })
    // Owner-only IS the credential, as on the gateway socket: never left to the umask.
    await fs.chmod(socketPath, 0o600)
  } catch (err) {
    server.close()
    return refuse((err as Error).message)
  }
  server.on('error', (err) => opts.log('warn', 'host call entry: socket error', { socket: socketPath, error: err.message }))
  opts.log('info', 'host call entry: listening', { socket: socketPath })
  return {
    socketPath,
    close: () => new Promise<void>((resolve) => {
      server.closeAllConnections?.()
      server.close(() => resolve())
      void fs.unlink(socketPath).catch(() => { /* gone */ })
    }),
  }
}
