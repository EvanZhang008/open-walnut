/**
 * /api/v1 Personal AI conversation management (additive) — rename/pin, delete,
 * stop, and structured-question answers. Mirrors the web console's
 * conversations REST routes + the WS `chat:stop` / `chat:answer-question`
 * RPCs with equivalent semantics (no new behavior).
 *
 *   PATCH  /conversations/:id { title? | pinned? } → { conversation }
 *   DELETE /conversations/:id                      → 204 (main conversation → 409)
 *   POST   /conversations/:id/stop                 → { stopped, questionCancelled }
 *   POST   /conversations/:id/answer { answers }   → { ok: true }
 *   PUT    /conversations/active { conversationId } → { activeConversationId }
 *   GET    /chat/stats?agentId&conversationId      → conversation size stats
 *   GET    /chat/engine?agentId&conversationId     → { engine, sessionId? } (read-only)
 *   POST   /chat/clear?agentId&conversationId      → { ok: true }
 *   POST   /chat/compact?agentId&conversationId    → { ok, async|alreadyRunning } (Wave 3)
 *
 * The active pointer matters server-side (not just client UI state): cron
 * results and background notifications route into the ACTIVE conversation.
 *
 * Cloud companion (REPLICA): Class A — the replica runs its OWN Personal AI agent
 * (the v1 chat endpoints already work there), so these operate on the local
 * conversation store / turn queue directly. No bridge.
 *
 * Stop semantics: the WS chat keys AbortControllers per client socket; a REST
 * client has no socket identity, so stop aborts ALL of the agent's active
 * turns via core/agent-abort-registry.ts (both WS- and REST-initiated turns
 * register there). For a single-user Personal AI that IS the "stop" the phone means.
 *
 * Frozen-contract note: everything here is additive (docs/reference/api-v1.md).
 */

import { Router, type Request, type Response, type NextFunction } from 'express'
import { log } from '../../logging/index.js'
import { broadcastEvent } from '../ws/handler.js'
import { EventNames } from '../../core/event-bus.js'
import { listConversations } from '../../core/conversations.js'

export const personalAiV1Router = Router()

const DEFAULT_AGENT_ID = 'general'

// Same frozen error shape as api-v1.ts.
function sendError(res: Response, status: number, code: string, message: string, extra?: Record<string, unknown>): void {
  res.status(status).json({ error: { code, message }, ...(extra ?? {}) })
}

/** Same agentId resolution as api-v1.ts: query/body param, default 'general'. */
function requestAgentId(req: Request): string | null {
  const raw = (typeof req.query.agentId === 'string' && req.query.agentId)
    || (typeof req.body?.agentId === 'string' && req.body.agentId)
    || DEFAULT_AGENT_ID
  return /^[a-z0-9][a-z0-9-]{0,63}$/.test(raw) ? raw : null
}

async function consoleAgentExists(agentId: string): Promise<boolean> {
  if (agentId === DEFAULT_AGENT_ID) return true
  const { getConsoleAgent } = await import('../../core/agent-registry.js')
  return !!(await getConsoleAgent(agentId))
}

async function conversationExists(agentId: string, conversationId: string): Promise<boolean> {
  if (!/^conv-[A-Za-z0-9-]+$/.test(conversationId)) return false
  const list = await listConversations(agentId)
  return list.some((c) => c.id === conversationId)
}

/** Shared 404 gating: resolve agent + conversation or reply and return null. */
async function resolveConversation(req: Request, res: Response): Promise<{ agentId: string; conversationId: string } | null> {
  const agentId = requestAgentId(req)
  if (!agentId || !(await consoleAgentExists(agentId))) {
    sendError(res, 404, 'not_found', `Agent not found: ${req.query.agentId ?? req.body?.agentId}`)
    return null
  }
  const conversationId = String(req.params.id ?? '')
  if (!(await conversationExists(agentId, conversationId))) {
    sendError(res, 404, 'not_found', `Conversation not found: ${conversationId}`)
    return null
  }
  return { agentId, conversationId }
}

// PUT /api/v1/conversations/active { conversationId, agentId? } — switch the
// ACTIVE conversation pointer. Server-side state, not client UI state: cron
// results + background notifications route into the active conversation.
// Registered before the :id routes (different method, but keep the shape
// obvious): 'active' is never treated as a conversation id.
personalAiV1Router.put('/conversations/active', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const agentId = requestAgentId(req)
    if (!agentId || !(await consoleAgentExists(agentId))) {
      sendError(res, 404, 'not_found', `Agent not found: ${req.query.agentId ?? req.body?.agentId}`)
      return
    }
    const conversationId = req.body?.conversationId
    if (typeof conversationId !== 'string' || !(await conversationExists(agentId, conversationId))) {
      sendError(res, 404, 'not_found', `Conversation not found: ${conversationId}`)
      return
    }
    const { setActiveConversationId } = await import('../../core/conversations.js')
    await setActiveConversationId(agentId, conversationId)
    // Same event shape as the internal PUT /api/agents/:agentId/conversations/active.
    broadcastEvent(EventNames.CONVERSATION_UPDATED, { agentId, activeConversationId: conversationId })
    res.json({ activeConversationId: conversationId })
  } catch (err) {
    next(err)
  }
})

/** agentId + conversationId for the chat/* routes (explicit conv id wins; else the active pointer). */
async function resolveChatTarget(req: Request, res: Response): Promise<{ agentId: string; conversationId: string } | null> {
  const agentId = requestAgentId(req)
  if (!agentId || !(await consoleAgentExists(agentId))) {
    sendError(res, 404, 'not_found', `Agent not found: ${req.query.agentId ?? req.body?.agentId}`)
    return null
  }
  const rawConvId = (typeof req.query.conversationId === 'string' && req.query.conversationId)
    || (typeof req.body?.conversationId === 'string' && req.body.conversationId)
    || ''
  if (rawConvId) {
    if (!(await conversationExists(agentId, rawConvId))) {
      sendError(res, 404, 'not_found', `Conversation not found: ${rawConvId}`)
      return null
    }
    return { agentId, conversationId: rawConvId }
  }
  const { getActiveConversationId } = await import('../../core/conversations.js')
  return { agentId, conversationId: await getActiveConversationId(agentId) }
}

// GET /api/v1/chat/engine?agentId&conversationId → { engine, sessionId?, cwd? }
//
// Why this exists: on the lane engine (`config.agent.provider === 'claude-code'`)
// a chat turn runs inside a real `claude` CLI session, so the model/effort/mode
// the answer is produced with live on THAT session record and are switchable
// through the ordinary `/sessions/:id/model|effort|controls` endpoints. Those
// endpoints already accept a lane session id (they resolve by record, not by the
// listable projection); what no v1 route exposed was the id itself, so a mobile
// client had no way to find the session behind its own conversation. The web
// console reads it from an internal non-v1 route (POST .../lane-session), which
// mobile cannot use.
//
// READ-ONLY on purpose: it never mints a lane. Minting is a side effect of
// sending, and a picker that spawns a CLI just by being opened would start a
// process the user never asked for. Hence `sessionId: null` until the
// conversation has had its first turn: the client shows the model as read-only
// (or hides the pill) rather than fabricating one.
//
// `engine: 'in-process'` means the config is NOT on the lane engine, so there is
// no per-conversation session and nothing to switch: the model is whatever
// `config.agent.main_model` says, which is a config-level fact and not this
// endpoint's to change.
personalAiV1Router.get('/chat/engine', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const ids = await resolveChatTarget(req, res)
    if (!ids) return
    const { getConfig, resolveAgentEngineProvider } = await import('../../core/config-manager.js')
    const config = await getConfig()
    if (resolveAgentEngineProvider(config) !== 'claude-code') {
      res.json({
        engine: 'in-process',
        sessionId: null,
        ...(config.agent?.main_model ? { model: config.agent.main_model } : {}),
      })
      return
    }
    const { personalAiLaneKey } = await import('../../core/sessions/personal-ai-lane.js')
    const { getSessionByLane } = await import('../../core/session-tracker.js')
    const record = await getSessionByLane(personalAiLaneKey(ids.agentId, ids.conversationId))
    res.json({
      engine: 'lane',
      sessionId: record?.claudeSessionId ?? null,
      ...(record?.cwd ? { cwd: record.cwd } : {}),
      // '' on the record means the primary box, matching ProjectedSession.host.
      ...(record ? { host: record.host ?? '' } : {}),
    })
  } catch (err) {
    next(err)
  }
})

// GET /api/v1/chat/stats?agentId&conversationId — real conversation size
// (API message count + token estimate incl. system/tools), cached between turns.
personalAiV1Router.get('/chat/stats', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const ids = await resolveChatTarget(req, res)
    if (!ids) return
    const { computeChatStats } = await import('./chat-history.js')
    res.json(await computeChatStats(ids.agentId, ids.conversationId))
  } catch (err) {
    next(err)
  }
})

// POST /api/v1/chat/clear?agentId&conversationId — clear the conversation.
// Retires the lane session too (same reason as the web route): the CLI holds its
// own copy of the transcript, so leaving it alive means "clear" cleared nothing
// from the model's point of view.
personalAiV1Router.post('/chat/clear', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const ids = await resolveChatTarget(req, res)
    if (!ids) return
    const chatHistory = await import('../../core/chat-history.js')
    await chatHistory.clear(ids.agentId, ids.conversationId)
    const { archiveLaneForConversation } = await import('../../core/sessions/personal-ai-lane.js')
    const retired = await archiveLaneForConversation(ids.agentId, ids.conversationId)
    log.web.info('Personal AI conversation cleared via api-v1', { ...ids, retiredLaneSessionId: retired ?? undefined })
    res.json({ ok: true })
  } catch (err) {
    next(err)
  }
})

// POST /api/v1/chat/compact?agentId&conversationId (Wave 3) — fire-and-forget
// background compaction (the same trigger the web console uses). Answers
// immediately: { ok, async: true }, or { ok, alreadyRunning: true } when a
// compaction is already in flight. Class A (the replica compacts its own
// Personal AI's conversation with its own model credentials).
personalAiV1Router.post('/chat/compact', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const ids = await resolveChatTarget(req, res)
    if (!ids) return
    const { isCompactionInProgress, triggerBackgroundCompaction } = await import('../background-compaction.js')
    if (isCompactionInProgress(ids.agentId, ids.conversationId)) {
      res.json({ ok: true, alreadyRunning: true })
      return
    }
    triggerBackgroundCompaction('api-v1', { force: true, agentId: ids.agentId, conversationId: ids.conversationId })
    res.json({ ok: true, async: true })
  } catch (err) {
    next(err)
  }
})

// PATCH /api/v1/conversations/:id { title? | pinned? } → { conversation }
personalAiV1Router.patch('/conversations/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const ids = await resolveConversation(req, res)
    if (!ids) return
    const { agentId, conversationId } = ids
    const title = req.body?.title
    const pinned = req.body?.pinned
    if (title !== undefined && typeof title !== 'string') {
      sendError(res, 400, 'bad_request', 'title must be a string')
      return
    }
    if (pinned !== undefined && typeof pinned !== 'boolean') {
      sendError(res, 400, 'bad_request', 'pinned must be a boolean')
      return
    }
    if (title === undefined && pinned === undefined) {
      sendError(res, 400, 'bad_request', 'At least one of title, pinned is required')
      return
    }
    const { renameConversation, setPinned } = await import('../../core/conversations.js')
    let conversation
    if (typeof title === 'string') conversation = await renameConversation(agentId, conversationId, title)
    if (typeof pinned === 'boolean') conversation = await setPinned(agentId, conversationId, pinned)
    broadcastEvent(EventNames.CONVERSATION_UPDATED, { agentId, conversation })
    res.json({ conversation })
  } catch (err) {
    if (err instanceof Error && err.message.includes('not found')) {
      sendError(res, 404, 'not_found', err.message)
      return
    }
    next(err)
  }
})

// DELETE /api/v1/conversations/:id → 204. The MAIN conversation is never
// deletable (it receives background notifications + cron) → 409 conflict.
personalAiV1Router.delete('/conversations/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const ids = await resolveConversation(req, res)
    if (!ids) return
    const { agentId, conversationId } = ids
    const { deleteConversation, getActiveConversationId } = await import('../../core/conversations.js')
    try {
      await deleteConversation(agentId, conversationId)
    } catch (err) {
      if (err instanceof Error && err.message.toLowerCase().includes('main')) {
        sendError(res, 409, 'conflict', err.message)
        return
      }
      throw err
    }
    // The active pointer may have moved (if the active conversation was deleted).
    const activeConversationId = await getActiveConversationId(agentId)
    broadcastEvent(EventNames.CONVERSATION_DELETED, { agentId, conversationId, activeConversationId })
    res.status(204).end()
  } catch (err) {
    next(err)
  }
})

// POST /api/v1/conversations/:id/stop → { stopped, questionCancelled }
// Aborts ALL of the agent's active turns (see the header comment for why
// agent-level, not per-socket) and cancels any pending user_ask question —
// the same pair of effects as the WS `chat:stop`.
personalAiV1Router.post('/conversations/:id/stop', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const ids = await resolveConversation(req, res)
    if (!ids) return
    const { agentId, conversationId } = ids
    const { abortAgentTurns } = await import('../../core/agent-abort-registry.js')
    const { hasPendingQuestion, cancelQuestion } = await import('../../core/agent-question.js')
    const questionCancelled = hasPendingQuestion(agentId)
    const stopped = abortAgentTurns(agentId)
    cancelQuestion(agentId)
    // Lane engine: the work lives in a `claude` CLI, which no AbortController can
    // reach — interrupt the lane session too (canonical bus path, never a signal).
    // Unconditional: resolves null when this conversation has no lane record.
    let laneInterrupted: string | null = null
    try {
      const { interruptLaneForConversation } = await import('../../core/sessions/personal-ai-lane.js')
      laneInterrupted = await interruptLaneForConversation(agentId, conversationId)
    } catch (err) {
      // Never fail the client's stop over the lane half.
      log.web.warn('api-v1 stop: lane interrupt failed', {
        agentId, conversationId, error: err instanceof Error ? err.message : String(err),
      })
    }
    log.web.info('Personal AI turn stopped via api-v1', {
      agentId, conversationId, stopped, questionCancelled,
      laneSessionId: laneInterrupted ?? undefined,
    })
    // Response shape stays frozen ({ stopped, questionCancelled }) — the lane id
    // is logged, not added to the contract.
    res.json({ stopped, questionCancelled })
  } catch (err) {
    next(err)
  }
})

// POST /api/v1/conversations/:id/answer { answers: Record<string,string> }
// Answer a pending structured question (user_ask tool) — mirrors the WS
// `chat:answer-question`: persists the answers as a UI entry, broadcasts the
// history update, and unblocks the agent loop. 409 when nothing is pending.
personalAiV1Router.post('/conversations/:id/answer', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const ids = await resolveConversation(req, res)
    if (!ids) return
    const { agentId, conversationId } = ids
    const answers = req.body?.answers
    if (
      answers === null || typeof answers !== 'object' || Array.isArray(answers)
      || Object.keys(answers).length === 0
      || !Object.values(answers).every((v) => typeof v === 'string')
    ) {
      sendError(res, 400, 'bad_request', 'answers must be a non-empty object of string values')
      return
    }
    const { hasPendingQuestion, submitAnswers } = await import('../../core/agent-question.js')
    if (!hasPendingQuestion(agentId)) {
      sendError(res, 409, 'conflict', 'No pending question for this agent')
      return
    }
    // Persist the user's answers as a UI-only chat entry (same as chat.ts).
    const chatHistory = await import('../../core/chat-history.js')
    const answerLines = Object.entries(answers as Record<string, string>)
      .map(([k, v]) => `${k}: ${v}`).join('\n')
    await chatHistory.addNotification({ role: 'user', content: answerLines, agentId, conversationId })
    broadcastEvent(EventNames.CHAT_HISTORY_UPDATED, {
      entry: { role: 'user', content: answerLines, source: 'question-answer' },
      agentId,
      conversationId,
    })
    submitAnswers(answers as Record<string, string>, agentId)
    log.web.info('Personal AI question answered via api-v1', { agentId, conversationId, answerCount: Object.keys(answers).length })
    res.json({ ok: true })
  } catch (err) {
    next(err)
  }
})

// Router-level error funnel — keeps unexpected failures in the frozen shape.
personalAiV1Router.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  log.web.error('api-v1 Personal AI route error', {
    error: err instanceof Error ? err.message : String(err),
  })
  if (res.headersSent) {
    res.end()
    return
  }
  sendError(res, 500, 'internal', 'Internal server error')
})
