/**
 * What a chat surface does when a lane turn has no answer (yet).
 *
 * Shared by the phone REST turn (api-v1.ts) and the web chat RPC (chat.ts), so
 * both follow one rule set (core/sessions/lane-turn.ts owns detection):
 *
 *   - a dead CLI, a failed send, or a stall whose CLI is no longer running is a
 *     real failure: the caller persists an error row, as before;
 *   - a stall whose CLI is STILL running is not over. The user is told (the
 *     notice unlocks their composer) but NO error row is written, because the
 *     turn may still answer. When the late answer lands it becomes this turn's
 *     assistant row, stamped with this turn's id, instead of attaching to
 *     whatever turn happens to be next (the 2026-09-26 glued-answer bug). If the
 *     lane dies or goes silent again first, the error row is written then.
 *
 * The phone channel gets two frames when the late answer lands (the sequence is
 * in docs/reference/api-v1.md, chat SSE): the additive `message-late`, then an
 * ordinary `message-end` carrying the same `{turnId, fullText}`. The second one
 * is what an app that predates `message-late` already acts on: it ends the turn
 * and refetches GET /messages, which now holds the late row.
 */

import type { MessageParam } from '../../model/model.js'
import * as chatHistory from '../../core/chat-history.js'
import { EventNames } from '../../core/event-bus.js'
import type { LaneTurnFailure } from '../../core/sessions/lane-turn.js'
import { stripEntityRefs } from '../../utils/entity-refs.js'
import { log } from '../../logging/index.js'
import { broadcastEvent } from '../ws/handler.js'

/** Shown (never persisted) when a turn stalls while its CLI keeps running. */
export const LANE_STALL_NOTICE =
  'The main AI has gone quiet on this turn. It is still running, and its answer will appear here if it arrives.'

/** The persisted error text for a turn that has no answer. */
export function laneFailureMessage(failure: LaneTurnFailure | undefined): string {
  switch (failure) {
    case 'died': return 'The main AI stopped before it answered this turn.'
    case 'send-failed': return 'The message could not be delivered to the main AI.'
    case 'stalled': return 'The main AI stopped responding on this turn.'
    case 'busy': return 'The main AI is still busy with an earlier turn that did not stop. Try again in a few minutes.'
    default: return 'The main AI did not answer this turn.'
  }
}

/**
 * Wait for a stalled turn's late answer and file it under THAT turn.
 * Never throws, never rejects. The returned promise settles once the answer is
 * filed and its frames are out, or once the give-up row is written: a caller
 * that keeps a delivery path open for those frames (the cloud relay mirror,
 * chat-turn-relay.ts armLateMirror) closes it then.
 */
export function followLateAnswer(opts: {
  agentId: string
  conversationId: string
  turnId?: string
  laneSessionId: string
  late: Promise<string | null>
  /** The phone channel, when the turn came from the REST API. */
  emitSse?: (event: string, data: unknown) => void
  /** Rewrite the text before it is stored (the web chat resolves entity refs). */
  prepare?: (text: string) => Promise<string>
  /** Persist the error row once the lane has provably given up. */
  onGiveUp: (errMsg: string) => Promise<void>
}): Promise<void> {
  const { agentId, conversationId, turnId, laneSessionId } = opts
  return opts.late.then(async (lateText) => {
    if (lateText === null) {
      log.web.warn('lane turn: no late answer arrived, recording the failure', {
        agentId, conversationId, turnId, sessionId: laneSessionId,
      })
      await opts.onGiveUp(laneFailureMessage('stalled'))
      return
    }
    const text = opts.prepare ? await opts.prepare(lateText) : lateText
    await chatHistory.addAIMessages(
      [{ role: 'assistant', content: [{ type: 'text', text }] }] as MessageParam[],
      {
        agentId, conversationId,
        ...(turnId ? { turnId } : {}),
        engine: chatHistory.laneEngineLabel(laneSessionId),
      },
    )
    broadcastEvent(EventNames.CHAT_HISTORY_UPDATED, {
      entry: { role: 'assistant', content: text, timestamp: new Date().toISOString() },
      agentId,
      conversationId,
    })
    // `message-late` is additive: a client that knows it replaces the notice on
    // the turn it names. `message-end` follows with the same payload because an
    // app that predates `message-late` ignores it, and without a frame it acts on
    // the answer would sit on disk until the user happened to reload. The row is
    // written above, so the refetch that `message-end` triggers finds it.
    const payload = { turnId, fullText: stripEntityRefs(text) }
    opts.emitSse?.('message-late', payload)
    opts.emitSse?.('message-end', payload)
    log.web.info('lane turn: late answer filed under its own turn', {
      agentId, conversationId, turnId, sessionId: laneSessionId, resultLength: text.length,
    })
  }).catch((err) => {
    log.web.error('lane turn: filing the late answer failed', {
      agentId, conversationId, turnId, sessionId: laneSessionId,
      error: err instanceof Error ? err.message : String(err),
    })
  })
}
