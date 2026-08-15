/**
 * Conversations routes — per-agent conversation list CRUD.
 *
 * Mounted at /api/agents, sharing the prefix with the agents router. The agents
 * router only matches single-segment ids (/:id), so the deeper
 * /:agentId/conversations paths fall through here without collision.
 *
 *   GET    /api/agents/:agentId/conversations         -> { conversations, activeConversationId }
 *   POST   /api/agents/:agentId/conversations         {title?} -> 201 { conversation }
 *   PUT    /api/agents/:agentId/conversations/active   {conversationId} -> { activeConversationId }
 *   PATCH  /api/agents/:agentId/conversations/:cid     {title?, pinned?} -> { conversation }
 *   DELETE /api/agents/:agentId/conversations/:cid     -> 204
 *   POST   /api/agents/:agentId/conversations/:cid/lane-session -> { sessionId, cwd, created }
 */

import { Router, type Request, type Response, type NextFunction } from 'express'
import { validateAgentId, validateConversationId } from '../../constants.js'
import {
  listConversations,
  getActiveConversationId,
  getMainConversationId,
  setActiveConversationId,
  createConversation,
  deleteConversation,
  renameConversation,
  setPinned,
} from '../../core/conversations.js'
import { broadcastEvent } from '../ws/handler.js'
import { EventNames } from '../../core/event-bus.js'
import { log } from '../../logging/index.js'

export function createConversationsRouter(): Router {
  const router = Router()

  // GET /api/agents/:agentId/conversations
  router.get('/:agentId/conversations', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const agentId = validateAgentId(req.params.agentId as string)
      // Resolve the main conversation FIRST so the lazy back-fill runs (legacy
      // indexes get an isMain promoted + persisted) before we read the list —
      // the returned metas then carry isMain so the UI badge shows immediately.
      await getMainConversationId(agentId)
      const [conversations, activeConversationId] = await Promise.all([
        listConversations(agentId),
        getActiveConversationId(agentId),
      ])
      res.json({ conversations, activeConversationId })
    } catch (err) {
      next(err)
    }
  })

  // POST /api/agents/:agentId/conversations
  router.post('/:agentId/conversations', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const agentId = validateAgentId(req.params.agentId as string)
      const title = typeof req.body?.title === 'string' ? req.body.title : undefined
      const conversation = await createConversation(agentId, title)
      broadcastEvent(EventNames.CONVERSATION_CREATED, { agentId, conversation })
      res.status(201).json({ conversation })
    } catch (err) {
      next(err)
    }
  })

  // PUT /api/agents/:agentId/conversations/active
  router.put('/:agentId/conversations/active', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const agentId = validateAgentId(req.params.agentId as string)
      const conversationId = validateConversationId(req.body?.conversationId as string)
      await setActiveConversationId(agentId, conversationId)
      broadcastEvent(EventNames.CONVERSATION_UPDATED, { agentId, activeConversationId: conversationId })
      res.json({ activeConversationId: conversationId })
    } catch (err) {
      if (err instanceof Error && err.message.includes('not found')) {
        res.status(404).json({ error: err.message })
        return
      }
      next(err)
    }
  })

  // PATCH /api/agents/:agentId/conversations/:cid  — rename and/or pin
  router.patch('/:agentId/conversations/:cid', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const agentId = validateAgentId(req.params.agentId as string)
      const cid = validateConversationId(req.params.cid as string)
      let conversation
      if (typeof req.body?.title === 'string') {
        conversation = await renameConversation(agentId, cid, req.body.title)
      }
      if (typeof req.body?.pinned === 'boolean') {
        conversation = await setPinned(agentId, cid, req.body.pinned)
      }
      if (!conversation) {
        res.status(400).json({ error: 'No updatable fields provided (title or pinned)' })
        return
      }
      broadcastEvent(EventNames.CONVERSATION_UPDATED, { agentId, conversation })
      res.json({ conversation })
    } catch (err) {
      if (err instanceof Error && err.message.includes('not found')) {
        res.status(404).json({ error: err.message })
        return
      }
      next(err)
    }
  })

  // POST /api/agents/:agentId/conversations/:cid/lane-session
  // Resolve (or create) the lane session backing this conversation — the thin-layer
  // chat surface mounts the session timeline directly on it and sends through the
  // ordinary session queue. Created idle (empty first message): the first user
  // message rides session:send, exactly like every other session. 409 when the
  // engine flag is off — the in-process loop has no lane, and minting one anyway
  // would leave an orphan CLI.
  router.post('/:agentId/conversations/:cid/lane-session', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const agentId = validateAgentId(req.params.agentId as string)
      const cid = validateConversationId(req.params.cid as string)
      const { getConfig, resolveAgentEngineProvider } = await import('../../core/config-manager.js')
      // Every console agent runs on the lane engine (per-agent persona via
      // consoleAgentProfile) — the only gate left is the engine flag itself.
      if (resolveAgentEngineProvider(await getConfig()) !== 'claude-code') {
        res.status(409).json({ error: 'Lane engine is not active' })
        return
      }
      const { getOrCreateLaneSession } = await import('../../core/sessions/personal-ai-lane.js')
      const lane = await getOrCreateLaneSession(agentId, cid)
      const { WALNUT_HOME } = await import('../../constants.js')
      res.json({ sessionId: lane.sessionId, cwd: WALNUT_HOME, created: lane.created, engine: lane.engine })
    } catch (err) {
      next(err)
    }
  })

  // POST /api/agents/:agentId/conversations/:cid/lane-engine  {engine}
  // Switch the provider backing this conversation's lane (claude ⇄ codex).
  // Only legal while the conversation is EMPTY — the lane session is archived
  // and re-minted on the requested engine (an engine is a spawn-time fact).
  // 409 once messages exist / for forked lanes (swapLaneEngine guards).
  router.post('/:agentId/conversations/:cid/lane-engine', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const agentId = validateAgentId(req.params.agentId as string)
      const cid = validateConversationId(req.params.cid as string)
      const engine = (req.body as { engine?: string } | undefined)?.engine
      if (engine !== 'claude' && engine !== 'codex') {
        res.status(400).json({ error: "engine must be 'claude' or 'codex'" })
        return
      }
      const { getConfig, resolveAgentEngineProvider } = await import('../../core/config-manager.js')
      if (resolveAgentEngineProvider(await getConfig()) !== 'claude-code') {
        res.status(409).json({ error: 'Lane engine is not active' })
        return
      }
      const { swapLaneEngine } = await import('../../core/sessions/personal-ai-lane.js')
      const { SessionControlError } = await import('../../core/sessions/session-controls.js')
      try {
        const lane = await swapLaneEngine(agentId, cid, engine)
        const { WALNUT_HOME } = await import('../../constants.js')
        res.json({ sessionId: lane.sessionId, cwd: WALNUT_HOME, created: lane.created, engine: lane.engine })
      } catch (err) {
        if (err instanceof SessionControlError) {
          res.status(err.statusCode).json({ error: err.message })
          return
        }
        throw err
      }
    } catch (err) {
      next(err)
    }
  })

  // POST /api/agents/:agentId/conversations/:cid/fork
  // Fork the conversation: new conversation + a forked lane session that carries
  // the full history via the CLI's native --resume --fork-session. No task is
  // created (lane sessions are taskless). 409 when the engine flag is off or the
  // conversation has no session yet.
  router.post('/:agentId/conversations/:cid/fork', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const agentId = validateAgentId(req.params.agentId as string)
      const cid = validateConversationId(req.params.cid as string)
      const { getConfig, resolveAgentEngineProvider } = await import('../../core/config-manager.js')
      if (resolveAgentEngineProvider(await getConfig()) !== 'claude-code') {
        res.status(409).json({ error: 'Lane engine is not active' })
        return
      }
      const { forkLaneConversation } = await import('../../core/sessions/lane-fork.js')
      const { SessionControlError } = await import('../../core/sessions/session-controls.js')
      try {
        const result = await forkLaneConversation(agentId, cid)
        broadcastEvent(EventNames.CONVERSATION_CREATED, { agentId, conversation: result.conversation })
        res.json({ conversation: result.conversation, sessionId: result.sessionId })
      } catch (err) {
        if (err instanceof SessionControlError) {
          res.status(err.statusCode).json({ error: err.message })
          return
        }
        throw err
      }
    } catch (err) {
      next(err)
    }
  })

  // DELETE /api/agents/:agentId/conversations/:cid
  // (The pre-delete distill step was removed with the unified memory redesign —
  //  durable knowledge is saved in-conversation via skill_manage.)
  router.delete('/:agentId/conversations/:cid', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const agentId = validateAgentId(req.params.agentId as string)
      const cid = validateConversationId(req.params.cid as string)

      await deleteConversation(agentId, cid)
      // The active id may have changed (if we deleted the active conversation).
      const activeConversationId = await getActiveConversationId(agentId)
      broadcastEvent(EventNames.CONVERSATION_DELETED, { agentId, conversationId: cid, activeConversationId })
      res.status(204).end()
    } catch (err) {
      log.web.warn('conversation delete failed', {
        agentId: req.params.agentId, conversationId: req.params.cid,
        error: err instanceof Error ? err.message : String(err),
      })
      // The main conversation is not deletable → 409 Conflict.
      if (err instanceof Error && err.message.toLowerCase().includes('main')) {
        res.status(409).json({ error: err.message })
        return
      }
      next(err)
    }
  })

  return router
}
