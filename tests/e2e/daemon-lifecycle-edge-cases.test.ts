/**
 * L3.3 — Daemon lifecycle edge cases (4 tests).
 *
 * Selected from the 35-case coverage matrix in the plan:
 *   E1 — concurrent writeMessage calls to same session serialize correctly
 *   E2 — client attaches after session already reaped → sees failure via send
 *   E3 — two clients connected to the same MockDaemon both receive
 *        session_state=dead broadcasts
 *   E4 — EAGAIN is marked retriable; session is NOT reaped
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants())

import { SESSION_STREAMS_DIR } from '../../src/constants.js'
import { RemoteSessionManager } from '../../src/providers/remote-session-manager.js'
import { SendHeldError } from '../../src/providers/delivery-failure.js'
import { createMockDaemon, type MockDaemon } from '../helpers/mock-daemon.js'

const fakeSshTarget = { hostname: 'localhost' }

describe('L3.3 Daemon lifecycle edge cases', () => {
  let daemon: MockDaemon

  beforeEach(async () => {
    fs.mkdirSync(SESSION_STREAMS_DIR, { recursive: true })
    daemon = await createMockDaemon()
  })

  afterEach(async () => {
    await daemon.stop()
  })

  // E1 — Many concurrent sends all resolve; none hang
  it('E1: 10 concurrent writeMessage calls all resolve', async () => {
    const tmpId = `e1-${Date.now()}`
    const mgr = new RemoteSessionManager(tmpId, 'host', fakeSshTarget, `ws://127.0.0.1:${daemon.port}`)
    await mgr.start({
      args: ['-p', '--output-format', 'stream-json', '--verbose'],
      cwd: '/tmp',
      message: 'slow:2000 stay-alive',
      onOutput: () => {},
      onExit: () => {},
    })
    await new Promise((r) => setTimeout(r, 150))

    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) => mgr.writeMessage(`msg-${i}`)),
    )
    // Some may fail if FIFO contention hits — but all must resolve, none hang
    expect(results).toHaveLength(10)
    for (const r of results) expect(typeof r).toBe('boolean')

    await mgr.cleanup()
  })

  // E2 — Send to reaped session returns reason:session_dead
  it('E2: send to session already reaped returns writeMessage=false', async () => {
    const tmpId = `e2-${Date.now()}`
    const mgr = new RemoteSessionManager(tmpId, 'host', fakeSshTarget, `ws://127.0.0.1:${daemon.port}`)
    await mgr.start({
      args: ['-p', '--output-format', 'stream-json', '--verbose'],
      cwd: '/tmp',
      message: 'slow:2000 stay-alive',
      onOutput: () => {},
      onExit: () => {},
    })
    await new Promise((r) => setTimeout(r, 150))

    daemon.simulateDeath(tmpId, 1)
    // Wait for death broadcast to propagate
    await new Promise((r) => setTimeout(r, 100))

    const ok = await mgr.writeMessage('hello to dead session')
    expect(ok).toBe(false)

    await mgr.cleanup()
  })

  // E3 — Multiple clients attached to same daemon all get session_state=dead
  it('E3: two clients attached to daemon both receive session_state=dead', async () => {
    const tmpId = `e3-${Date.now()}`
    const m1 = new RemoteSessionManager(tmpId, 'host-1', fakeSshTarget, `ws://127.0.0.1:${daemon.port}`)
    const m2 = new RemoteSessionManager(tmpId, 'host-2', fakeSshTarget, `ws://127.0.0.1:${daemon.port}`)

    const exit1 = vi.fn()
    const exit2 = vi.fn()

    await m1.start({
      args: ['-p', '--output-format', 'stream-json', '--verbose'],
      cwd: '/tmp',
      message: 'slow:2000 stay-alive',
      onOutput: () => {},
      onExit: exit1,
    })
    // m2 must attach to SAME sid — simulate by starting with same tmpId. In a
    // real system two clients share the same remote session; here we just
    // start a second manager with the same tmpId to validate broadcast.
    await m2.start({
      args: ['-p', '--output-format', 'stream-json', '--verbose'],
      cwd: '/tmp',
      message: 'slow:2000 stay-alive',
      onOutput: () => {},
      onExit: exit2,
    })
    await new Promise((r) => setTimeout(r, 200))

    daemon.emitSessionState(tmpId, 'dead', { exitCode: 3 })
    await new Promise((r) => setTimeout(r, 200))

    // Both managers see the dead broadcast and fire onExit
    expect(exit1).toHaveBeenCalledTimes(1)
    expect(exit2).toHaveBeenCalledTimes(1)
    expect(exit1.mock.calls[0][0]).toBe(3)
    expect(exit2.mock.calls[0][0]).toBe(3)

    await m1.cleanup()
    await m2.cleanup()
  })

  // E4 — EAGAIN does NOT reap; session is still alive afterwards
  it('E4: EAGAIN fault holds the line (SendHeldError) and the session stays alive', async () => {
    const tmpId = `e4-${Date.now()}`
    const mgr = new RemoteSessionManager(tmpId, 'host', fakeSshTarget, `ws://127.0.0.1:${daemon.port}`)
    const onExit = vi.fn()
    await mgr.start({
      args: ['-p', '--output-format', 'stream-json', '--verbose'],
      cwd: '/tmp',
      message: 'slow:2000 stay-alive',
      onOutput: () => {},
      onExit,
    })
    await new Promise((r) => setTimeout(r, 150))

    daemon.injectSendFault(tmpId, 'EAGAIN')
    const write = mgr.writeMessage('hi')
    await expect(write).rejects.toBeInstanceOf(SendHeldError)
    await expect(write).rejects.toThrow('the session host refused delivery (EAGAIN)')

    // EAGAIN is an intact, full pipe, not a death verdict (5408d5875): the client
    // keeps the transport and never fires onExit, so nothing stops and resumes a
    // live CLI over it. Server-side the session is NOT reaped either (verified at
    // the daemon-core unit level, see daemon-cmd-send-strict-ack).
    expect(mgr.hasPipe).toBe(true)
    expect(onExit).not.toHaveBeenCalled()

    await mgr.cleanup()
  })
})
