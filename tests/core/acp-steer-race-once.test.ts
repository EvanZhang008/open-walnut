/**
 * A steer that loses its race with the end of a live ACP turn is tried once, and the message goes
 * into the next turn once (2026-11-09: a Codex session's queue steered one message 7,835 times in
 * 45 minutes. Each failed steer was journaled as a turn error, the error kicked the queue drain,
 * the drain steered the same message again, and the panel read "Ran 344 tools, 7859 failed").
 *
 * The real AcpSession and the real queue run here; only the daemon connection is fake. Its steer
 * answer kicks the drain again the way that error did, so a session that steers more than once per
 * turn loops here too (capped, so the old code fails instead of hanging).
 */
import fs from 'node:fs/promises'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-acp-steer-race-once'))

import { WALNUT_HOME } from '../../src/constants.js'
import { enqueueMessage, getQueue, resetCache } from '../../src/core/session-message-queue.js'
import { _resetForTesting } from '../../src/core/task-manager.js'
import { _resetSessionTrackerForTesting } from '../../src/core/session-tracker.js'
import { SessionRunner } from '../../src/providers/claude-code-session.js'
import { AcpSession } from '../../src/providers/acp-session.js'

beforeEach(async () => {
  _resetForTesting()
  _resetSessionTrackerForTesting()
  resetCache()
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  await fs.mkdir(WALNUT_HOME, { recursive: true })
})

afterEach(async () => {
  vi.restoreAllMocks()
  resetCache()
  await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
})

type Drain = { drainAcpQueue(session: unknown, sid: string): Promise<void>; clearActiveProcessing(sid: string): void }

function liveTurn(sessionId: string): AcpSession {
  const session = new AcpSession({ taskId: '', project: '', cwd: '/tmp', mode: 'default', engine: 'codex', providerSessionId: sessionId })
  Object.assign(session as object, { _active: true, _turnActive: true, _capabilities: { steering: true, steeringInjectOnly: true } })
  return session
}

const journal = (session: AcpSession, event: Record<string, unknown>, v: number) =>
  (session as unknown as { consumeJournalLine(line: string, v: number): void })
    .consumeJournalLine(JSON.stringify({ kind: 'meta', ts: Date.now(), event }), v)

describe('a steer that meets the end of the live ACP turn', () => {
  it('is tried once per turn, and the message goes into the next turn once', async () => {
    const runner = new SessionRunner() as unknown as Drain
    const sessionId = 'acp-steer-race-once'
    const session = liveTurn(sessionId)
    const kicked: Promise<void>[] = []
    const send = vi.fn(async (command: string) => {
      if (command !== 'acpSteer') return { ok: true }
      // The old error row kicked the drain again; at most 100 times here.
      if (kicked.length < 100) kicked.push(new Promise<void>((resolve) => setImmediate(() => { void runner.drainAcpQueue(session, sessionId).finally(resolve) })))
      return { ok: false, errorKind: 'steer_race' }
    })
    // Every drain a kick started, and the kicks those started, have ended.
    const settled = async () => { for (let seen = -1; seen !== kicked.length;) { seen = kicked.length; await Promise.all(kicked) } }
    Object.assign(session as object, { conn: { connected: true, send } })
    const prompt = vi.spyOn(session, 'send').mockResolvedValue(undefined as never)

    const queued = await enqueueMessage(sessionId, 'late words')
    await runner.drainAcpQueue(session, sessionId)
    // Every later kick in this turn (an enqueue, an event, a sweep) finds nothing to steer.
    for (let i = 0; i < 20; i++) await runner.drainAcpQueue(session, sessionId)
    await settled()

    expect(send.mock.calls.filter(([c]) => c === 'acpSteer')).toHaveLength(1)
    expect(session.canSteer).toBe(false)
    expect(prompt).not.toHaveBeenCalled()
    expect(await getQueue(sessionId)).toEqual([expect.objectContaining({ id: queued.id, status: 'pending' })])

    // The turn ends: the drain sends it as the next prompt, once.
    journal(session, { type: 'turn-ended', commandId: 'acp-prompt:qm-first', stopReason: 'end_turn' }, 1)
    expect(session.activity).toBe('idle')
    await runner.drainAcpQueue(session, sessionId)
    await runner.drainAcpQueue(session, sessionId)
    expect(prompt).toHaveBeenCalledTimes(1)
    expect(prompt).toHaveBeenCalledWith('late words', queued.id)
    runner.clearActiveProcessing(sessionId)

    // A new turn may be steered again.
    journal(session, { type: 'prompt-accepted', commandId: 'acp-prompt:qm-next', walnutMessageId: 'qm-next', text: 'x' }, 2)
    expect(session.canSteer).toBe(true)
  })

  it('a session whose worker never said injection only (an older worker) is never steered', async () => {
    const runner = new SessionRunner() as unknown as Drain
    const sessionId = 'acp-steer-old-worker'
    const session = liveTurn(sessionId)
    // An older worker's snapshot: `steering` alone meant "supported", and its adapter may start a turn.
    Object.assign(session as object, { _capabilities: { steering: true } })
    const send = vi.fn(async () => ({ ok: true }))
    Object.assign(session as object, { conn: { connected: true, send } })
    const prompt = vi.spyOn(session, 'send').mockResolvedValue(undefined as never)
    const queued = await enqueueMessage(sessionId, 'words')
    expect(session.canSteer).toBe(false)
    expect(await session.steer('words', queued.id)).toBe(false)
    await runner.drainAcpQueue(session, sessionId)
    expect(send).not.toHaveBeenCalled()
    expect(prompt).not.toHaveBeenCalled()
    journal(session, { type: 'turn-ended', commandId: 'acp-prompt:qm-old', stopReason: 'end_turn' }, 1)
    await runner.drainAcpQueue(session, sessionId)
    expect(prompt).toHaveBeenCalledTimes(1)
    runner.clearActiveProcessing(sessionId)
  })
})
