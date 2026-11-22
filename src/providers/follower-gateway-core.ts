/**
 * A host's `walnut` calls answered by its own Walnut server while the leader is away
 * ('follower-gateway-v1'). Shared by both daemon twins (daemon-source.ts inlines it by
 * `toString()`): self-contained, no imports at runtime.
 *
 * When the gateway's rules find no leader to relay a call to, and a follower of that
 * Walnut is linked here that said at `follower.hello` that it answers local calls, the
 * call goes to it as a `gateway-request` event (the same event the leader gets) and its
 * `gateway-result` answers the caller. That server runs the call through the same task
 * logic the leader runs (core/peers/gateway-answer.ts), on its copies.
 *
 *   a session's call   the follower first; it not linked, or answering `needs_leader` or
 *                      an unsupported code, the daemon's own away answer as before
 *                      (offlineHost.handle). A read with no answer in time goes there too;
 *                      a write with none is `hub_timeout` (it may have run: never twice).
 *                      A refusal the follower marks `detail.final` (its own `needs_leader`:
 *                      a route of the leader's, a write it cannot keep, a task the Mac keeps
 *                      local) is the caller's answer while the follower may still write. The
 *                      Mac back: it goes on as before, to the leader that answers now (nothing
 *                      ran). The companion leading: relayed to it (relayElsewhere), never to
 *                      the daemon's own away answer; what the companion does not take either
 *                      (its "needs the Walnut server"), or with no link to it now, ends as the
 *                      follower said, or held for the Mac where the daemon holds such a call
 *                      (holdForLeader: a message, a memory write)
 *   a plugin job's     the follower's answer is final; no follower: `hub_unreachable`
 *   a same-host send   while the leader answers (`online`, 'follower-peer-v1'): handed to a
 *                      follower that said `answersOnline`, in place of the daemon's own
 *                      handleLocal; what it leaves (`needs_leader`), or does not answer in
 *                      time, goes to the leader, carrying the message id the daemon set, so a
 *                      delivery made twice is written once
 *
 * ONE rule for "the leader is away": a call goes to the follower only while the follower
 * may write (`mayWrite`, the test `follower.op` applies: the leader quiet for its whole
 * window, or gone). In the seconds between the gateway passing over a quiet leader and
 * that window ending, a session's call takes the daemon's own path as before, and a plugin
 * job's call waits (`routeJob`), within its own deadline, for the leader to answer again
 * or the follower to be allowed to write, then goes that way.
 *
 * The follower's own view of the leader lags this daemon's by up to a poll of follower.status
 * (a few seconds): right after the leader's link drops, it may still refuse with `leader_answers`
 * ("the Mac answers again") a call this daemon handed it because the leader is gone. While this
 * daemon still sees the leader away, that refusal is not taken at its word: the call is handed to
 * the follower again every LAG_STEP_MS, under the SAME relayId (a refusal runs nothing and is not
 * kept, so the follower's dedupe still runs it once), until it answers, the leader answers again
 * here (the call is routed afresh: relayed), or LAG_MAX_MS or the call's time runs out (today's
 * way: the daemon's own away answer, counted).
 *
 * One attempt per call, timed as a relay to the leader is (relayAttemptMs). A follower
 * socket answers only the relays it was sent.
 *
 * `noteOwnAnswer` counts each call the daemon then answers with its own away code while a
 * follower was there to answer it (a hand-back, or a call while it is linked and may write),
 * per op: the number task B drives to zero, read in follower.status and server.status.
 */

export const FOLLOWER_GATEWAY_CAPABILITY = 'follower-gateway-v1'

export interface FollowerGatewayResponse {
  ok: boolean
  result?: Record<string, unknown>
  error?: { code: string; message: string; detail?: unknown; retryAfterMs?: number; api?: unknown }
}

/**
 * Who made the call, beside its session id: a plugin job, named by the daemon from its own record
 * of the run it started (plugin-jobs-core.ts callerOfRun), never from the caller's words. The same
 * `caller` frame field goes to the leader (relayToPrimary) and to this host's own Walnut server
 * (handOff): the leader keeps it only for a job it gives that host (core/plugin-jobs/index.ts
 * relayedJobOf), the follower records the job as its write's maker.
 *
 * `vouched: true`: the daemon saw that the process on the gateway socket IS that run or one of its
 * descendants (the standalone daemon's process-tree check, daemon-standalone.ts jobCallerVouched).
 * Absent: the job is named for the record only. The run's id is no secret from another process of
 * the same user (it is in the run's environment and its state file), so anything that lets a job do
 * more than an anonymous caller reads `vouched`, never the name alone. The JS fallback twin
 * (daemon-source.ts) cannot read a socket's process, so its callers are never vouched.
 */
export type GatewayCaller = { kind: 'plugin-job'; plugin: string; job: string; vouched?: true }

export interface FollowerGatewayDeps<S> {
  /** The follower of `home` linked now that answers local calls, or null. */
  follower(home: string): S | null
  /** Whether that follower may write now (the twin's followerMayWrite: no leader answers it). */
  mayWrite(home: string): boolean
  /** The cloud companion leads `home` (a backup lead is recorded): what the follower refuses for want of a leader is asked of it. */
  leaderElsewhere?(home: string): boolean
  /**
   * Relay `call` to that leader, its answer to `answer`. False: nothing was sent (no link to it
   * now), so the follower's answer stands. The twins' forwardToBackup.
   */
  relayElsewhere?(call: HandOff, answer: (r: FollowerGatewayResponse) => void): boolean
  /**
   * What this host keeps for the Mac of a call no leader took (the twins' offlineHost.holdWrite: a
   * message or a memory write, held as the follower's own hold is, which the daemon refuses while
   * the companion leads), or null.
   */
  holdForLeader?(call: HandOff): FollowerGatewayResponse | null
  /** Whether that follower takes a same-host send while the leader answers (its hello's `answersOnline`). */
  answersOnline?(ws: S): boolean
  now(): number
  /** Send an event on a socket; false when it could not be written. */
  send(ws: S, ev: string, data: Record<string, unknown>): boolean
  nextRelayId(): number
  instanceId: string
  /** How long the attempt may wait for a call due by `deadline` (gateway-core.ts relayAttemptMs). */
  attemptMs(deadline: number): number
  setTimer(fn: () => void, ms: number): unknown
  clearTimer(t: unknown): void
  log(level: 'info' | 'warn', msg: string, data?: Record<string, unknown>): void
  /** This daemon stops (the twins' daemonCommands.closed): a call handed again later ends as a new one would. */
  stopping?(): boolean
}

export interface HandOff {
  home: string
  capability: string
  callerSid: string
  payload: Record<string, unknown>
  caller?: GatewayCaller
  deadline: number
  /** A read: with no answer in time, `fallback` answers it (nothing runs twice by reading). */
  readable?: boolean
  /** The daemon's own path (a session's call); absent: the follower's answer is final. */
  fallback?: () => void
  /**
   * A same-host send while the leader answers: no write gate (its records are `online`), and with
   * no answer in time `fallback` ends it (the twins' endOnline: relayed to the leader unless the
   * follower's follower.peer already claimed its message id and wrote it; offline-host-core.ts).
   */
  online?: boolean
  /** A plugin job's call: routes it afresh (the twin's `again`), set by routeJob. */
  reroute?: () => void
  /** Its caller hung up (the twins' gatewayCallerLeft): nobody reads it, so it is not handed again. */
  left?: () => boolean
}

export function createFollowerGateway<S>(deps: FollowerGatewayDeps<S>) {
  /** Codes a follower answers that hand a session's call back to the daemon's own answer. */
  const FALLS_BACK = ['needs_leader', 'unsupported_replica', 'unsupported_version']
  /** `lagSince`: when the follower first refused this call with `leader_answers` while this daemon saw the leader away. */
  interface Pending { ws: S; call: HandOff; respond: (r: FollowerGatewayResponse) => void; timer: unknown; lagSince?: number }
  const pending = new Map<number, Pending>()
  /** Calls between two hands of the lag wait (waitOutLag): out of `pending`, still the follower's. */
  const lagging = new Set<number>()
  /** How often a plugin job's waiting call looks again, and the time it keeps for its attempt after. */
  const JOB_WAIT_STEP_MS = 250
  const JOB_WAIT_SPARE_MS = 2_000
  /**
   * A `leader_answers` refusal while this daemon sees the leader away: handed again this often, for
   * at most LAG_MAX_MS (the follower re-reads follower.status every 3 s), and only while the call
   * keeps LAG_SPARE_MS for the follower to run it: a start's budget (replica/local-calls.ts
   * START_LEFT_MS, 10 s, plus its 500 ms answer margin), so no re-handed call is refused as too late.
   */
  const LAG_STEP_MS = 500
  const LAG_MAX_MS = 5_000
  const LAG_SPARE_MS = 10_500

  /** A follower of `home` answers its calls now: linked, and allowed to write. */
  function answers(home: string | undefined): boolean {
    return !!home && deps.follower(home) !== null && deps.mayWrite(home)
  }

  /** A follower of `home` takes a same-host send while the leader answers ('follower-peer-v1'). */
  function answersOnline(home: string | undefined): boolean {
    const ws = home ? deps.follower(home) : null
    return ws !== null && deps.answersOnline?.(ws) === true
  }

  /** Hand `call` to the follower. False: nothing was sent (none answers now, or the write failed); the caller goes on. */
  function handOff(call: HandOff, respond: (r: FollowerGatewayResponse) => void): boolean {
    return sendTo(call, respond)
  }

  /** handOff, or a call handed again after a lagging refusal (`again`: its relayId and when the lag began). */
  function sendTo(call: HandOff, respond: (r: FollowerGatewayResponse) => void, again?: { relayId: number; lagSince: number }): boolean {
    const ws = deps.follower(call.home)
    if (!ws) return false
    if (call.online ? deps.answersOnline?.(ws) !== true : !deps.mayWrite(call.home)) return false
    const relayId = again ? again.relayId : deps.nextRelayId()
    const entry: Pending = { ws, call, respond, timer: null, ...(again ? { lagSince: again.lagSince } : {}) }
    pending.set(relayId, entry)
    // What is left of the call's time (after a wait, maybe little): the server answers within it,
    // and refuses before anything runs when it is too short for the op (replica/local-calls.ts).
    const answerInMs = deps.attemptMs(call.deadline)
    const sent = deps.send(ws, 'gateway-request', {
      relayId, instanceId: deps.instanceId, capability: call.capability, callerSid: call.callerSid, payload: call.payload,
      ...(call.caller ? { caller: call.caller } : {}), ...(call.online ? { online: true } : {}), answerInMs,
    })
    if (!sent) {
      pending.delete(relayId)
      return false
    }
    entry.timer = deps.setTimer(() => ended(relayId, 'timeout'), answerInMs)
    deps.log('info', again ? 'gateway: handed to this host\'s Walnut server again' : 'gateway: handed to this host\'s Walnut server', {
      relayId, capability: call.capability, callerSid: call.callerSid, op: typeof call.payload.name === 'string' ? call.payload.name : undefined,
      ...(call.caller ? { plugin: call.caller.plugin, job: call.caller.job } : {}),
    })
    return true
  }

  function ended(relayId: number, why: 'timeout' | 'closed'): void {
    const e = pending.get(relayId)
    if (!e) return
    pending.delete(relayId)
    deps.clearTimer(e.timer)
    const op = typeof e.call.payload.name === 'string' ? e.call.payload.name : undefined
    if (e.call.fallback && (e.call.readable || e.call.online)) {
      deps.log('info', e.call.online ? 'gateway: this host\'s Walnut server did not answer a same-host send, relayed to the leader' : 'gateway: this host\'s Walnut server did not answer a read, answered here', { relayId, why, op })
      e.call.fallback()
      return
    }
    deps.log('warn', 'gateway: this host\'s Walnut server did not answer', { relayId, why, op })
    e.respond({ ok: false, error: { code: 'hub_timeout', message: 'this host\'s Walnut server did not answer in time; the call may have run, read before trying again' } })
  }

  /**
   * A plugin job's call that no leader takes now. 'handed': the follower has it. 'waiting':
   * a follower is linked but may not write yet (the leader went quiet within its window and
   * may answer again): `again` runs in a moment, to route the call afresh. 'none': no
   * follower, or no time left to wait; the caller answers `hub_unreachable`.
   */
  function routeJob(call: HandOff, respond: (r: FollowerGatewayResponse) => void, again: () => void, waited = false): 'handed' | 'waiting' | 'none' {
    if (handOff({ ...call, reroute: again }, respond)) return 'handed'
    if (deps.follower(call.home) === null) return 'none'
    if (call.deadline - deps.now() <= JOB_WAIT_STEP_MS + JOB_WAIT_SPARE_MS) return 'none'
    if (!waited) {
      deps.log('info', 'gateway: a plugin job\'s call waits for its leader or this host\'s Walnut server', {
        op: typeof call.payload.name === 'string' ? call.payload.name : undefined, ...(call.caller ? { plugin: call.caller.plugin, job: call.caller.job } : {}),
      })
    }
    deps.setTimer(again, JOB_WAIT_STEP_MS)
    return 'waiting'
  }

  /** Op names counted one by one; past this many, the rest share one row. */
  const OWN_OPS_MAX = 200
  const own = { total: 0, byOp: {} as Record<string, number>, byWhy: {} as Record<string, number>, last: null as null | { op: string; why: string; at: number } }

  /**
   * The daemon answers a call with its own away code (offlineHost.handle) although a follower was
   * there: `handed_back` (the follower answered needs_leader or an unsupported code, or a read it
   * did not answer in time) or `follower_linked` (it is linked and may write, and the call was not
   * handed to it: an outside caller's read, say). One log line each.
   */
  function noteOwnAnswer(op: unknown, why: 'handed_back' | 'follower_linked', callerSid?: string): void {
    const name = typeof op === 'string' && op ? op : '(none)'
    const key = Object.prototype.hasOwnProperty.call(own.byOp, name) || Object.keys(own.byOp).length < OWN_OPS_MAX ? name : '(other)'
    own.total++
    own.byOp[key] = (own.byOp[key] ?? 0) + 1
    own.byWhy[why] = (own.byWhy[why] ?? 0) + 1
    own.last = { op: name, why, at: deps.now() }
    deps.log('info', 'gateway: daemon offline answer used', { op: name, why, ...(callerSid ? { callerSid } : {}), total: own.total })
  }

  /**
   * A call the daemon answers with its own away code (offlineHost.handle): counted when this host's
   * follower was there for it, handed back by it or linked and allowed to write. One rule for both twins.
   */
  function noteOwnOffline(home: string, capability: string, callerSid: string, payload: Record<string, unknown>, handedBack?: boolean): void {
    const why = handedBack ? 'handed_back' : answers(home) ? 'follower_linked' : null
    if (why) noteOwnAnswer(capability === 'tools.call' ? payload.name : capability, why, callerSid)
  }

  /** What noteOwnAnswer counted since this daemon started. */
  function ownAnswers(): { total: number; byOp: Record<string, number>; byWhy: Record<string, number>; last: null | { op: string; why: string; at: number } } {
    return { total: own.total, byOp: { ...own.byOp }, byWhy: { ...own.byWhy }, last: own.last ? { ...own.last } : null }
  }

  function holds(relayId: unknown): boolean {
    return typeof relayId === 'number' && pending.has(relayId)
  }

  /**
   * The follower refused with `leader_answers` a call this daemon handed it while it saw the leader
   * away: its view lags (see the top). True: the call waits a step, then goes to the follower again
   * under the same relayId, or, the leader answering here again by then, is routed afresh (relayed,
   * nothing ran). False, the refusal taken as before: a same-host send, the leader answering here
   * already or the companion leading, nothing to route it on, or the lag budget or the call's time spent.
   */
  function waitOutLag(relayId: number, e: Pending): boolean {
    const home = e.call.home
    const goOn = e.call.fallback ?? e.call.reroute
    if (e.call.online || !goOn || !deps.mayWrite(home) || deps.leaderElsewhere?.(home) === true) return false
    const now = deps.now()
    const lagSince = e.lagSince ?? now
    if (now + LAG_STEP_MS - lagSince > LAG_MAX_MS || e.call.deadline - now - LAG_STEP_MS < LAG_SPARE_MS) return false
    const op = typeof e.call.payload.name === 'string' ? e.call.payload.name : undefined
    if (e.lagSince === undefined) deps.log('info', 'gateway: this host\'s Walnut server does not see the leader away yet; the call goes to it again', { relayId, op })
    lagging.add(relayId)
    deps.setTimer(() => {
      lagging.delete(relayId)
      // As the first hand checks (the twins' handleGatewayLine, routeJob's `again`): a daemon that
      // stops answers it so, and a caller that left is not handed again, nor routed on.
      if (deps.stopping?.() === true) {
        e.respond({ ok: false, error: { code: 'hub_unreachable', message: 'daemon is shutting down; retry after reconnecting', detail: { stopping: true } } })
        return
      }
      if (e.call.left?.() === true) {
        deps.log('info', 'gateway: a call this host\'s Walnut server refused ends before it is handed again, its caller left', { relayId, op })
        return
      }
      if (!deps.mayWrite(home)) {
        deps.log('info', 'gateway: the leader answers again; a call this host\'s Walnut server refused is routed afresh', { relayId, op })
        goOn()
        return
      }
      // The follower gone, or the write failed: the twin's rules decide, as on any hand-back.
      if (!sendTo(e.call, e.respond, { relayId, lagSince })) goOn()
    }, LAG_STEP_MS)
    return true
  }

  /** The follower's answer: 'ok', or why it was not taken ('stale': nothing waits on it). */
  function settle(ws: S, relayId: number, resp: FollowerGatewayResponse): 'ok' | 'wrong_socket' | 'stale' {
    const e = pending.get(relayId)
    if (!e) return 'stale'
    if (e.ws !== ws) return 'wrong_socket'
    pending.delete(relayId)
    deps.clearTimer(e.timer)
    const code = !resp.ok && resp.error ? resp.error.code : ''
    // `final`: the follower's word stands (a same-host send while the leader answers still goes on).
    // Only while no leader answers here: the Mac back takes what it refused.
    const detail = !resp.ok && resp.error ? resp.error.detail as { final?: unknown } | undefined : undefined
    const final = !e.call.online && !!detail && typeof detail === 'object' && detail.final === true && deps.mayWrite(e.call.home)
    if (code === 'needs_leader' && !!detail && typeof detail === 'object' && (detail as { why?: unknown }).why === 'leader_answers' && waitOutLag(relayId, e)) return 'ok'
    // The companion leading: the leader that answers now, asked directly (see the top).
    if (final && code === 'needs_leader' && e.call.fallback && deps.leaderElsewhere?.(e.call.home) === true) {
      askElsewhere(relayId, e, resp)
      return 'ok'
    }
    if (e.call.fallback && FALLS_BACK.indexOf(code) !== -1 && !final) {
      deps.log('info', 'gateway: this host\'s Walnut server handed the call back', { relayId, code, op: e.call.payload.name })
      e.call.fallback()
      return 'ok'
    }
    e.respond(resp)
    return 'ok'
  }

  /** The companion's answer means it took nothing: it needs the Mac too (its own or its API's `needs_leader`), or did not lead. */
  function notTaken(r: FollowerGatewayResponse): boolean {
    if (r.ok || !r.error) return false
    const api = r.error.api && typeof r.error.api === 'object' ? (r.error.api as { code?: unknown }).code : undefined
    return r.error.code === 'hub_unreachable' || r.error.code === 'needs_leader' || api === 'needs_leader'
  }

  /**
   * A final `needs_leader` while the companion leads: relayed to it. What it does not take, or with
   * no link to it, ends as the follower said, or held for the Mac (holdForLeader). Never the
   * daemon's own away answer, so never counted as one.
   */
  function askElsewhere(relayId: number, e: Pending, refused: FollowerGatewayResponse): void {
    const op = typeof e.call.payload.name === 'string' ? e.call.payload.name : undefined
    const stand = (why: 'not_taken' | 'no_link') => {
      const held = deps.holdForLeader?.(e.call) ?? null
      deps.log('info', held ? 'gateway: a call nobody leading takes now is held for the Mac' : 'gateway: this host\'s Walnut server\'s refusal stands', { relayId, op, why })
      e.respond(held ?? refused)
    }
    const sent = deps.relayElsewhere?.(e.call, (r) => (notTaken(r) ? stand('not_taken') : e.respond(r))) === true
    if (sent) deps.log('info', 'gateway: this host\'s Walnut server needs a leader for the call; asked of the cloud companion, which leads', { relayId, op })
    else stand('no_link')
  }

  /** A follower socket closed: what it was sent and never answered ends now. */
  function dropSocket(ws: S): void {
    for (const [relayId, e] of [...pending]) if (e.ws === ws) ended(relayId, 'closed')
  }

  /** A gateway-result's fields as the caller's answer. */
  function responseOf(f: { result?: unknown; error?: unknown; errorCode?: unknown; detail?: unknown; api?: unknown }): FollowerGatewayResponse {
    if (f.result && typeof f.result === 'object' && !f.error) return { ok: true, result: f.result as Record<string, unknown> }
    const error: NonNullable<FollowerGatewayResponse['error']> = {
      code: typeof f.errorCode === 'string' && f.errorCode ? f.errorCode : 'internal',
      message: typeof f.error === 'string' && f.error ? f.error : 'gateway request failed',
      ...(f.api !== undefined ? { api: f.api } : {}),
    }
    if (f.detail !== undefined) {
      error.detail = f.detail
      const ra = f.detail && typeof f.detail === 'object' ? (f.detail as { retryAfterMs?: unknown }).retryAfterMs : undefined
      if (typeof ra === 'number') error.retryAfterMs = ra
    }
    return { ok: false, error }
  }

  return { answers, answersOnline, handOff, routeJob, holds, settle, dropSocket, responseOf, noteOwnAnswer, noteOwnOffline, ownAnswers, pendingCount: () => pending.size + lagging.size }
}
