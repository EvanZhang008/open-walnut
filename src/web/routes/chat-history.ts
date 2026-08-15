/**
 * Chat history REST endpoints.
 *
 * GET  /api/chat/history  — load display messages (paginated)
 * GET  /api/chat/stats    — real conversation stats (API msg count + tokens)
 * POST /api/chat/clear    — clear entire conversation
 * POST /api/chat/compact  — force smart compaction
 */

import { Router, type Request, type Response, type NextFunction } from 'express'
import { validateAgentId, validateConversationId } from '../../constants.js'
import * as chatHistory from '../../core/chat-history.js'
import { estimateMessagesTokens, estimateFullPayload } from '../../core/daily-log.js'
import { getContextWindowSize } from '../../agent/model.js'
import { log } from '../../logging/index.js'
import { isCompactionInProgress, triggerBackgroundCompaction } from '../background-compaction.js'

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

// Per-agent cache for stats endpoint — avoids rebuilding system prompt + tool schemas.
// Invalidated automatically when file mtime changes (any chat history write).
export interface ChatStatsPayload {
  apiMessageCount: number
  estimatedTokens: number
  systemTokens: number
  toolsTokens: number
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

  // Compute full payload estimate (system + tools + messages)
  let systemTokens = 0
  let toolsTokens = 0
  if (!agentId || agentId === 'general') {
    // General agent: use full system prompt + tools
    try {
      const { buildSystemPrompt } = await import('../../agent/context.js')
      const { getToolSchemas } = await import('../../agent/tools.js')
      const systemPrompt = await buildSystemPrompt(agentId, conversationId)
      const tools = getToolSchemas()
      const breakdown = estimateFullPayload({ system: systemPrompt, tools, messages: modelContext })
      systemTokens = breakdown.system
      toolsTokens = breakdown.tools
    } catch (err) {
      log.web.warn('chat stats: full payload estimation failed', { error: String(err) })
    }
  } else {
    // Non-General: estimate from agent def system prompt + filtered tools
    try {
      const { getConsoleAgent } = await import('../../core/agent-registry.js')
      const { buildSubagentToolSet } = await import('../../agent/subagent-context.js')
      const { estimateTokens } = await import('../../core/daily-log.js')
      const agentDef = await getConsoleAgent(agentId)
      if (agentDef) {
        systemTokens = estimateTokens(agentDef.system_prompt ?? '')
        const agentTools = await buildSubagentToolSet(agentDef)
        toolsTokens = estimateTokens(JSON.stringify(agentTools))
      }
    } catch (err) {
      log.web.warn('chat stats: agent payload estimation failed', { agentId, error: String(err) })
    }
  }

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
    systemTokens,
    toolsTokens,
    estimatedTotalTokens: systemTokens + toolsTokens + messageTokens,
    compacted: !!summary,
    contextWindow,
  }

  // Cache for subsequent calls
  cachedStatsMap.set(cacheKey, result)
  cachedMtimeMap.set(cacheKey, lastUpdated)
  return result
}

// GET /api/chat/history?page=1&pageSize=100&agentId=general
chatHistoryRouter.get('/history', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const page = req.query.page ? parseInt(req.query.page as string, 10) : 1
    const pageSize = req.query.pageSize ? parseInt(req.query.pageSize as string, 10) : 100
    const { agentId, conversationId } = await resolveChatRef(req)
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
