/**
 * Unit tests for the auto-continue scheduler (b12 retry hardening).
 *
 * Fully offline: the scheduler's clock, timers, send, session lookup and note
 * emission are all injected, so we drive the state machine deterministically
 * without a server, a CLI, or real timers.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants())

import {
  SessionAutoContinue,
  matchesRetryExhaustion,
  resolveAutoContinueConfig,
  AUTO_CONTINUE_SOURCE,
  type AutoContinueConfig,
  type AutoContinueDeps,
} from '../../src/core/session-auto-continue.js'
import { bus, EventNames } from '../../src/core/event-bus.js'
import type { BusEvent } from '../../src/core/event-bus.js'
import type { SessionRecord } from '../../src/core/types.js'

// ── Fake environment ──

class FakeClock {
  t = 1_000_000
  now = () => this.t
  advance(ms: number) { this.t += ms }
}

interface FakeTimer { id: number; fn: () => void; fireAt: number }

/** A controllable timer queue keyed to the FakeClock. */
class FakeTimers {
  private seq = 0
  timers = new Map<number, FakeTimer>()
  constructor(private clock: FakeClock) {}
  set = (fn: () => void, ms: number): ReturnType<typeof setTimeout> => {
    const id = ++this.seq
    this.timers.set(id, { id, fn, fireAt: this.clock.now() + ms })
    return id as unknown as ReturnType<typeof setTimeout>
  }
  clear = (handle: ReturnType<typeof setTimeout>): void => {
    this.timers.delete(handle as unknown as number)
  }
  /** Fire every timer whose fireAt <= current clock, in order. */
  runDue(): void {
    const due = [...this.timers.values()].filter((t) => t.fireAt <= this.clock.now()).sort((a, b) => a.fireAt - b.fireAt)
    for (const t of due) { this.timers.delete(t.id); t.fn() }
  }
}

function makeSession(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return { claudeSessionId: 'sess-1', taskId: 'task-1', archived: false, ...(overrides as object) } as SessionRecord
}

interface Harness {
  sac: SessionAutoContinue
  clock: FakeClock
  timers: FakeTimers
  sends: Array<{ sessionId: string; message: string; opts: { source: string; taskId?: string } }>
  notes: Array<{ sessionId: string; message: string }>
  sessionRecord: SessionRecord | null
}

function makeHarness(cfgOverrides: Partial<AutoContinueConfig> = {}, depOverrides: Partial<AutoContinueDeps> = {}): Harness {
  const clock = new FakeClock()
  const timers = new FakeTimers(clock)
  const sends: Harness['sends'] = []
  const notes: Harness['notes'] = []
  const h: Harness = { sac: null as unknown as SessionAutoContinue, clock, timers, sends, notes, sessionRecord: makeSession() }
  const cfg: AutoContinueConfig = { enabled: true, delayMs: 180_000, maxPerHour: 2, windowMs: 3_600_000, ...cfgOverrides }
  const deps: Partial<AutoContinueDeps> = {
    now: clock.now,
    setTimer: timers.set,
    clearTimer: timers.clear,
    send: async (sessionId, message, opts) => { sends.push({ sessionId, message, opts }); return { id: 'qm-x' } },
    getSession: async () => h.sessionRecord,
    emitNote: (sessionId, _taskId, message) => { notes.push({ sessionId, message }) },
    ...depOverrides,
  }
  h.sac = new SessionAutoContinue(cfg, deps)
  return h
}

function resultEvent(data: Record<string, unknown>): BusEvent {
  return { name: EventNames.SESSION_RESULT, data, destinations: ['main-ai'], urgency: 'normal', timestamp: Date.now(), source: 'session-runner', traceId: 'x' }
}
function sendEvent(sessionId: string, source = 'ui'): BusEvent {
  return { name: EventNames.SESSION_SEND, data: { sessionId, message: 'hi' }, destinations: [], urgency: 'normal', timestamp: Date.now(), source, traceId: 'x' }
}

// ── Signature matching ──

describe('matchesRetryExhaustion', () => {
  it('matches "Request timed out" (case-insensitive)', () => {
    expect(matchesRetryExhaustion('API Error: Request timed out')).toBe(true)
    expect(matchesRetryExhaustion('request TIMED OUT after 10 retries')).toBe(true)
  })
  it('matches "The operation timed out." (undici/fetch abort text, 2026-07-31 incident)', () => {
    expect(matchesRetryExhaustion('API Error: The operation timed out.')).toBe(true)
    expect(matchesRetryExhaustion('the OPERATION timed out')).toBe(true)
  })
  it('matches the api_timeout debug marker', () => {
    expect(matchesRetryExhaustion('turn ended: api_timeout')).toBe(true)
  })
  it('does NOT match ordinary errors or clean results', () => {
    expect(matchesRetryExhaustion('No conversation found with session ID')).toBe(false)
    expect(matchesRetryExhaustion('Hello! I processed your message')).toBe(false)
    expect(matchesRetryExhaustion('')).toBe(false)
    expect(matchesRetryExhaustion(null)).toBe(false)
    expect(matchesRetryExhaustion(undefined)).toBe(false)
  })
})

// ── Scheduling / firing ──

describe('SessionAutoContinue scheduling', () => {
  it('schedules and fires ONE continue nudge after the delay on a retry-exhaustion error', async () => {
    const h = makeHarness()
    h.sac.handleEvent(resultEvent({ sessionId: 'sess-1', taskId: 'task-1', isError: true, result: 'API Error: Request timed out' }))
    expect(h.sac.hasPending('sess-1')).toBe(true)
    expect(h.sends.length).toBe(0) // not yet — waiting for delay

    // Before delay: nothing fires.
    h.clock.advance(179_000)
    h.timers.runDue()
    expect(h.sends.length).toBe(0)

    // After delay: fires exactly once.
    h.clock.advance(2_000)
    h.timers.runDue()
    await Promise.resolve(); await Promise.resolve()

    expect(h.sends.length).toBe(1)
    expect(h.sends[0]).toMatchObject({ sessionId: 'sess-1', message: 'continue', opts: { source: AUTO_CONTINUE_SOURCE, taskId: 'task-1' } })
    expect(h.notes.length).toBe(1)
    expect(h.notes[0].sessionId).toBe('sess-1')
    expect(h.sac.hasPending('sess-1')).toBe(false)
  })

  it('is a strict no-op for a clean (non-error) result', () => {
    const h = makeHarness()
    h.sac.handleEvent(resultEvent({ sessionId: 'sess-1', isError: false, result: 'Request timed out' }))
    expect(h.sac.hasPending('sess-1')).toBe(false)
  })

  it('is a strict no-op for an error WITHOUT the retry-exhaustion signature', () => {
    const h = makeHarness()
    h.sac.handleEvent(resultEvent({ sessionId: 'sess-1', isError: true, result: 'No conversation found' }))
    expect(h.sac.hasPending('sess-1')).toBe(false)
  })

  it('ignores intermediate team/background results even with the signature', () => {
    const h = makeHarness()
    h.sac.handleEvent(resultEvent({ sessionId: 'sess-1', isError: true, result: 'Request timed out', teamActive: true }))
    expect(h.sac.hasPending('sess-1')).toBe(false)
    h.sac.handleEvent(resultEvent({ sessionId: 'sess-1', isError: true, result: 'Request timed out', backgroundActive: true }))
    expect(h.sac.hasPending('sess-1')).toBe(false)
  })

  it('does not stack a second pending nudge while one is already pending', () => {
    const h = makeHarness()
    h.sac.handleEvent(resultEvent({ sessionId: 'sess-1', isError: true, result: 'Request timed out' }))
    h.sac.handleEvent(resultEvent({ sessionId: 'sess-1', isError: true, result: 'Request timed out again' }))
    expect(h.timers.timers.size).toBe(1)
  })

  it('when disabled it never schedules', () => {
    const h = makeHarness({ enabled: false })
    h.sac.handleEvent(resultEvent({ sessionId: 'sess-1', isError: true, result: 'Request timed out' }))
    expect(h.sac.hasPending('sess-1')).toBe(false)
  })
})

// ── User-send cancels pending nudge ──

describe('SessionAutoContinue cancellation', () => {
  it('a user send cancels the pending nudge before it fires', async () => {
    const h = makeHarness()
    h.sac.handleEvent(resultEvent({ sessionId: 'sess-1', isError: true, result: 'Request timed out' }))
    expect(h.sac.hasPending('sess-1')).toBe(true)

    h.sac.handleEvent(sendEvent('sess-1', 'ui'))
    expect(h.sac.hasPending('sess-1')).toBe(false)

    h.clock.advance(200_000)
    h.timers.runDue()
    await Promise.resolve()
    expect(h.sends.length).toBe(0) // nudge never fired
  })

  it('our OWN nudge send does not cancel a (future) pending nudge', () => {
    const h = makeHarness()
    h.sac.handleEvent(resultEvent({ sessionId: 'sess-1', isError: true, result: 'Request timed out' }))
    h.sac.handleEvent(sendEvent('sess-1', AUTO_CONTINUE_SOURCE))
    expect(h.sac.hasPending('sess-1')).toBe(true)
  })

  it('a session:deleted (real user deletion) cancels a pending nudge', () => {
    const h = makeHarness()
    h.sac.handleEvent(resultEvent({ sessionId: 'sess-1', isError: true, result: 'Request timed out' }))
    h.sac.handleEvent({ name: EventNames.SESSION_DELETED, data: { sessionId: 'sess-1' }, destinations: [], urgency: 'normal', timestamp: Date.now(), source: 'x', traceId: 'x' })
    expect(h.sac.hasPending('sess-1')).toBe(false)
  })

  it('a session:ended (normal turn-end) does NOT cancel a pending nudge', () => {
    // SESSION_ENDED fires on every turn-end/process-reap — including right after
    // the retry-exhaustion error result that scheduled this nudge. It must NOT
    // undo the pending nudge, or auto-continue could never fire in production.
    const h = makeHarness()
    h.sac.handleEvent(resultEvent({ sessionId: 'sess-1', isError: true, result: 'Request timed out' }))
    h.sac.handleEvent({ name: EventNames.SESSION_ENDED, data: { sessionId: 'sess-1' }, destinations: [], urgency: 'normal', timestamp: Date.now(), source: 'x', traceId: 'x' })
    expect(h.sac.hasPending('sess-1')).toBe(true)
  })
})

// ── Fire-time guards ──

describe('SessionAutoContinue fire-time guards', () => {
  async function fireOnce(h: Harness, sid = 'sess-1', result = 'Request timed out') {
    h.sac.handleEvent(resultEvent({ sessionId: sid, isError: true, result }))
    h.clock.advance(181_000)
    h.timers.runDue()
    await Promise.resolve(); await Promise.resolve()
  }

  it('does not fire when the session record is gone', async () => {
    const h = makeHarness()
    h.sessionRecord = null
    await fireOnce(h)
    expect(h.sends.length).toBe(0)
  })

  it('does not fire when the session is archived', async () => {
    const h = makeHarness()
    h.sessionRecord = makeSession({ archived: true })
    await fireOnce(h)
    expect(h.sends.length).toBe(0)
  })

  it('TOCTOU: a user send DURING the async fire-time lookup aborts the nudge', async () => {
    // The timer has already fired (pending handle gone — cancel() can't clear it);
    // the user message lands while fire() is awaiting getSession. The epoch bump
    // must abort the in-flight fire so no 'continue' is injected behind the user.
    const h = makeHarness()
    let releaseLookup: (() => void) | null = null
    const gate = new Promise<void>((resolve) => { releaseLookup = resolve })
    const record = makeSession()
    h.sac = new SessionAutoContinue(
      { enabled: true, delayMs: 1_000, maxPerHour: 2, windowMs: 3_600_000 },
      {
        now: h.clock.now, setTimer: h.timers.set, clearTimer: h.timers.clear,
        send: async (sessionId, message, opts) => { h.sends.push({ sessionId, message, opts }); return {} },
        getSession: async () => { await gate; return record }, // parked mid-fire
        emitNote: (sessionId, _t, message) => { h.notes.push({ sessionId, message }) },
      },
    )
    h.sac.handleEvent(resultEvent({ sessionId: 'sess-1', isError: true, result: 'Request timed out' }))
    h.clock.advance(1_001)
    h.timers.runDue() // fire() starts, parks on getSession
    expect(h.sac.hasPending('sess-1')).toBe(false) // timer handle already consumed

    // User takes over while fire() is parked.
    h.sac.handleEvent(sendEvent('sess-1', 'ui'))

    releaseLookup!()
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve()
    expect(h.sends.length).toBe(0) // nudge aborted — nothing injected behind the user
    expect(h.notes.length).toBe(0)

    // And the aborted fire released its cap slot: a fresh error can still fire twice.
    h.sac.handleEvent(resultEvent({ sessionId: 'sess-1', isError: true, result: 'Request timed out' }))
    h.clock.advance(1_001)
    h.timers.runDue()
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve()
    expect(h.sends.length).toBe(1)
  })

  it('honors the structured retryExhausted signal even when the result text is generic', () => {
    const h = makeHarness()
    h.sac.handleEvent(resultEvent({ sessionId: 'sess-1', isError: true, result: 'API Error', retryExhausted: true }))
    expect(h.sac.hasPending('sess-1')).toBe(true)
  })
})

// ── Rolling-hour cap ──

describe('SessionAutoContinue hourly cap', () => {
  it('fires at most maxPerHour times per rolling window, then resumes after the window', async () => {
    const h = makeHarness({ maxPerHour: 2, windowMs: 3_600_000, delayMs: 1_000 })

    async function cycle() {
      h.sac.handleEvent(resultEvent({ sessionId: 'sess-1', isError: true, result: 'Request timed out' }))
      h.clock.advance(1_100)
      h.timers.runDue()
      await Promise.resolve(); await Promise.resolve()
    }

    await cycle() // fire 1
    await cycle() // fire 2
    expect(h.sends.length).toBe(2)

    // 3rd within the window is capped — schedule is refused outright.
    h.sac.handleEvent(resultEvent({ sessionId: 'sess-1', isError: true, result: 'Request timed out' }))
    expect(h.sac.hasPending('sess-1')).toBe(false)
    expect(h.sends.length).toBe(2)

    // After the window elapses, the cap resets and a new nudge can fire.
    h.clock.advance(3_600_001)
    await cycle() // fire 3
    expect(h.sends.length).toBe(3)
  })

  it('maxPerHour=0 disables firing entirely', () => {
    const h = makeHarness({ maxPerHour: 0 })
    h.sac.handleEvent(resultEvent({ sessionId: 'sess-1', isError: true, result: 'Request timed out' }))
    expect(h.sac.hasPending('sess-1')).toBe(false)
  })
})

// ── Config resolution ──

describe('resolveAutoContinueConfig', () => {
  const KEYS = ['WALNUT_AUTO_CONTINUE_ENABLED', 'WALNUT_AUTO_CONTINUE_DELAY_MS', 'WALNUT_AUTO_CONTINUE_MAX_PER_HOUR', 'WALNUT_AUTO_CONTINUE_WINDOW_MS']
  beforeEach(() => { for (const k of KEYS) delete process.env[k] })

  it('defaults: enabled, 3-min delay, cap 2/hour', () => {
    const cfg = resolveAutoContinueConfig()
    expect(cfg).toEqual({ enabled: true, delayMs: 180_000, maxPerHour: 2, windowMs: 3_600_000 })
  })
  it('honors env overrides and clamps out-of-range values', () => {
    process.env.WALNUT_AUTO_CONTINUE_ENABLED = '0'
    process.env.WALNUT_AUTO_CONTINUE_DELAY_MS = '5000'
    process.env.WALNUT_AUTO_CONTINUE_MAX_PER_HOUR = '999999'
    const cfg = resolveAutoContinueConfig()
    expect(cfg.enabled).toBe(false)
    expect(cfg.delayMs).toBe(5000)
    expect(cfg.maxPerHour).toBe(100) // clamped to max
  })
  it('ignores garbage values, falling back to defaults', () => {
    process.env.WALNUT_AUTO_CONTINUE_DELAY_MS = 'not-a-number'
    expect(resolveAutoContinueConfig().delayMs).toBe(180_000)
  })
})

// ── Bus wiring smoke test ──

describe('startSessionAutoContinue bus wiring', () => {
  it('subscribes and unsubscribes cleanly', async () => {
    bus.clear()
    const { startSessionAutoContinue } = await import('../../src/core/session-auto-continue.js')
    const handle = startSessionAutoContinue({ enabled: true, delayMs: 1000, maxPerHour: 2, windowMs: 3_600_000 })
    expect(handle.instance).toBeTruthy()
    handle.stop()
    bus.clear()
  })
})
