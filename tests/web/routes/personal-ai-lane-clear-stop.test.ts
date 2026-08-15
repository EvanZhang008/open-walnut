/**
 * Lane lifecycle on "clear conversation" and on "stop" (P4).
 *
 * Both were silently one-sided before: they acted on Walnut's in-process state and
 * left the `claude` session that actually holds the conversation untouched.
 *
 *   CLEAR — chatHistory.clear() empties OUR store only. The CLI keeps its own
 *     JSONL, so it would answer the next message still remembering everything the
 *     user just asked to forget (a privacy break, not a cosmetic one). Clear must
 *     therefore stop the CLI and ARCHIVE the record, because an archived record is
 *     precisely what makes the next lane resolve mint a fresh session
 *     (getSessionByLane excludes archived rows).
 *
 *   STOP — the in-process AbortController cannot reach a CLI the daemon owns, so a
 *     lane turn ignored the stop button entirely. Stop must additionally emit the
 *     canonical SESSION_INTERRUPT (the same path the session composer's stop
 *     button uses) — never a signal, never a bespoke kill.
 *
 * Both halves are failure-safe: a dead CLI, a missing record, or a throwing stop
 * must not fail the user's action. Those are asserted, not assumed.
 *
 * Real: express routers, conversations store, session records (temp-dir sqlite),
 * event bus. Stubbed: sessionRunner (spies only — no signal is ever sent, no
 * `claude` is ever spawned).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs/promises'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/constants.js')>()
  return { ...actual, ...createMockConstants('walnut-lane-clear-stop') }
})

vi.mock('../../../src/web/ws/handler.js', () => ({ broadcastEvent: vi.fn() }))

// terminateSession probes these three; a method the code calls but the stub omits
// surfaces as "not a function", so keep them in sync with session-lifecycle.ts.
const { interruptMock, settleMock, findSessionMock } = vi.hoisted(() => ({
  interruptMock: vi.fn(async () => {}),
  settleMock: vi.fn(),
  findSessionMock: vi.fn(),
}))
vi.mock('../../../src/providers/claude-code-session.js', () => ({
  sessionRunner: {
    findAcpSession: () => null,
    findSessionByClaudeId: (sid: string) => findSessionMock(sid),
    settleInFlightTurn: (sid: string) => settleMock(sid),
    isCronArmed: () => false,
  },
}))

import express from 'express'
import request from 'supertest'
import { chatHistoryRouter } from '../../../src/web/routes/chat-history.js'
import { personalAiV1Router } from '../../../src/web/routes/personal-ai-v1.js'
import { errorHandler } from '../../../src/web/middleware/error-handler.js'
import { WALNUT_HOME } from '../../../src/constants.js'
import { bus, EventNames, type BusEvent } from '../../../src/core/event-bus.js'
import { personalAiLaneKey } from '../../../src/core/sessions/personal-ai-lane.js'

const LANE_SID = '11111111-2222-3333-4444-555555555555'

function createApp() {
  const app = express()
  app.use(express.json())
  app.use('/api/chat', chatHistoryRouter)
  app.use('/api/v1', personalAiV1Router)
  app.use(errorHandler)
  return app
}

/** SESSION_INTERRUPT payloads captured off the bus (what a real stop would emit). */
let interrupts: Array<{ sessionId?: string }> = []

/** Seed a live lane record for `conversationId`, as getOrCreateLaneSession would. */
async function seedLane(conversationId: string, processStatus = 'running'): Promise<void> {
  const { createSessionRecord, updateSessionRecord } = await import('../../../src/core/session-tracker.js')
  await createSessionRecord(LANE_SID, '', '', WALNUT_HOME, {
    title: 'Personal AI chat',
    lane: personalAiLaneKey('general', conversationId),
    initialProcessStatus: 'idle',
  })
  if (processStatus !== 'idle') {
    await updateSessionRecord(LANE_SID, { process_status: processStatus } as Record<string, unknown>)
  }
}

async function laneRecord(conversationId: string) {
  const { getSessionByLane } = await import('../../../src/core/session-tracker.js')
  return await getSessionByLane(personalAiLaneKey('general', conversationId))
}

beforeEach(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  await fs.mkdir(WALNUT_HOME, { recursive: true })
  const [sessionDb, sessionTracker] = await Promise.all([
    import('../../../src/core/session-db.js'),
    import('../../../src/core/session-tracker.js'),
  ])
  sessionDb.closeDb()
  sessionTracker._resetSessionTrackerForTesting()

  bus.clear()
  interrupts = []
  bus.subscribe('session-runner', (event: BusEvent) => {
    if (event.name === EventNames.SESSION_INTERRUPT) interrupts.push(event.data as { sessionId?: string })
  })

  interruptMock.mockClear()
  interruptMock.mockResolvedValue(undefined)
  settleMock.mockClear()
  findSessionMock.mockReset()
  findSessionMock.mockReturnValue({ interrupt: interruptMock })
})

afterEach(async () => {
  bus.clear()
  await fs.rm(WALNUT_HOME, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }).catch(() => {})
})

// ══════════════════════════════════════════════════════════════════
//  CLEAR — POST /api/chat/clear (web console)
// ══════════════════════════════════════════════════════════════════

describe('POST /api/chat/clear retires the lane', () => {
  it('stops the CLI and archives the record, so the next resolve mints a fresh session', async () => {
    const { createConversation } = await import('../../../src/core/conversations.js')
    const conv = await createConversation('general', 'To clear')
    await seedLane(conv.id)
    expect((await laneRecord(conv.id))?.claudeSessionId).toBe(LANE_SID)

    const res = await request(createApp()).post(`/api/chat/clear?conversationId=${conv.id}`)
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)

    // The live CLI was stopped through the canonical terminate path (a spy — no
    // signal was sent anywhere).
    expect(interruptMock).toHaveBeenCalledTimes(1)
    // And the lane is free: the record is archived, so getSessionByLane (which
    // excludes archived rows) reports nothing bound to this conversation.
    expect(await laneRecord(conv.id)).toBeNull()
    const { getSessionByClaudeId } = await import('../../../src/core/session-tracker.js')
    const raw = await getSessionByClaudeId(LANE_SID)
    expect(raw?.archived).toBe(true)
    expect(raw?.archive_reason).toBe('chat_cleared')
  })

  it('still clears (and still archives) when stopping the CLI THROWS', async () => {
    // A dead/unreachable CLI is normal — it must not strand the user with a
    // conversation they cannot clear.
    const { createConversation } = await import('../../../src/core/conversations.js')
    const conv = await createConversation('general', 'Stop throws')
    await seedLane(conv.id)
    interruptMock.mockRejectedValueOnce(new Error('daemon is gone'))

    const res = await request(createApp()).post(`/api/chat/clear?conversationId=${conv.id}`)
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
    expect(await laneRecord(conv.id)).toBeNull()
  })

  it('clears the chat history itself (unchanged behavior)', async () => {
    const { createConversation } = await import('../../../src/core/conversations.js')
    const chatHistory = await import('../../../src/core/chat-history.js')
    const conv = await createConversation('general', 'With history')
    await chatHistory.addNotification({ role: 'user', content: 'secret plans', agentId: 'general', conversationId: conv.id })
    await seedLane(conv.id)

    await request(createApp()).post(`/api/chat/clear?conversationId=${conv.id}`).expect(200)
    const entries = await chatHistory.getDisplayEntries(1, 50, 'general', conv.id)
    expect(entries.messages.length).toBe(0)
  })

  it('is a plain no-op when the conversation has no lane session', async () => {
    const { createConversation } = await import('../../../src/core/conversations.js')
    const conv = await createConversation('general', 'No lane')
    const res = await request(createApp()).post(`/api/chat/clear?conversationId=${conv.id}`)
    expect(res.status).toBe(200)
    expect(interruptMock).not.toHaveBeenCalled()
  })
})

// ══════════════════════════════════════════════════════════════════
//  CLEAR — POST /api/v1/chat/clear (mobile)
// ══════════════════════════════════════════════════════════════════

describe('POST /api/v1/chat/clear retires the lane too', () => {
  it('archives the lane record and stops the CLI (same effects as the web route)', async () => {
    const { createConversation } = await import('../../../src/core/conversations.js')
    const conv = await createConversation('general', 'v1 clear')
    await seedLane(conv.id)

    const res = await request(createApp()).post(`/api/v1/chat/clear?conversationId=${conv.id}`)
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
    expect(interruptMock).toHaveBeenCalledTimes(1)
    expect(await laneRecord(conv.id)).toBeNull()
  })
})

// ══════════════════════════════════════════════════════════════════
//  STOP — POST /api/v1/conversations/:id/stop
// ══════════════════════════════════════════════════════════════════

describe('POST /api/v1/conversations/:id/stop reaches the lane', () => {
  it('emits the canonical SESSION_INTERRUPT for the lane session', async () => {
    const { createConversation } = await import('../../../src/core/conversations.js')
    const conv = await createConversation('general', 'Stop me')
    await seedLane(conv.id, 'running')

    const res = await request(createApp()).post(`/api/v1/conversations/${conv.id}/stop`)
    expect(res.status).toBe(200)
    // Frozen response shape — the lane id is logged, not added to the contract.
    expect(Object.keys(res.body).sort()).toEqual(['questionCancelled', 'stopped'])
    expect(interrupts).toEqual([{ sessionId: LANE_SID }])
  })

  it('does not throw and reports normally when there is no lane', async () => {
    const { createConversation } = await import('../../../src/core/conversations.js')
    const conv = await createConversation('general', 'No lane')
    const res = await request(createApp()).post(`/api/v1/conversations/${conv.id}/stop`)
    expect(res.status).toBe(200)
    expect(res.body.stopped).toBe(0)
    expect(interrupts).toEqual([])
  })

  it('leaves an already-stopped lane alone (nothing to interrupt)', async () => {
    const { createConversation } = await import('../../../src/core/conversations.js')
    const conv = await createConversation('general', 'Already stopped')
    await seedLane(conv.id, 'stopped')
    await request(createApp()).post(`/api/v1/conversations/${conv.id}/stop`).expect(200)
    expect(interrupts).toEqual([])
  })

  it('interrupts an IDLE lane too — the record lags a turn that just started', async () => {
    // process_status is written by the runner and can trail reality by a beat; a
    // stop that only fired on 'running' would miss exactly the moment the user is
    // most likely to press it.
    const { createConversation } = await import('../../../src/core/conversations.js')
    const conv = await createConversation('general', 'Idle lane')
    await seedLane(conv.id, 'idle')
    await request(createApp()).post(`/api/v1/conversations/${conv.id}/stop`).expect(200)
    expect(interrupts).toEqual([{ sessionId: LANE_SID }])
  })

  it('never sends a process signal — the stop goes over the bus only', async () => {
    const { createConversation } = await import('../../../src/core/conversations.js')
    const conv = await createConversation('general', 'Bus only')
    await seedLane(conv.id, 'running')
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true)
    try {
      await request(createApp()).post(`/api/v1/conversations/${conv.id}/stop`).expect(200)
      expect(killSpy).not.toHaveBeenCalled()
    } finally {
      killSpy.mockRestore()
    }
  })
})
