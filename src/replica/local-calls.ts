/**
 * A host replica's answer to its own host's `walnut` calls while the Mac is away (the
 * `host-local-calls` capability; the daemon's side: providers/follower-gateway-core.ts).
 *
 * The daemon hands a call of a session or a plugin job on this host here as a
 * `gateway-request` event on the follower link, when no leader takes it. It runs through
 * the leader's own path (core/peers/gateway-answer.ts: dedupe, the capability router,
 * executeOp), whose API calls reach this replica's own routes with its in-process
 * credential and the caller's identity (write-actor.ts): reads answer from the copies, and
 * writes go to the write port and this host's journal, as a person's away write does.
 *
 *   the Mac answers again   `needs_leader` before anything runs: the daemon relays it there,
 *                           except a same-host send the daemon handed over marked `online`
 *                           (follower-peer-v1): away-sends.ts takes it as handleLocal would, and
 *                           whatever it does not deliver goes to the Mac (onlineReply)
 *   a route that needs the Mac   its 503 `needs_leader` goes back with that code, so a
 *                                session's call gets the daemon's own away answer instead
 *   a full journal, the brake    `queue_full` / `throttled` with the route's wait: retryable
 *   no host key yet             every call refused: an empty key would take the Mac's own origin
 *   too little time left        a call the daemon held while the Mac went quiet comes with what
 *                                is left of its time (`answerInMs`): it runs within that, and when
 *                                that is too short for the op (a start needs its start budget) it
 *                                is refused before anything runs, retryable, never "may have run"
 */
import { log } from '../logging/index.js'
import { packRelayResult, relayedCallOf, serveRelayedCall, type KeptRelay, type RelayedCall } from '../core/peers/gateway-answer.js'
import { gatewayHubTimeoutMs } from '../providers/gateway-core.js'
import { DaemonFrameTooLargeError, tooLargeGatewayReply } from '../providers/daemon-frame-cap.js'

/** The route refusals that go back with their own code: the daemon's away answer, and the two a caller retries. */
const LIFTED = ['needs_leader', 'queue_full', 'throttled'] as const

/** Answered this much before the daemon's own timer ends the relay. */
const ANSWER_MARGIN_MS = 500
/** What a call needs left to be done here: a start (a CLI spawned and its first turn sent), and any other. */
export const START_LEFT_MS = 10_000
export const CALL_LEFT_MS = 2_000

/** The time `call` needs here: a start's budget for one that may start a session. */
export function neededMs(call: RelayedCall): number {
  const p = call.payload as { name?: unknown; args?: { record_only?: unknown } } | null
  const name = call.capability === 'tools.call' && p && typeof p.name === 'string' ? p.name : ''
  return name === 'task_start' || (name === 'task_create' && p?.args?.record_only !== true) ? START_LEFT_MS : CALL_LEFT_MS
}

/** The ops a same-host send is (offline-host-core.ts LOCAL_SEND_OPS): the one call taken while the Mac answers. */
const ONLINE_OPS = ['task_send', 'session_send']

/** A same-host send the daemon handed over while the Mac answers ('follower-peer-v1'). */
export function isOnlineSend(event: Record<string, unknown>, call: RelayedCall): boolean {
  const p = call.payload as { name?: unknown } | null
  return event.online === true && call.capability === 'tools.call' && !!p && typeof p.name === 'string' && ONLINE_OPS.includes(p.name)
}

/** What a same-host send's answer is final with while the Mac answers: the daemon's own brakes, as its handleLocal answered them. */
const ONLINE_FINAL = ['throttled', 'queue_full']

/**
 * A same-host send's answer while the Mac answers: only a delivery made here (or the daemon's brake)
 * is final. Anything else this server could not finish (an error, a give-up, too little time left, a
 * refusal) goes to the Mac as handleLocal left it: `needs_leader`, the daemon relays it, and the
 * daemon's claim of the message id keeps it written once (offline-host-core.ts endOnline).
 */
export function onlineReply(reply: Record<string, unknown>): Record<string, unknown> {
  if (reply.result && typeof reply.result === 'object' && !reply.error) return reply
  if (typeof reply.errorCode === 'string' && (reply.errorCode === 'needs_leader' || ONLINE_FINAL.includes(reply.errorCode))) return reply
  const why = typeof reply.error === 'string' ? reply.error.slice(0, 300) : 'this host could not deliver it'
  return { relayId: reply.relayId, errorCode: 'needs_leader', error: `${why}; your Mac delivers it`, detail: { why: 'server_delivers' } }
}

/** How long the daemon may take to ack a result on the loopback link. */
const RESULT_ACK_MS = 10_000

export interface LocalCallsDeps {
  /** A command on the follower link (`gateway-result`). */
  request(cmd: string, params: Record<string, unknown>, timeoutMs: number): Promise<Record<string, unknown>>
  /** The Mac's name for this host: where the calls come from. */
  hostKey: string | null
  /** What the daemon advertised (its `hello`), or null before it answered. */
  capabilities(): readonly string[] | null
  /** Whether the Mac answers now (server-role.ts leaderAnswers). */
  leaderAnswers(): boolean
}

/** The handler for the daemon's `gateway-request` events. */
export function createLocalCalls(deps: LocalCallsDeps): (event: Record<string, unknown>) => void {
  // Never a stand-in name: '__local__' is the Mac's own origin, so a call would act as the Mac's.
  const hostKey = deps.hostKey ?? ''
  /** What the daemon advertised (its own capabilities, not this server's). */
  const daemonHas = (c: string) => deps.capabilities()?.includes(c) === true
  const send = async (reply: Record<string, unknown>, kept?: KeptRelay): Promise<boolean> => {
    try {
      const packed = await packRelayResult(reply, daemonHas('gateway-result-gz-v1'))
      return (await deps.request('gateway-result', packed, RESULT_ACK_MS)).ok === true
    } catch (err) {
      // Too large for one frame, or the link went: the caller hears why, never a bare timeout.
      log.web.warn('replica: a local call\'s answer could not be sent', { relayId: reply.relayId, error: err instanceof Error ? err.message : String(err) })
      const small = err instanceof DaemonFrameTooLargeError
        ? tooLargeGatewayReply(Number(reply.relayId), err.bytes, hostKey)
        : { relayId: reply.relayId, error: 'this host\'s Walnut server could not send the answer: ' + (err instanceof Error ? err.message : String(err)), errorCode: 'internal' }
      // A resend of this relay gets the same small answer, never the one that cannot be sent.
      if (kept) kept.reply = Promise.resolve(small)
      return deps.request('gateway-result', small, RESULT_ACK_MS).then((r) => r.ok === true, () => false)
    }
  }
  return (event) => {
    const receivedAt = Date.now()
    const call = relayedCallOf(event)
    if (!call) return
    const online = isOnlineSend(event, call)
    // Within what the daemon still waits for (an older daemon names none: the hub timeout).
    const left = call.answerInMs === undefined ? gatewayHubTimeoutMs() : Math.min(gatewayHubTimeoutMs(), call.answerInMs - ANSWER_MARGIN_MS)
    void serveRelayedCall(call, {
      hostKey,
      hasCapability: daemonHas,
      label: 'replica',
      receivedAt,
      deadlineMs: Math.max(0, left),
      liftCodes: LIFTED,
      refuse: (c) => !hostKey
        ? { relayId: c.relayId, error: 'this host\'s Walnut server does not know its host name yet, so it cannot answer for it', errorCode: 'needs_leader' }
        : deps.leaderAnswers() && !online
          ? { relayId: c.relayId, error: 'your Mac answers again; the call goes to it', errorCode: 'needs_leader' }
          // Never below a call handed over with its whole time (a short hub timeout set on purpose).
          : left < Math.min(neededMs(c), gatewayHubTimeoutMs() - ANSWER_MARGIN_MS)
            ? {
                relayId: c.relayId, errorCode: 'hub_unreachable',
                error: `this call reached this host's Walnut server with ${Math.max(0, Math.round(left / 1000))}s of its time left, too little to do it; nothing was done, try again`,
                detail: { why: 'too_little_time', retryAfterMs: 1_000 },
              }
            : null,
      send: (reply, kept) => send(online ? onlineReply(reply) : reply, kept),
    })
  }
}
