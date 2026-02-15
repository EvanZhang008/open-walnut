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

let compactionInProgress = false

export function isCompactionInProgress(): boolean {
  return compactionInProgress
}

export function triggerBackgroundCompaction(source: string, options?: { force?: boolean }): void {
  if (compactionInProgress) return

  // Claim the slot immediately (synchronous — no yield between check and set)
  // to prevent TOCTOU race across the async gap below.
  compactionInProgress = true

  void (async () => {
    try {
      if (!options?.force && !await chatHistory.needsCompaction()) return

      log.agent.info('background compaction starting', { source })
      const oldMsgCount = (await chatHistory.getModelContext()).length
      broadcastEvent(EventNames.CHAT_COMPACTING, {})

      const { summarizer, memoryFlusher } = await createCompactionCallbacks({ trackUsage: true })
      const result = await chatHistory.compact(summarizer, memoryFlusher)

      if (result) {
        const divider = buildCompactionDivider(oldMsgCount, result)
        await chatHistory.addNotification({
          role: 'assistant',
          content: divider,
          source: 'compaction',
          notification: true,
        })
        broadcastEvent(EventNames.CHAT_COMPACTED, { divider })
        log.agent.info('background compaction complete', { source, oldMsgCount })
      } else {
        broadcastEvent(EventNames.CHAT_COMPACTED, {})
        log.agent.info('background compaction skipped (no result)', { source })
      }
    } catch (err) {
      broadcastEvent(EventNames.CHAT_COMPACTED, {})   // clear UI spinner on error
      log.agent.warn('background compaction failed', {
        source,
        error: err instanceof Error ? err.message : String(err),
      })
    } finally {
      compactionInProgress = false
    }
  })()
}
