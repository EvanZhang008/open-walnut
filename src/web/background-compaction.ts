/**
 * Background compaction — runs compaction outside the turn queue so the user
 * can keep chatting while the LLM summarizes old context.
 *
 * All compaction triggers (post-chat, post-cron, post-heartbeat, REST /compact)
 * share this single entry point. Callers must NOT enqueue this into the main
 * agent turn queue — it runs independently.
 */

import * as chatHistory from '../core/chat-history.js'
import { broadcastEvent } from './ws/handler.js'
import { EventNames } from '../core/event-bus.js'
import { createCompactionCallbacks, buildCompactionDivider } from './routes/chat.js'
import { log } from '../logging/index.js'

/** Per (agent, conversation) compaction tracking — each can compact independently. */
const compactingKeys = new Set<string>()

/** Tracking key — backward compatible: undefined conversationId → ':_' suffix. */
function trackKey(agentId?: string, conversationId?: string): string {
  return `${agentId || 'general'}:${conversationId || '_'}`
}

export function isCompactionInProgress(agentId = 'general', conversationId?: string): boolean {
  return compactingKeys.has(trackKey(agentId, conversationId))
}

export function triggerBackgroundCompaction(source: string, options?: { force?: boolean; agentId?: string; conversationId?: string }): void {
  const agentId = options?.agentId ?? 'general'
  const conversationId = options?.conversationId
  const key = trackKey(agentId, conversationId)
  if (compactingKeys.has(key)) return

  // Claim the slot immediately (synchronous — no yield between check and set)
  compactingKeys.add(key)

  void (async () => {
    try {
      if (!options?.force && !await chatHistory.needsCompaction(agentId, conversationId)) return

      log.agent.info('background compaction starting', { source, agentId, conversationId })
      const oldMsgCount = (await chatHistory.getModelContext(agentId, conversationId)).length
      broadcastEvent(EventNames.CHAT_COMPACTING, { agentId, conversationId })

      // No memory flusher: compaction summarizes, it does not run a tool-using
      // turn to persist memory first (see compact()'s optional second argument).
      const { summarizer } = await createCompactionCallbacks({ trackUsage: true })
      const result = await chatHistory.compact(summarizer, undefined, agentId, conversationId)

      if (result) {
        const divider = buildCompactionDivider(oldMsgCount, result)
        await chatHistory.addNotification({
          role: 'assistant',
          content: divider,
          source: 'compaction',
          notification: true,
          agentId,
          conversationId,
        })
        broadcastEvent(EventNames.CHAT_COMPACTED, { divider, agentId, conversationId })
        log.agent.info('background compaction complete', { source, agentId, conversationId, oldMsgCount })
      } else {
        broadcastEvent(EventNames.CHAT_COMPACTED, { agentId, conversationId })
        log.agent.info('background compaction skipped (no result)', { source, agentId, conversationId })
      }
    } catch (err) {
      broadcastEvent(EventNames.CHAT_COMPACTED, { agentId, conversationId })   // clear UI spinner on error
      log.agent.warn('background compaction failed', {
        source,
        agentId,
        conversationId,
        error: err instanceof Error ? err.message : String(err),
      })
    } finally {
      compactingKeys.delete(key)
    }
  })()
}
