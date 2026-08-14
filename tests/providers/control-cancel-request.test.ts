/**
 * REPRODUCE (incident a172ce49): the CLI WITHDRAWS a pending can_use_tool
 * control_request by emitting `{type:'control_cancel_request', request_id}`
 * (turn aborted, resume, process restart re-planning). Walnut had NO handler —
 * the cancel fell into the control_* swallow, so the pending permission never
 * cleared: permanent amber "Waiting" badge, a 60s re-emit loop (497 re-emits in
 * one day), and a stale card whose Allow/Deny 404s. Session a172ce49 carried
 * TWO such cancelled ExitPlanMode requests and stuck "Waiting" for days.
 *
 * These tests pin the cancel contract: the pending map entry, the re-emit
 * timer, and the UI all settle; the request_id is poisoned so a daemon replay
 * of the ORIGINAL control_request cannot resurrect the prompt.
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

function collectEvents(name: string): BusEvent[] {
  const events: BusEvent[] = []
  bus.subscribe('ctrl-cancel-test', (e) => {
    if (e.name === name) events.push(e)
  }, { global: true })
  return events
}

const CTRL_REQUEST = {
  type: 'control_request',
  request_id: 'req-cancel-1',
  request: {
    subtype: 'can_use_tool',
    tool_name: 'ExitPlanMode',
    input: { plan: 'the plan text' },
  },
}

describe('control_cancel_request settles the pending permission', () => {
  let session: ClaudeCodeSession

  beforeEach(() => {
    bus.clear()
    session = new ClaudeCodeSession('task-cancel', 'proj', MOCK_CLI)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(session as any).claudeSessionId = 'sid-cancel-test'
  })

  afterEach(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(session as any)._clearAllPermissionReEmitTimers()
    bus.clear()
  })

  it('clears the pending map, stops the re-emit timer, and emits resolved(cancelled)', async () => {
    const resolved = collectEvents(EventNames.SESSION_PERMISSION_RESOLVED)

    feed(session, CTRL_REQUEST)
    expect(session.hasPendingPermission).toBe(true)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((session as any)._permissionReEmitTimers.size).toBe(1)

    feed(session, { type: 'control_cancel_request', request_id: 'req-cancel-1' })

    expect(session.hasPendingPermission).toBe(false)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((session as any)._permissionReEmitTimers.size).toBe(0)
    expect(resolved.length).toBe(1)
    const data = resolved[0].data as { requestId: string; allowed: boolean; cancelled?: boolean }
    expect(data.requestId).toBe('req-cancel-1')
    expect(data.allowed).toBe(false)
    expect(data.cancelled).toBe(true)
    // Give the fire-and-forget record-clear import a beat — must not throw.
    await new Promise(r => setTimeout(r, 20))
  })

  it('poisons the request_id so a replayed control_request cannot resurrect the prompt', () => {
    feed(session, CTRL_REQUEST)
    feed(session, { type: 'control_cancel_request', request_id: 'req-cancel-1' })
    expect(session.hasPendingPermission).toBe(false)

    // Daemon replay of the original request after the cancel (reconnect races).
    feed(session, CTRL_REQUEST)
    expect(session.hasPendingPermission).toBe(false)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((session as any)._permissionReEmitTimers.size).toBe(0)
  })

  it('a cancel for an UNKNOWN request_id is a safe no-op on other pending requests', () => {
    const resolved = collectEvents(EventNames.SESSION_PERMISSION_RESOLVED)
    feed(session, CTRL_REQUEST)

    feed(session, { type: 'control_cancel_request', request_id: 'req-other-999' })

    // The real pending request survives untouched; the unknown id still emits a
    // settle event (harmless — no UI card matches it).
    expect(session.hasPendingPermission).toBe(true)
    expect(resolved.every(e => (e.data as { requestId: string }).requestId !== 'req-cancel-1')).toBe(true)
  })

  it('a cancel with no request_id is swallowed without touching state', () => {
    feed(session, CTRL_REQUEST)
    feed(session, { type: 'control_cancel_request' })
    expect(session.hasPendingPermission).toBe(true)
  })
})

describe('resetConsumedOffsetFromSnapshot (incident 267a4b68 — live watermark epoch reset)', () => {
  let session: ClaudeCodeSession

  beforeEach(() => {
    session = new ClaudeCodeSession('task-wm', 'proj', 'true')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(session as any).claudeSessionId = 'sid-wm-reset'
  })

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const wm = () => (session as any)._consumedOffset as number
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const setWm = (v: number) => { (session as any)._consumedOffset = v }

  it('regresses the in-memory watermark when the snapshot layer proves an epoch change', () => {
    setWm(134_248_535) // dead-incarnation coordinate
    session.resetConsumedOffsetFromSnapshot(115_135_073)
    expect(wm()).toBe(115_135_073)
  })

  it('never moves the watermark FORWARD (normal advance owns that path)', () => {
    setWm(1_000)
    session.resetConsumedOffsetFromSnapshot(50_000)
    expect(wm()).toBe(1_000)
  })

  it('rejects invalid sentinels (negative / non-integer / MAX_SAFE_INTEGER)', () => {
    setWm(134_248_535)
    session.resetConsumedOffsetFromSnapshot(-1)
    session.resetConsumedOffsetFromSnapshot(1.5)
    session.resetConsumedOffsetFromSnapshot(Number.MAX_SAFE_INTEGER)
    expect(wm()).toBe(134_248_535)
  })

  it('END-TO-END guard effect: a real result above the reset watermark is no longer "replayed"', () => {
    setWm(134_248_535)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(session as any)._currentEventV = 115_134_908
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((session as any)._isReplayedByOffset()).toBe(true) // the incident: real result judged replay
    session.resetConsumedOffsetFromSnapshot(115_000_000)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((session as any)._isReplayedByOffset()).toBe(false) // after reset: processed for real
  })
})
