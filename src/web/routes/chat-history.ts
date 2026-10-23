/**
 * Chat history REST endpoints.
 *
 * GET  /api/chat/history  — load display messages (paginated)
 * GET  /api/chat/stats    — real conversation stats (API msg count + tokens)
 * POST /api/chat/clear    — clear entire conversation
 * POST /api/chat/compact  — force smart compaction
 *
 * On the cloud companion (stage 4d of docs/plan/walnut-companion-unified-replica.md) the
 * history is the Mac's copy (core/companion-conversation-rows.ts), never the file git sync
 * wrote here, and a clear or a compaction needs the Mac (companionChatChangeRefusal).
 */

import { Router, type Request, type Response, type NextFunction } from 'express'
import { validateAgentId, validateConversationId } from '../../constants.js'
import * as chatHistory from '../../core/chat-history.js'
import { estimateMessagesTokens } from '../../core/daily-log.js'
import { getContextWindowSize } from '../../model/model.js'
import { getLastTurnTokens } from '../agent-turn-queue.js'
import { log } from '../../logging/index.js'
import { isCompactionInProgress, triggerBackgroundCompaction } from '../background-compaction.js'
import { isCompanion } from '../../core/server-role.js'
import { NeedsLeaderError } from '../../core/replication/needs-leader.js'

export const chatHistoryRouter = Router()

/**
 * Resolve the (agentId, conversationId) a chat request targets. An explicit
 * conversationId wins; otherwise we fall back to the agent's ACTIVE conversation.
 * Boundary resolution — every chat read/write is conversation-scoped, so routes
 * must never pass a bare undefined conversationId into the store layer (which now
 * rejects it instead of silently reading the legacy ghost file).
 */
async function resolveChatRef(req: Request): Promise<{ agentId: string | undefined; conversationId: string }> {
  const rawAgentId = (req.query.agentId as string) || undefined
  const agentId = rawAgentId ? validateAgentId(rawAgentId) : undefined
  const rawConvId = (req.query.conversationId as string) || undefined
  if (rawConvId) return { agentId, conversationId: validateConversationId(rawConvId) }
  const { getActiveConversationId } = await import('../../core/conversations.js')
  const conversationId = await getActiveConversationId(agentId ?? 'general')
  return { agentId, conversationId }
}

// Per-agent cache for the stats endpoint, invalidated automatically when the
// chat-history file mtime changes (any write).
//
// `systemTokens`/`toolsTokens` are OPTIONAL and normally absent: a turn runs in a
// `claude` lane session, whose system prompt and tool schemas belong to the CLI,
// so Walnut cannot break the payload down. The one number it does know exactly is
// the whole input the lane last reported (see estimatedTotalTokens below), and
// both clients read the total, treating the two parts as optional extras.
export interface ChatStatsPayload {
  apiMessageCount: number
  estimatedTokens: number
  systemTokens?: number
  toolsTokens?: number
  estimatedTotalTokens: number
  compacted: boolean
  contextWindow: number
}
const cachedStatsMap = new Map<string, ChatStatsPayload>()
const cachedMtimeMap = new Map<string, string>()

/**
 * Real conversation size stats (API msg count + token estimate), cached
 * between turns. Shared by GET /api/chat/stats and GET /api/v1/chat/stats.
 */
export async function computeChatStats(
  agentId: string | undefined,
  conversationId: string,
): Promise<ChatStatsPayload> {
  const cacheKey = `${agentId || 'general'}:${conversationId || '_'}`

  // Check if cached stats are still valid (chat history hasn't changed)
  const lastUpdated = await chatHistory.getLastUpdated(agentId, conversationId)
  const cachedStats = cachedStatsMap.get(cacheKey)
  const cachedMtime = cachedMtimeMap.get(cacheKey)
  if (cachedStats && cachedMtime === lastUpdated) {
    return cachedStats
  }

  // Full computation (first call or after new messages/compaction)
  const modelContext = await chatHistory.getModelContext(agentId, conversationId)
  const messageTokens = estimateMessagesTokens(modelContext)
  const summary = await chatHistory.getCompactionSummary(agentId, conversationId)

  // The lane's own last-reported input count: the EXACT total the CLI sent,
  // system prompt and tool schemas included, fed by the session:usage-update
  // handler. It is the only honest "how full is this context" number here, since
  // the lane's system prompt and tools are the CLI's, not Walnut's. 0 until the
  // lane's first assistant message reports usage — then the message estimate is
  // the best available answer.
  const laneTokens = getLastTurnTokens(conversationId) ?? 0

  // Read model from config for context window detection
  let contextWindow: number
  try {
    const { getConfig } = await import('../../core/config-manager.js')
    const config = await getConfig()
    contextWindow = getContextWindowSize(config.agent?.main_model)
  } catch {
    contextWindow = getContextWindowSize(undefined)
  }

  const result: ChatStatsPayload = {
    apiMessageCount: modelContext.length,
    estimatedTokens: messageTokens,
    estimatedTotalTokens: laneTokens > 0 ? laneTokens : messageTokens,
    compacted: !!summary,
    contextWindow,
  }

  // Cache for subsequent calls
  cachedStatsMap.set(cacheKey, result)
  cachedMtimeMap.set(cacheKey, lastUpdated)
  return result
}

/**
 * On the cloud companion: a clear or a compaction rewrites the Mac's conversation (and a
 * clear retires the Mac's lane, which only the Mac can stop), and neither merges with what
 * the Mac did since, so it waits for the Mac. The phone's v1 routes reach the Mac while it
 * answers; this box's own routes never write the file git sync used to carry.
 */
export function companionChatChangeRefusal(): NeedsLeaderError | null {
  return isCompanion() ? new NeedsLeaderError('chat_changes_need_mac', 'Clearing or compacting a chat is done on your Mac, which is not answering right now.') : null
}

// GET /api/chat/history?page=1&pageSize=100&agentId=general
chatHistoryRouter.get('/history', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const page = req.query.page ? parseInt(req.query.page as string, 10) : 1
    const pageSize = req.query.pageSize ? parseInt(req.query.pageSize as string, 10) : 100
    const { agentId, conversationId } = await resolveChatRef(req)
    if (isCompanion()) {
      // The Mac's copy, this box's own turns on the tail; a chat the copy does not hold needs the Mac.
      const { listConversations } = await import('../../core/conversations.js')
      const meta = (await listConversations(agentId ?? 'general')).find((c) => c.id === conversationId)
      // The messages turned off for the box (Settings): a chat this box did not make is the Mac's.
      const { copyKindOff } = await import('../../core/replication/kinds/gate.js')
      const bodiesOff = await copyKindOff('conversation-bodies')
      if (bodiesOff && !meta) throw new NeedsLeaderError('not_kept_here', 'This chat is kept only on your Mac.')
      const { companionChatHistoryPage } = await import('../../core/companion-conversation-rows.js')
      const copied = await companionChatHistoryPage(agentId ?? 'general', conversationId, page, pageSize, meta?.messageCount ?? 0)
      if (!copied) throw new NeedsLeaderError(bodiesOff ? 'not_kept_here' : 'chat_history_needs_mac')
      res.json(copied)
      return
    }
    const result = await chatHistory.getDisplayEntries(page, pageSize, agentId, conversationId)
    res.json(result)
  } catch (err) {
    next(err)
  }
})

// GET /api/chat/stats?agentId=general — real conversation size (cached between turns)
chatHistoryRouter.get('/stats', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { agentId, conversationId } = await resolveChatRef(req)
    res.json(await computeChatStats(agentId, conversationId))
  } catch (err) {
    next(err)
  }
})

// GET /api/chat/triage — triage notification entries (newest first)
chatHistoryRouter.get('/triage', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : 50
    const taskId = req.query.taskId as string | undefined
    const { agentId, conversationId } = await resolveChatRef(req)
    const result = await chatHistory.getTriageEntries(limit, taskId, agentId, conversationId)
    res.json(result)
  } catch (err) {
    next(err)
  }
})

// POST /api/chat/clear?agentId=general&conversationId=conv-...
//
// Also retires the conversation's lane session (see archiveLaneForConversation):
// clearing only Walnut's store would leave the CLI still holding the transcript,
// so a user clearing for privacy would not actually have forgotten anything.
chatHistoryRouter.post('/clear', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const refused = companionChatChangeRefusal()
    if (refused) throw refused
    const { agentId, conversationId } = await resolveChatRef(req)
    await chatHistory.clear(agentId, conversationId)
    const { archiveLaneForConversation } = await import('../../core/sessions/personal-ai-lane.js')
    const retired = await archiveLaneForConversation(agentId ?? 'general', conversationId)
    log.web.info('chat conversation cleared', { agentId, conversationId, retiredLaneSessionId: retired ?? undefined })
    res.json({ ok: true })
  } catch (err) {
    next(err)
  }
})

// POST /api/chat/compact?agentId=general&conversationId=conv-... — fire-and-forget background compaction
chatHistoryRouter.post('/compact', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const refused = companionChatChangeRefusal()
    if (refused) throw refused
    const { agentId, conversationId } = await resolveChatRef(req)
    if (isCompactionInProgress(agentId, conversationId)) {
      res.json({ ok: true, alreadyRunning: true })
      return
    }
    triggerBackgroundCompaction('rest-api', { force: true, agentId, conversationId })
    res.json({ ok: true, async: true })
  } catch (err) {
    next(err)
  }
})
