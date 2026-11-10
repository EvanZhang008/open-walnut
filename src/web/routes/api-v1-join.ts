/**
 * A message the phone sends while its conversation's turn runs goes into that turn
 * (`POST /api/v1/conversations/:id/messages` with `join: true`), as a session's
 * message does on the web (2026-11-09, the owner: "不要queue了 就像网页版也一样直接发出去").
 *
 * The running v1 lane turn opens its door here once its own message is with the
 * CLI (runLaneTurn `onJoinable`), and closes it when it ends. The route asks with no
 * await between its turn check and the offer, so a message is either inside the
 * turn, which then waits for its answer too (core/sessions/lane-turn-joins.ts), or
 * refused with the 409 `turn_active` an older phone already banks on. A request
 * without `join` never comes here: an older phone gets what it always got.
 */
import type { Response } from 'express'
import { isCompanion } from '../../core/server-role.js'
import * as chatHistory from '../../core/chat-history.js'
import type { LaneTurnJoiner } from '../../core/sessions/lane-turn.js'
import { log } from '../../logging/index.js'
import { claimChatSend } from './chat-send-once.js'

interface OpenJoin {
  agentId: string
  turnId: string
  laneSessionId: string
  joiner: LaneTurnJoiner
  /** The turn awaits these before it writes its answer. */
  rows: Promise<unknown>[]
}

const open = new Map<string, OpenJoin>()

/** The running turn of `conversationId` takes messages from now on. */
export function openJoin(opts: OpenJoin & { conversationId: string }): void {
  const { conversationId, ...entry } = opts
  open.set(conversationId, entry)
}

/** That turn takes none any more (it ended, or is ending). */
export function closeJoin(conversationId: string, turnId: string): void {
  if (open.get(conversationId)?.turnId === turnId) open.delete(conversationId)
}

/** A message for the running turn, as the box that decides answered it. `sent`
 *  settles once it is in the lane's queue; it rejects when the send failed.
 *  `joined` false: no turn ran any more, and the message started one of its own
 *  (an older primary's answer through a replica). */
export interface JoinOffer {
  turnId: string
  laneSessionId: string
  sent: Promise<void>
  joined: boolean
}

/**
 * Offer `text` to the running turn `turnId`. Synchronous: null when no such turn
 * takes it now (none open, another turn, another agent, not with the CLI yet,
 * ending).
 */
export function offerJoin(
  agentId: string, conversationId: string, turnId: string, text: string, messageId: string,
): JoinOffer | null {
  const entry = open.get(conversationId)
  if (!entry || entry.turnId !== turnId || entry.agentId !== agentId) return null
  // The row the phone reads back carries the phone's id from this copy (api-v1.ts
  // stampLaneMessageIds), as a turn's own message does. Written once the CLI has the
  // message, so one withdrawn unrun leaves no copy that could lend its id to a later
  // row with the same words. A copy that fails to write costs only that id on the
  // row: the message is in the lane. The turn awaits it before it writes its answer.
  const writeCopy = (): void => {
    entry.rows.push(chatHistory.addUserMessage(text, {
      displayText: text, turnId, agentId, conversationId, messageId,
    }).catch((err) => log.web.warn('api-v1 joined message: chat-history copy failed', {
      conversationId, turnId, messageId, error: err instanceof Error ? err.message : String(err),
    })))
  }
  const sent = entry.joiner.offer(text, messageId, writeCopy)
  if (!sent) return null
  return { turnId, laneSessionId: entry.laneSessionId, sent, joined: true }
}

// ── Joined messages, for a repeat of their POST ──

const JOINED_TTL_MS = 60 * 60_000
const JOINED_MAX = 2_000
const joinedReceipts = new Map<string, { sessionId: string; at: number }>()

function keyOf(agentId: string, conversationId: string, messageId: string): string {
  return `${agentId}\u0000${conversationId}\u0000${messageId}`
}

/** A message that went into a running turn: a repeat of its POST says so too. */
export function rememberJoined(agentId: string, conversationId: string, messageId: string, sessionId: string): void {
  const key = keyOf(agentId, conversationId, messageId)
  joinedReceipts.delete(key)
  joinedReceipts.set(key, { sessionId, at: Date.now() })
  while (joinedReceipts.size > JOINED_MAX) joinedReceipts.delete(joinedReceipts.keys().next().value as string)
}

/** The fields a repeat's 202 adds for a message that went into a turn (none for any other). */
export function joinedReceiptOf(
  agentId: string, conversationId: string, messageId: string,
): { joined: true; sessionId: string } | Record<string, never> {
  const key = keyOf(agentId, conversationId, messageId)
  const hit = joinedReceipts.get(key)
  if (!hit) return {}
  if (Date.now() - hit.at > JOINED_TTL_MS) { joinedReceipts.delete(key); return {} }
  return { joined: true, sessionId: hit.sessionId }
}

// ── The route's answer ──

function turnActive(res: Response): void {
  res.status(409).json({ error: { code: 'turn_active', message: 'A turn is already active on this conversation' } })
}

/**
 * Send `text` into the conversation's running turn `runningTurnId`, or answer
 * nothing (false) when that turn cannot take it now. On this box the offer is made
 * before the first await, so it is judged against the turn the route just saw; a
 * replica claims the id first and then asks the primary (chat-join-relay.ts), so a
 * repeat arriving meanwhile waits for that answer instead of asking again. A taken
 * message is claimed under the turn's id, so a repeat of the POST is answered by
 * it and never sent twice; one whose send fails is given back and refused with 409,
 * the answer that makes the client keep it for after the turn.
 */
export async function answerJoin(
  res: Response, agentId: string, conversationId: string, runningTurnId: string, text: string, messageId: string,
): Promise<boolean> {
  let offer: JoinOffer | null
  let claim: ReturnType<typeof claimChatSend>
  if (!isCompanion()) {
    offer = offerJoin(agentId, conversationId, runningTurnId, text, messageId)
    if (!offer) return false
    claim = claimChatSend(agentId, conversationId, messageId, offer.turnId)
  } else {
    claim = claimChatSend(agentId, conversationId, messageId, runningTurnId)
    const { relayChatJoinToPrimary } = await import('./chat-join-relay.js')
    offer = await relayChatJoinToPrimary(agentId, conversationId, runningTurnId, text, messageId)
    if (!offer) { claim.dropped(); return false }
  }
  try {
    await offer.sent
  } catch (err) {
    claim.dropped()
    log.web.warn('api-v1 message could not join the running turn', {
      conversationId, turnId: offer.turnId, agentId, messageId,
      error: err instanceof Error ? err.message : String(err),
    })
    turnActive(res)
    return true
  }
  claim.started(offer.turnId)
  if (!offer.joined) {
    log.web.info('api-v1 message for the running turn started a turn of its own', { conversationId, turnId: offer.turnId, agentId, messageId })
    res.status(202).json({ turnId: offer.turnId })
    return true
  }
  rememberJoined(agentId, conversationId, messageId, offer.laneSessionId)
  log.web.info('api-v1 message joined the running turn', {
    conversationId, turnId: offer.turnId, agentId, messageId, messageLength: text.length,
  })
  res.status(202).json({ turnId: offer.turnId, joined: true, sessionId: offer.laneSessionId })
  return true
}

/** Tests only. */
export function _resetJoinsForTesting(): void {
  open.clear()
  joinedReceipts.clear()
}
