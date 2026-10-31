/**
 * The dispatcher of a host replica (docs/plan/walnut-replica-servers-impl.md,
 * section 3), mounted BEFORE every body parser so a forwarded body stays raw
 * bytes. For each request on the public port:
 *
 *   cls local / feature   next(): the express route runs here
 *   the Mac answers       forward over the follower Link (host-server/proxy.ts)
 *     a write             op id kept (minted when the client sent none),
 *                         x-walnut-forwarded-at stamped (the host's clock when
 *                         the stream opened, before the body), a budget from the
 *                         request fully written to the first answer byte: the
 *                         wait the client says (x-walnut-wait-ms, at least 15 s),
 *                         then 504 for that request alone (a slow Mac is not
 *                         away). A write that says no wait (the iOS app, a raw
 *                         fetch) is never cut while the Mac works on it: the
 *                         client's own deadline ends it, a presence flip answers
 *                         it at once, 20 min is the backstop
 *     GET/HEAD failed before any byte answered: the companion if it stands in, else away
 *     a write failed after it was written: 504 primary_timeout (never journaled)
 *     a write failed before the stream opened: away (provably not sent)
 *     the Mac really away (presence.ts macAway: the quiet window, no daemon,
 *                   the companion leads): every in-flight forward to it is cut at
 *                   once: a GET/HEAD with no answer byte sent yet runs again on
 *                   the copies (as if it had been routed away), a write is 504
 *                   ("Nothing was saved" when its stream never opened); a suspect
 *                   mark (one failed stream) cuts nothing
 *     a browser that went away (abort, reload) is no failure of the Mac: no suspect
 *   the companion stands in   forwarded as the host server does today
 *   every answer   x-walnut-presence-seq and x-walnut-presence-boot (front.ts header:
 *                  the seq in force when the request was routed)
 *   else away (answerAway)
 *     read          next() on the copies, x-walnut-offline: <asOf ms> and
 *                   x-walnut-offline-why: away | suspect (a known device only)
 *     host-write / queue:<kind> / note-write
 *                   next() with req.replicaWrite (the route's write goes to the
 *                   daemon with follower.op, WP10); `leader_answers` from the
 *                   daemon: forwarded once with the same op id, and that forward
 *                   failing before any byte is 503 leader_unsure; a lost answer
 *                   is asked again with the SAME op id (the daemon dedupes), and
 *                   after a lost answer `leader_answers` is forwarded only when
 *                   the daemon says the op id is not in its journal (opPending: false)
 *                   The body is read only for a known device token, at most 15 MB.
 *     needs-leader  503 {error:{code:'needs_leader', why, retryAfter}}
 *
 * WebSockets: spliced raw to the Mac (or the companion) while it answers; on a
 * flip to away every socket spliced to the Mac is closed with 4001 leader_away
 * (a frozen Mac keeps its sockets open and silent) and every handshake still
 * waiting on it is dispatched again; away sockets are the replica's own (the
 * front closes them with 4002 leader_back on the way back), and so are the ones
 * spliced to the companion standing in. A handshake has the write budget.
 */

import crypto from 'node:crypto'
import type http from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Duplex } from 'node:stream'
import { forwardHttp, forwardUpgrade, isLinkDropped, type ForwardTarget, type UpgradeForward } from '../host-server/proxy.js'
import { wasNotSent } from '../host-server/daemon-link.js'
import type { Route } from '../host-server/route.js'
import { classify, isRead, type AwayRule, type RouteDecision } from './route-table.js'
import { closeAtFrame, closeFrame, FrameCursor } from './ws-frames.js'

/** The shortest budget of a write that says its wait, and a WebSocket handshake's budget. */
export const WRITE_BUDGET_MS = 15_000
/**
 * The longest wait a client may ask for a write (x-walnut-wait-ms), and the
 * budget of a write that says none: past every client's own deadline (the iOS
 * app waits at most 900 s, a voice transcription), so the client gives up first.
 */
export const MAX_WRITE_BUDGET_MS = 20 * 60_000
/** A socket closed mid-frame gets the rest of that frame first, for at most this long. */
const CLOSE_AT_FRAME_MS = 1_000
/** How often a lost follower.op answer is asked again (same op id). */
const OP_TRIES = 3
const OP_TIMEOUT_MS = 5_000
/** Between two follower.op tries: how often the link is looked at, and the gap with no link to look at. */
const OP_RELINK_POLL_MS = 50
const OP_RETRY_GAP_MS = 200
/** A write body read here (an away write that may be replayed) is at most this. */
const MAX_BODY_BYTES = 15 * 1024 * 1024

export const OP_ID_HEADER = 'x-walnut-op-id'
export const FORWARDED_AT_HEADER = 'x-walnut-forwarded-at'
export const OFFLINE_HEADER = 'x-walnut-offline'
/** Beside x-walnut-offline: `suspect` (a stream to a live Mac failed) or `away`. */
export const OFFLINE_WHY_HEADER = 'x-walnut-offline-why'
export const ANSWERED_VIA_HEADER = 'x-walnut-answered-via'
/** On every answer: the count of presence changes told in this process, and the process's id (front.ts). */
export const PRESENCE_SEQ_HEADER = 'x-walnut-presence-seq'
export const PRESENCE_BOOT_HEADER = 'x-walnut-presence-boot'

export type OfflineWhy = 'away' | 'suspect'
/** How long the client waits for this write (web/src/api/op-id.ts): the write budget, when longer. */
export const WAIT_HEADER = 'x-walnut-wait-ms'

export type Target = Exclude<Route, { kind: 'alone' }>

/** What a route's away write (WP10) gets back from the daemon. */
export type ReplicaWriteResult =
  | { kind: 'applied'; reply: Record<string, unknown> }
  /** The dispatcher answered the request itself (forwarded to the leader, or 503). */
  | { kind: 'answered' }
  | { kind: 'refused'; code: string; message: string; detail?: unknown; retryAfterMs?: number }

export interface ReplicaWrite {
  opId: string
  away: AwayRule
  /** The raw body as the client sent it. */
  raw: Buffer
  /** `follower.op {op, args, opId, base?, actor?}` (write-port.ts builds each part). */
  submit(op: string, args: Record<string, unknown>, base?: unknown, actor?: object): Promise<ReplicaWriteResult>
  /**
   * Another follower write command (`follower.send`, `follower.permission`, `follower.start`),
   * with the same retry and forward rules. `timeoutMs`: each try's wait, for a command that
   * takes longer than a journal write (a CLI start).
   */
  call(cmd: string, params: Record<string, unknown>, opts?: { timeoutMs?: number }): Promise<ReplicaWriteResult>
}

declare module 'node:http' {
  interface IncomingMessage {
    /** Set by the replica dispatcher on an away write (dispatch.ts). */
    replicaWrite?: ReplicaWrite
  }
}

export interface DispatchDeps {
  /** Where a request goes right now (presence.ts chooseReplicaRoute). */
  route(): Route
  /** When the copies were last made whole (their last completed round; 0 when not known), for x-walnut-offline. */
  asOf(): number
  /** Why an answer comes from the copies now (x-walnut-offline-why); absent: `away`. */
  offlineWhy?(): OfflineWhy
  /** The presence headers every answer carries (x-walnut-presence-seq, -boot); absent: none. */
  presenceHeaders?(): Record<string, string>
  /** A stream to the leader or the companion through the daemon. */
  connect(kind: Target['kind']): Promise<Duplex>
  /** A stream to `kind` failed: skip it for a few seconds. */
  suspect(kind: Target['kind'], err: Error): void
  /** `kind` answered a forward (a response or a 101): its suspect marks stop doubling (presence.ts SuspectMarks). */
  answered?(kind: Target['kind']): void
  /** The page an HTML navigation gets while away; absent (the replica, WP7): the console, from the copies. */
  answerAlone?(req: IncomingMessage, res: ServerResponse, why: string): void
  /** `follower.op` on the link (cap replica-ops-v1); absent: away writes need the Mac. */
  followerOp?(params: Record<string, unknown>, timeoutMs: number): Promise<Record<string, unknown>>
  /** Any follower command on the link (follower.send, follower.permission); absent: those writes need the Mac. */
  followerCall?(cmd: string, params: Record<string, unknown>, timeoutMs: number): Promise<Record<string, unknown>>
  /**
   * Whether the daemon advertises replica-ops-v1 right now (null: not known yet,
   * no hello answered). Absent: followerOp alone says. False: an older daemon,
   * whose answer to follower.op would be an unknown command.
   */
  followerOpCap?(): boolean | null
  /** Whether the link to the daemon is up now: a try after a failed one waits for it. */
  linked?(): boolean
  /** The replica's own /ws (away). */
  ownUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void
  log(level: 'info' | 'warn', msg: string, data?: Record<string, unknown>): void
  /** Whether the request carries a known device token (an away write body is read only then, and only it learns x-walnut-offline). */
  authorized?(req: IncomingMessage): boolean
  /** The answer to a caller with no known token (auth.ts replicaRefusal: a wrong token counts in the shared bucket, 429 once full). */
  refuse?(req: IncomingMessage): Promise<{ status: number; body: unknown }>
  now?(): number
  writeBudgetMs?: number
  /** Tests: a fixed table. */
  classify?(method: string, path: string): RouteDecision
  /**
   * A `local` row with a condition (`local: 'session' | 'host'`): whether this
   * request is this host's data (self-host.ts, WP6). False: it is a leader
   * route. Absent: every local row runs here.
   */
  localHere?(req: IncomingMessage, decision: RouteDecision): boolean | Promise<boolean>
}

export interface Dispatcher {
  /** Express middleware for the public app (before every body parser). */
  middleware(req: IncomingMessage, res: ServerResponse, next: (err?: unknown) => void): void
  /** An upgrade on the public port: spliced to the Mac or the companion, else the replica's own /ws. */
  upgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void
  /** The Mac is really away (false: every in-flight forward to it answered 504, its sockets closed 4001), or answers again (true). */
  presenceChanged(answers: boolean): void
  /** Forwards waiting for an answer, sockets spliced to the Mac, to the companion, and handshakes waiting (tests, the report). */
  counts(): { inFlight: number; spliced: number; standIn: number; handshakes: number }
}

export function mintOpId(): string {
  return 'op-' + crypto.randomBytes(8).toString('hex')
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  if (res.headersSent || res.destroyed) return
  const text = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', 'content-length': Buffer.byteLength(text), ...headers })
  res.end(text)
}

const MESSAGES: Record<string, string> = {
  needs_leader: 'This needs your Mac, which is not answering right now.',
  leader_unsure: 'Your Mac just came back; try again in a few seconds.',
  // The request reached the Mac, which may have applied it: a retry is a new action.
  primary_timeout: 'Your Mac did not answer in time, and it may have kept the change; check it before you try again.',
  // A flip answered while the stream was still opening: provably never sent.
  not_sent: 'Your Mac did not answer in time. Nothing was saved; try again.',
  lost_answer: 'Your Mac just came back, and this host may have kept the change; check it before you try again.',
  // follower.op answers lost after every try: the daemon may have journaled it.
  journal_unsure: 'This host did not answer, and it may have kept the change; check it before you try again.',
}

export { closeFrame }

/** Read a request's whole body (bounded): over `max`, it stops reading and rejects 413 (the caller answers, then closes). */
function readBody(req: IncomingMessage, max: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const parts: Buffer[] = []
    let size = 0
    const onData = (c: Buffer) => {
      size += c.length
      if (size > max) {
        req.off('data', onData)
        req.pause()
        reject(Object.assign(new Error('the body is too large'), { status: 413 }))
        return
      }
      parts.push(c)
    }
    req.on('data', onData)
    req.on('end', () => resolve(Buffer.concat(parts)))
    req.on('error', reject)
  })
}

/**
 * The budget of a forwarded write: the wait the client says, at least `base`,
 * at most MAX_WRITE_BUDGET_MS. A client that says none (or no number) is not
 * cut while the Mac works: MAX_WRITE_BUDGET_MS, past its own deadline.
 */
export function writeBudgetOf(req: IncomingMessage, base: number): number {
  const asked = Math.round(Number(req.headers[WAIT_HEADER]))
  if (!Number.isFinite(asked) || asked <= 0) return MAX_WRITE_BUDGET_MS
  return Math.min(Math.max(asked, base), MAX_WRITE_BUDGET_MS)
}

/** A browser loading a page (not the API, not an asset). */
function isNavigation(req: IncomingMessage, pathname: string): boolean {
  if (!isRead(req.method ?? 'GET') || pathname.startsWith('/api/')) return false
  if (/\.[a-z0-9]{1,8}$/i.test(pathname)) return false
  return String(req.headers.accept ?? '').includes('text/html')
}

function pathOf(req: IncomingMessage): string {
  const raw = (req as IncomingMessage & { path?: string }).path ?? new URL(req.url ?? '/', 'http://replica').pathname
  return raw
}

/** The op id of a write: the client's, else one minted here (the iOS app sends none). */
export function ensureOpId(req: IncomingMessage): string {
  const sent = req.headers[OP_ID_HEADER]
  const id = typeof sent === 'string' && /^[A-Za-z0-9_-]{6,80}$/.test(sent) ? sent : mintOpId()
  req.headers[OP_ID_HEADER] = id
  return id
}

interface Flight {
  res: ServerResponse
  up: http.ClientRequest | null
  to: Target['kind']
  write: boolean
  done: boolean
  /** Answered by a presence flip: the forward's own outcome is ignored. */
  flipped: boolean
  /** A read's way to the copies, when the Mac went away before any answer byte (flip). */
  away?: () => void
}

/** A WebSocket handshake waiting on its target, or a socket spliced to it. */
interface Splice {
  client: Duplex
  upstream: Duplex
  to: Target['kind']
  /** Where the bytes passed on to the browser stand (a close frame goes between two frames). */
  cursor: FrameCursor
  count: (c: Buffer) => void
}
interface Handshake { req: IncomingMessage; socket: Duplex; head: Buffer; to: Target['kind']; fwd: UpgradeForward }

function ignoreSocketError(): void { /* the peer went away; its close ends the work */ }

function detach(up: http.ClientRequest): void {
  up.removeAllListeners('error')
  up.on('error', () => { /* answered already */ })
  up.destroy()
}

export function createDispatcher(deps: DispatchDeps): Dispatcher {
  const now = deps.now ?? Date.now
  const writeBudget = deps.writeBudgetMs ?? WRITE_BUDGET_MS
  const decide = deps.classify ?? classify
  const flights = new Set<Flight>()
  const splices = new Set<Splice>()
  const handshakes = new Set<Handshake>()

  function target(route: Target): ForwardTarget {
    return route.kind === 'leader'
      ? { kind: 'leader', connect: () => deps.connect('leader') }
      : { kind: 'companion', origin: route.origin, connect: () => deps.connect('companion') }
  }

  /**
   * One forward; `onFail(err, sent)` when the target could not be reached or
   * dropped it (a stream that did not open, a socket error): those, and only
   * those, are failures of the target. A write's budget runs from the request
   * fully written to the first answer byte and answers that request alone with
   * 504: a Mac that is slow at one request is not away for the others.
   */
  function forward(
    req: IncomingMessage, res: ServerResponse, route: Target, write: boolean, onFail: (err: Error, sent: boolean) => void,
    extra: { body?: Buffer; away?: () => void } = {},
  ): void {
    const body = extra.body
    const flight: Flight = { res, up: null, to: route.kind, write, done: false, flipped: false, ...(extra.away && !write ? { away: extra.away } : {}) }
    flights.add(flight)
    let sent = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const finish = () => { flight.done = true; flights.delete(flight); if (timer) clearTimeout(timer) }
    // One line per forward, by outcome (section 13 observability; walnut-logs.sh replica).
    const startedAt = now()
    let told = false
    const tell = (outcome: string, extra?: Record<string, unknown>): void => {
      if (told) return
      told = true
      const length = Number(res.getHeader('content-length'))
      deps.log('info', 'replica forward', {
        outcome, to: route.kind, method: req.method, path: pathOf(req), write, status: res.statusCode, ms: now() - startedAt,
        bytes: (body?.length ?? 0) + (Number.isFinite(length) ? length : 0),
        ...(write ? { opId: req.headers[OP_ID_HEADER] } : {}), ...extra,
      })
    }
    res.once('finish', finish)
    res.once('close', finish)
    res.once('finish', () => tell(flight.flipped ? 'flipped' : 'answered'))
    res.once('close', () => tell(flight.flipped ? 'flipped' : 'closed'))
    const budget = write ? writeBudgetOf(req, writeBudget) : 0
    const headers: Record<string, string> = write ? { [OP_ID_HEADER]: ensureOpId(req) } : {}
    forwardHttp(req, res, target(route), (err) => {
      if (flight.flipped || flight.done) return
      finish()
      // A browser that went away is no failure of the target (proxy.ts never calls for it; kept here too).
      if (res.destroyed) return
      tell(sent ? 'lost' : 'unreachable', { error: err.message })
      onFail(err, sent)
    }, {
      headers,
      // The host's clock once the stream to the Mac opened, before any body byte (an open can take seconds).
      ...(write ? { stamp: () => ({ [FORWARDED_AT_HEADER]: String(now()) }) } : {}),
      ...(body ? { body } : {}),
      onSent: (up) => {
        // A flip that answered while the stream was opening: this request is never sent.
        if (flight.flipped || flight.done || res.headersSent) { detach(up); return }
        sent = true
        flight.up = up
        up.once('response', () => { if (timer) clearTimeout(timer); deps.answered?.(route.kind) })
        if (!budget) return
        up.once('finish', () => {
          if (flight.done || res.headersSent) return
          timer = setTimeout(() => {
            if (flight.done || res.headersSent) return
            finish()
            detach(up)
            deps.log('warn', 'replica: a forwarded write got no answer within its budget', { to: route.kind, opId: req.headers[OP_ID_HEADER], method: req.method, path: pathOf(req), budgetMs: budget })
            tell('timeout', { budgetMs: budget })
            timedOut(res, true)
          }, budget)
          timer.unref?.()
        })
      },
    })
  }

  /** A caller with a known device token (no check configured: every caller, tests). */
  function known(req: IncomingMessage): boolean {
    return !deps.authorized || deps.authorized(req)
  }

  /** How old the copies are, and why they answer, is told to a known device only. */
  function offlineHeader(req: IncomingMessage): Record<string, string> {
    return known(req) ? { [OFFLINE_HEADER]: String(deps.asOf()), [OFFLINE_WHY_HEADER]: deps.offlineWhy?.() ?? 'away' } : {}
  }

  /** The presence headers, as they stand now (every answer; again once the route was decided). */
  function stampPresence(res: ServerResponse): void {
    if (res.headersSent || !deps.presenceHeaders) return
    for (const [k, v] of Object.entries(deps.presenceHeaders())) res.setHeader(k, v)
  }

  function needsLeader(req: IncomingMessage, res: ServerResponse, why: string): void {
    sendJson(res, 503, { error: { code: 'needs_leader', why, retryAfter: 5, message: MESSAGES.needs_leader } }, {
      ...offlineHeader(req), [ANSWERED_VIA_HEADER]: 'replica', 'retry-after': '5',
    })
  }

  /** A caller with no known token, before any byte of its body is read; the connection closes after. */
  function refuse(req: IncomingMessage, res: ServerResponse): void {
    const fallback = { status: 401, body: { error: 'Invalid or revoked token', code: 'token_refused' } }
    const answer = (r: { status: number; body: unknown }) => sendJson(res, r.status, r.body, { connection: 'close' })
    ;(deps.refuse ? deps.refuse(req) : Promise.resolve(fallback)).then(answer, () => answer(fallback))
  }

  /** 504 for a write the Mac did not answer; `sent`: it reached the Mac, which may have applied it. */
  function timedOut(res: ServerResponse, sent: boolean): void {
    sendJson(res, 504, { error: { code: 'primary_timeout', sent, message: sent ? MESSAGES.primary_timeout : MESSAGES.not_sent } }, { [ANSWERED_VIA_HEADER]: 'replica' })
  }

  /** The route's away write: follower.op with this request's op id (WP10 calls it). */
  function replicaWrite(req: IncomingMessage, res: ServerResponse, away: AwayRule, raw: Buffer): ReplicaWrite {
    const opId = ensureOpId(req)
    /** One follower write command, its answer lost asked again under the same op id. */
    const run = async (cmd: string, params: Record<string, unknown>, op: string, timeoutMs = OP_TIMEOUT_MS): Promise<ReplicaWriteResult> => {
      const send = cmd === 'follower.op'
        ? (p: Record<string, unknown>) => deps.followerOp!(p, timeoutMs)
        : deps.followerCall
          ? (p: Record<string, unknown>) => deps.followerCall!(cmd, p, timeoutMs)
          : null
      if (!send) { needsLeader(req, res, 'daemon_needs_upgrade'); return { kind: 'answered' } }
      {
        // Whether an earlier try may have reached the daemon (a timeout, or `closed` after it
        // was written): only then may it be journaled. A try the link refused never left here.
        let lost = false
        const relinkBy = Date.now() + OP_TIMEOUT_MS
        for (let attempt = 1; attempt <= OP_TRIES; attempt++) {
          if (attempt > 1) await relinked(relinkBy)
          let r: Record<string, unknown>
          try {
            r = await send(params)
          } catch (err) {
            const error = err instanceof Error ? err.message : String(err)
            if (wasNotSent(err)) {
              deps.log('warn', 'replica: follower.op not sent (no link to the daemon), trying again', { opId, op, attempt, error })
              continue
            }
            // A lost answer: the same op id again (the daemon answers a pending one with its first result).
            lost = true
            deps.log('warn', 'replica: follower.op answer lost, asking again', { opId, op, attempt, error })
            continue
          }
          if (r.ok === false && r.error === 'closed') {
            lost = true
            deps.log('warn', 'replica: follower.op answer lost, asking again', { opId, op, attempt, error: 'closed' })
            continue
          }
          if (r.ok === true) return { kind: 'applied', reply: r }
          if (r.errorKind === 'leader_answers' && lost && r.opPending !== false) {
            // The daemon checks who leads before its journal: an earlier try whose answer was
            // lost may be journaled, so forwarding now could apply it twice.
            deps.log('warn', 'replica: the Mac answers after a lost answer, the write may be journaled; not forwarded', { opId, op })
            sendJson(res, 503, { error: { code: 'leader_unsure', why: 'lost_answer', retryAfter: 5, message: MESSAGES.lost_answer } }, { 'retry-after': '5' })
            return { kind: 'answered' }
          }
          if (r.errorKind === 'leader_answers') {
            // The view was stale and the Mac answers: provably not applied here, so forwarded once, same op id.
            deps.log('info', 'replica: the daemon says the Mac answers, forwarding the write once', { opId, op })
            // The Mac answers this one: it is no away answer.
            res.removeHeader(OFFLINE_HEADER)
            res.removeHeader(OFFLINE_WHY_HEADER)
            res.removeHeader(ANSWERED_VIA_HEADER)
            forward(req, res, { kind: 'leader' }, true, (err, sent) => {
              deps.suspect('leader', err)
              if (sent) return timedOut(res, true)
              sendJson(res, 503, { error: { code: 'leader_unsure', retryAfter: 5, message: MESSAGES.leader_unsure } }, { 'retry-after': '5' })
            }, { body: raw })
            return { kind: 'answered' }
          }
          return {
            kind: 'refused', code: typeof r.errorKind === 'string' ? r.errorKind : 'refused', message: String(r.error ?? 'the daemon refused the write'),
            ...(r.detail !== undefined ? { detail: r.detail } : {}), ...(typeof r.retryAfterMs === 'number' ? { retryAfterMs: r.retryAfterMs } : {}),
          }
        }
        if (!lost) {
          // No try ever left this server: nothing can be journaled, so the client may try again.
          deps.log('warn', 'replica: follower.op never sent, the link to the daemon stayed down', { opId, op })
          needsLeader(req, res, 'daemon_unreachable')
          return { kind: 'answered' }
        }
        sendJson(res, 503, { error: { code: 'journal_unwritable', why: 'no_answer', retryAfter: 5, message: MESSAGES.journal_unsure } }, { 'retry-after': '5' })
        return { kind: 'answered' }
      }
    }
    return {
      opId, away, raw,
      submit: (op, args, base, actor) => run('follower.op', { op, args, opId, ...(base === undefined ? {} : { base }), ...(actor ? { actor } : {}) }, op),
      call: (cmd, params, opts) => run(cmd, { ...params, opId }, cmd, opts?.timeoutMs ?? OP_TIMEOUT_MS),
    }
  }

  /** Before a try after a failed one: the link up again (bounded by `by`), or a short gap when it cannot be looked at. */
  async function relinked(by: number): Promise<void> {
    if (!deps.linked) { await sleep(OP_RETRY_GAP_MS); return }
    while (!deps.linked() && Date.now() < by) await sleep(OP_RELINK_POLL_MS)
  }

  function answerAway(req: IncomingMessage, res: ServerResponse, next: (err?: unknown) => void, decision: RouteDecision, why: string): void {
    // A failed forward may have changed what is told: the answer carries the seq it is made under.
    stampPresence(res)
    // Section 13 observability: what the replica answered itself, and under which row.
    deps.log('info', 'replica away answer', { route: decision.row?.pattern ?? pathOf(req), path: pathOf(req), method: req.method, cls: decision.cls, away: decision.away, why })
    if (decision.away === 'read') {
      if (deps.answerAlone && isNavigation(req, pathOf(req))) return deps.answerAlone(req, res, why)
      // The auth middleware's 401 to a caller with no token carries no copy age.
      for (const [k, v] of Object.entries(offlineHeader(req))) res.setHeader(k, v)
      res.setHeader(ANSWERED_VIA_HEADER, 'replica')
      return next()
    }
    if (decision.away === 'needs-leader') return needsLeader(req, res, decision.why ?? why)
    if (!deps.followerOp) return needsLeader(req, res, 'daemon_needs_upgrade')
    const cap = deps.followerOpCap ? deps.followerOpCap() : true
    if (cap === false) return needsLeader(req, res, 'daemon_needs_upgrade')
    if (cap === null) return needsLeader(req, res, 'daemon_unreachable')
    // This runs before the auth middleware: a body is read only for a known device,
    // and a wrong token counts toward the same limit as on /api and /ws.
    if (!known(req)) return refuse(req, res)
    const length = Number(req.headers['content-length'])
    if (Number.isFinite(length) && length > MAX_BODY_BYTES) return tooLarge(res)
    readBody(req, MAX_BODY_BYTES).then((raw) => {
      // The body parsers skip a request already read: the route sees this body.
      if (raw.length && String(req.headers['content-type'] ?? '').includes('json')) {
        try { (req as IncomingMessage & { body?: unknown }).body = JSON.parse(raw.toString('utf8')) } catch {
          return sendJson(res, 400, { error: { code: 'bad_request', message: 'The body is not JSON.' } })
        }
      }
      req.replicaWrite = replicaWrite(req, res, decision.away, raw)
      for (const [k, v] of Object.entries(offlineHeader(req))) res.setHeader(k, v)
      res.setHeader(ANSWERED_VIA_HEADER, 'replica')
      next()
    }, (err: Error & { status?: number }) => {
      if (err.status === 413) return tooLarge(res)
      sendJson(res, 400, { error: { code: 'bad_request', message: err.message } })
    })
  }

  /** 413, and the connection closes once it is sent (the rest of the body is never read). */
  function tooLarge(res: ServerResponse): void {
    sendJson(res, 413, { error: { code: 'too_large', message: `The body is over ${MAX_BODY_BYTES} bytes.` } }, { connection: 'close' })
  }

  function flip(f: Flight): void {
    f.flipped = true
    flights.delete(f)
    if (f.up) detach(f.up)
    if (f.res.headersSent) { f.res.destroy(); return }
    // A read with no answer byte sent yet changes nothing either way: it runs again on the copies.
    if (f.away) { f.away(); return }
    // A write: `up` null, its stream never opened (provably not sent, "Nothing was saved").
    timedOut(f.res, f.write && f.up !== null)
  }

  /** Close a spliced socket with a WebSocket close frame, between two frames (ws-frames.ts); the target's side is let go. */
  function closeSplice(sp: Splice, code: number, reason: string): void {
    splices.delete(sp)
    sp.upstream.off('data', sp.count)
    closeAtFrame(sp.client, sp.upstream, sp.cursor, closeFrame(code, reason), CLOSE_AT_FRAME_MS)
  }

  /** An upgrade to where the route says now; a handshake has the write budget. */
  function upgradeTo(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    const route = deps.route()
    if (route.kind === 'alone') return deps.ownUpgrade(req, socket, head)
    let h: Handshake | null = null
    const fwd = forwardUpgrade(req, socket, head, target(route), (err) => {
      if (h) handshakes.delete(h)
      // A slow handshake answers that browser alone: no failure of the target.
      if ((err as Error & { code?: string }).code === 'handshake_timeout') {
        deps.log('warn', 'replica: a WebSocket handshake got no answer within its budget', { to: route.kind, budgetMs: writeBudget })
        if (!socket.destroyed) socket.end('HTTP/1.1 504 Gateway Timeout\r\nConnection: close\r\nContent-Length: 0\r\n\r\n')
        return
      }
      deps.suspect(route.kind, err)
      if (socket.destroyed) return
      // Nothing was written to the browser yet: the replica's own socket if it is away now.
      if (deps.route().kind === 'alone') return deps.ownUpgrade(req, socket, head)
      socket.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\nContent-Length: 0\r\n\r\n')
    }, (client, upstream, upHead) => {
      if (h) handshakes.delete(h)
      deps.answered?.(route.kind)
      const cursor = new FrameCursor()
      // The frames that came with the 101 were passed on before the splice.
      if (upHead?.length) cursor.take(upHead)
      const count = (c: Buffer) => { cursor.take(c) }
      // Beside the pipe: the same chunks, in the order they are written to the browser.
      upstream.on('data', count)
      const sp: Splice = { client, upstream, to: route.kind, cursor, count }
      splices.add(sp)
      client.once('close', () => { splices.delete(sp) })
    }, { handshakeMs: writeBudget })
    if (fwd.settled()) return
    h = { req, socket, head, to: route.kind, fwd }
    handshakes.add(h)
    socket.once('close', () => { if (h) handshakes.delete(h) })
  }

  /** A request for the leader (or answered as away): the forward path every leader row takes. */
  function routeOn(req: IncomingMessage, res: ServerResponse, next: (err?: unknown) => void, decision: RouteDecision): void {
    const route = deps.route()
    stampPresence(res)
    if (route.kind === 'alone') return answerAway(req, res, next, decision, route.why)
    const write = !isRead(req.method ?? 'GET')
    // A read the Mac went away under (a flip, before any answer byte): the copies answer it.
    const away = () => { if (!res.headersSent && !res.destroyed) answerAway(req, res, next, decision, 'mac-away') }
    let again = false
    const onFail = (err: Error, sent: boolean): void => {
      // The link under it dropped, not the target: a read goes to it once more (proxy.ts isLinkDropped).
      if (!write && !again && isLinkDropped(err)) {
        again = true
        deps.log('info', 'replica: a read lost its link, sending it again', { to: route.kind, path: pathOf(req) })
        forward(req, res, route, false, onFail, { away })
        return
      }
      deps.suspect(route.kind, err)
      if (!write) {
        // A read may go to the next one, and is answered here when nobody else can.
        const nextRoute = deps.route()
        if (nextRoute.kind !== 'alone' && nextRoute.kind !== route.kind) {
          forward(req, res, nextRoute, false, (err2) => {
            deps.suspect(nextRoute.kind, err2)
            answerAway(req, res, next, decision, 'nobody-answers')
          })
          return
        }
        return answerAway(req, res, next, decision, nextRoute.kind === 'alone' ? nextRoute.why : 'unreachable')
      }
      // A write that may have reached the target is never repeated nor journaled here.
      if (sent) {
        deps.log('warn', 'replica: a forwarded write got no answer', { to: route.kind, opId: req.headers[OP_ID_HEADER], method: req.method, path: pathOf(req), error: err.message })
        return timedOut(res, true)
      }
      // Provably not sent: answered as away.
      answerAway(req, res, next, decision, 'unreachable')
    }
    forward(req, res, route, write, onFail, { away })
  }

  return {
    middleware(req, res, next) {
      // Every answer of this replica says which presence it was made under (front.ts header).
      stampPresence(res)
      const decision = decide(req.method ?? 'GET', pathOf(req))
      if (decision.cls === 'feature') return next()
      if (decision.cls === 'local') {
        if (!decision.row?.local) return next()
        // A row with a condition and nobody to judge it is the leader's, as before WP6.
        const localHere = deps.localHere
        if (!localHere) return routeOn(req, res, next, decision)
        // Asked once, then here or to the leader as any read.
        Promise.resolve().then(() => localHere(req, decision)).catch(() => false).then((here) => {
          if (here) return next()
          routeOn(req, res, next, decision)
        })
        return
      }
      routeOn(req, res, next, decision)
    },

    upgrade(req, socket, head) {
      // Node drops its own error listener before 'upgrade': a browser that resets
      // while its stream opens would raise uncaught and end this server.
      socket.on('error', ignoreSocketError)
      upgradeTo(req, socket, head)
    },

    presenceChanged(answers) {
      for (const h of [...handshakes]) if (h.fwd.settled()) handshakes.delete(h)
      // The side that no longer answers: its handshakes are dispatched again, its sockets closed.
      const from: Target['kind'] = answers ? 'companion' : 'leader'
      const waiting = [...handshakes].filter((h) => h.to === from)
      for (const h of waiting) {
        handshakes.delete(h)
        if (h.fwd.cancel() && !h.socket.destroyed) upgradeTo(h.req, h.socket, h.head)
      }
      const sockets = [...splices].filter((sp) => sp.to === from)
      // A frozen Mac keeps its socket open and silent: close the browser's, so it reconnects here.
      // Back: a socket the companion took while it stood in goes to the Mac again.
      for (const sp of sockets) closeSplice(sp, answers ? 4002 : 4001, answers ? 'leader_back' : 'leader_away')
      if (answers) {
        if (sockets.length || waiting.length) deps.log('info', 'replica: the Mac is back, sockets on the companion closed', { sockets: sockets.length, handshakes: waiting.length })
        return
      }
      const stuck = [...flights].filter((f) => f.to === 'leader')
      for (const f of stuck) flip(f)
      if (stuck.length || sockets.length || waiting.length) {
        deps.log('info', 'replica: the Mac went away, in-flight forwards answered and its sockets closed', { forwards: stuck.length, sockets: sockets.length, handshakes: waiting.length })
      }
    },

    counts: () => {
      let spliced = 0
      let standIn = 0
      for (const sp of splices) { if (sp.to === 'leader') spliced++; else standIn++ }
      return { inFlight: flights.size, spliced, standIn, handshakes: [...handshakes].filter((h) => !h.fwd.settled()).length }
    },
  }
}
