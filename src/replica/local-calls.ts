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
 *   the Mac answers again   `needs_leader` before anything runs: the daemon relays it there
 *   a route that needs the Mac   its 503 `needs_leader` goes back with that code, so a
 *                                session's call gets the daemon's own away answer instead
 */
import { log } from '../logging/index.js'
import { relayedCallOf, serveRelayedCall, type KeptRelay } from '../core/peers/gateway-answer.js'
import { gatewayHubTimeoutMs } from '../providers/gateway-core.js'
import { DaemonFrameTooLargeError, tooLargeGatewayReply } from '../providers/daemon-frame-cap.js'

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
  const hostKey = deps.hostKey || '__local__'
  const send = async (reply: Record<string, unknown>, kept?: KeptRelay): Promise<boolean> => {
    try {
      return (await deps.request('gateway-result', reply, RESULT_ACK_MS)).ok === true
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
    void serveRelayedCall(call, {
      hostKey,
      hasCapability: (c) => deps.capabilities()?.includes(c) === true,
      label: 'replica',
      receivedAt,
      deadlineMs: gatewayHubTimeoutMs(),
      liftCodes: ['needs_leader'],
      refuse: (c) => deps.leaderAnswers()
        ? { relayId: c.relayId, error: 'your Mac answers again; the call goes to it', errorCode: 'needs_leader' }
        : null,
      send: (reply, kept) => send(reply, kept),
    })
  }
}
