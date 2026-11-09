/**
 * A cold resume reads the restored cost state on the transcript's host before
 * it starts the CLI. That read scans the transcript, so the spawn waits for it
 * at most SPAWN_COST_STATE_WAIT_MS and goes on; a late answer still seeds the
 * baseline, but only while no result has seeded it (2026-11-08: a resume waited
 * 29 s before its CLI was spawned, the step unknown).
 *
 * MACHINE SAFETY: nothing is spawned. The transport is a recorder whose start
 * never resolves, the cwd check and the file reader are stubs, and the data
 * home is a temp dir (createMockConstants).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createMockConstants } from '../helpers/mock-constants.js'

const rec = vi.hoisted(() => ({
  starts: [] as Array<{ at: number; args: string[] }>,
  costCalls: [] as Array<{ sid: string; cwd?: string; timeoutMs?: number; at: number }>,
  costAnswer: null as Promise<{ totalCostUsd: number } | null> | null,
  logs: [] as unknown[][],
}))

vi.mock('../../src/constants.js', () => createMockConstants())
vi.mock('../../src/logging/index.js', async (orig) => {
  const real = await orig<Record<string, unknown>>()
  // Any depth (log.session.info) is the same recorder.
  const recorder: Record<string, unknown> = new Proxy(function recordLog() {}, {
    get: (_t, k) => (k === 'then' ? undefined : recorder),
    apply: (_t, _this, args: unknown[]) => { rec.logs.push(args) },
  }) as never
  return { ...real, log: recorder }
})
vi.mock('../../src/providers/session-manager.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  createSessionManager: () => ({
    isRemote: false, hasPipe: false, processName: 'claude', pid: null, outputFile: null, host: null,
    renameForSession: () => {},
    // Recorded, never resolved: nothing is spawned.
    start: (opts: { args: string[] }) => { rec.starts.push({ at: Date.now(), args: [...opts.args] }); return new Promise(() => {}) },
  }),
  registerSessionManager: () => {},
  unregisterSessionManager: () => {},
}))
vi.mock('../../src/providers/cwd-check.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  checkCwdExists: async () => ({ ok: true }),
}))
vi.mock('../../src/core/daemon-file-reader.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  DaemonFileReader: class {
    async probeSessionPath() { return '/projects/-tmp/session.jsonl' }
    readCostState(sid: string, cwd?: string, timeoutMs?: number) {
      rec.costCalls.push({ sid, cwd, timeoutMs, at: Date.now() })
      return rec.costAnswer ?? Promise.resolve(null)
    }
  },
}))

import { ClaudeCodeSession, SPAWN_COST_STATE_WAIT_MS } from '../../src/providers/claude-code-session.js'

const SID = 'aaaaaaaa-bbbb-4ccc-8ddd-000000000001'

type Internals = { _costBaselineKnown: boolean; billableCostDelta(total: number | undefined): number }

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => { resolve = r })
  return { promise, resolve }
}

/** A cold resume carrying a message, with a model named so the unnamed-model guard is not asked. */
function resume(): ClaudeCodeSession & Internals {
  const s = new ClaudeCodeSession('', 'proj') as ClaudeCodeSession & Internals
  s.send('hello', '/tmp', SID, undefined, 'claude-opus-4-8')
  return s
}

function preSpawnLog(): Record<string, unknown> | undefined {
  const row = rec.logs.find((args) => args[0] === 'spawn: pre-spawn steps')
  return row?.[1] as Record<string, unknown> | undefined
}

beforeEach(() => {
  rec.starts.length = 0
  rec.costCalls.length = 0
  rec.costAnswer = null
  rec.logs.length = 0
})
afterEach(() => { vi.restoreAllMocks() })

describe('the restored cost read on a cold resume', () => {
  it('seeds before the start when it answers in time, and logs every pre-spawn step', async () => {
    rec.costAnswer = Promise.resolve({ totalCostUsd: 5 })
    const s = resume()
    await vi.waitFor(() => expect(rec.starts).toHaveLength(1), { timeout: 5000 })
    expect(rec.costCalls).toHaveLength(1)
    expect(rec.costCalls[0]).toMatchObject({ sid: SID, cwd: '/tmp' })
    // A bounded read of its own; the spawn waits for it far less than that (SPAWN_COST_STATE_WAIT_MS).
    expect(rec.costCalls[0]!.timeoutMs).toBeGreaterThan(0)
    expect(rec.costCalls[0]!.timeoutMs).toBeLessThanOrEqual(30_000)
    expect(s._costBaselineKnown).toBe(true)
    expect(s.billableCostDelta(5.1)).toBeCloseTo(0.1, 6)
    const line = preSpawnLog()
    expect(line).toMatchObject({ sessionId: SID, costStateInTime: true })
    for (const key of ['fenceMs', 'taskDirMs', 'cwdCheckMs', 'probeMs', 'costStateMs', 'modelGuardMs', 'totalMs']) {
      expect(typeof line![key]).toBe('number')
    }
    expect(rec.logs.filter((args) => args[0] === 'spawn: pre-spawn steps')).toHaveLength(1)
  })

  it('a read slower than the bound does not hold the start, and seeds when it lands before any result', async () => {
    const answer = deferred<{ totalCostUsd: number } | null>()
    rec.costAnswer = answer.promise
    const sent = Date.now()
    const s = resume()
    await vi.waitFor(() => expect(rec.starts).toHaveLength(1), { timeout: SPAWN_COST_STATE_WAIT_MS + 3000 })
    // The read was started before the start and is still unanswered.
    expect(rec.costCalls[0]!.at).toBeLessThanOrEqual(rec.starts[0]!.at)
    expect(rec.starts[0]!.at - sent).toBeLessThan(SPAWN_COST_STATE_WAIT_MS + 2000)
    expect(s._costBaselineKnown).toBe(false)
    expect(preSpawnLog()).toMatchObject({ costStateInTime: false })

    answer.resolve({ totalCostUsd: 690 })
    await vi.waitFor(() => expect(s._costBaselineKnown).toBe(true), { timeout: 2000 })
    expect(s.billableCostDelta(690.25)).toBeCloseTo(0.25, 6)
  })

  it('a late answer after the first result never re-seeds, so nothing is counted twice', async () => {
    const answer = deferred<{ totalCostUsd: number } | null>()
    rec.costAnswer = answer.promise
    const s = resume()
    await vi.waitFor(() => expect(rec.starts).toHaveLength(1), { timeout: SPAWN_COST_STATE_WAIT_MS + 3000 })
    // The first result arrives first: it seeds the baseline and bills nothing.
    expect(s.billableCostDelta(690.02)).toBe(0)
    expect(s._costBaselineKnown).toBe(true)

    answer.resolve({ totalCostUsd: 690 })
    // The late seed runs in the read's own continuation: once its promise settled and the
    // microtasks after it drained, it has run if it ever will.
    await answer.promise
    await new Promise((r) => setImmediate(r))
    // Billed from the result's 690.02, not from the late 690.
    expect(s.billableCostDelta(690.5)).toBeCloseTo(0.48, 6)
  })
})
