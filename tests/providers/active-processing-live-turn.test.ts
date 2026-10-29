/**
 * The activeProcessing safety timer waits on a turn that is still running.
 *
 * 2026-10-28: "activeProcessing safety timeout (60s): force-clearing stuck entry"
 * fired about 300 times a day, once for every turn longer than 60 s. Clearing a
 * live turn's entry sent its later messages down processNext instead of the
 * mid-turn path. The timer now re-arms while the session under that exact id runs a
 * turn that has not ended (inTurn); a session whose turn ended (its result
 * reached the session but not the runner), that left running, or that no longer
 * answers to the id (renamed) is cleared as before. The live half (a real session
 * reads inTurn for its whole turn) is in claude-code-session.test.ts.
 *
 * White-box on the runner's maps, as the batch-id regression tests in
 * claude-code-session.test.ts are: a real turn past 60 s would be a 60 s test.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import path from 'node:path'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-active-processing-live-turn'))

import { ACTIVE_PROCESSING_MAX_HOLD_MS, SessionRunner } from '../../src/providers/claude-code-session.js'
import { createMockDaemon, type MockDaemon } from '../helpers/mock-daemon.js'

const MOCK_CLI = path.resolve(import.meta.dirname, 'mock-claude.mjs')

interface RunnerInternals {
  setActiveProcessing(sessionId: string, batchCount: number, messageIds?: string[]): void
  activeProcessing: Set<string>
  activeProcessingTimers: Map<string, ReturnType<typeof setTimeout>>
  batchMessageIds: Map<string, string[]>
  sessions: Map<string, unknown>
}

let daemon: MockDaemon
beforeAll(async () => { daemon = await createMockDaemon() })
afterAll(async () => { await daemon?.stop() })

function setup(sid: string, fake?: { processStatus: string; turnEnded: boolean }) {
  const runner = new SessionRunner(MOCK_CLI)
  ;(runner as unknown as { _testDaemonUrl?: string })._testDaemonUrl = `ws://127.0.0.1:${daemon.port}`
  const internal = runner as unknown as RunnerInternals
  const session = fake
    ? { sessionId: sid, ...fake, kill: () => {}, get inTurn() { return this.processStatus === 'running' && !this.turnEnded } }
    : undefined
  if (session) internal.sessions.set(`task-${sid}`, session)
  return { runner, internal, session }
}

describe('activeProcessing safety timer and a turn still running', () => {
  it('waits on through many intervals while the turn runs, then clears once the turn ended', async () => {
    const sid = 'live-turn-long'
    const { runner, internal, session } = setup(sid, { processStatus: 'running', turnEnded: false })
    try {
      vi.useFakeTimers()
      internal.setActiveProcessing(sid, 1, ['qm-long'])
      const settled = runner.currentTurn(sid)!.then(() => 'resolved', () => 'rejected')

      // A 5-minute turn: the entry stays, so a message sent now takes the mid-turn path.
      await vi.advanceTimersByTimeAsync(5 * 60_000)
      expect(internal.activeProcessing.has(sid)).toBe(true)

      // The session saw its turn end, the runner never heard of it: that is stuck.
      session!.turnEnded = true
      await vi.advanceTimersByTimeAsync(60_000)
      expect(internal.activeProcessing.has(sid)).toBe(false)
      expect(internal.batchMessageIds.get(sid)).toEqual(['qm-long'])
      // The ledger's own 10-minute clock may already have rejected it; either way it is settled.
      expect(await settled).toBe('rejected')
    } finally {
      vi.useRealTimers()
      runner.destroyAndKill()
    }
  })

  it('clears at the next interval once the session is no longer running', async () => {
    const sid = 'live-turn-idle'
    const { runner, internal, session } = setup(sid, { processStatus: 'running', turnEnded: false })
    try {
      vi.useFakeTimers()
      internal.setActiveProcessing(sid, 1, ['qm-idle'])
      const settled = runner.currentTurn(sid)!.then(() => 'resolved', () => 'rejected')
      await vi.advanceTimersByTimeAsync(60_000)
      expect(internal.activeProcessing.has(sid)).toBe(true)
      session!.processStatus = 'idle'
      await vi.advanceTimersByTimeAsync(60_000)
      expect(internal.activeProcessing.has(sid)).toBe(false)
      expect(await settled).toBe('rejected')
    } finally {
      vi.useRealTimers()
      runner.destroyAndKill()
    }
  })

  it('a session that already left running is cleared at 60 s, as before', async () => {
    const sid = 'not-running'
    const { runner, internal } = setup(sid, { processStatus: 'error', turnEnded: true })
    try {
      vi.useFakeTimers()
      internal.setActiveProcessing(sid, 1)
      const settled = runner.currentTurn(sid)!.then(() => 'resolved', () => 'rejected')
      await vi.advanceTimersByTimeAsync(60_000)
      expect(internal.activeProcessing.has(sid)).toBe(false)
      expect(await settled).toBe('rejected')
    } finally {
      vi.useRealTimers()
      runner.destroyAndKill()
    }
  })

  it('an id no session answers to any more (renamed) is cleared at 60 s, as before', async () => {
    const sid = 'renamed-away'
    const { runner, internal } = setup(sid)
    try {
      vi.useFakeTimers()
      internal.setActiveProcessing(sid, 1)
      const settled = runner.currentTurn(sid)!.then(() => 'resolved', () => 'rejected')
      await vi.advanceTimersByTimeAsync(60_000)
      expect(internal.activeProcessing.has(sid)).toBe(false)
      expect(await settled).toBe('rejected')
    } finally {
      vi.useRealTimers()
      runner.destroyAndKill()
    }
  })

  it('a new batch replaces the timer: the old one never clears the new entry', async () => {
    const sid = 'rebatched'
    const { runner, internal, session } = setup(sid, { processStatus: 'running', turnEnded: false })
    try {
      vi.useFakeTimers()
      internal.setActiveProcessing(sid, 1, ['qm-a'])
      const first = runner.currentTurn(sid)!.then(() => 'resolved', () => 'rejected')
      await vi.advanceTimersByTimeAsync(90_000)
      // The first turn's entry is replaced by a second one (a new batch).
      internal.setActiveProcessing(sid, 1, ['qm-b'])
      const second = runner.currentTurn(sid)!.then(() => 'resolved', () => 'rejected')
      await vi.advanceTimersByTimeAsync(3 * 60_000)
      expect(internal.activeProcessing.has(sid)).toBe(true)
      expect(internal.batchMessageIds.get(sid)).toEqual(['qm-b'])
      // One chain: the first batch's timer was cancelled, not left re-arming beside it
      // (the other timer is the turn ledger's own clock for the open turn).
      expect(vi.getTimerCount()).toBe(2)
      expect(internal.activeProcessingTimers.size).toBe(1)
      session!.processStatus = 'idle'
      await vi.advanceTimersByTimeAsync(60_000)
      expect(internal.activeProcessing.has(sid)).toBe(false)
      await Promise.all([first, second])
    } finally {
      vi.useRealTimers()
      runner.destroyAndKill()
    }
  })

  it('a turn held past the cap is cleared as a stuck one', async () => {
    const sid = 'held-too-long'
    const { runner, internal } = setup(sid, { processStatus: 'running', turnEnded: false })
    try {
      vi.useFakeTimers()
      internal.setActiveProcessing(sid, 1, ['qm-cap'])
      const settled = runner.currentTurn(sid)!.then(() => 'resolved', () => 'rejected')
      await vi.advanceTimersByTimeAsync(ACTIVE_PROCESSING_MAX_HOLD_MS - 60_000)
      expect(internal.activeProcessing.has(sid)).toBe(true)
      await vi.advanceTimersByTimeAsync(2 * 60_000)
      expect(internal.activeProcessing.has(sid)).toBe(false)
      expect(internal.activeProcessingTimers.has(sid)).toBe(false)
      expect(await settled).toBe('rejected')
    } finally {
      vi.useRealTimers()
      runner.destroyAndKill()
    }
  })
})
