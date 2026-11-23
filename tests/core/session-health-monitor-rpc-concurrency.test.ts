/**
 * Health monitor tick: the phases that make one daemon round trip per session run
 * those round trips a few at once, and no new phase may queue them one by one.
 *
 * 2026-11-23: "health monitor: check() slow" spiked to ~40 an hour. With ~85 live
 * sessions every tick hit the snapshot pull's caps (10 + 5 `getState` calls) and the
 * stuck-session reconcile's cap (5 stream-tail reads), all awaited one after another
 * at 0.3 to 0.5 s each: 4 to 5 s of waiting in line per tick, so machine load pushed
 * most ticks past the 5 s warn line. The caps stay; only the waiting overlaps.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-health-rpc-concurrency'))

let inFlight = 0
let maxInFlight = 0
const slowRoundTrip = async <T>(value: T, ms = 60): Promise<T> => {
  inFlight++
  maxInFlight = Math.max(maxInFlight, inFlight)
  await new Promise(r => setTimeout(r, ms))
  inFlight--
  return value
}

const send = vi.fn(async () => slowRoundTrip({ ok: true, exists: true }))
vi.mock('../../src/providers/daemon-connection.js', () => ({
  isDaemonConnected: () => false,
  getDaemonDisconnectedSince: () => null,
  probeDaemonSession: async () => null,
  getPooledSnapshotConnection: () => ({ send, hasCapability: () => true }),
}))
const reconcileProcessStatus = vi.fn(async () => slowRoundTrip({ converged: false, reason: 'turn-not-terminal' }))
vi.mock('../../src/core/session-reconcile.js', () => ({
  reconcileProcessStatus: (...args: unknown[]) => reconcileProcessStatus(...(args as [])),
}))
vi.mock('../../src/core/session-snapshot-apply.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../src/core/session-snapshot-apply.js')>(),
  applySnapshot: async () => ({ outcome: 'shadow' as const, diverged: false }),
}))
vi.mock('../../src/providers/session-manager.js', () => ({
  getRegisteredSessionManager: () => null,
}))
vi.mock('../../src/utils/session-liveness.js', () => ({
  isSessionProcessAlive: async () => true,
  isLocalJsonlFresh: () => 'unknown' as const,
}))
vi.mock('../../src/providers/claude-code-session.js', () => ({
  sessionRunner: { findSessionByClaudeId: () => undefined },
}))
vi.mock('../../src/core/task-manager.js', () => ({
  queryTasksSlim: async () => [],
  listTasksByIds: async () => [],
  getTask: async () => undefined,
}))

import { SessionHealthMonitor, DAEMON_RPC_CONCURRENCY } from '../../src/core/session-health-monitor.js'
import { setSnapshotModeForTests, _resetSnapshotGateForTests } from '../../src/core/session-snapshot-gate.js'
import type { TickContext } from '../../src/core/periodic-task.js'
import type { SessionRecord } from '../../src/core/types.js'

const OLD = new Date(Date.now() - 30 * 60_000).toISOString()
const running = (n: number): SessionRecord[] => Array.from({ length: n }, (_, i) => ({
  claudeSessionId: `s-${i}`, taskId: '', project: 'proj', process_status: 'running', mode: 'default',
  startedAt: OLD, lastActiveAt: OLD, last_status_change: OLD, messageCount: 0, host: 'devbox',
}) as SessionRecord)

type Steps = {
  checkSnapshotPull(s: SessionRecord[], c?: TickContext): Promise<void>
  reconcileStuckRunningSessions(s: SessionRecord[], t?: Map<string, never>, c?: TickContext): Promise<Set<string>>
}
const steps = (m: SessionHealthMonitor) => m as unknown as Steps

beforeEach(() => {
  inFlight = 0; maxInFlight = 0
  send.mockClear(); reconcileProcessStatus.mockClear()
  _resetSnapshotGateForTests()
  setSnapshotModeForTests('shadow')
})

describe('daemon round trips of one tick overlap, within their caps', () => {
  it('snapshot pull: all 10 capped pulls are sent, a few at a time', async () => {
    await steps(new SessionHealthMonitor()).checkSnapshotPull(running(10))
    expect(send).toHaveBeenCalledTimes(10)
    expect(maxInFlight).toBeGreaterThan(1)
    expect(maxInFlight).toBeLessThanOrEqual(DAEMON_RPC_CONCURRENCY)
  })

  it('snapshot pull: the per-tick cap still holds with more candidates than it', async () => {
    await steps(new SessionHealthMonitor()).checkSnapshotPull(running(25))
    expect(send).toHaveBeenCalledTimes(10)
  })

  it('snapshot pull: a tick already over budget sends nothing', async () => {
    await steps(new SessionHealthMonitor()).checkSnapshotPull(running(10), { overBudget: () => true, elapsedMs: () => 99_999 })
    expect(send).not.toHaveBeenCalled()
  })

  it('stuck reconcile: 5 tail reads per tick, a few at a time', async () => {
    await steps(new SessionHealthMonitor()).reconcileStuckRunningSessions(running(8), new Map())
    expect(reconcileProcessStatus).toHaveBeenCalledTimes(5)
    expect(maxInFlight).toBeGreaterThan(1)
    expect(maxInFlight).toBeLessThanOrEqual(DAEMON_RPC_CONCURRENCY)
  })

  it('stuck reconcile: the next tick inside the retry window reads the other three only', async () => {
    const monitor = new SessionHealthMonitor()
    await steps(monitor).reconcileStuckRunningSessions(running(8), new Map())
    reconcileProcessStatus.mockClear()
    await steps(monitor).reconcileStuckRunningSessions(running(8), new Map())
    expect(reconcileProcessStatus.mock.calls.map(c => (c[0] as unknown as SessionRecord).claudeSessionId))
      .toEqual(['s-5', 's-6', 's-7'])
  })

  it('stuck reconcile: a tick already over budget reads nothing', async () => {
    await steps(new SessionHealthMonitor()).reconcileStuckRunningSessions(running(8), new Map(), { overBudget: () => true, elapsedMs: () => 99_999 })
    expect(reconcileProcessStatus).not.toHaveBeenCalled()
  })
})

/**
 * The class guard: a `for ... of` loop in the health monitor that awaits a daemon
 * round trip per session costs the sum of every round trip in the tick. Each such
 * loop must be named here with why its calls are rare; a new one fails this test
 * (run them with mapLimit and DAEMON_RPC_CONCURRENCY instead).
 */
const SERIAL_RPC_LOOPS_ALLOWED: Record<string, string> = {
  enforceLiveLimit: 'probes at most the few sessions the live limit would stop this tick',
  checkHungSessions: 'probes only a running session already past the hung-warning threshold, after free in-memory gates',
  checkIdleTimeout: 'probes only a session already past its idle timeout',
  recoverInfraFailedSessions: 'probes only sessions in a connection-lost error',
}
const DAEMON_ROUND_TRIP = /await\s+(?:probeWithTimeout|probeDaemonSession|reconcileProcessStatus|fetchStreamTailFold|fetchDaemonSessionView|isSessionProcessAlive|conn\.send|stopThroughOwner)\s*\(/

describe('no tick phase queues one daemon round trip per session', () => {
  it('every for-of loop that awaits a daemon round trip is a named, gated exception', () => {
    const file = path.join(__dirname, '../../src/core/session-health-monitor.ts')
    const src = fs.readFileSync(file, 'utf8')
    const offenders: string[] = []
    // A loop header's parentheses are matched by depth, so `for (const c of order(xs))`
    // is seen; `for await` too. A body without braces is one statement up to `;`.
    for (const m of src.matchAll(/\bfor (?:await )?\(/g)) {
      let i = m.index! + m[0].length
      for (let depth = 1; depth > 0 && i < src.length; i++) depth += src[i] === '(' ? 1 : src[i] === ')' ? -1 : 0
      const header = src.slice(m.index! + m[0].length, i - 1)
      if (!/^\s*(?:const|let|var)\s[^]*?\s(?:of|in)\s/.test(header)) continue
      while (/\s/.test(src[i]!)) i++
      const start = i
      if (src[i] === '{') {
        i++
        for (let depth = 1; depth > 0 && i < src.length; i++) depth += src[i] === '{' ? 1 : src[i] === '}' ? -1 : 0
      } else {
        i = src.indexOf(';', i) + 1
      }
      const body = src.slice(start, i)
      if (!DAEMON_ROUND_TRIP.test(body)) continue
      const before = src.slice(0, m.index!)
      const owner = [...before.matchAll(/\n {2}(?:private |public )?(?:async )?(\w+)\s*(?:<[^>]*>)?\(/g)].pop()?.[1] ?? '?'
      if (!(owner in SERIAL_RPC_LOOPS_ALLOWED)) offenders.push(`${owner} (line ${before.split('\n').length})`)
    }
    expect(offenders).toEqual([])
  })

  it('the allowance names only methods that still exist', () => {
    const src = fs.readFileSync(path.join(__dirname, '../../src/core/session-health-monitor.ts'), 'utf8')
    for (const name of Object.keys(SERIAL_RPC_LOOPS_ALLOWED)) expect(src).toMatch(new RegExp(`private async ${name}\\(`))
  })
})
