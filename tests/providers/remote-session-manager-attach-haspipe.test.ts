/**
 * REGRESSION: attach() must seed _hasPipe from the daemon's authoritative
 * `alive` — NOT leave it false (inc-1783357192826).
 *
 * Only start() ever set _hasPipe=true. A walnut restart under a live CLI (the
 * normal dev:prod redeploy path) goes through attach(), which historically
 * left hasPipe=false forever. Downstream, the turn-end result handler in
 * claude-code-session.ts keys "FIFO stays alive between turns" off hasPipe:
 * false misclassified every healthy idle session as EXITING → status
 * 'stopped' → the server wiped the stream buffer at every turn end → the
 * "reply visible while streaming, gone when done" incident.
 *
 * Same class as Bug D (injectMidTurn stale hasPipe): hasPipe must track
 * daemon-authoritative liveness, never spawn-vs-attach.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { RemoteSessionManager } from '../../src/providers/remote-session-manager.js'
import { createMockDaemon, type MockDaemon } from '../helpers/mock-daemon.js'

const TEST_TARGET = { hostname: '127.0.0.1', user: undefined, port: undefined }

describe('RemoteSessionManager.attach() hasPipe seeding', () => {
  let daemon: MockDaemon
  const managers: RemoteSessionManager[] = []

  const makeManager = (sid: string) => {
    const mgr = new RemoteSessionManager(sid, 'testhost', TEST_TARGET, `ws://127.0.0.1:${daemon.port}`)
    managers.push(mgr)
    return mgr
  }

  beforeEach(async () => {
    daemon = await createMockDaemon()
  })

  afterEach(async () => {
    for (const mgr of managers.splice(0)) {
      try { await mgr.cleanup() } catch { /* best effort */ }
    }
    await daemon.stop()
  })

  it('attach to a LIVE session sets hasPipe=true (walnut restart under live CLI)', async () => {
    // Daemon already holds a live session (CLI survived the walnut restart).
    daemon.seedSession('sid-live', { pid: 4242, alive: true })

    const mgr = makeManager('sid-live')
    expect(mgr.hasPipe).toBe(false) // fresh RSM, nothing known yet

    const result = await mgr.attach({
      sessionId: 'sid-live',
      onOutput: vi.fn(),
      onExit: vi.fn(),
    })

    expect(result.alive).toBe(true)
    // THE regression: this stayed false, so every turn end downstream was
    // classified 'stopped' and the stream buffer was wiped instantly.
    expect(mgr.hasPipe).toBe(true)
  })

  it('attach to a DEAD session keeps hasPipe=false', async () => {
    daemon.seedSession('sid-dead', { pid: 4243, alive: false })

    const mgr = makeManager('sid-dead')
    const result = await mgr.attach({
      sessionId: 'sid-dead',
      onOutput: vi.fn(),
      onExit: vi.fn(),
    })

    expect(result.alive).toBe(false)
    expect(mgr.hasPipe).toBe(false)
  })

  it('attach-then-death still flips hasPipe false and fires onExit once (parity with start())', async () => {
    daemon.seedSession('sid-adopted', { pid: 4244, alive: true })

    const mgr = makeManager('sid-adopted')
    const onExit = vi.fn()
    await mgr.attach({
      sessionId: 'sid-adopted',
      onOutput: vi.fn(),
      onExit,
    })
    expect(mgr.hasPipe).toBe(true)

    daemon.emitSessionState('sid-adopted', 'dead', { exitCode: 3 })
    await new Promise((r) => setTimeout(r, 30))

    expect(onExit).toHaveBeenCalledTimes(1)
    expect(onExit).toHaveBeenCalledWith(3)
    expect(mgr.hasPipe).toBe(false)
  })
})
