/**
 * A host's local call entry ('host-call-entry-v1'): `POST /api/host/call` on this host's own
 * Walnut server. A session or plugin job its daemon started posts the very request line it would
 * write on the daemon's gateway socket ({v:1, op, sid, args:{name, args, callId}, waitMs?}), with
 * the token the daemon gave it (WALNUT_CALL_TOKEN, host-call-token-core.ts) as its Bearer.
 *
 * This server decides nothing of the call: it hands the line to its daemon over the follower link
 * (`follower.gateway`), which checks the token for the line's sid and runs the line through the
 * same function a socket line takes (handleGatewayLine: sid resolution, plugin job run ids,
 * trigger check callers, caller proof, the leader's relay or the hand-off to this server). ONE
 * rule for who may call and where a call goes, whichever door it came in by.
 *
 * It is an op-level door, not a route-level API: a session's route call could not be forwarded
 * to the leader with an identity the leader can check.
 *
 * Every answer carries HOST_CALL_ANSWER_HEADER, so a client tells the entry's word from a server
 * that has no entry (host-call-client-core.ts):
 *   200  the daemon's answer to the call, exactly what the socket would have written
 *   401  no token, or one the daemon did not take (a wrong one counts toward its own limit, 429)
 *   503/501 `entry_unavailable`: nothing ran (off, no daemon link, an older daemon); use the socket
 * A line the daemon took whose answer never came back is a `hub_timeout` answer: it may have run.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { HOST_CALL_ANSWER_HEADER, HOST_CALL_PATH } from '../providers/host-call-client-core.js'
import { GATEWAY_HUB_TIMEOUT_MS, GATEWAY_MAX_LINE_BYTES, GATEWAY_MIN_RELAY_MS, GATEWAY_WAIT_MAX_MS, parseGatewayLine, wantsCallerProof } from '../providers/gateway-core.js'
import { isDaemonDrainRefusal } from '../providers/daemon-drain-resend.js'
import { wasNotSent } from '../host-server/daemon-link.js'

/** The daemon capability that carries `follower.gateway` (daemon-capabilities.ts). */
export const HOST_CALL_CAPABILITY = 'host-call-entry-v1'
/** The rate-limit bucket of wrong tokens here: never the devices' (auth.ts), so a stray process locks out no phone. */
export const HOST_CALL_FAILURE_KEY = 'host-call'
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
  /** The pid of the process on the other end of this request's connection, for an approval's caller proof. */
  peerPid?(req: IncomingMessage): Promise<number | undefined>
  log(level: 'info' | 'warn', msg: string, data?: Record<string, unknown>): void
  now?(): number
  /** Tests: the wrong-token limit. */
  limiter?: { limited(key: string): boolean; failed(key: string, token: string): void }
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

async function defaultLimiter(): Promise<NonNullable<HostCallEntryDeps['limiter']>> {
  const { isAuthRateLimited, recordAuthFailure } = await import('../web/middleware/auth-rate-limit.js')
  return { limited: (key) => isAuthRateLimited(key), failed: (key, token) => recordAuthFailure(key, token) }
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
  let limiter: HostCallEntryDeps['limiter'] | null = deps.limiter ?? null
  const limit = async () => (limiter ??= await defaultLimiter())

  return {
    takes(req) {
      return req.method === 'POST' && (req.url ?? '').split('?')[0] === HOST_CALL_PATH
    },
    async handle(req, res) {
      const openedAt = now()
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
      const lim = await limit()
      if (lim.limited(HOST_CALL_FAILURE_KEY)) { req.resume(); return send(res, 429, { code: 'too_many_failures', error: 'too many refused tokens; try again later' }) }
      let raw: Buffer | null
      try { raw = await readBody(req, GATEWAY_MAX_LINE_BYTES) } catch { return }
      // The answers a socket line gets for the same faults (gateway-core.ts parseGatewayLine).
      if (raw === null) return send(res, 200, { ok: false, error: { code: 'bad_request', message: 'request line too large' } })
      const line = raw.toString('utf8')
      const parsed = parseGatewayLine(line)
      if (!parsed.ok) return send(res, 200, { ok: false, error: parsed.error })
      const request = JSON.parse(line) as Record<string, unknown>
      // An approval's caller proof: the process holding this connection, found as the Mac finds an
      // HTTP caller's (approvals/caller-proof.ts); the daemon checks it is inside the session.
      let peerPid: number | undefined
      if (deps.peerPid && wantsCallerProof(parsed.request.op, parsed.request.args)) {
        try { peerPid = await deps.peerPid(req) } catch { peerPid = undefined }
      }
      let reply: Record<string, unknown>
      try {
        reply = await deps.request('follower.gateway', { request, token, openedAt, ...(peerPid ? { peerPid } : {}) }, answerBudgetMs(parsed.request.waitMs))
      } catch (err) {
        if (wasNotSent(err)) return unavailable(res, 503, 'no_daemon_link', 'the line never reached this host\'s daemon; use the daemon socket')
        deps.log('warn', 'host call entry: no answer from the daemon', { op: parsed.request.op, error: (err as Error).message })
        return send(res, 200, { ok: false, error: { code: 'hub_timeout', message: 'this host\'s daemon did not answer in time; the call may have run, read it before trying again' } })
      }
      if (reply.ok === true && reply.response && typeof reply.response === 'object') return send(res, 200, reply.response)
      if (reply.errorKind === 'bad_token') {
        lim.failed(HOST_CALL_FAILURE_KEY, token)
        deps.log('warn', 'host call entry: a token the daemon did not take', { sid: parsed.request.sid })
        return send(res, 401, { code: 'token_refused', error: 'the daemon did not take this token for this caller' })
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
