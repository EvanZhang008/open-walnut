/**
 * /api/v1 Personal AI conversation management (Wave 1) — personal-ai-v1.ts. Bare
 * express + supertest against the real conversations store on an isolated
 * temp home. Verifies rename/pin PATCH, the main-conversation delete guard,
 * stop (agent-abort-registry + pending-question cancel), answer semantics
 * (persist + broadcast + submit), and the frozen error shape.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs/promises'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/constants.js')>()
  return { ...actual, ...createMockConstants('walnut-apiv1-personal-ai') }
})

// WS broadcast seam — personal-ai-v1 broadcasts CONVERSATION_*/CHAT_HISTORY_UPDATED.
const { broadcastMock } = vi.hoisted(() => ({ broadcastMock: vi.fn() }))
vi.mock('../../../src/web/ws/handler.js', () => ({
  broadcastEvent: broadcastMock,
}))

import express from 'express'
import request from 'supertest'
import { personalAiV1Router } from '../../../src/web/routes/personal-ai-v1.js'
import { errorHandler } from '../../../src/web/middleware/error-handler.js'
import { WALNUT_HOME } from '../../../src/constants.js'
import { createConversation, getMainConversationId, listConversations } from '../../../src/core/conversations.js'
import { registerAgentTurnAbort } from '../../../src/core/agent-abort-registry.js'
import { waitForAnswers, hasPendingQuestion, cancelQuestion } from '../../../src/core/agent-question.js'

function createApp() {
  const app = express()
  app.use(express.json())
  app.use('/api/v1', personalAiV1Router)
  app.use(errorHandler)
  return app
}

beforeEach(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  await fs.mkdir(WALNUT_HOME, { recursive: true })
  broadcastMock.mockReset()
  cancelQuestion('general') // clear any pending question left by a prior test
})

afterEach(async () => {
  cancelQuestion('general')
  await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
})

describe('PATCH /api/v1/conversations/:id', () => {
  it('renames and pins a conversation', async () => {
    const meta = await createConversation('general', 'Old title')
    const res = await request(createApp())
      .patch(`/api/v1/conversations/${meta.id}`)
      .send({ title: 'New title', pinned: true })
    expect(res.status).toBe(200)
    expect(res.body.conversation.title).toBe('New title')
    expect(res.body.conversation.pinned).toBe(true)
    const list = await listConversations('general')
    const updated = list.find((c) => c.id === meta.id)
    expect(updated?.title).toBe('New title')
    expect(updated?.pinned).toBe(true)
  })

  it('400 when neither title nor pinned is provided', async () => {
    const meta = await createConversation('general')
    const res = await request(createApp()).patch(`/api/v1/conversations/${meta.id}`).send({})
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('bad_request')
  })

  it('404 not_found for an unknown conversation', async () => {
    const res = await request(createApp())
      .patch('/api/v1/conversations/conv-does-not-exist')
      .send({ title: 'x' })
    expect(res.status).toBe(404)
    expect(res.body.error.code).toBe('not_found')
  })
})

describe('DELETE /api/v1/conversations/:id', () => {
  it('deletes a non-main conversation → 204', async () => {
    const meta = await createConversation('general', 'Deletable')
    const res = await request(createApp()).delete(`/api/v1/conversations/${meta.id}`)
    expect(res.status).toBe(204)
    const list = await listConversations('general')
    expect(list.some((c) => c.id === meta.id)).toBe(false)
  })

  it('409 conflict when deleting the main conversation', async () => {
    const mainId = await getMainConversationId('general')
    const res = await request(createApp()).delete(`/api/v1/conversations/${mainId}`)
    expect(res.status).toBe(409)
    expect(res.body.error.code).toBe('conflict')
  })
})

describe('POST /api/v1/conversations/:id/stop', () => {
  it('aborts every registered turn for the agent and reports the count', async () => {
    const meta = await createConversation('general')
    const c1 = new AbortController()
    const c2 = new AbortController()
    registerAgentTurnAbort('general', c1)
    registerAgentTurnAbort('general', c2)

    const res = await request(createApp()).post(`/api/v1/conversations/${meta.id}/stop`)
    expect(res.status).toBe(200)
    expect(res.body.stopped).toBe(2)
    expect(c1.signal.aborted).toBe(true)
    expect(c2.signal.aborted).toBe(true)
  })

  it('cancels a pending user_ask question and reports it', async () => {
    const meta = await createConversation('general')
    const { promise } = waitForAnswers([{ question: 'Pick one?' }], 'general')
    promise.catch(() => { /* cancellation rejects — expected */ })
    expect(hasPendingQuestion('general')).toBe(true)

    const res = await request(createApp()).post(`/api/v1/conversations/${meta.id}/stop`)
    expect(res.status).toBe(200)
    expect(res.body.questionCancelled).toBe(true)
    expect(hasPendingQuestion('general')).toBe(false)
  })

  it('stop with nothing active is a harmless no-op (0 stopped)', async () => {
    const meta = await createConversation('general')
    const res = await request(createApp()).post(`/api/v1/conversations/${meta.id}/stop`)
    expect(res.status).toBe(200)
    expect(res.body.stopped).toBe(0)
    expect(res.body.questionCancelled).toBe(false)
  })
})

describe('POST /api/v1/conversations/:id/answer', () => {
  it('resolves the pending question with the submitted answers', async () => {
    const meta = await createConversation('general')
    const { promise } = waitForAnswers([{ question: 'Deploy now?', header: 'Deploy' }], 'general')

    const res = await request(createApp())
      .post(`/api/v1/conversations/${meta.id}/answer`)
      .send({ answers: { Deploy: 'yes' } })
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ok: true })
    await expect(promise).resolves.toEqual({ Deploy: 'yes' })
    // Mirrors chat:answer-question — the answers land in history live.
    expect(broadcastMock).toHaveBeenCalledWith(
      'chat:history-updated',
      expect.objectContaining({
        entry: expect.objectContaining({ role: 'user', source: 'question-answer' }),
      }),
    )
  })

  it('409 conflict when no question is pending', async () => {
    const meta = await createConversation('general')
    const res = await request(createApp())
      .post(`/api/v1/conversations/${meta.id}/answer`)
      .send({ answers: { q: 'a' } })
    expect(res.status).toBe(409)
    expect(res.body.error.code).toBe('conflict')
  })

  it('400 for a malformed answers payload', async () => {
    const meta = await createConversation('general')
    for (const bad of [{}, { answers: {} }, { answers: 'text' }, { answers: { k: 42 } }]) {
      const res = await request(createApp()).post(`/api/v1/conversations/${meta.id}/answer`).send(bad)
      expect(res.status).toBe(400)
      expect(res.body.error.code).toBe('bad_request')
    }
  })
})

// ─── Wave 2 additions: active pointer + chat stats/clear ─────────────────────

describe('PUT /api/v1/conversations/active', () => {
  it('switches the active pointer and broadcasts', async () => {
    const meta = await createConversation('general', 'Switch target')
    const res = await request(createApp())
      .put('/api/v1/conversations/active')
      .send({ conversationId: meta.id })
    expect(res.status).toBe(200)
    expect(res.body.activeConversationId).toBe(meta.id)
    const { getActiveConversationId } = await import('../../../src/core/conversations.js')
    expect(await getActiveConversationId('general')).toBe(meta.id)
    expect(broadcastMock).toHaveBeenCalled()
  })

  it('404 for an unknown conversation id', async () => {
    const res = await request(createApp())
      .put('/api/v1/conversations/active')
      .send({ conversationId: 'conv-does-not-exist' })
    expect(res.status).toBe(404)
    expect(res.body.error.code).toBe('not_found')
  })
})

describe('GET /api/v1/chat/stats + POST /api/v1/chat/clear', () => {
  it('stats returns the conversation-size shape for the active conversation', async () => {
    await getMainConversationId('general')
    const res = await request(createApp()).get('/api/v1/chat/stats')
    expect(res.status).toBe(200)
    for (const key of ['apiMessageCount', 'estimatedTokens', 'estimatedTotalTokens', 'compacted', 'contextWindow']) {
      expect(res.body).toHaveProperty(key)
    }
  })

  it('clear empties an explicit conversation', async () => {
    const meta = await createConversation('general', 'To clear')
    const chatHistory = await import('../../../src/core/chat-history.js')
    await chatHistory.addNotification({ role: 'user', content: 'hello there', agentId: 'general', conversationId: meta.id })

    const res = await request(createApp()).post(`/api/v1/chat/clear?conversationId=${meta.id}`)
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
    const entries = await chatHistory.getDisplayEntries(1, 50, 'general', meta.id)
    expect(entries.messages.length).toBe(0)
  })

  it('404 for an unknown explicit conversation', async () => {
    const res = await request(createApp()).get('/api/v1/chat/stats?conversationId=conv-ghost')
    expect(res.status).toBe(404)
  })
})

describe('POST /api/v1/chat/compact (Wave 3)', () => {
  it('answers fire-and-forget for the active conversation; 404 for a ghost', async () => {
    await getMainConversationId('general')
    const res = await request(createApp()).post('/api/v1/chat/compact')
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
    // Either freshly triggered (async) or already in flight from the trigger above.
    expect(res.body.async === true || res.body.alreadyRunning === true).toBe(true)

    const ghost = await request(createApp()).post('/api/v1/chat/compact?conversationId=conv-ghost')
    expect(ghost.status).toBe(404)
  })
})

/**
 * The chat engine pair: a read-only GET, and a POST that mints.
 *
 * Why the POST exists: the phone's model pill was permanently read-only on any
 * conversation that had not been sent to ("Send a message first"), so the
 * ordinary chat had no working model control while a task's session had one
 * immediately. The GET must stay read-only — a poll or a prefetch spawning a CLI
 * is a process the user never asked for — so minting became an explicit request.
 *
 * The lane session is not spawned here (that needs a session runner), so these
 * assert the ROUTING: which shape each engine answers with, and that the POST
 * refuses outright when the box is not on the lane engine.
 */
describe('GET/POST /api/v1/chat/engine — the model pill\'s two halves', () => {
  /** Point the config at one engine. */
  async function setEngine(provider: 'walnut-agent' | 'claude-code'): Promise<void> {
    const yaml = await import('js-yaml')
    const { CONFIG_FILE } = await import('../../../src/constants.js')
    await fs.writeFile(CONFIG_FILE, yaml.dump({
      version: 1, user: {}, defaults: { priority: 'none' },
      agent: { provider, main_model: 'us.anthropic.claude-haiku-4-5-20251001-v1:0' },
    }), 'utf-8')
  }

  it('GET reports in-process + the config model, and the POST refuses to mint', async () => {
    await setEngine('walnut-agent')
    const meta = await createConversation('general', 'in-process chat')

    const info = await request(createApp()).get(`/api/v1/chat/engine?conversationId=${meta.id}`)
    expect(info.status).toBe(200)
    expect(info.body.engine).toBe('in-process')
    expect(info.body.sessionId).toBeNull()
    // The model is reported so the pill can SHOW it, never switch it.
    expect(info.body.model).toBe('us.anthropic.claude-haiku-4-5-20251001-v1:0')

    // 409, not a silently-minted orphan CLI: the in-process loop has no lane.
    const minted = await request(createApp()).post(`/api/v1/chat/engine/session?conversationId=${meta.id}`)
    expect(minted.status).toBe(409)
  })

  it('GET reports the lane engine with no session before the first turn', async () => {
    await setEngine('claude-code')
    const meta = await createConversation('general', 'lane chat')

    const info = await request(createApp()).get(`/api/v1/chat/engine?conversationId=${meta.id}`)
    expect(info.status).toBe(200)
    expect(info.body.engine).toBe('lane')
    // Null is the state the POST exists to resolve — the GET never mints.
    expect(info.body.sessionId).toBeNull()
  })

  it('both halves 404 an unknown conversation rather than inventing one', async () => {
    await setEngine('claude-code')
    expect((await request(createApp()).get('/api/v1/chat/engine?conversationId=conv-ghost')).status).toBe(404)
    expect((await request(createApp()).post('/api/v1/chat/engine/session?conversationId=conv-ghost')).status).toBe(404)
  })
})
