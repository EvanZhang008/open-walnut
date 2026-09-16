/**
 * Pool-level connect-PHASE listeners (addOnDaemonPhaseChange).
 *
 * `addOnDaemonHostConnected` only fires on the happy edge, and system:health only
 * carries a boolean — neither can tell the browser that a two-minute first
 * connect is currently uploading the daemon, or that it just failed on an ssh
 * key. This pins the three edges the UI depends on: every phase step, the
 * failure (WITH the cached error and the retry clock), and a human retry that
 * clears that failure.
 *
 * No ssh is spawned: DaemonConnection.prototype.connect is the seam. The mocks
 * that fail do what the real connect()'s catch does — stamp 'failed' BEFORE
 * throwing — because the ordering of that stamp against the pool's cache write
 * is exactly what the failure edge is about.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-phase-notify'))

import {
  DaemonConnection,
  addOnDaemonPhaseChange,
  clearDaemonFailureCache,
  getDaemonConnection,
  getDaemonConnectState,
  type DaemonConnectState,
} from '../../src/providers/daemon-connection.js'

const sshTarget = { hostname: 'devbox.example.test', user: 'builder' }

afterEach(() => {
  vi.restoreAllMocks()
  clearDaemonFailureCache()
})

describe('addOnDaemonPhaseChange', () => {
  it('returns an unsubscribe that actually stops the callbacks', () => {
    const seen: DaemonConnectState[] = []
    const off = addOnDaemonPhaseChange((s) => { seen.push(s) })
    const conn = new DaemonConnection('phase-unsub', sshTarget)

    conn.setPhaseForTest('ssh')
    expect(seen.length).toBe(1)

    off()
    conn.setPhaseForTest('probe')
    expect(seen.length).toBe(1)
  })

  it('fires once per real transition, never for a repeat of the same phase', () => {
    const phases: string[] = []
    const off = addOnDaemonPhaseChange((s) => { phases.push(s.phase) })
    const conn = new DaemonConnection('phase-dedup', sshTarget)
    try {
      conn.setPhaseForTest('ssh')
      conn.setPhaseForTest('ssh')
      conn.setPhaseForTest('probe')
      expect(phases.length).toBe(2)
    } finally { off() }
  })

  it('reports each connect step of a POOLED host with the pool-truth state', async () => {
    const host = 'phase-steps'
    const seen: Array<{ phase: string; host: string }> = []
    const off = addOnDaemonPhaseChange((s) => { seen.push({ phase: s.phase, host: s.host }) })
    // The real connect() stamps these phases in this order; drive them without ssh.
    vi.spyOn(DaemonConnection.prototype, 'connect').mockImplementation(async function (this: DaemonConnection) {
      for (const p of ['ssh', 'probe', 'install-runtime', 'upload', 'start', 'tunnel', 'handshake'] as const) {
        this.setPhaseForTest(p)
      }
    })
    try {
      await getDaemonConnection(host, sshTarget)
      expect(seen.map((s) => s.phase)).toEqual(
        ['ssh', 'probe', 'install-runtime', 'upload', 'start', 'tunnel', 'handshake'],
      )
      expect(new Set(seen.map((s) => s.host))).toEqual(new Set([host]))
    } finally { off() }
  })

  it('a failed connect fires with phase failed, the cached error and a retry clock', async () => {
    const host = 'phase-failed'
    const seen: DaemonConnectState[] = []
    const off = addOnDaemonPhaseChange((s) => { seen.push(s) })
    vi.spyOn(DaemonConnection.prototype, 'connect').mockImplementation(async function (this: DaemonConnection) {
      this.setPhaseForTest('ssh')
      this.setPhaseForTest('failed')   // what the real catch does, before it throws
      throw new Error('Permission denied (publickey)')
    })
    try {
      await expect(getDaemonConnection(host, sshTarget)).rejects.toThrow(/Permission denied/)
      await new Promise((r) => setImmediate(r))   // let the deferred notify have its turn

      const failed = seen.filter((s) => s.phase === 'failed')
      // Exactly one: the connection's own 'failed' stamp happens before the pool
      // has cached the cause, and a listener that heard THAT one would pin
      // "Could not connect" with no error text (the picker keeps the first
      // failure it sees). It defers, and stays quiet once the pool has spoken.
      expect(failed.length).toBe(1)
      expect(failed[0].error).toContain('Permission denied (publickey)')
      expect(failed[0].retryInMs).toBeGreaterThan(0)
      expect(failed[0].connected).toBe(false)
    } finally { off() }
  })

  it('a failure nobody caches (the reconnect path) is still announced, one tick later', async () => {
    const host = 'phase-uncached-failure'
    vi.spyOn(DaemonConnection.prototype, 'connect').mockImplementation(async function (this: DaemonConnection) {
      this.setPhaseForTest('ssh')
    })
    const conn = await getDaemonConnection(host, sshTarget)   // pooled, so the state is host-truth
    const seen: DaemonConnectState[] = []
    const off = addOnDaemonPhaseChange((s) => { seen.push(s) })
    try {
      // The reconnect loop gives up: no pool catch, no cache write.
      conn.setPhaseForTest('reconnecting')
      conn.setPhaseForTest('failed')
      expect(seen.map((s) => s.phase)).toEqual(['reconnecting'])   // not yet
      await new Promise((r) => setImmediate(r))
      expect(seen.map((s) => s.phase)).toEqual(['reconnecting', 'failed'])
    } finally { off() }
  })

  it('keeps the cause after the throttle expires, without a retry clock', async () => {
    const host = 'phase-stale-cause'
    vi.spyOn(DaemonConnection.prototype, 'connect').mockImplementation(async function (this: DaemonConnection) {
      this.setPhaseForTest('failed')
      throw new Error('ssh: connect to host devbox.example.test port 22: Operation timed out')
    })
    await expect(getDaemonConnection(host, sshTarget)).rejects.toThrow(/timed out/)
    const fresh = getDaemonConnectState(host)
    expect(fresh.retryInMs).toBeGreaterThan(0)

    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      vi.setSystemTime(Date.now() + 61_000)
      const stale = getDaemonConnectState(host)
      // The throttle is over (a retry is allowed now), but nothing has tried
      // since, so the failure is still the truth about this host.
      expect(stale.phase).toBe('failed')
      expect(stale.error).toContain('Operation timed out')
      expect(stale.retryInMs).toBeUndefined()
    } finally { vi.useRealTimers() }
  })

  it('replaces a pooled connection whose ssh target changed, when nothing is live', async () => {
    const host = 'phase-target-changed'
    const targetsSeen: Array<boolean> = []
    vi.spyOn(DaemonConnection.prototype, 'connect').mockImplementation(async function (this: DaemonConnection) {
      targetsSeen.push(this.targetsSame({ hostname: 'dev-b' }))
      this.setPhaseForTest('failed')
      throw new Error('ssh: Could not resolve hostname dev-b')
    })
    const disconnect = vi.spyOn(DaemonConnection.prototype, 'disconnect')
    // The warmup dialled a half-typed hostname and failed.
    await expect(getDaemonConnection(host, { hostname: 'dev-b' })).rejects.toThrow(/dev-b/)
    clearDaemonFailureCache(host)
    // The user finished typing; the alias now names another machine.
    await expect(getDaemonConnection(host, { hostname: 'devbox.example.test' })).rejects.toThrow()
    expect(targetsSeen).toEqual([true, false])   // second connect ran on a NEW instance
    expect(disconnect).toHaveBeenCalledTimes(1)  // the stale one was torn down, not leaked
  })

  it('clearDaemonFailureCache(host) fires again with the connection back at idle', async () => {
    const host = 'phase-cleared'
    vi.spyOn(DaemonConnection.prototype, 'connect').mockImplementation(async function (this: DaemonConnection) {
      this.setPhaseForTest('ssh')
      this.setPhaseForTest('failed')
      throw new Error('no route to host')
    })
    await expect(getDaemonConnection(host, sshTarget)).rejects.toThrow(/no route/)
    expect(getDaemonConnectState(host).phase).toBe('failed')

    const seen: DaemonConnectState[] = []
    const off = addOnDaemonPhaseChange((s) => { seen.push(s) })
    try {
      clearDaemonFailureCache(host)
      expect(seen.length).toBe(1)
      expect(seen[0].host).toBe(host)
      // Not merely "cache gone": the connection's own terminal phase is reset
      // too, or the push would read "failed" with no cause and no retry clock.
      expect(seen[0].phase).toBe('idle')
      expect(seen[0].error).toBeUndefined()
      expect(seen[0].retryInMs).toBeUndefined()
      expect(getDaemonConnectState(host).phase).toBe('idle')
    } finally { off() }
  })

  it('a listener that throws never breaks the connect path', async () => {
    const host = 'phase-throwing-listener'
    const offBad = addOnDaemonPhaseChange(() => { throw new Error('observer bug') })
    const good: string[] = []
    const offGood = addOnDaemonPhaseChange((s) => { good.push(s.phase) })
    vi.spyOn(DaemonConnection.prototype, 'connect').mockImplementation(async function (this: DaemonConnection) {
      this.setPhaseForTest('ssh')
    })
    try {
      await expect(getDaemonConnection(host, sshTarget)).resolves.toBeDefined()
      expect(good).toContain('ssh')
    } finally { offBad(); offGood() }
  })
})

describe('DaemonConnectState.connectElapsedMs', () => {
  it('is 0 for a host that has never been dialled', () => {
    expect(getDaemonConnectState('never-dialled-host').connectElapsedMs).toBe(0)
  })

  it('runs from the start of the attempt, not the start of the current step', async () => {
    const host = 'phase-elapsed'
    vi.spyOn(DaemonConnection.prototype, 'connect').mockImplementation(async function (this: DaemonConnection) {
      // Simulate a connect that has already burned time on earlier steps.
      ;(this as unknown as { _connectStartedAt: number })._connectStartedAt = Date.now() - 90_000
      this.setPhaseForTest('upload')
    })
    await getDaemonConnection(host, sshTarget)
    const state = getDaemonConnectState(host)
    expect(state.connectElapsedMs).toBeGreaterThanOrEqual(90_000)
    expect(state.phaseElapsedMs).toBeLessThan(5_000)
  })
})
