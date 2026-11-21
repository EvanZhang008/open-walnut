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
 *                      a write with none is `hub_timeout` (it may have run: never twice)
 *   a plugin job's     the follower's answer is final; no follower: `hub_unreachable`
 *
 * ONE rule for "the leader is away": a call goes to the follower only while the follower
 * may write (`mayWrite`, the test `follower.op` applies: the leader quiet for its whole
 * window, or gone). In the seconds between the gateway passing over a quiet leader and
 * that window ending, a session's call takes the daemon's own path as before, and a plugin
 * job's call waits (`routeJob`), within its own deadline, for the leader to answer again
 * or the follower to be allowed to write, then goes that way.
 *
 * One attempt per call, timed as a relay to the leader is (relayAttemptMs). A follower
 * socket answers only the relays it was sent.
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
 * (handOff): the leader keeps it only from the host its config runs the plugin's jobs on
 * (core/plugin-jobs/index.ts relayedJobOf), the follower records the job as its write's maker.
 */
export type GatewayCaller = { kind: 'plugin-job'; plugin: string; job: string }

export interface FollowerGatewayDeps<S> {
  /** The follower of `home` linked now that answers local calls, or null. */
  follower(home: string): S | null
  /** Whether that follower may write now (the twin's followerMayWrite: no leader answers it). */
  mayWrite(home: string): boolean
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
}

export function createFollowerGateway<S>(deps: FollowerGatewayDeps<S>) {
  /** Codes a follower answers that hand a session's call back to the daemon's own answer. */
  const FALLS_BACK = ['needs_leader', 'unsupported_replica', 'unsupported_version']
  interface Pending { ws: S; call: HandOff; respond: (r: FollowerGatewayResponse) => void; timer: unknown }
  const pending = new Map<number, Pending>()
  /** How often a plugin job's waiting call looks again, and the time it keeps for its attempt after. */
  const JOB_WAIT_STEP_MS = 250
  const JOB_WAIT_SPARE_MS = 2_000

  /** A follower of `home` answers its calls now: linked, and allowed to write. */
  function answers(home: string | undefined): boolean {
    return !!home && deps.follower(home) !== null && deps.mayWrite(home)
  }

  /** Hand `call` to the follower. False: nothing was sent (none answers now, or the write failed); the caller goes on. */
  function handOff(call: HandOff, respond: (r: FollowerGatewayResponse) => void): boolean {
    const ws = deps.follower(call.home)
    if (!ws || !deps.mayWrite(call.home)) return false
    const relayId = deps.nextRelayId()
    const entry: Pending = { ws, call, respond, timer: null }
    pending.set(relayId, entry)
    // What is left of the call's time (after a wait, maybe little): the server answers within it,
    // and refuses before anything runs when it is too short for the op (replica/local-calls.ts).
    const answerInMs = deps.attemptMs(call.deadline)
    const sent = deps.send(ws, 'gateway-request', {
      relayId, instanceId: deps.instanceId, capability: call.capability, callerSid: call.callerSid, payload: call.payload,
      ...(call.caller ? { caller: call.caller } : {}), answerInMs,
    })
    if (!sent) {
      pending.delete(relayId)
      return false
    }
    entry.timer = deps.setTimer(() => ended(relayId, 'timeout'), answerInMs)
    deps.log('info', 'gateway: handed to this host\'s Walnut server', {
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
    if (e.call.fallback && e.call.readable) {
      deps.log('info', 'gateway: this host\'s Walnut server did not answer a read, answered here', { relayId, why, op })
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
    if (handOff(call, respond)) return 'handed'
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

  function holds(relayId: unknown): boolean {
    return typeof relayId === 'number' && pending.has(relayId)
  }

  /** The follower's answer: 'ok', or why it was not taken ('stale': nothing waits on it). */
  function settle(ws: S, relayId: number, resp: FollowerGatewayResponse): 'ok' | 'wrong_socket' | 'stale' {
    const e = pending.get(relayId)
    if (!e) return 'stale'
    if (e.ws !== ws) return 'wrong_socket'
    pending.delete(relayId)
    deps.clearTimer(e.timer)
    const code = !resp.ok && resp.error ? resp.error.code : ''
    if (e.call.fallback && FALLS_BACK.indexOf(code) !== -1) {
      deps.log('info', 'gateway: this host\'s Walnut server handed the call back', { relayId, code, op: e.call.payload.name })
      e.call.fallback()
      return 'ok'
    }
    e.respond(resp)
    return 'ok'
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

  return { answers, handOff, routeJob, holds, settle, dropSocket, responseOf, pendingCount: () => pending.size }
}
