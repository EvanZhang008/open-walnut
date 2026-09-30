/**
 * A long tool call that emits nothing but heartbeats keeps its lane turn alive,
 * through the REAL stream parser.
 *
 * A lane turn fails on 15 minutes of stream silence (lane-turn.ts). While one
 * tool runs for a long time, the CLI's only output is a `tool_progress` line
 * about every 30 seconds, with no text, no tool event and no result. Those lines
 * count because ClaudeCodeSession.handleStreamLine stamps session-progress.ts
 * for EVERY line it parses. tests/core/lane-turn-liveness.test.ts pins the rule
 * by stamping the registry directly; this file pins that the parser is what
 * stamps it, so a refactor that drops the stamp shows up here as a stall.
 *
 * Real: ClaudeCodeSession's line handler, the progress registry, runLaneTurn and
 * the bus. Stubbed: the send queue and the session record (no CLI is spawned).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-lane-heartbeat'))

const sendMessageToSession = vi.hoisted(() => vi.fn())
vi.mock('../../src/core/session-message-queue.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/core/session-message-queue.js')>()),
  sendMessageToSession,
}))
const getSessionByClaudeId = vi.hoisted(() => vi.fn())
vi.mock('../../src/core/session-tracker.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/core/session-tracker.js')>()),
  getSessionByClaudeId,
}))

import { bus, EventNames } from '../../src/core/event-bus.js'
import { runLaneTurn, LANE_TURN_STALL_MS, LANE_TURN_TICK_MS, type LaneTurnTarget } from '../../src/core/sessions/lane-turn.js'
import { _resetSessionProgressForTesting } from '../../src/core/sessions/session-progress.js'
import { ClaudeCodeSession } from '../../src/providers/claude-code-session.js'

const SID = 'bbbbbbbb-1111-2222-3333-444444444444'
const MIN = 60_000

const lane: LaneTurnTarget = {
  resolve: async () => ({ sessionId: SID, created: false }),
  catchUp: async (_sid, message) => ({ message }),
}

function emit(name: string, data: Record<string, unknown>): void {
  bus.emit(name, data as never, ['main-ai'], { source: 'test' })
}

async function yieldReal(times = 5): Promise<void> {
  for (let i = 0; i < times; i++) await new Promise((r) => setImmediate(r))
}

async function peekDone(p: Promise<unknown>): Promise<boolean> {
  let done = false
  p.then(() => { done = true })
  await yieldReal()
  return done
}

/** The parser the lane's CLI output goes through, fed one line at a time. */
function parserFor(sessionId: string): (obj: unknown) => void {
  const session = new ClaudeCodeSession('task-heartbeat', 'proj', 'true')
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(session as any).claudeSessionId = sessionId
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (obj) => (session as any).handleStreamLine(JSON.stringify(obj))
}

beforeEach(() => {
  bus.clear()
  _resetSessionProgressForTesting()
  sendMessageToSession.mockReset()
  sendMessageToSession.mockImplementation(async () => ({ id: 'qm-1' }))
  getSessionByClaudeId.mockReset()
  getSessionByClaudeId.mockImplementation(async () => ({ process_status: 'running', status_reason: null }))
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] })
})

afterEach(() => {
  vi.useRealTimers()
  bus.clear()
})

describe('a long tool with only heartbeats', () => {
  it('is not a stall: 20 minutes of tool_progress lines keep the turn alive until its answer', async () => {
    const feed = parserFor(SID)
    const turn = runLaneTurn('general', 'conv-hb', 'run the long job', { source: 'api-v1', target: lane })
    for (let i = 0; i < 5_000 && sendMessageToSession.mock.calls.length === 0; i++) await yieldReal(1)
    expect(sendMessageToSession).toHaveBeenCalledTimes(1)
    emit(EventNames.SESSION_MESSAGES_DELIVERED, { sessionId: SID, count: 1, messageIds: ['qm-1'], turnGen: 1 })

    // One tool, twenty minutes, a heartbeat line every 30 s and nothing else.
    const total = 20 * MIN
    for (let t = 0; t < total; t += LANE_TURN_TICK_MS) {
      feed({ type: 'tool_progress', tool_use_id: 'toolu_long', elapsed_time_seconds: t / 1000 })
      await vi.advanceTimersByTimeAsync(LANE_TURN_TICK_MS)
      await yieldReal()
    }
    expect(total).toBeGreaterThan(LANE_TURN_STALL_MS)
    expect(await peekDone(turn)).toBe(false)

    emit(EventNames.SESSION_RESULT, { sessionId: SID, result: 'the job finished', turnGen: 1 })
    await expect(turn).resolves.toEqual({ sessionId: SID, resultText: 'the job finished' })
  })
})
