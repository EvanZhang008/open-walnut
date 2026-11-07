/**
 * L2.2 — DaemonConnection event fan-out (5 tests).
 *
 * Validates the boundary between raw WebSocket messages and the
 * DaemonConnection event-handler API:
 *   - session_state events with all fields land intact on subscribers
 *   - Multiple handlers fan out
 *   - One handler throwing does not affect other handlers (isolation)
 *   - Unsubscribe actually stops delivery
 *   - Messages with `id` field go to pending-command resolve path, NOT to
 *     event handlers (wire-protocol separation)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { DaemonConnection, type DaemonEvent } from '../../src/providers/daemon-connection.js'
import { createMockDaemon, type MockDaemon } from '../helpers/mock-daemon.js'

const TARGET = { hostname: '127.0.0.1', user: undefined, port: undefined }

describe('L2.2 DaemonConnection event forwarding', () => {
  let daemon: MockDaemon
  let conn: DaemonConnection

  beforeEach(async () => {
    daemon = await createMockDaemon()
    conn = new DaemonConnection('test-host', TARGET)
    await conn.connectDirect(`ws://127.0.0.1:${daemon.port}`)
  })

  afterEach(async () => {
    try { conn.disconnect() } catch { /* best effort */ }
    await daemon.stop()
  })

  // D1 — daemon emits session_state → subscriber receives all fields
  it('D1: session_state event preserves sid/state/exitCode/reason', async () => {
    const received: DaemonEvent[] = []
    conn.onEvent((e) => received.push(e))
    daemon.emitSessionState('abc', 'dead', { exitCode: 17, reason: 'test-reason' })
    await vi.waitFor(() => { expect(received).toHaveLength(1) }, { timeout: 10_000, interval: 10 })
    expect(received[0]).toMatchObject({
      ev: 'session_state',
      sid: 'abc',
      state: 'dead',
      exitCode: 17,
      reason: 'test-reason',
    })
  })

  // D2 — multiple subscribers receive the same event
  it('D2: multiple handlers all receive the event (fan-out)', async () => {
    const h1 = vi.fn(); const h2 = vi.fn(); const h3 = vi.fn()
    conn.onEvent(h1); conn.onEvent(h2); conn.onEvent(h3)
    daemon.emitEvent('jsonl', { sid: 'x', line: '{"type":"user"}' })
    await vi.waitFor(() => {
      expect(h1).toHaveBeenCalledTimes(1)
      expect(h2).toHaveBeenCalledTimes(1)
      expect(h3).toHaveBeenCalledTimes(1)
    }, { timeout: 10_000, interval: 10 })
  })

  // D3 — a throwing handler does not block the others
  it('D3: handler throwing does not break fan-out to siblings', async () => {
    const bad = vi.fn(() => { throw new Error('handler boom') })
    const good = vi.fn()
    conn.onEvent(bad)
    conn.onEvent(good)
    daemon.emitEvent('jsonl', { sid: 'x', line: 'hello' })
    await vi.waitFor(() => {
      expect(bad).toHaveBeenCalledTimes(1)
      expect(good).toHaveBeenCalledTimes(1)
    }, { timeout: 10_000, interval: 10 })
  })

  // D4 — unsubscribe stops delivery
  it('D4: unsubscribe stops further delivery', async () => {
    const handler = vi.fn()
    const unsub = conn.onEvent(handler)
    daemon.emitEvent('jsonl', { sid: 'x', line: 'first' })
    await vi.waitFor(() => { expect(handler).toHaveBeenCalledTimes(1) }, { timeout: 10_000, interval: 10 })
    unsub()
    daemon.emitEvent('jsonl', { sid: 'x', line: 'second' })
    await new Promise((r) => setTimeout(r, 20))
    expect(handler).toHaveBeenCalledTimes(1)
  })

  // D5 — messages with numeric `id` route to pending-command resolve, NOT events
  it('D5: command reply (has numeric id) does not reach event handlers', async () => {
    const handler = vi.fn()
    conn.onEvent(handler)
    // `ping` is handled by MockDaemon and replies with {id, ok:true, pong:true}.
    // That reply has a numeric id and should be resolved via pending-command path.
    const reply = await conn.send('ping', {})
    expect(reply).toMatchObject({ ok: true, pong: true })
    await new Promise((r) => setTimeout(r, 30))
    expect(handler).not.toHaveBeenCalled()
  })

  // D6 — registering the SAME handler reference twice must NOT double-deliver.
  // This is the streamed-text-doubling root cause: a leaked re-subscribe left
  // the same handler in eventHandlers twice, so every line dispatched twice in
  // one tick. The onEvent guard dedups by reference.
  it('D6: duplicate handler registration does not double-deliver', async () => {
    const handler = vi.fn()
    conn.onEvent(handler)
    conn.onEvent(handler) // same reference — must be ignored
    daemon.emitEvent('jsonl', { sid: 'x', line: '{"type":"stream_event"}' })
    // A duplicate registration would dispatch in the same tick as the first call.
    await vi.waitFor(() => { expect(handler).toHaveBeenCalled() }, { timeout: 10_000, interval: 10 })
    expect(handler).toHaveBeenCalledTimes(1)
  })

  // D7 — the unsubscribe returned for a deduped (already-registered) handler
  // still removes it; after unsubscribing, no further delivery.
  it('D7: unsub from a deduped registration still stops delivery', async () => {
    const handler = vi.fn()
    conn.onEvent(handler)
    const unsubDup = conn.onEvent(handler) // deduped — returns a working unsub
    unsubDup()
    daemon.emitEvent('jsonl', { sid: 'x', line: 'after-unsub' })
    await new Promise((r) => setTimeout(r, 30))
    expect(handler).not.toHaveBeenCalled()
  })
})
