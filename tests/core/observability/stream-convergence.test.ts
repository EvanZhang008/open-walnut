/**
 * Convergence sentinel — the pure diff at its core (P3-lite).
 *
 * Invariant: every streamed text msgId must appear in persisted history after
 * the turn ends. Direction is one-way (streamed ⊆ persisted); persisted ids
 * that never streamed are normal (replays, subagents, mid-turn reconnects).
 *
 * The windowed cases pin the 2026-09-30 false alarm: a transcript over the
 * reader's byte ceiling is parsed as its last 4 MiB, and a turn longer than
 * that had its earliest ids reported "missing" although they sat in the file a
 * few MB before the window (6/59 on a 42 MB remote session, 13/19 on a 155 MB
 * local one). Inside a suffix window presence is monotonic in stream order, so
 * ids ahead of the first hit are unverifiable, ids from it onward are checked.
 */
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  getSessionByClaudeId: vi.fn(),
  readSessionHistory: vi.fn(),
  windowedArrays: new WeakSet<object>(),
  createIncident: vi.fn(),
  obsError: vi.fn(),
  obsWarn: vi.fn(),
  obsInfo: vi.fn(),
  obsDebug: vi.fn(),
}))

vi.mock('../../../src/core/session-tracker.js', () => ({
  getSessionByClaudeId: mocks.getSessionByClaudeId,
}))
vi.mock('../../../src/core/session-history.js', () => ({
  readSessionHistory: mocks.readSessionHistory,
  isWindowedHistory: (arr: object) => mocks.windowedArrays.has(arr),
}))
vi.mock('../../../src/core/observability/incidents.js', () => ({
  createIncident: mocks.createIncident,
}))
vi.mock('../../../src/logging/index.js', () => ({
  log: {
    obs: {
      error: mocks.obsError,
      debug: mocks.obsDebug,
      warn: mocks.obsWarn,
      info: mocks.obsInfo,
    },
  },
}))

import {
  armStreamConvergenceCheck, diffStreamedVsPersisted,
} from '../../../src/core/observability/stream-convergence.js'

describe('diffStreamedVsPersisted (full parse)', () => {
  it('converged: every streamed id persisted', () => {
    const d = diffStreamedVsPersisted(['msg_a', 'msg_b'], new Set(['msg_a', 'msg_b', 'msg_older']))
    expect(d.missing).toEqual([])
    expect(d.checked).toBe(2)
    expect(d.unverifiable).toBe(0)
  })

  it('flags streamed ids missing from history (the vanish class)', () => {
    const d = diffStreamedVsPersisted(['msg_a', 'msg_b'], new Set(['msg_a']))
    expect(d.missing).toEqual(['msg_b'])
    expect(d.checked).toBe(2)
  })

  it('extra persisted ids are NOT a violation (one-way check)', () => {
    const d = diffStreamedVsPersisted(['msg_a'], new Set(['msg_a', 'msg_x', 'msg_y']))
    expect(d.missing).toEqual([])
  })

  it('dedupes streamed ids: one message streamed as many blocks counts once', () => {
    // Text split across tool calls streams as several blocks of one msgId.
    const d = diffStreamedVsPersisted(['msg_a', 'msg_a', 'msg_a'], new Set<string>())
    expect(d.missing).toEqual(['msg_a'])
    expect(d.checked).toBe(1)
  })

  it('empty streamed set is vacuously converged', () => {
    const d = diffStreamedVsPersisted([], new Set(['msg_a']))
    expect(d.missing).toEqual([])
    expect(d.checked).toBe(0)
    expect(d.unverifiable).toBe(0)
  })

  it('order/position is irrelevant — only id presence matters (/compact-proof)', () => {
    // A compact may reorder and renumber history arbitrarily; ids survive.
    const d = diffStreamedVsPersisted(['msg_b', 'msg_a'], new Set(['msg_a', 'msg_b']))
    expect(d.missing).toEqual([])
  })

  it('a full parse never declares anything unverifiable: an early miss IS missing', () => {
    const d = diffStreamedVsPersisted(['msg_a', 'msg_b', 'msg_c'], new Set(['msg_c']))
    expect(d.missing).toEqual(['msg_a', 'msg_b'])
    expect(d.checked).toBe(3)
    expect(d.unverifiable).toBe(0)
  })
})

describe('diffStreamedVsPersisted (windowed parse)', () => {
  const W = { windowed: true }

  it('a turn longer than the window: ids before the first hit are unverifiable, not missing', () => {
    // The reported shape: 59 streamed, the window starts mid-turn, 6 early ids
    // sit a few MB before it. Nothing is lost.
    const streamed = ['m1', 'm2', 'm3', 'm4', 'm5', 'm6', 'm7', 'm8', 'm9']
    const window = new Set(['m4', 'm5', 'm6', 'm7', 'm8', 'm9', 'older_a', 'older_b'])
    const d = diffStreamedVsPersisted(streamed, window, W)
    expect(d.missing).toEqual([])
    expect(d.unverifiable).toBe(3)
    expect(d.checked).toBe(6)
  })

  it('a real loss AFTER the first hit is still flagged inside the window', () => {
    const d = diffStreamedVsPersisted(['m1', 'm2', 'm3', 'm4', 'm5'], new Set(['m3', 'm5']), W)
    expect(d.missing).toEqual(['m4'])
    expect(d.unverifiable).toBe(2)
    expect(d.checked).toBe(3)
  })

  it('a window holding NONE of the turn is a full loss, not "all unverifiable"', () => {
    // The turn's tail is the newest part of the file; a 4 MiB tail that holds
    // 200 recent messages and none of this turn's is the P0 class.
    const d = diffStreamedVsPersisted(['m1', 'm2', 'm3'], new Set(['older_a', 'older_b']), W)
    expect(d.missing).toEqual(['m1', 'm2', 'm3'])
    expect(d.checked).toBe(3)
    expect(d.unverifiable).toBe(0)
  })

  it('a window holding the whole turn behaves like a full parse', () => {
    const d = diffStreamedVsPersisted(['m1', 'm2', 'm3'], new Set(['m1', 'm2', 'm3', 'older']), W)
    expect(d.missing).toEqual([])
    expect(d.checked).toBe(3)
    expect(d.unverifiable).toBe(0)
  })

  it('dedupes in stream order before anchoring (one message = many blocks)', () => {
    const d = diffStreamedVsPersisted(['m1', 'm1', 'm2', 'm2', 'm3'], new Set(['m2', 'm3']), W)
    expect(d.unverifiable).toBe(1)
    expect(d.checked).toBe(2)
    expect(d.missing).toEqual([])
  })

  it('the first streamed id present anchors even when later ones repeat earlier text', () => {
    // Only PRESENCE positions the anchor; a later miss after it stays a miss.
    const d = diffStreamedVsPersisted(['m1', 'm2', 'm3', 'm4'], new Set(['m2', 'm4']), W)
    expect(d.unverifiable).toBe(1)
    expect(d.missing).toEqual(['m3'])
  })
})

describe('armStreamConvergenceCheck', () => {
  it('arms one delayed check per finished turn (the warm-up exemption is gone with the warm-up)', () => {
    vi.useFakeTimers()
    try {
      armStreamConvergenceCheck('thread-b', ['msg_x'])
      expect(vi.getTimerCount()).toBe(1)
    } finally {
      vi.clearAllTimers()
      vi.useRealTimers()
    }
  })
})

describe('runCheck honours a windowed history parse', () => {
  const record = { cwd: '/tmp/proj', host: 'remote-a', taskId: 't1' }

  beforeEach(() => {
    vi.useFakeTimers()
    mocks.getSessionByClaudeId.mockReset().mockResolvedValue(record)
    mocks.readSessionHistory.mockReset()
    mocks.createIncident.mockReset().mockResolvedValue(undefined)
    mocks.obsError.mockReset()
    mocks.obsWarn.mockReset()
    mocks.obsInfo.mockReset()
    mocks.obsDebug.mockReset()
  })
  afterEach(() => {
    vi.clearAllTimers()
    vi.useRealTimers()
  })

  async function runArmed(sid: string, streamed: string[]): Promise<void> {
    armStreamConvergenceCheck(sid, streamed)
    await vi.advanceTimersByTimeAsync(15_000)
    // Dynamic imports + awaited reads inside runCheck settle over a few ticks.
    for (let i = 0; i < 10; i++) await vi.advanceTimersByTimeAsync(0)
  }

  it('a windowed parse that starts mid-turn raises NO violation (the 2026-09-30 false alarm)', async () => {
    const messages = ['m4', 'm5', 'm6'].map((msgId) => ({ role: 'assistant', text: 'x', timestamp: 't', msgId }))
    mocks.windowedArrays.add(messages)
    mocks.readSessionHistory.mockResolvedValue(messages)

    await runArmed('sid-window-ok', ['m1', 'm2', 'm3', 'm4', 'm5', 'm6'])

    expect(mocks.obsError).not.toHaveBeenCalled()
    expect(mocks.createIncident).not.toHaveBeenCalled()
    expect(mocks.obsDebug).toHaveBeenCalledWith('stream-convergence: converged', expect.objectContaining({
      sessionId: 'sid-window-ok', windowed: true, unverifiable: 3, checked: 3,
    }))
  })

  it('the same parse NOT marked windowed is a full parse: the early ids ARE missing (partial = warn + case file, no card)', async () => {
    const messages = ['m4', 'm5', 'm6'].map((msgId) => ({ role: 'assistant', text: 'x', timestamp: 't', msgId }))
    mocks.readSessionHistory.mockResolvedValue(messages)

    await runArmed('sid-full-miss', ['m1', 'm2', 'm3', 'm4', 'm5', 'm6'])

    expect(mocks.obsError).not.toHaveBeenCalled()
    expect(mocks.obsWarn).toHaveBeenCalledTimes(1)
    expect(mocks.obsWarn.mock.calls[0][0]).toMatch(/partial, case file only/)
    expect(mocks.obsWarn.mock.calls[0][1]).toMatchObject({
      sessionId: 'sid-full-miss', missing: ['m1', 'm2', 'm3'], checked: 6, unverifiable: 0, windowed: false,
      host: 'remote-a',
    })
    expect(mocks.createIncident).toHaveBeenCalledTimes(1)
    expect(mocks.createIncident.mock.calls[0][0]).toMatchObject({ severity: 'warn', label: 'stream-convergence' })
  })

  it('a windowed parse with a loss AFTER the anchor still opens a case file (warn, no card)', async () => {
    const messages = ['m3', 'm5'].map((msgId) => ({ role: 'assistant', text: 'x', timestamp: 't', msgId }))
    mocks.windowedArrays.add(messages)
    mocks.readSessionHistory.mockResolvedValue(messages)

    await runArmed('sid-window-loss', ['m1', 'm2', 'm3', 'm4', 'm5'])

    expect(mocks.obsError).not.toHaveBeenCalled()
    expect(mocks.obsWarn).toHaveBeenCalledTimes(1)
    expect(mocks.obsWarn.mock.calls[0][1]).toMatchObject({
      missing: ['m4'], checked: 3, unverifiable: 2, windowed: true,
    })
    expect(mocks.createIncident).toHaveBeenCalledTimes(1)
    expect(mocks.createIncident.mock.calls[0][0]).toMatchObject({ severity: 'warn' })
  })

  describe('a WHOLE turn missing is the only thing that can reach the user, and only after a second read', () => {
    const none = [{ role: 'assistant', text: 'x', timestamp: 't', msgId: 'older' }]

    it('first look: warn + re-arm, no card, no case file yet', async () => {
      mocks.readSessionHistory.mockResolvedValue(none)

      await runArmed('sid-full-loss', ['m1', 'm2'])

      expect(mocks.obsError).not.toHaveBeenCalled()
      expect(mocks.createIncident).not.toHaveBeenCalled()
      expect(mocks.obsWarn).toHaveBeenCalledTimes(1)
      expect(mocks.obsWarn.mock.calls[0][0]).toMatch(/re-reading before alarming/)
      expect(vi.getTimerCount()).toBe(1) // the confirming read
    })

    it('still missing a minute later: the error card and an error-severity case file', async () => {
      mocks.readSessionHistory.mockResolvedValue(none)

      await runArmed('sid-full-loss-confirmed', ['m1', 'm2'])
      await vi.advanceTimersByTimeAsync(60_000)
      for (let i = 0; i < 10; i++) await vi.advanceTimersByTimeAsync(0)

      expect(mocks.readSessionHistory).toHaveBeenCalledTimes(2)
      expect(mocks.obsError).toHaveBeenCalledTimes(1)
      expect(mocks.obsError.mock.calls[0][1]).toMatchObject({
        sessionId: 'sid-full-loss-confirmed', missing: ['m1', 'm2'], checked: 2,
      })
      expect(mocks.createIncident).toHaveBeenCalledTimes(1)
      expect(mocks.createIncident.mock.calls[0][0]).toMatchObject({ severity: 'error', label: 'stream-convergence' })
    })

    it('present a minute later (a late write): info line, no card, no case file', async () => {
      mocks.readSessionHistory
        .mockResolvedValueOnce(none)
        .mockResolvedValueOnce(['m1', 'm2'].map((msgId) => ({ role: 'assistant', text: 'x', timestamp: 't', msgId })))

      await runArmed('sid-late-write', ['m1', 'm2'])
      await vi.advanceTimersByTimeAsync(60_000)
      for (let i = 0; i < 10; i++) await vi.advanceTimersByTimeAsync(0)

      expect(mocks.obsError).not.toHaveBeenCalled()
      expect(mocks.createIncident).not.toHaveBeenCalled()
      expect(mocks.obsInfo).toHaveBeenCalledTimes(1)
      expect(mocks.obsInfo.mock.calls[0][0]).toMatch(/second read/)
      expect(vi.getTimerCount()).toBe(0)
    })

    it('a windowed parse holding NONE of the turn takes the same confirmed path', async () => {
      mocks.windowedArrays.add(none)
      mocks.readSessionHistory.mockResolvedValue(none)

      await runArmed('sid-window-none', ['m1', 'm2', 'm3'])
      expect(mocks.obsError).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(60_000)
      for (let i = 0; i < 10; i++) await vi.advanceTimersByTimeAsync(0)

      expect(mocks.obsError).toHaveBeenCalledTimes(1)
      expect(mocks.obsError.mock.calls[0][1]).toMatchObject({ missing: ['m1', 'm2', 'm3'], checked: 3, windowed: true })
    })
  })
})
