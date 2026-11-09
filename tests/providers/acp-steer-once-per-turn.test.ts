/**
 * A steer the live ACP turn refused is asked once per turn, and the refusal is never
 * the turn's error (2026-11-09: Codex refused every steer of one long turn, and each
 * refusal, journaled as an error, drove the queue to steer again, ~30,000 times).
 * After the turn ends the message goes out as the next prompt (the runner's drain).
 */
import fs from 'node:fs/promises'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-acp-steer-once'))

import { WALNUT_HOME } from '../../src/constants.js'
import { _resetSessionTrackerForTesting } from '../../src/core/session-tracker.js'
import { bus, EventNames } from '../../src/core/event-bus.js'
import { AcpSession } from '../../src/providers/acp-session.js'

let v = 0
function feed(session: AcpSession, event: Record<string, unknown>): void {
  const line = JSON.stringify({ kind: 'meta', ts: Date.now(), event })
  ;(session as unknown as { handleDaemonEvent(ev: unknown): void })
    .handleDaemonEvent({ sid: session.runtimeId, ev: 'jsonl', line, v: ++v })
}

function liveSession(steerReply: () => Record<string, unknown>) {
  const session = new AcpSession({ taskId: '', project: '', cwd: '/tmp', mode: 'default', engine: 'codex' })
  const send = vi.fn(async (command: string) => (command === 'acpSteer' ? steerReply() : { ok: true }))
  Object.assign(session as object, {
    conn: { connected: true, send },
    _active: true,
    _capabilities: { steering: true },
  })
  return { session, steers: () => send.mock.calls.filter(([c]) => c === 'acpSteer').length }
}

const errors: unknown[] = []
beforeEach(async () => {
  _resetSessionTrackerForTesting()
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  await fs.mkdir(WALNUT_HOME, { recursive: true })
  errors.length = 0
  bus.subscribe('steer-once-probe', (e) => { if (e.name === EventNames.SESSION_ERROR) errors.push(e.data) }, { global: true })
})
afterEach(() => {
  bus.clear()
  vi.restoreAllMocks()
})

describe('ACP steer refused by the live turn', () => {
  it('is asked once per turn, and asked again in the next turn', async () => {
    const { session, steers } = liveSession(() => ({ ok: false, errorKind: 'steer_race' }))
    feed(session, { type: 'prompt-accepted', commandId: 'acp-prompt:qm-1', walnutMessageId: 'qm-1', text: 'work' })
    feed(session, { type: 'turn-started', commandId: 'acp-prompt:qm-1' })
    expect(await session.steer('reply', 'qm-peer')).toBe(false)
    expect(await session.steer('reply', 'qm-peer')).toBe(false)
    expect(await session.steer('other', 'qm-other')).toBe(false)
    expect(steers()).toBe(1)
    feed(session, { type: 'turn-ended', commandId: 'acp-prompt:qm-1', stopReason: 'end_turn' })
    feed(session, { type: 'prompt-accepted', commandId: 'acp-prompt:qm-2', walnutMessageId: 'qm-2', text: 'next' })
    feed(session, { type: 'turn-started', commandId: 'acp-prompt:qm-2' })
    expect(await session.steer('reply', 'qm-peer')).toBe(false)
    expect(steers()).toBe(2)
  })

  it('an older worker\'s journaled refusal raises no session error and does not fail the turn', () => {
    const { session } = liveSession(() => ({ ok: true }))
    feed(session, { type: 'prompt-accepted', commandId: 'acp-prompt:qm-1', walnutMessageId: 'qm-1', text: 'work' })
    feed(session, { type: 'turn-started', commandId: 'acp-prompt:qm-1' })
    feed(session, { type: 'error', errorKind: 'steer_race', message: 'ACP live turn ended before steering applied' })
    expect(errors).toEqual([])
    expect((session as unknown as { _turnHadError: boolean })._turnHadError).toBe(false)
  })

  it('knows which queue rows the worker took, as a prompt or a steer', () => {
    const { session } = liveSession(() => ({ ok: true }))
    feed(session, { type: 'prompt-accepted', commandId: 'acp-prompt:qm-1', walnutMessageId: 'qm-1', text: 'work' })
    feed(session, { type: 'steer-accepted', commandId: 'acp-steer:qm-2', walnutMessageId: 'qm-2', text: 'more' })
    expect(session.hasTaken('qm-1')).toBe(true)
    expect(session.hasTaken('qm-2')).toBe(true)
    expect(session.hasTaken('qm-3')).toBe(false)
  })
})
