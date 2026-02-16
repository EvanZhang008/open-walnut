/**
 * Chat history REST endpoints.
 *
 * GET  /api/chat/history  — load display messages (paginated)
 * GET  /api/chat/stats    — real conversation stats (API msg count + tokens)
 * POST /api/chat/clear    — clear entire conversation
 * POST /api/chat/compact  — force smart compaction
 */

import { Router, type Request, type Response, type NextFunction } from 'express'
import * as chatHistory from '../../core/chat-history.js'
import { estimateMessagesTokens, estimateFullPayload } from '../../core/daily-log.js'
import { log } from '../../logging/index.js'
import { isCompactionInProgress, triggerBackgroundCompaction } from '../background-compaction.js'

export const chatHistoryRouter = Router()

// GET /api/chat/history?page=1&pageSize=100
chatHistoryRouter.get('/history', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const page = req.query.page ? parseInt(req.query.page as string, 10) : 1
    const pageSize = req.query.pageSize ? parseInt(req.query.pageSize as string, 10) : 100
    const result = await chatHistory.getDisplayEntries(page, pageSize)
    res.json(result)
  } catch (err) {
    next(err)
  }
})

// GET /api/chat/stats — real conversation size
chatHistoryRouter.get('/stats', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const modelContext = await chatHistory.getModelContext()
    const messageTokens = estimateMessagesTokens(modelContext)
    const summary = await chatHistory.getCompactionSummary()

    // Compute full payload estimate (system + tools + messages)
    let systemTokens = 0
    let toolsTokens = 0
    try {
      const { buildSystemPrompt } = await import('../../agent/context.js')
      const { getToolSchemas } = await import('../../agent/tools.js')
      const systemPrompt = await buildSystemPrompt()
      const tools = getToolSchemas()
      const breakdown = estimateFullPayload({ system: systemPrompt, tools, messages: modelContext })
      systemTokens = breakdown.system
      toolsTokens = breakdown.tools
    } catch (err) {
      log.web.warn('chat stats: full payload estimation failed', { error: String(err) })
    }

    res.json({
      apiMessageCount: modelContext.length,
      estimatedTokens: messageTokens,
      systemTokens,
      toolsTokens,
      estimatedTotalTokens: systemTokens + toolsTokens + messageTokens,
      compacted: !!summary,
    })
  } catch (err) {
    next(err)
  }
})

// GET /api/chat/triage — triage notification entries (newest first)
chatHistoryRouter.get('/triage', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : 50
    const taskId = req.query.taskId as string | undefined
    const result = await chatHistory.getTriageEntries(limit, taskId)
    res.json(result)
  } catch (err) {
    next(err)
  }
})

// POST /api/chat/clear
chatHistoryRouter.post('/clear', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    await chatHistory.clear()
    res.json({ ok: true })
  } catch (err) {
    next(err)
  }
})

// POST /api/chat/compact — fire-and-forget background compaction
chatHistoryRouter.post('/compact', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    if (isCompactionInProgress()) {
      res.json({ ok: true, alreadyRunning: true })
      return
    }
    triggerBackgroundCompaction('rest-api', { force: true })
    res.json({ ok: true, async: true })
  } catch (err) {
    next(err)
  }
})
