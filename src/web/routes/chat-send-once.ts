/**
 * One chat send, one turn, by the message id the client minted for it.
 *
 * `POST /api/v1/conversations/:id/messages` takes an additive `messageId`. The phone
 * mints one per message and sends every attempt of that message under it, the way
 * session sends carry their `qm-*` ids. A POST whose answer never reached the phone
 * (the app went to the background, the connection dropped) is INCONCLUSIVE there:
 * the server may have the message and be running its turn. Before this, the retry
 * the person tapped was a new message to the server, so the agent got the same
 * instruction twice (App Store gate r8, Q1chat-x). Now the box that took the first
 * POST answers a repeat with the first one's 202 and starts nothing.
 *
 * THE PRIMARY IS THE AUTHORITY. The box that runs a turn is the box that can say
 * whether it ran: the primary. A relayed turn carries its `messageId` to the
 * primary (chat-turn-relay.ts), and the primary keeps the same map, so a relay of
 * a message it already took is answered `duplicate: true` with the ORIGINAL turnId
 * and starts nothing there either. This covers the phone that switches between the
 * companion and the Mac, too.
 *
 * On the companion an id goes through these states:
 *  - CLAIMED: the POST was accepted and its relay is in the air. A repeat waits
 *    for the outcome (`ClaimedChatSend.outcome`), so it is answered by what
 *    happened;
 *  - STARTED: the primary accepted the turn (or the companion answered it
 *    itself). A repeat gets the first 202 with `duplicate: true`;
 *  - UNSURE: the relay failed in a way that leaves open that the primary got the
 *    turn (no accept came back in time, or the bridge died after the send). The id
 *    is KEPT, with the turnId it was relayed under, and the retry is relayed again
 *    under the same turnId and messageId, for the primary to dedupe (send-once gate
 *    r1, MEDIUM-1: giving the id back here made the retry a second turn there);
 *  - gone: the turn PROVABLY never ran (the relay never left this box, the primary
 *    answered that it does not know the action, or it refused with its own turn
 *    running). The id is given back, so the retry the phone makes after the failure
 *    runs (the order gate r6 caught the opposite, its HIGH-3: the id was remembered
 *    before the relay, every retry after a failed relay was answered `duplicate:
 *    true`, and the message was lost for an hour).
 *
 * Kept in memory, per box and for an hour: long enough for any retry a person
 * makes after a lost answer, and nothing to migrate. A RESTART FORGETS every id
 * (the send-once gate's G-P4: a retry after a restart, a deploy included, runs
 * again); that is the price of keeping nothing on disk, and it is no worse than
 * before the field existed. The phone also hides its failed copy once the
 * conversation shows the message's own row (rows carry `messageId`, and
 * ChatStore.carryLocalRows matches by it), which is what keeps most retries from
 * happening at all.
 */

const SEND_ONCE_TTL_MS = 60 * 60_000
const SEND_ONCE_MAX = 2_000
/** A client id, never a path or markup: letters, digits and `_.:-`, at most 128. */
const MESSAGE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/

export type ChatSendOutcome = 'started' | 'dropped' | 'unsure'

interface Entry {
  turnId: string
  at: number
  state: 'claimed' | 'started' | 'unsure'
  /** Resolves when a claimed send starts its turn, is given back, or ends unsure. */
  outcome: Promise<ChatSendOutcome>
  settle: (outcome: ChatSendOutcome) => void
}

const accepted = new Map<string, Entry>()

function keyOf(agentId: string, conversationId: string, messageId: string): string {
  return `${agentId}\u0000${conversationId}\u0000${messageId}`
}

/** A message id the route takes, or undefined (none, or one it does not take,
 *  which is then treated as none: the field is additive). */
export function validChatMessageId(raw: unknown): string | undefined {
  return typeof raw === 'string' && MESSAGE_ID.test(raw) ? raw : undefined
}

/** The request's message id, or undefined when it sent none (or one this route
 *  does not take, which is then treated as none: the field is additive). */
export function chatMessageIdOf(body: unknown): string | undefined {
  return validChatMessageId((body as { messageId?: unknown } | null | undefined)?.messageId)
}

/** What this box knows of an earlier POST of this message: a turn it started, a
 *  claim whose turn has not started yet (with the promise of its outcome), or a
 *  relay that may have reached the primary (its turnId, to relay again under). */
export type PriorChatSend =
  | { state: 'started'; turnId: string }
  | { state: 'claimed'; turnId: string; outcome: Promise<ChatSendOutcome> }
  | { state: 'unsure'; turnId: string }

export function priorChatSend(
  agentId: string, conversationId: string, messageId: string, now = Date.now(),
): PriorChatSend | undefined {
  const key = keyOf(agentId, conversationId, messageId)
  const hit = accepted.get(key)
  if (!hit) return undefined
  if (hit.state !== 'claimed' && now - hit.at > SEND_ONCE_TTL_MS) {
    accepted.delete(key)
    return undefined
  }
  if (hit.state === 'claimed') return { state: 'claimed', turnId: hit.turnId, outcome: hit.outcome }
  return { state: hit.state, turnId: hit.turnId }
}

/** A claim on a message id, made by the POST that took it. */
export interface ClaimedChatSend {
  readonly turnId: string
  /** The turn started (the primary runs it, or the relay was accepted): remember
   *  the id, under `turnId` when the primary named another (a duplicate there). */
  started(turnId?: string): void
  /** No turn started, provably (the relay never left, or was refused): give the
   *  id back. */
  dropped(): void
  /** The relay may have reached the primary: keep the id and its turnId, so the
   *  retry is relayed again for the primary to dedupe. */
  unsure(): void
}

/**
 * Claim a message id for the POST that is about to start its turn. Synchronous on
 * purpose: the route checks `priorChatSend` and claims with no await between, so
 * two POSTs of one message can never both claim it. Oldest first out past the cap.
 */
export function claimChatSend(
  agentId: string, conversationId: string, messageId: string, turnId: string, now = Date.now(),
): ClaimedChatSend {
  const key = keyOf(agentId, conversationId, messageId)
  let settle: (outcome: ChatSendOutcome) => void = () => {}
  const outcome = new Promise<ChatSendOutcome>((resolve) => { settle = resolve })
  const entry: Entry = { turnId, at: now, state: 'claimed', outcome, settle }
  accepted.delete(key)
  accepted.set(key, entry)
  while (accepted.size > SEND_ONCE_MAX) {
    const oldest = accepted.keys().next().value
    if (oldest === undefined) break
    accepted.get(oldest)?.settle('dropped')
    accepted.delete(oldest)
  }
  let done = false
  // Still this claim's entry: a cap eviction, or a newer claim, may have replaced it.
  const mine = (): boolean => accepted.get(key) === entry
  return {
    turnId,
    started: (startedTurnId?: string) => {
      if (done) return
      done = true
      if (mine()) {
        entry.state = 'started'
        if (startedTurnId) entry.turnId = startedTurnId
        entry.at = Date.now()
      }
      entry.settle('started')
    },
    dropped: () => {
      if (done) return
      done = true
      if (mine()) accepted.delete(key)
      entry.settle('dropped')
    },
    unsure: () => {
      if (done) return
      done = true
      if (mine()) {
        entry.state = 'unsure'
        entry.at = Date.now()
      }
      entry.settle('unsure')
    },
  }
}

export function _resetChatSendOnceForTesting(): void {
  for (const entry of accepted.values()) entry.settle('dropped')
  accepted.clear()
}

export const _CHAT_SEND_ONCE_LIMITS = { ttlMs: SEND_ONCE_TTL_MS, max: SEND_ONCE_MAX }
