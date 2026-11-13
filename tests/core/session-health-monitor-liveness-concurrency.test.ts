/**
 * Health monitor tick: liveness probes run a few at once, and a tick that only
 * WAITED on them does not warn.
 *
 * 2026-11-13: "health monitor: check() slow" warned on nearly every tick (about
 * 2,000 lines a day). The liveness loop probed ~125 sessions one after another
 * (0.5 to 1.8 s), and the warning fired past a fixed 500 ms of wall time, while the
 * tick's CPU was about a tenth of that: the loop was free, the tick was waiting.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fsp from 'node:fs/promises'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-health-liveness-concurrency'))

let probeMs = 40
let inFlight = 0
let maxInFlight = 0
let probed: string[] = []

vi.mock('../../src/utils/process.js', () => ({
  isProcessAlive: () => false,
  isProcessAliveAsync: async () => false,
}))
vi.mock('../../src/utils/session-liveness.js', () => ({
  isSessionProcessAlive: async (s: { claudeSessionId: string }) => {
    probed.push(s.claudeSessionId)
    inFlight++
    maxInFlight = Math.max(maxInFlight, inFlight)
    await new Promise(r => setTimeout(r, probeMs))
    inFlight--
    return true
  },
  isLocalJsonlFresh: () => 'unknown' as const,
}))
vi.mock('../../src/providers/daemon-connection.js', () => ({
  isDaemonConnected: () => false,
  getDaemonDisconnectedSince: () => null,
  probeDaemonSession: async () => null,
  getPooledSnapshotConnection: () => null,
}))
vi.mock('../../src/providers/session-manager.js', () => ({
  getRegisteredSessionManager: () => null,
}))
vi.mock('../../src/core/config-manager.js', () => ({
  getConfig: async () => ({ session: { idle_timeout_minutes: 60, local_idle_exit_minutes: 0, local_live_limit: 0 } }),
  updateConfig: async () => undefined,
  seedConfigDefaults: async () => undefined,
}))
vi.mock('../../src/core/session-snapshot-gate.js', () => ({
  getSnapshotStatusMode: () => 'off',
}))
vi.mock('../../src/core/phase.js', () => ({
  applySessionPhase: vi.fn(async () => undefined),
  TERMINAL_PHASES: new Set(['COMPLETE', 'CANCELLED']),
}))
vi.mock('../../src/providers/claude-code-session.js', () => ({
  sessionRunner: {
    isTeamActive: () => false,
    isCronArmed: () => false,
    isBackgroundWorkActive: () => Promise.resolve(false),
    hasPendingPermission: () => false,
    getSessionTimestamps: () => undefined,
    markExpectedTeardown: vi.fn(),
    reconcilePendingBackgroundTasks: async () => undefined,
    findSessionByClaudeId: () => undefined,
  },
}))

import { createSessionRecord, updateSessionRecord } from '../../src/core/session-tracker.js'
import {
  SessionHealthMonitor, LIVENESS_PROBE_CONCURRENCY, SLOW_TICK_WARN_MS, prefetchLiveness,
} from '../../src/core/session-health-monitor.js'
import { log } from '../../src/logging/index.js'
import { WALNUT_HOME } from '../../src/constants.js'
import type { SessionRecord } from '../../src/core/types.js'

const N = 24
let seeded: string[] = []

beforeEach(async () => {
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true })
  await fsp.mkdir(WALNUT_HOME, { recursive: true })
  inFlight = 0; maxInFlight = 0; probed = []; seeded = []; probeMs = 40
  for (let i = 0; i < N; i++) {
    const sid = `live-${i}`
    seeded.push(sid)
    await createSessionRecord(sid, '', 'proj', undefined, { pid: 999999990 + i })
    await updateSessionRecord(sid, { process_status: 'idle', last_status_change: new Date().toISOString() })
  }
})

afterEach(async () => {
  vi.restoreAllMocks()
  for (const sid of seeded) {
    try { await updateSessionRecord(sid, { archived: true, process_status: 'error', pid: undefined }) } catch { /* torn down */ }
  }
  for (let i = 0; i < 3; i++) {
    try { await fsp.rm(WALNUT_HOME, { recursive: true, force: true }); break }
    catch { await new Promise(r => setTimeout(r, 50)) }
  }
})

describe('liveness loop probes concurrently', () => {
  it('probes every session once, at most LIVENESS_PROBE_CONCURRENCY at a time', async () => {
    await new SessionHealthMonitor().check()

    expect([...new Set(probed)].sort()).toEqual([...seeded].sort())
    expect(probed.length).toBe(N) // the cycle memo: one probe per session
    // Overlap is what makes the loop cheap; the cap is what keeps a host unflooded.
    expect(maxInFlight).toBeGreaterThan(1)
    expect(maxInFlight).toBeLessThanOrEqual(LIVENESS_PROBE_CONCURRENCY)
  })

  it('a tick past 500 ms that only waited on probes logs at debug, not warn', async () => {
    // N / 8 waves × 250 ms ≈ 750 ms: past the old fixed 500 ms, far under the new threshold.
    probeMs = 250
    const warn = vi.spyOn(log.session, 'warn')
    const debug = vi.spyOn(log.session, 'debug')
    await new SessionHealthMonitor().check()
    const isSlowLine = (c: unknown[]) => String(c[0]) === 'health monitor: check() slow'
    expect(warn.mock.calls.filter(isSlowLine)).toEqual([])
    expect(debug.mock.calls.filter(isSlowLine)).toHaveLength(1)
  })
})

describe('prefetchLiveness', () => {
  const recs = (n: number) => Array.from({ length: n }, (_, i) => ({ claudeSessionId: `s${i}` }) as SessionRecord)

  it('starts no probe once the tick is over budget', async () => {
    const isAlive = vi.fn(async () => true)
    await prefetchLiveness(recs(5), isAlive, { overBudget: () => true, elapsedMs: () => 99_999 })
    expect(isAlive).not.toHaveBeenCalled()
  })

  it('a throwing probe neither stops the others nor escapes', async () => {
    const isAlive = vi.fn(async (s: SessionRecord) => {
      if (s.claudeSessionId === 's1') throw new Error('daemon gone')
      return true
    })
    await expect(prefetchLiveness(recs(4), isAlive)).resolves.toBeUndefined()
    expect(isAlive).toHaveBeenCalledTimes(4)
  })

  it('the warn threshold is a share of the tick budget, not a fixed 500 ms', () => {
    expect(SLOW_TICK_WARN_MS).toBeGreaterThanOrEqual(5_000)
  })
})
