/**
 * The companion's half of the forward (policy.ts): while the Mac answers, a
 * phone's /api/v1 call is carried to it (`server.http` over the bridge) and its
 * answer is sent back as it is; otherwise the companion's own route answers.
 *
 * "The Mac answers" is the leader's view, not one request's luck: the Mac's
 * bridge is up, its heartbeat is fresh, the companion does not lead any host,
 * and the user lets the companion stand in for the Mac (the heartbeat carries
 * `cloud_bridge.backup_leader`). A forward the Mac never saw (no bridge, a
 * refusal before the route ran, an old Mac) is answered here instead. A forward
 * that went out and got no answer is answered here only for a read; a write may
 * have been applied, so the phone is told that, never given a second copy.
 *
 * The carrier (replica plan WP13): a byte stream through the Mac's own daemon
 * (stream-forward.ts, the Mac's door is stream-door.ts) when its bridge hello
 * says `bridge-stream-v1`, with no size cap; else the `server.http` frame as
 * before. A stream refused at once was never sent and goes as that frame; one
 * the daemon or the Mac never answers counts as an unanswered call.
 */

import type { NextFunction, Request, Response } from 'express'
import type { Duplex } from 'node:stream'
import { log } from '../../logging/index.js'
import { isSelfCallToken } from '../../lib/self-api-root.js'
import { setLeaderPresence } from '../../core/server-role.js'
import { LEADER_HEARTBEAT_MS } from '../../core/leader/protocol.js'
import type { RelayFailure } from '../routes/v1-control-relay.js'
import { MAX_FORWARD_REQUEST_BYTES, companionAnswers, forwardRequestHeaders } from './policy.js'
import { forwardOnStream } from './stream-forward.js'

/** What the companion knows of the Mac right now. */
export interface PrimarySnapshot {
  bridge: boolean
  heard: boolean
  lastSeenAt: number
  leading: number
  backupAllowed: boolean | null
  takeoverMs: number
}

export type CallOutcome =
  | { ok: true; result: Record<string, unknown> }
  | { ok: false; failure: RelayFailure }

export interface ForwardDeps {
  now: () => number
  primary: () => Promise<PrimarySnapshot | null>
  call: (params: Record<string, unknown>, timeoutMs: number) => Promise<CallOutcome>
  /** WALNUT_COMPANION_FORWARD=0 turns the forward off. */
  enabled: () => boolean
  /**
   * This server's own op call (its Personal AI, its gateway): the companion
   * answering itself, so it keeps its own path and never reaches the Mac as a phone.
   */
  ownCall?: (req: Request) => boolean
  /**
   * The forward on a stream ('bridge-stream-v1', stream-forward.ts): taken when
   * `capable()` (the Mac's daemon said it can), else `call` (server.http) as before.
   */
  stream?: { capable: () => boolean | Promise<boolean>; open: () => Promise<Duplex> }
}

/** A read waits this long for the Mac before the companion answers it from its copy. */
export const FORWARD_READ_TIMEOUT_MS = 8_000
/** A write waits this long: the Mac may be slow, and a second copy of a write is worse. */
export const FORWARD_WRITE_TIMEOUT_MS = 25_000
/** A Mac that does not know `server.http` is asked again after this. */
const UNSUPPORTED_REST_MS = 10 * 60_000
/** At most this many reads are in flight to the Mac; more are answered here. */
const MAX_INFLIGHT_READS = 16

type Why =
  | 'turned-off' | 'no-bridge' | 'no-leader' | 'primary-unheard' | 'primary-silent' | 'primary-suspect'
  | 'companion-leads' | 'not-allowed' | 'primary-too-old'

/**
 * Whether the Mac answers, from the snapshot. `suspectAt`: a forward went out
 * and got no answer then; until the Mac is heard again after it, it is not asked.
 */
export function macAnswers(s: PrimarySnapshot | null, now: number, suspectAt: number, unsupportedUntil: number): Why | null {
  if (!s) return 'no-leader'
  if (!s.bridge) return 'no-bridge'
  if (!s.heard) return 'primary-unheard'
  if (now - s.lastSeenAt > Math.min(3 * LEADER_HEARTBEAT_MS, s.takeoverMs)) return 'primary-silent'
  if (suspectAt > 0 && s.lastSeenAt <= suspectAt) return 'primary-suspect'
  if (s.leading > 0) return 'companion-leads'
  if (s.backupAllowed !== true) return 'not-allowed'
  if (unsupportedUntil > now) return 'primary-too-old'
  return null
}

/** Away by the companion's own view; unknown (never heard, no leader) is not away. */
const AWAY = new Set<Why>(['no-bridge', 'primary-silent', 'primary-suspect', 'companion-leads'])
/** How often the companion's one view of the leader (core/server-role.ts) is brought up to date. */
const PRESENCE_TICK_MS = 5_000

export interface ForwardStatus {
  forwarded: number
  /** Of `forwarded`, the calls carried on a stream (bridge-stream-v1). */
  streamed: number
  /** Streams refused at once (nothing sent) whose call then went as one server.http frame. */
  streamRefused: number
  /** Calls answered here, by why. */
  answeredHere: Record<string, number>
  /** Writes that went out and got no answer (the phone was told it may have been applied). */
  unanswered: number
  lastForwardAt: number | null
  lastAnsweredHere: { why: string; at: number } | null
}

function hasBody(req: Request): boolean {
  return Number(req.headers['content-length'] ?? 0) > 0 || req.headers['transfer-encoding'] !== undefined
}

/** The JSON body as it arrived, or 'unsupported' for any other kind (it stays here). */
function bodyOf(req: Request): Buffer | null | 'unsupported' {
  if (!hasBody(req)) return null
  const type = String(req.headers['content-type'] ?? '')
  if (!/^application\/([\w.-]+\+)?json\b/i.test(type) || req.body === undefined) return 'unsupported'
  return Buffer.from(JSON.stringify(req.body))
}

export function createV1Forward(deps: ForwardDeps) {
  const status: ForwardStatus = { forwarded: 0, streamed: 0, streamRefused: 0, answeredHere: {}, unanswered: 0, lastForwardAt: null, lastAnsweredHere: null }
  let suspectAt = 0
  let unsupportedUntil = 0
  let inflightReads = 0
  let lastLoggedWhy: string | null = null

  function answerHere(why: string, req: Request, res: Response, next: NextFunction): void {
    status.answeredHere[why] = (status.answeredHere[why] ?? 0) + 1
    status.lastAnsweredHere = { why, at: deps.now() }
    // Says why the Mac was not asked, once per change: a sleeping Mac would log every poll.
    if (why !== lastLoggedWhy && !/^(stream|send|chat|identity|bytes|device-data|task-copy|paged|launch|own-call)$/.test(why)) {
      lastLoggedWhy = why
      log.web.info('v1 forward: the companion answers itself', { why, method: req.method, path: req.path })
    }
    res.setHeader('X-Walnut-Answered-By', 'companion')
    next()
  }

  async function middleware(req: Request, res: Response, next: NextFunction): Promise<void> {
    const method = req.method.toUpperCase()
    if (!deps.enabled()) return answerHere('turned-off', req, res, next)
    if (deps.ownCall?.(req)) return answerHere('own-call', req, res, next)
    const kept = companionAnswers(method, req.path)
    if (kept) return answerHere(kept, req, res, next)
    const now = deps.now()
    const why = macAnswers(await deps.primary(), now, suspectAt, unsupportedUntil)
    if (why) return answerHere(why, req, res, next)
    const body = bodyOf(req)
    if (body === 'unsupported') return answerHere('body-kind', req, res, next)
    // A stream has no size cap; the server.http frame keeps its own.
    const onStream = deps.stream ? await deps.stream.capable() : false
    if (!onStream && body && body.byteLength > MAX_FORWARD_REQUEST_BYTES) return answerHere('body-size', req, res, next)
    const isRead = method === 'GET' || method === 'HEAD'
    if (isRead && inflightReads >= MAX_INFLIGHT_READS) return answerHere('busy', req, res, next)

    const timeoutMs = isRead ? FORWARD_READ_TIMEOUT_MS : FORWARD_WRITE_TIMEOUT_MS
    if (onStream && deps.stream) return viaStream(req, res, next, method, body, isRead, timeoutMs, deps.stream.open)
    return viaCall(req, res, next, method, body, isRead, timeoutMs)
  }

  /** The call as one server.http frame over the bridge (the forward before bridge-stream-v1). */
  async function viaCall(
    req: Request, res: Response, next: NextFunction, method: string, body: Buffer | null, isRead: boolean, timeoutMs: number,
  ): Promise<void> {
    const params: Record<string, unknown> = {
      method,
      url: req.originalUrl,
      headers: forwardRequestHeaders(req.headers),
      // The Mac gives up a little before this side does, so its answer arrives.
      timeoutMs: timeoutMs - 2_000,
      ...(body ? { data: body.toString('base64'), size: body.byteLength } : {}),
    }
    if (isRead) inflightReads++
    let outcome: CallOutcome
    try {
      outcome = await deps.call(params, timeoutMs)
    } finally {
      if (isRead) inflightReads--
    }

    if (outcome.ok) {
      const r = outcome.result as { status?: unknown; headers?: unknown; data?: unknown; tooLarge?: unknown }
      const code = typeof r.status === 'number' && r.status >= 100 && r.status < 600 ? r.status : 502
      if (r.tooLarge === true) {
        if (isRead) return answerHere('reply-size', req, res, next)
        // The write was applied there; its reply did not fit. Say so rather than repeat it here.
        log.web.warn('v1 forward: a write was applied on the Mac and its reply was too large to carry', { method, path: req.path, status: code })
        status.forwarded++
        status.lastForwardAt = deps.now()
        res.status(code).setHeader('X-Walnut-Answered-By', 'primary')
        res.json({ ok: code < 400, note: 'Applied on the Mac; the reply was too large to carry back.' })
        return
      }
      status.forwarded++
      status.lastForwardAt = deps.now()
      res.status(code)
      if (r.headers && typeof r.headers === 'object') {
        for (const [k, v] of Object.entries(r.headers as Record<string, unknown>)) {
          if (typeof v === 'string') res.setHeader(k, v)
        }
      }
      res.setHeader('X-Walnut-Answered-By', 'primary')
      if (method === 'HEAD' || code === 204 || code === 304) { res.end(); return }
      res.end(typeof r.data === 'string' ? Buffer.from(r.data, 'base64') : Buffer.alloc(0))
      return
    }

    const f = outcome.failure
    if (f.kind === 'needs_upgrade') {
      unsupportedUntil = deps.now() + UNSUPPORTED_REST_MS
      return answerHere('primary-too-old', req, res, next)
    }
    // Refused before the route ran (a call the Mac would not take): nothing happened there.
    if (f.kind === 'error' && f.code === 'forward_refused') return answerHere('refused', req, res, next)
    // Never reached the Mac: answer here, whatever the method.
    if (f.kind === 'bridge_offline' && f.notSent) return answerHere('not-sent', req, res, next)
    // It went out and no answer came: the Mac is not asked again until it is heard.
    suspectAt = deps.now()
    if (isRead) return answerHere('unanswered', req, res, next)
    status.unanswered++
    log.web.warn('v1 forward: a write got no answer from the Mac', { method, path: req.path, kind: f.kind, message: f.message })
    res.status(504).json({
      error: {
        code: 'primary_timeout',
        message: 'Your Mac did not answer in time. It may have applied this change: check before you try again.',
      },
    })
  }

  /** The same ladder as the server.http answer below, for a call carried on a stream. */
  async function viaStream(
    req: Request, res: Response, next: NextFunction, method: string, body: Buffer | null,
    isRead: boolean, timeoutMs: number, open: () => Promise<Duplex>,
  ): Promise<void> {
    if (isRead) inflightReads++
    let o: Awaited<ReturnType<typeof forwardOnStream>>
    try {
      o = await forwardOnStream({ req, res, method, body, timeoutMs, open })
    } finally {
      if (isRead) inflightReads--
    }
    if (o.kind === 'answered') {
      status.forwarded++
      status.streamed++
      status.lastForwardAt = deps.now()
      return
    }
    if (o.kind === 'refused') return answerHere('refused', req, res, next)
    if (o.kind === 'not-sent') {
      // Nothing reached the Mac, whatever the method. Refused at once (no primary
      // socket that takes streams): the server.http frame, as before, cap included.
      // A daemon or Mac that did not answer the open in time is not asked again
      // until it is heard (as below).
      if (!o.slow) {
        status.streamRefused++
        log.web.info('v1 forward: no stream to the Mac, the call goes as one frame', { method, path: req.path, message: o.message })
        if (body && body.byteLength > MAX_FORWARD_REQUEST_BYTES) return answerHere('body-size', req, res, next)
        return viaCall(req, res, next, method, body, isRead, timeoutMs)
      }
      suspectAt = deps.now()
      log.web.info('v1 forward: the Mac did not take a stream in time', { method, path: req.path, message: o.message })
      return answerHere('unanswered', req, res, next)
    }
    suspectAt = deps.now()
    if (isRead) return answerHere('unanswered', req, res, next)
    status.unanswered++
    log.web.warn('v1 forward: a write got no answer from the Mac', { method, path: req.path, kind: 'stream', message: o.message })
    res.status(504).json({
      error: {
        code: 'primary_timeout',
        message: 'Your Mac did not answer in time. It may have applied this change: check before you try again.',
      },
    })
  }

  return {
    middleware: (req: Request, res: Response, next: NextFunction): void => {
      middleware(req, res, next).catch(next)
    },
    /**
     * The Mac is away by the companion's own view: no bridge, silent, a forward
     * since its last beat went unanswered, or the companion leads a host. A
     * route with a copy answers from it at once rather than wait on the Mac.
     * Unknown (never heard, no leader) is not away: such a route asks as before.
     */
    primaryAway: async (): Promise<boolean> => {
      const why = macAnswers(await deps.primary(), deps.now(), suspectAt, unsupportedUntil)
      return why !== null && AWAY.has(why)
    },
    /** The same view as an answer for server-role.ts: whether the Mac is there, and why not. */
    presence: async (): Promise<{ answers: boolean; why: string }> => {
      const why = macAnswers(await deps.primary(), deps.now(), suspectAt, unsupportedUntil)
      return { answers: why === null || !AWAY.has(why), why: why ?? 'answers' }
    },
    status: (): ForwardStatus & { suspectAt: number | null; unsupportedUntil: number | null } => ({
      ...status,
      answeredHere: { ...status.answeredHere },
      suspectAt: suspectAt || null,
      unsupportedUntil: unsupportedUntil > deps.now() ? unsupportedUntil : null,
    }),
  }
}

// ── The cloud box's one instance ──

let instance: ReturnType<typeof createV1Forward> | null = null
let primaryBridge: import('../../core/link/bridge-link.js').BridgeLink | null = null

export function getV1Forward(): ReturnType<typeof createV1Forward> {
  if (instance) return instance
  instance = createV1Forward({
    now: () => Date.now(),
    enabled: () => process.env.WALNUT_COMPANION_FORWARD !== '0',
    ownCall: (req) => {
      const auth = req.headers.authorization
      return typeof auth === 'string' && auth.startsWith('Bearer ') && isSelfCallToken(auth.slice(7))
    },
    primary: async () => {
      const [{ bridgeForHost }, { getBackupLeader }] = await Promise.all([
        import('../ws/bridge-registry.js'),
        import('../../core/leader/backup-leader.js'),
      ])
      const leader = await getBackupLeader()
      if (!leader) return null
      const s = leader.status()
      return {
        bridge: bridgeForHost('__local__').connected,
        heard: s.primaryHeard,
        lastSeenAt: s.primaryLastSeenAt,
        leading: s.leading.length,
        backupAllowed: s.backupAllowed,
        takeoverMs: s.takeoverMs,
      }
    },
    call: async (params, timeoutMs) => {
      const { callPrimaryControl } = await import('../routes/v1-control-relay.js')
      return callPrimaryControl('server.http', '__server__', params, timeoutMs)
    },
    stream: {
      capable: async () => {
        if (process.env.WALNUT_COMPANION_STREAM === '0') return false
        const [{ bootPolicy }, { bridgeHasCapability }] = await Promise.all([
          import('../../core/boot-policy.js'), import('../ws/bridge-registry.js'),
        ])
        return bootPolicy('companion-stream-forward') && bridgeHasCapability('__local__', 'bridge-stream-v1')
      },
      // Through the primary's bridge Link (core/link/bridge-link.ts): to the primary only.
      open: async () => {
        if (!primaryBridge) {
          const [registry, { createBridgeLink }] = await Promise.all([import('../ws/bridge-registry.js'), import('../../core/link/bridge-link.js')])
          primaryBridge = createBridgeLink({ hostAlias: '__local__', walnutId: '', registry })
        }
        return primaryBridge.openStream('primary', 'web')
      },
    },
  })
  return instance
}

let presenceTimer: ReturnType<typeof setInterval> | null = null

/**
 * The companion's one view of the leader (core/server-role.ts) follows this
 * forward's view, from boot (server.ts) until stop. Started there, never as a
 * side effect of getV1Forward(): a route reading leaderAnswers() before any
 * forward exists would see the default (not heard).
 */
export function startLeaderPresenceTick(): void {
  if (presenceTimer) return
  const tick = () => {
    void getV1Forward().presence().then((p) => setLeaderPresence(p.answers, p.why)).catch(() => { /* the next tick */ })
  }
  tick()
  presenceTimer = setInterval(tick, PRESENCE_TICK_MS)
  presenceTimer.unref?.()
}

export function stopLeaderPresenceTick(): void {
  if (presenceTimer) { clearInterval(presenceTimer); presenceTimer = null }
}

/** Tests only. */
export function _resetV1ForwardForTesting(): void {
  instance = null
  primaryBridge?.close()
  primaryBridge = null
  stopLeaderPresenceTick()
}
