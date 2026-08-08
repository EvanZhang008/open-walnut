/**
 * REPRODUCE (inc-1786165723472): the CLI emits `control_request_progress`
 * heartbeat lines for in-flight OUTBOUND control_requests (side_question —
 * Walnut's own auto-tidy `/btw`). handleStreamLine had no case for it, so the
 * line fell into the unknown-event catch-all and the UI rendered a PERMANENT
 * "Unknown Claude event" system block pinned below the conversation — cleared
 * only by refresh (control lines never persist to canonical JSONL).
 *
 * The catch-all's job is "conversation content never silently disappears".
 * Control-protocol plumbing is NOT conversation content — the daemon already
 * drops the control_request/control_response family on replay for exactly this
 * reason. These tests pin the classification: the control_* family never
 * reaches the UI, while genuinely-unknown types still do (the catch-all must
 * stay alive — that property is load-bearing).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants())

import { ClaudeCodeSession } from '../../src/providers/claude-code-session.js'
import { bus, EventNames } from '../../src/core/event-bus.js'
import type { BusEvent } from '../../src/core/event-bus.js'

const MOCK_CLI = 'true' // never spawned — we feed lines directly

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const feed = (session: ClaudeCodeSession, obj: unknown) => (session as any).handleStreamLine(JSON.stringify(obj))

function collectUnknownEvents(): BusEvent[] {
  const events: BusEvent[] = []
  // global: emitUnknownEventOnce targets ['main-ai']; a named subscriber
  // wouldn't match, so observe the bus globally like the WS forwarder does.
  bus.subscribe('ctrl-progress-test', (e) => {
    if (e.name === EventNames.SESSION_UNKNOWN_EVENT) events.push(e)
  }, { global: true })
  return events
}

describe('control-protocol lines never surface as unknown-event UI blocks', () => {
  let session: ClaudeCodeSession

  beforeEach(() => {
    bus.clear()
    session = new ClaudeCodeSession('task-ctrl', 'proj', MOCK_CLI)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(session as any).claudeSessionId = 'sid-ctrl-progress'
  })

  afterEach(() => {
    bus.clear()
  })

  it('control_request_progress is swallowed silently (the incident line, verbatim shape)', () => {
    const unknown = collectUnknownEvents()
    feed(session, {
      type: 'control_request_progress',
      request_id: 'sq-1786164561310-dcabb5c6',
      status: 'started',
    })
    expect(unknown).toEqual([])
  })

  it('future control_* variants are also protocol plumbing — no UI block', () => {
    const unknown = collectUnknownEvents()
    feed(session, { type: 'control_cancel_request', request_id: 'x-1' })
    feed(session, { type: 'control_stream_chunk', request_id: 'x-2', chunk: 'partial' })
    expect(unknown).toEqual([])
  })

  it('genuinely-unknown types STILL surface (the catch-all stays alive)', () => {
    const unknown = collectUnknownEvents()
    feed(session, { type: 'mystery_future_event', payload: 42 })
    expect(unknown.length).toBe(1)
    expect((unknown[0].data as { eventType?: string }).eventType).toBe('mystery_future_event')
  })
})
