/**
 * A message for the running turn through the cloud companion (api-v1-join.ts).
 *
 * The companion runs no turn of its own for a relayed conversation: the primary
 * does, so the primary decides whether its running turn takes the message. The
 * replica asks it with the same `server.chat.turn` action a turn uses, plus
 * `join: true`, under a turnId of its own: an older primary that knows no join
 * then refuses with `turn_active` (its turn runs), which the phone banks on, and
 * never mistakes the request for a replay of the running turn.
 */
import crypto from 'node:crypto'
import { isCompanion } from '../../core/server-role.js'
import { log } from '../../logging/index.js'
import { joinedReceiptOf, rememberJoined, type JoinOffer } from './api-v1-join.js'
import { claimChatSend, priorChatSend } from './chat-send-once.js'
import { followedRelayTurnId, type PrimaryChatTurnOutcome } from './chat-turn-relay.js'

const SERVER_RELAY_SID = '__server__'
const JOIN_RELAY_TIMEOUT_MS = 30_000
const TURN_ACTIVE = 'A turn is already active on this conversation'

/**
 * Replica: ask the primary to put the message into the conversation's running
 * turn. Null when it did not take it (no relayed turn followed here, the primary
 * refused, could not be reached): the route then answers 409 and the client keeps
 * the message for after the turn. A message the primary already had (a retry) is
 * taken.
 */
export async function relayChatJoinToPrimary(
  agentId: string, conversationId: string, turnId: string, text: string, messageId: string,
): Promise<JoinOffer | null> {
  if (!isCompanion() || followedRelayTurnId(conversationId) === undefined) return null
  const { callPrimaryControl } = await import('./v1-control-relay.js')
  const outcome = await callPrimaryControl(
    'server.chat.turn' as never,
    SERVER_RELAY_SID,
    { agentId, conversationId, text, turnId: crypto.randomUUID(), messageId, join: true },
    JOIN_RELAY_TIMEOUT_MS,
  ).catch(() => null)
  if (!outcome?.ok) {
    log.web.info('chat join relay: the primary could not be asked', {
      conversationId, agentId, messageId, ...(outcome && !outcome.ok ? { failure: outcome.failure.kind } : {}),
    })
    return null
  }
  const result = outcome.result as Partial<PrimaryChatTurnOutcome>
  if (result.accepted !== true) return null
  const primaryTurnId = typeof result.turnId === 'string' && result.turnId ? result.turnId : turnId
  if (result.joined !== true) {
    // The primary had it as a turn of its own (a repeat), or an older primary whose
    // turn had just ended started it as one. The message is taken; the client follows
    // that turn as it follows any send, and reads its answer from the conversation.
    log.web.info('chat join relay: the primary runs the message as a turn of its own', {
      conversationId, agentId, messageId, primaryTurnId, duplicate: result.duplicate === true,
    })
    return { turnId: primaryTurnId, laneSessionId: '', sent: Promise.resolve(), joined: false }
  }
  // The client follows the running turn under the id this box's stream uses.
  return {
    turnId: followedRelayTurnId(conversationId) ?? turnId,
    laneSessionId: typeof result.sessionId === 'string' ? result.sessionId : '',
    sent: Promise.resolve(),
    joined: true,
  }
}

/** Primary: a replica's message for the running turn. */
export async function handlePrimaryChatJoin(
  agentId: string, conversationId: string, text: string, turnId: string,
  messageId: string | undefined, hasImages: boolean,
): Promise<PrimaryChatTurnOutcome> {
  const refuse = (): PrimaryChatTurnOutcome => ({ accepted: false, turnId, reason: 'turn_active', message: TURN_ACTIVE })
  if (!messageId || hasImages) return refuse()
  // A retry of a message this box already took, as a turn or into one.
  const prior = priorChatSend(agentId, conversationId, messageId)
  if (prior?.state === 'started') {
    // Said as it was: a message that went into a turn, or one that ran as its own.
    const receipt = joinedReceiptOf(agentId, conversationId, messageId)
    return { accepted: true, turnId: prior.turnId, duplicate: true, ...receipt }
  }
  if (prior) return refuse()
  const { offerJoinToRunningTurn } = await import('./api-v1.js')
  const offer = offerJoinToRunningTurn(agentId, conversationId, text, messageId)
  if (!offer) return refuse()
  const claim = claimChatSend(agentId, conversationId, messageId, offer.turnId)
  try {
    await offer.sent
  } catch (err) {
    claim.dropped()
    log.web.warn('chat join relay: the message could not join the running turn', {
      conversationId, agentId, messageId, error: err instanceof Error ? err.message : String(err),
    })
    return refuse()
  }
  claim.started()
  rememberJoined(agentId, conversationId, messageId, offer.laneSessionId)
  log.web.info('chat join relay: the message joined the running turn', {
    conversationId, agentId, messageId, turnId: offer.turnId,
  })
  return { accepted: true, turnId: offer.turnId, joined: true, sessionId: offer.laneSessionId }
}
