/**
 * /api/v1 butler conversation management (Wave 1) — butler-v1.ts. Bare
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
  return { ...actual, ...createMockConstants('walnut-apiv1-butler') }
})

// WS broadcast seam — butler-v1 broadcasts CONVERSATION_*/CHAT_HISTORY_UPDATED.
const { broadcastMock } = vi.hoisted(() => ({ broadcastMock: vi.fn() }))
vi.mock('../../../src/web/ws/handler.js', () => ({
  broadcastEvent: broadcastMock,
}))

import express from 'express'
import request from 'supertest'
import { butlerV1Router } from '../../../src/web/routes/butler-v1.js'
import { errorHandler } from '../../../src/web/middleware/error-handler.js'
import { WALNUT_HOME } from '../../../src/constants.js'
import { createConversation, getMainConversationId, listConversations } from '../../../src/core/conversations.js'
import { registerAgentTurnAbort } from '../../../src/core/agent-abort-registry.js'
import { waitForAnswers, hasPendingQuestion, cancelQuestion } from '../../../src/core/agent-question.js'

function createApp() {
  const app = express()
  app.use(express.json())
  app.use('/api/v1', butlerV1Router)
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
