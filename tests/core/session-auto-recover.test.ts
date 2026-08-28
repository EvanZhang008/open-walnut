/**
 * Unit tests for the auto-recover scheduler — bringing back sessions whose
 * execution host or daemon died under them (inc-1787439819342).
 *
 * Fully offline: clock, timers, send, session/task lookup, budget persistence and
 * note emission are all injected, so the state machine runs deterministically
 * with no server, CLI or real timers.
 */

import { describe, it, expect, vi } from 'vitest'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants())

import {
  SessionAutoRecover,
  buildRecoveryPrompt,
  resolveAutoRecoverConfig,
  AUTO_RECOVER_SOURCE,
  type AutoRecoverConfig,
  type AutoRecoverDeps,
} from '../../src/core/session-auto-recover.js'
import { EventNames } from '../../src/core/event-bus.js'
import type { BusEvent } from '../../src/core/event-bus.js'
import type { SessionRecord, StatusReason, TaskPhase } from '../../src/core/types.js'

// ── Fake environment ──

class FakeClock {
  t = 1_000_000
  now = () => this.t
  advance(ms: number) { this.t += ms }
}

interface FakeTimer { id: number; fn: () => void; fireAt: number }

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
  runDue(): void {
    const due = [...this.timers.values()]
      .filter((t) => t.fireAt <= this.clock.now())
      .sort((a, b) => a.fireAt - b.fireAt)
    for (const t of due) { this.timers.delete(t.id); t.fn() }
  }
  get count(): number { return this.timers.size }
}

/** The incident's session: remote, mid-turn work, killed by a host reboot, and
 *  labelled by the gate hand-off. */
function makeSession(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    claudeSessionId: 'sess-1',
    taskId: 'task-1',
    type: 'interactive',
    host: 'clouddev',
    archived: false,
    process_status: 'error',
    status_reason: 'snapshot_projection',
    errorKind: 'infra',
    errorMessage: 'Connection lost — unable to reach remote host',
    ...(overrides as object),
  } as SessionRecord
}

interface Harness {
  sar: SessionAutoRecover
  clock: FakeClock
  timers: FakeTimers
  sends: Array<{ sessionId: string; message: string; opts: { source: string; taskId?: string } }>
  notes: Array<{ sessionId: string; message: string }>
  budgetWrites: Array<{ sessionId: string; attempts: number; cause?: StatusReason }>
  record: SessionRecord | null
  phase: TaskPhase | null
}

function makeHarness(
  cfgOverrides: Partial<AutoRecoverConfig> = {},
  depOverrides: Partial<AutoRecoverDeps> = {},
): Harness {
  const clock = new FakeClock()
  const timers = new FakeTimers(clock)
  const h: Harness = {
    sar: null as unknown as SessionAutoRecover,
    clock, timers,
    sends: [], notes: [], budgetWrites: [],
    record: makeSession(),
    phase: 'IN_PROGRESS',
  }
  const cfg: AutoRecoverConfig = {
    enabled: true,
    delayMs: 20_000,
    staggerMs: 15_000,
    maxAttempts: 3,
    maxPerHost: 10,
    windowMs: 6 * 3_600_000,
    ...cfgOverrides,
  }
  const deps: Partial<AutoRecoverDeps> = {
    now: clock.now,
    setTimer: timers.set,
    clearTimer: timers.clear,
    send: async (sessionId, message, opts) => { h.sends.push({ sessionId, message, opts }); return { id: 'qm-x' } },
    getSession: async () => h.record,
    getTaskPhase: async () => h.phase,
    noteAttempt: async (sessionId, attempts, cause) => { h.budgetWrites.push({ sessionId, attempts, cause }) },
    emitNote: (sessionId, _taskId, message) => { h.notes.push({ sessionId, message }) },
    ...depOverrides,
  }
  h.sar = new SessionAutoRecover(cfg, deps)
  return h
}

function sendEvent(sessionId: string, source = 'ui'): BusEvent {
  return {
    name: EventNames.SESSION_SEND, data: { sessionId, message: 'hi' },
    destinations: [], urgency: 'normal', timestamp: Date.now(), source, traceId: 'x',
  }
}

/** Advance past the delay and run whatever came due, then let the async fire()
 *  chain settle. */
async function settle(h: Harness, ms = 25_000): Promise<void> {
  h.clock.advance(ms)
  h.timers.runDue()
  await new Promise((r) => setTimeout(r, 0))
  await new Promise((r) => setTimeout(r, 0))
}

// ── The happy path: the incident, recovered ──

describe('auto-recover happy path', () => {
  it('resumes a mid-turn session killed by a host reboot', async () => {
    const h = makeHarness()
    expect(h.sar.schedule(h.record!, 'remote_unreachable')).toBe(true)
    // Nothing fires immediately — the host may still be finishing its boot.
    expect(h.sends).toHaveLength(0)

    await settle(h)

    expect(h.sends).toHaveLength(1)
    expect(h.sends[0].sessionId).toBe('sess-1')
    expect(h.sends[0].opts.source).toBe(AUTO_RECOVER_SOURCE)
    expect(h.sends[0].opts.taskId).toBe('task-1')
    // The prompt must tell the agent it was not at fault and to re-check state.
    expect(h.sends[0].message).toContain('[Walnut auto-recover]')
    expect(h.sends[0].message).toContain('re-check the real state on disk')
    // A human-visible note too.
    expect(h.notes).toHaveLength(1)
    expect(h.notes[0].message).toContain('Auto-recovering')
  })

  it('persists the attempt BEFORE sending, so a crash mid-resume still spends budget', async () => {
    const order: string[] = []
    const h = makeHarness({}, {
      noteAttempt: async () => { order.push('budget') },
      send: async () => { order.push('send'); return {} },
    })
    h.sar.schedule(h.record!, 'remote_unreachable')
    await settle(h)
    expect(order).toEqual(['budget', 'send'])
  })
})

// ── wouldAttempt: the sync verdict callers use to decide phase advancement ──

describe('wouldAttempt guards', () => {
  it('refuses when disabled', () => {
    const h = makeHarness({ enabled: false })
    expect(h.sar.wouldAttempt(h.record!)).toEqual({ ok: false, reason: 'disabled' })
  })

  it('refuses an archived session', () => {
    const h = makeHarness()
    expect(h.sar.wouldAttempt(makeSession({ archived: true }))).toEqual({ ok: false, reason: 'archived' })
  })

  it('refuses a session with no task — there is no work to continue', () => {
    const h = makeHarness()
    expect(h.sar.wouldAttempt(makeSession({ taskId: undefined }))).toEqual({ ok: false, reason: 'no-task' })
  })

  it('refuses derived session types (triage / hook / cron / subagent)', () => {
    const h = makeHarness()
    for (const type of ['triage', 'hook', 'cron', 'subagent'] as const) {
      expect(h.sar.wouldAttempt(makeSession({ type })), type)
        .toEqual({ ok: false, reason: 'not-interactive' })
    }
  })

  it('refuses a cause that is not positively infra', () => {
    const h = makeHarness()
    // The bare incident shape (unknown) does NOT qualify for an unattended resume.
    expect(h.sar.wouldAttempt(makeSession({
      errorKind: undefined, errorMessage: undefined, status_reason: 'snapshot_projection',
    }))).toEqual({ ok: false, reason: 'not-infra' })
    // A model refusal must never be resumed.
    expect(h.sar.wouldAttempt(makeSession({
      errorKind: 'terminal', errorMessage: "Claude can't help with this", status_reason: 'api_error',
    }))).toEqual({ ok: false, reason: 'not-infra' })
  })

  it('refuses once the persisted session budget is spent', () => {
    const h = makeHarness({ maxAttempts: 2 })
    const spent = makeSession({
      autoRecover: { attempts: 2, lastAt: new Date(h.clock.now() - 60_000).toISOString() },
    })
    expect(h.sar.wouldAttempt(spent)).toEqual({ ok: false, reason: 'session-budget' })
  })

  it('lets the budget roll over once the window has passed', () => {
    const h = makeHarness({ maxAttempts: 2, windowMs: 3_600_000 })
    const stale = makeSession({
      autoRecover: { attempts: 5, lastAt: new Date(h.clock.now() - 7_200_000).toISOString() },
    })
    expect(h.sar.wouldAttempt(stale)).toEqual({ ok: true })
  })

  it('refuses a second pending recovery for the same session', () => {
    const h = makeHarness()
    expect(h.sar.schedule(h.record!)).toBe(true)
    expect(h.sar.schedule(h.record!)).toBe(false)
    expect(h.timers.count).toBe(1)
  })
})

// ── Per-host protection: a reboot strands MANY sessions at once ──

describe('per-host bounds', () => {
  it('staggers resumes on the same host instead of spawning them together', () => {
    const h = makeHarness({ delayMs: 20_000, staggerMs: 15_000 })
    for (let i = 0; i < 3; i++) {
      expect(h.sar.schedule(makeSession({ claudeSessionId: `sess-${i}`, taskId: `task-${i}` }))).toBe(true)
    }
    const fireAts = [...h.timers.timers.values()].map((t) => t.fireAt - h.clock.now()).sort((a, b) => a - b)
    expect(fireAts).toEqual([20_000, 35_000, 50_000])
  })

  it('caps resumes per host inside the window', () => {
    const h = makeHarness({ maxPerHost: 2 })
    expect(h.sar.schedule(makeSession({ claudeSessionId: 'a', taskId: 't-a' }))).toBe(true)
    expect(h.sar.schedule(makeSession({ claudeSessionId: 'b', taskId: 't-b' }))).toBe(true)
    expect(h.sar.schedule(makeSession({ claudeSessionId: 'c', taskId: 't-c' })))
      .toBe(false)
    expect(h.sar.hostFiredCount('clouddev')).toBe(2)
  })

  it('counts hosts separately — one bad host must not starve another', () => {
    const h = makeHarness({ maxPerHost: 1 })
    expect(h.sar.schedule(makeSession({ claudeSessionId: 'a', taskId: 't-a', host: 'hostA' }))).toBe(true)
    expect(h.sar.schedule(makeSession({ claudeSessionId: 'b', taskId: 't-b', host: 'hostB' }))).toBe(true)
    expect(h.sar.schedule(makeSession({ claudeSessionId: 'c', taskId: 't-c', host: 'hostA' }))).toBe(false)
  })

  it('reserves the host slot at SCHEDULE time so a same-tick burst cannot overrun the cap', () => {
    // Reserving at fire time would let N schedule() calls in one tick all pass.
    const h = makeHarness({ maxPerHost: 3 })
    const armed = [0, 1, 2, 3, 4]
      .map((i) => h.sar.schedule(makeSession({ claudeSessionId: `s${i}`, taskId: `t${i}` })))
    expect(armed).toEqual([true, true, true, false, false])
  })
})

// ── fire() re-validation: the delay is long enough for everything to change ──

describe('fire-time re-validation', () => {
  it('aborts when the session came back on its own', async () => {
    const h = makeHarness()
    h.sar.schedule(h.record!)
    h.record = makeSession({ process_status: 'running' })
    await settle(h)
    expect(h.sends).toHaveLength(0)
  })

  it('aborts when the task is no longer IN_PROGRESS — the human already took it back', async () => {
    const h = makeHarness()
    h.sar.schedule(h.record!)
    h.phase = 'AGENT_COMPLETE'
    await settle(h)
    expect(h.sends).toHaveLength(0)
    // And no budget was spent on a resume that never happened.
    expect(h.budgetWrites).toHaveLength(0)
  })

  it('aborts when the task vanished (getTaskPhase → null)', async () => {
    const h = makeHarness()
    h.sar.schedule(h.record!)
    h.phase = null
    await settle(h)
    expect(h.sends).toHaveLength(0)
  })

  it('aborts when the session was archived during the delay', async () => {
    const h = makeHarness()
    h.sar.schedule(h.record!)
    h.record = makeSession({ archived: true })
    await settle(h)
    expect(h.sends).toHaveLength(0)
  })

  it('aborts when the session record disappeared', async () => {
    const h = makeHarness()
    h.sar.schedule(h.record!)
    h.record = null
    await settle(h)
    expect(h.sends).toHaveLength(0)
  })

  it('aborts when the cause stopped being infra during the delay', async () => {
    const h = makeHarness()
    h.sar.schedule(h.record!)
    h.record = makeSession({ errorKind: 'terminal' })
    await settle(h)
    expect(h.sends).toHaveLength(0)
  })
})

// ── Human supersession ──

describe('supersession by a human', () => {
  it('a non-auto send cancels a pending recovery', async () => {
    const h = makeHarness()
    h.sar.schedule(h.record!)
    h.sar.handleEvent(sendEvent('sess-1'))
    expect(h.sar.hasPending('sess-1')).toBe(false)
    await settle(h)
    expect(h.sends).toHaveLength(0)
  })

  it('our OWN send does not cancel (it would cancel itself)', () => {
    const h = makeHarness()
    h.sar.schedule(h.record!)
    h.sar.handleEvent(sendEvent('sess-1', AUTO_RECOVER_SOURCE))
    expect(h.sar.hasPending('sess-1')).toBe(true)
  })

  it('a send landing mid-fire still aborts it (epoch check, not just the timer)', async () => {
    // Clearing a timer cannot stop a callback that already started, so fire()
    // re-checks the epoch after every await. Cancel during the session lookup.
    const h = makeHarness({}, {
      getSession: async () => {
        h.sar.handleEvent(sendEvent('sess-1'))
        return h.record
      },
    })
    h.sar.schedule(h.record!)
    await settle(h)
    expect(h.sends).toHaveLength(0)
  })

  it('session deletion cancels', async () => {
    const h = makeHarness()
    h.sar.schedule(h.record!)
    h.sar.handleEvent({
      name: EventNames.SESSION_DELETED, data: { sessionId: 'sess-1' },
      destinations: [], urgency: 'normal', timestamp: Date.now(), source: 'ui', traceId: 'x',
    })
    await settle(h)
    expect(h.sends).toHaveLength(0)
  })
})

// ── Prompt + config ──

describe('buildRecoveryPrompt', () => {
  it('names the host and the cause', () => {
    expect(buildRecoveryPrompt('clouddev', 'remote_unreachable')).toContain('on clouddev')
    expect(buildRecoveryPrompt('clouddev', 'remote_unreachable')).toContain('the host became unreachable')
    expect(buildRecoveryPrompt('__local__', 'server_restart')).toContain('on this machine')
    expect(buildRecoveryPrompt('__local__', 'server_restart')).toContain('the Walnut server restarted')
  })

  it('absolves the agent so it does not waste a turn debugging a phantom failure', () => {
    const p = buildRecoveryPrompt('clouddev', 'daemon_reported_exit')
    expect(p).toContain('Nothing you did caused it')
  })
})

describe('resolveAutoRecoverConfig', () => {
  it('is ON by default — restoring a process the infrastructure took away needs no opt-in', () => {
    const prev = process.env.WALNUT_AUTO_RECOVER_ENABLED
    delete process.env.WALNUT_AUTO_RECOVER_ENABLED
    expect(resolveAutoRecoverConfig().enabled).toBe(true)
    process.env.WALNUT_AUTO_RECOVER_ENABLED = '0'
    expect(resolveAutoRecoverConfig().enabled).toBe(false)
    if (prev === undefined) delete process.env.WALNUT_AUTO_RECOVER_ENABLED
    else process.env.WALNUT_AUTO_RECOVER_ENABLED = prev
  })

  it('clamps nonsense values to the defaults', () => {
    const prev = process.env.WALNUT_AUTO_RECOVER_MAX_ATTEMPTS
    process.env.WALNUT_AUTO_RECOVER_MAX_ATTEMPTS = 'not-a-number'
    expect(resolveAutoRecoverConfig().maxAttempts).toBe(3)
    process.env.WALNUT_AUTO_RECOVER_MAX_ATTEMPTS = '99999'
    expect(resolveAutoRecoverConfig().maxAttempts).toBe(50)
    if (prev === undefined) delete process.env.WALNUT_AUTO_RECOVER_MAX_ATTEMPTS
    else process.env.WALNUT_AUTO_RECOVER_MAX_ATTEMPTS = prev
  })
})

// ── Budget arithmetic at the boundary ──

describe('attempt budget', () => {
  it('increments from the persisted count and stops at the cap', async () => {
    const h = makeHarness({ maxAttempts: 3 })
    h.record = makeSession({
      autoRecover: { attempts: 2, lastAt: new Date(h.clock.now() - 1_000).toISOString() },
    })
    h.sar.schedule(h.record, 'remote_unreachable')
    await settle(h)
    expect(h.budgetWrites).toEqual([{ sessionId: 'sess-1', attempts: 3, cause: 'remote_unreachable' }])
    expect(h.sends).toHaveLength(1)
  })

  it('falls back to the record status_reason when the caller passes no cause', async () => {
    const h = makeHarness()
    h.sar.schedule(h.record!)
    await settle(h)
    expect(h.budgetWrites[0].cause).toBe('snapshot_projection')
  })

  it('gives up rather than exceeding the cap when the record changed during the delay', async () => {
    const h = makeHarness({ maxAttempts: 3 })
    h.sar.schedule(h.record!)
    // Another server (or a retry from the other discovery site) spent the budget
    // while we waited.
    h.record = makeSession({
      autoRecover: { attempts: 3, lastAt: new Date(h.clock.now()).toISOString() },
    })
    await settle(h)
    expect(h.sends).toHaveLength(0)
    expect(h.budgetWrites).toHaveLength(0)
  })
})

describe('stop()', () => {
  it('clears pending timers and per-host state', () => {
    const h = makeHarness()
    h.sar.schedule(h.record!)
    expect(h.timers.count).toBe(1)
    h.sar.stop()
    expect(h.timers.count).toBe(0)
    expect(h.sar.hostFiredCount('clouddev')).toBe(0)
  })
})
