/**
 * The endpoint wait (src/core/sessions/endpoint-wait.ts) on a hand-run clock: a turn that never
 * reached the model endpoint waits on its machine, probes, continues once when the endpoint answers,
 * and gives the user the session only after its cap, naming the machine and the endpoint. And the
 * status the user reads for each step (user-status.ts).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-endpoint-wait'))

import { EventNames } from '../../../src/core/event-bus.js'
import type { BusEvent } from '../../../src/core/event-bus.js'
import {
  EndpointWaiter, ENDPOINT_WAIT_MAX_RESUMES, type EndpointWaitDeps, type EndpointProbeAnswer, recordInEndpointWait,
} from '../../../src/core/sessions/endpoint-wait.js'
import { AUTO_CONTINUE_SOURCE } from '../../../src/core/session-auto-continue.js'
import { deriveUserStatus } from '../../../src/core/user-status.js'
import type { SessionRecord, SessionEndpointWait } from '../../../src/core/types.js'

const REFUSED = 'API Error: Connection refused — a firewall or proxy may be blocking it (ECONNREFUSED)'
const SID = 'sess-endpoint-1'
const MIN = 60_000

function rig(opts: { probe?: (n: number) => EndpointProbeAnswer | Promise<EndpointProbeAnswer>; holdsOff?: () => string | null } = {}) {
  let now = Date.parse('2026-11-03T14:00:00Z')
  const timers: Array<{ at: number; fn: () => void; id: number }> = []
  let nextId = 1
  const rec: SessionRecord = {
    claudeSessionId: SID, taskId: 'task-1', project: 'P', process_status: 'error', mode: 'bypass',
    host: '__local__', cwd: '/work/repo', errorMessage: REFUSED,
  } as unknown as SessionRecord
  const sent: Array<{ text: string; source: string }> = []
  const notes: string[] = []
  const gaveUp: string[] = []
  let probes = 0
  const deps: EndpointWaitDeps = {
    now: () => now,
    setTimer: (fn, ms) => { const id = nextId++; timers.push({ at: now + ms, fn, id }); return id as unknown as ReturnType<typeof setTimeout> },
    clearTimer: (h) => { const i = timers.findIndex((t) => t.id === (h as unknown as number)); if (i >= 0) timers.splice(i, 1) },
    getSession: async () => rec,
    listSessions: async () => [rec],
    patchWait: async (_sid, fn) => { const next = fn(rec.endpointWait); if (next) rec.endpointWait = next; else delete rec.endpointWait },
    probe: async () => { probes++; return opts.probe ? opts.probe(probes) : { kind: 'probed', url: 'http://127.0.0.1:8402', probed: 'http://127.0.0.1:8402', reachable: false, error: 'ECONNREFUSED' } },
    send: async (_sid, text, o) => { sent.push({ text, source: o.source }) },
    note: (_sid, _task, text) => { notes.push(text) },
    gaveUp: async (_rec, _w, words) => { gaveUp.push(words) },
    holdsOff: async () => opts.holdsOff?.() ?? null,
  }
  const waiter = new EndpointWaiter(deps)
  const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve() }
  /** Advance the clock by `ms`, firing every timer due on the way. */
  const advance = async (ms: number) => {
    const end = now + ms
    for (;;) {
      await flush()
      timers.sort((a, b) => a.at - b.at)
      const t = timers[0]
      if (!t || t.at > end) break
      timers.shift()
      now = t.at
      t.fn()
      await flush()
    }
    now = end
    await flush()
  }
  const emit = async (name: string, data: Record<string, unknown>, source = 'session-runner') => {
    waiter.handleEvent({ name, data, source } as unknown as BusEvent)
    await flush()
  }
  const result = (r: Record<string, unknown>) => emit(EventNames.SESSION_RESULT, { sessionId: SID, taskId: 'task-1', ...r })
  return { rec, sent, notes, gaveUp, waiter, advance, emit, result, probes: () => probes }
}

/** The status a task with this session reads (worker of a lead, its turn handed back). */
function statusOf(rec: SessionRecord, hasLeader = true) {
  const w = rec.endpointWait
  return deriveUserStatus({
    phase: 'NEED_ACTION', hasSession: true, hasLeader, processStatus: rec.process_status,
    errorMessage: rec.errorMessage, errorReason: 'api_error',
    endpointWait: w ? { state: w.state, url: w.url, where: w.where, since: w.since, resumes: w.resumes, gaveUpWhy: w.gaveUpWhy, probeError: w.probeError, cause: w.cause } : null,
  })
}

describe('the endpoint wait', () => {
  beforeEach(() => { delete process.env.WALNUT_ENDPOINT_WAIT })

  it('a request that dropped mid-way waits on its machine and tries again on a widening clock, then gives up naming the network', async () => {
    // 2026-11-08: the network cut every large upload, while a small probe went through.
    const DROPPED = 'API Error: Connection dropped (ECONNRESET)'
    const up = { kind: 'probed', url: 'http://127.0.0.1:8402', probed: 'http://127.0.0.1:8402', reachable: true } as const
    const r = rig({ probe: () => up })
    r.rec.errorMessage = DROPPED
    await r.result({ isError: true, result: DROPPED })
    expect(r.rec.endpointWait).toMatchObject({ state: 'waiting', cause: 'dropped', resumes: 0 })
    const waiting = statusOf(r.rec)
    expect(waiting).toMatchObject({ state: 'waiting', kind: 'machine' })
    expect(waiting.waitingOn).toMatch(/connection from this (Mac|machine) to its model endpoint, which keeps dropping mid-request/)

    // The probe answers at once, but the first try waits for the 3-minute mark.
    await r.advance(2 * MIN)
    expect(r.sent).toEqual([])
    await r.advance(2 * MIN)
    expect(r.sent).toEqual([{ text: 'continue', source: AUTO_CONTINUE_SOURCE }])
    expect(r.notes.at(-1)).toContain('dropped mid-request')

    // Each try drops again: the next ones come 15, then 60 minutes after the latest drop.
    const triesAt: number[] = [4]
    for (let minute = 4; minute < 200 && r.gaveUp.length === 0; minute++) {
      const before = r.sent.length
      if (r.rec.endpointWait?.state === 'resumed') await r.result({ isError: true, result: DROPPED })
      await r.advance(MIN)
      if (r.sent.length > before) triesAt.push(minute + 1)
    }
    expect(triesAt.length).toBe(ENDPOINT_WAIT_MAX_RESUMES)
    expect(triesAt[1]! - triesAt[0]!).toBeGreaterThanOrEqual(15)
    expect(triesAt[2]! - triesAt[1]!).toBeGreaterThanOrEqual(60)
    expect(r.gaveUp).toHaveLength(1)
    expect(r.gaveUp[0]).toMatch(/kept dropping mid-request .*Check the network there, then Retry the session/)
    // Its lead's to retry (2026-11-09), the user's only with no one above the task.
    expect(statusOf(r.rec)).toMatchObject({ state: 'waiting', kind: 'lead', waitingOn: expect.stringContaining('Walnut stopped waiting for its model endpoint') })
    expect(statusOf(r.rec, false)).toMatchObject({ state: 'needs', source: 'error' })
  })

  it('a drop after a long refusal still waits its clock from the drop, never at once', async () => {
    // Review 2026-11-08: the clock ran from the wait's start, so three tries came seconds apart.
    let up = false
    const r = rig({ probe: () => ({ kind: 'probed', url: 'http://127.0.0.1:8402', probed: 'http://127.0.0.1:8402', reachable: up, ...(up ? {} : { error: 'ECONNREFUSED' }) }) })
    await r.result({ isError: true, result: 'API Error: Connection refused' })
    await r.advance(20 * MIN)
    expect(r.sent).toEqual([])
    up = true
    await r.advance(MIN)
    expect(r.sent).toHaveLength(1)
    await r.result({ isError: true, result: 'API Error: Connection dropped (ECONNRESET)' })
    expect(r.rec.endpointWait).toMatchObject({ state: 'waiting', cause: 'dropped', dropTries: 0, resumes: 1 })
    await r.advance(2 * MIN)
    expect(r.sent).toHaveLength(1)
    await r.advance(2 * MIN)
    expect(r.sent).toHaveLength(2)
    expect(r.gaveUp).toEqual([])
  })

  it('a host whose daemon cannot probe counts each drop try and gives up after the cap', async () => {
    const DROPPED = 'API Error: Connection dropped (ECONNRESET)'
    const r = rig({ probe: () => ({ kind: 'unsupported' }) })
    await r.result({ isError: true, result: DROPPED })
    for (let minute = 0; minute < 400 && r.gaveUp.length === 0; minute++) {
      if (r.rec.endpointWait?.state === 'resumed') await r.result({ isError: true, result: DROPPED })
      await r.advance(MIN)
    }
    expect(r.sent).toHaveLength(ENDPOINT_WAIT_MAX_RESUMES)
    expect(r.gaveUp).toHaveLength(1)
    expect(r.gaveUp[0]).toMatch(new RegExp(`kept dropping mid-request .*\\(${ENDPOINT_WAIT_MAX_RESUMES} tries\\)`))
  })

  it('a clean turn after a drop closes the wait', async () => {
    const DROPPED = 'API Error: read ECONNRESET'
    const r = rig({ probe: () => ({ kind: 'probed', url: 'http://127.0.0.1:8402', probed: 'http://127.0.0.1:8402', reachable: true }) })
    await r.result({ isError: true, result: DROPPED })
    await r.advance(4 * MIN)
    expect(r.sent).toHaveLength(1)
    await r.result({ isError: false, result: 'done' })
    expect(r.rec.endpointWait).toBeUndefined()
  })

  it('waits on its machine while the endpoint refuses, spending nothing, then continues once', async () => {
    let up = false
    const r = rig({ probe: () => ({ kind: 'probed', url: 'http://127.0.0.1:8402', probed: 'http://127.0.0.1:8402', reachable: up, ...(up ? {} : { error: 'ECONNREFUSED' }) }) })
    await r.result({ isError: true, result: REFUSED })
    expect(r.rec.endpointWait).toMatchObject({ state: 'waiting', host: '__local__', resumes: 0 })
    expect(recordInEndpointWait(r.rec)).toBe(true)

    // Twenty minutes of a dead endpoint: probes, no continue, no failed turn in the chat.
    await r.advance(20 * MIN)
    expect(r.sent).toEqual([])
    expect(r.probes()).toBeGreaterThan(20)
    expect(r.rec.endpointWait).toMatchObject({ state: 'waiting', url: 'http://127.0.0.1:8402', probeError: 'ECONNREFUSED' })
    const waiting = statusOf(r.rec)
    expect(waiting.state).toBe('waiting')
    expect(waiting.kind).toBe('machine')
    expect(waiting.waitingOn).toContain('http://127.0.0.1:8402')
    expect(waiting.waitingOn).toMatch(/this (Mac|machine)/)

    // It answers: one continue through the normal send path, and a note in the chat.
    up = true
    await r.advance(3 * MIN)
    expect(r.sent).toEqual([{ text: 'continue', source: AUTO_CONTINUE_SOURCE }])
    expect(r.notes.at(-1)).toContain('answers again')
    expect(r.rec.endpointWait).toMatchObject({ state: 'resumed', resumes: 1 })

    // Its own send event is not someone else's, and the turn that ran closes the wait.
    await r.emit(EventNames.SESSION_MESSAGE_QUEUED, { sessionId: SID }, AUTO_CONTINUE_SOURCE)
    expect(r.rec.endpointWait).toBeDefined()
    await r.result({ isError: false, result: 'done' })
    expect(r.rec.endpointWait).toBeUndefined()
    await r.advance(60 * MIN)
    expect(r.sent).toHaveLength(1)
  })

  it('a continue a person stopped (interrupted) closes the wait: no continue over their Stop', async () => {
    const r = rig({ probe: () => ({ kind: 'probed', url: 'http://127.0.0.1:8402', probed: 'http://127.0.0.1:8402', reachable: true }) })
    await r.result({ isError: true, result: REFUSED })
    await r.advance(1 * MIN)
    expect(r.sent).toHaveLength(1)
    await r.result({ isError: false, interrupted: true, result: '' })
    expect(r.rec.endpointWait).toBeUndefined()
    await r.advance(60 * MIN)
    expect(r.sent).toHaveLength(1)
  })

  it('a continued turn that ended cleanly with work running on closes the wait too', async () => {
    const r = rig({ probe: () => ({ kind: 'probed', url: 'http://127.0.0.1:8402', probed: 'http://127.0.0.1:8402', reachable: true }) })
    await r.result({ isError: true, result: REFUSED })
    await r.advance(1 * MIN)
    await r.result({ isError: false, result: 'started a background agent', backgroundActive: true })
    expect(r.rec.endpointWait).toBeUndefined()
    await r.advance(60 * MIN)
    expect(r.sent).toHaveLength(1)
  })

  it.each(['person-stopped', 'task-complete', 'team-stopped'])('%s: no continue, the wait closes', async (why) => {
    let off: string | null = null
    const r = rig({ probe: () => ({ kind: 'probed', url: 'http://127.0.0.1:8402', probed: 'http://127.0.0.1:8402', reachable: true }), holdsOff: () => off })
    await r.result({ isError: true, result: REFUSED })
    off = why
    await r.advance(60 * MIN)
    expect(r.sent).toEqual([])
    expect(r.rec.endpointWait).toBeUndefined()
  })

  it('a message that comes in while the probe runs wins: the wait is not brought back', async () => {
    let r!: ReturnType<typeof rig>
    r = rig({
      probe: async () => {
        // The person writes while the daemon is still answering the probe.
        await r.emit(EventNames.SESSION_SEND, { sessionId: SID }, 'web-ui')
        return { kind: 'probed', url: 'http://127.0.0.1:8402', probed: 'http://127.0.0.1:8402', reachable: true }
      },
    })
    await r.result({ isError: true, result: REFUSED })
    await r.advance(1 * MIN)
    expect(r.sent).toEqual([])
    expect(r.rec.endpointWait).toBeUndefined()
  })

  it('holds the turn notices only while the wait is open', () => {
    const base = { claudeSessionId: SID, process_status: 'idle', errorMessage: undefined } as unknown as SessionRecord
    const w = { since: '2026-11-03T14:00:00Z', host: '__local__', where: 'this Mac', resumes: 1 }
    expect(recordInEndpointWait({ ...base, endpointWait: { ...w, state: 'waiting' } } as SessionRecord)).toBe(true)
    // A continue whose turn ended cleanly: its notices are due, before the waiter closes the wait.
    expect(recordInEndpointWait({ ...base, endpointWait: { ...w, state: 'resumed' } } as SessionRecord)).toBe(false)
    expect(recordInEndpointWait({ ...base, process_status: 'error', errorMessage: REFUSED, endpointWait: { ...w, state: 'resumed' } } as SessionRecord)).toBe(true)
    expect(recordInEndpointWait({ ...base, endpointWait: { ...w, state: 'gave_up' } } as SessionRecord)).toBe(false)
    // No waiter runs here (this test started none): an unreachable error alone holds nothing.
    expect(recordInEndpointWait({ ...base, process_status: 'error', errorMessage: REFUSED, statusUpdatedAt: new Date().toISOString() } as SessionRecord)).toBe(false)
  })

  it('a host that stays away gives up naming the machine, not the endpoint', async () => {
    const r = rig({ probe: () => ({ kind: 'offline' }) })
    await r.result({ isError: true, result: REFUSED })
    await r.advance(30 * MIN)
    expect(statusOf(r.rec).waitingOn).toMatch(/^This (Mac|machine), to connect again/)
    await r.advance(6 * 60 * MIN)
    expect(r.gaveUp[0]).toMatch(/^This (Mac|machine) has not been connected since 2026-11-03 14:00 UTC/)
  })

  it('a message from anyone else ends the wait: they drive the session now', async () => {
    const r = rig()
    await r.result({ isError: true, result: REFUSED })
    await r.emit(EventNames.SESSION_SEND, { sessionId: SID }, 'web-ui')
    expect(r.rec.endpointWait).toBeUndefined()
    await r.advance(60 * MIN)
    expect(r.probes()).toBe(0)
    expect(r.sent).toEqual([])
  })

  it('gives up after six hours and names the machine and the endpoint', async () => {
    const r = rig()
    await r.result({ isError: true, result: REFUSED })
    await r.advance(5 * 60 * MIN)
    expect(r.gaveUp).toEqual([])
    await r.advance(61 * MIN)
    expect(r.rec.endpointWait).toMatchObject({ state: 'gave_up', gaveUpWhy: 'time' })
    expect(r.gaveUp).toHaveLength(1)
    expect(r.gaveUp[0]).toMatch(/model endpoint http:\/\/127\.0\.0\.1:8402 on this (Mac|machine) has not answered since 2026-11-03 14:00 UTC/)
    expect(r.sent).toEqual([])
    // A gave-up wait is its lead's to retry (2026-11-09), the user's only with no one above the task.
    const lead = statusOf(r.rec)
    expect(lead).toMatchObject({ state: 'waiting', kind: 'lead' })
    expect(lead.waitingOn).toContain('Walnut stopped waiting for its model endpoint')
    const needs = statusOf(r.rec, false)
    expect(needs.state).toBe('needs')
    expect(needs.ask).toContain('http://127.0.0.1:8402')
    // A gave-up wait no longer holds the turn's notices: the failure is its lead's now.
    expect(recordInEndpointWait(r.rec)).toBe(false)
    const probesAtGiveUp = r.probes()
    await r.advance(60 * MIN)
    expect(r.probes()).toBe(probesAtGiveUp)
  })

  it(`gives up after ${ENDPOINT_WAIT_MAX_RESUMES} continues that ended unreachable again`, async () => {
    const r = rig({ probe: () => ({ kind: 'probed', url: 'http://127.0.0.1:8402', probed: 'http://127.0.0.1:8402', reachable: true }) })
    await r.result({ isError: true, result: REFUSED })
    for (let i = 1; i <= ENDPOINT_WAIT_MAX_RESUMES; i++) {
      await r.advance(1 * MIN)
      expect(r.sent).toHaveLength(i)
      await r.result({ isError: true, result: REFUSED })
    }
    expect(r.rec.endpointWait).toMatchObject({ state: 'gave_up', gaveUpWhy: 'resumes', resumes: ENDPOINT_WAIT_MAX_RESUMES })
    expect(r.gaveUp[0]).toContain('still could not reach it')
    await r.advance(60 * MIN)
    expect(r.sent).toHaveLength(ENDPOINT_WAIT_MAX_RESUMES)
  })

  it('a daemon that cannot probe gets a continue on a timer, a few times only', async () => {
    const r = rig({ probe: () => ({ kind: 'unsupported' }) })
    await r.result({ isError: true, result: REFUSED })
    await r.advance(2 * MIN)
    expect(r.sent).toEqual([])
    await r.advance(2 * MIN)
    expect(r.sent).toHaveLength(1)
    // Each blind continue fails the same way and the wait goes on.
    await r.result({ isError: true, result: REFUSED })
    await r.advance(6 * 60 * MIN)
    expect(r.sent.length).toBeLessThanOrEqual(4)
    expect(r.rec.endpointWait?.state).toBe('gave_up')
  })

  it('an offline host is looked at again calmly, never continued blind', async () => {
    const r = rig({ probe: () => ({ kind: 'offline' }) })
    await r.result({ isError: true, result: REFUSED })
    await r.advance(30 * MIN)
    expect(r.sent).toEqual([])
    expect(r.probes()).toBeLessThanOrEqual(16)
  })

  it('takes nothing but an unreachable endpoint at a real turn end', async () => {
    for (const res of [
      { isError: true, result: 'API Error: 401 Unauthorized' },
      { isError: true, result: 'API Error: Request timed out' },
      { isError: true, result: REFUSED, detachedBgActive: true },
      { isError: false, result: 'ok' },
    ]) {
      const r = rig()
      await r.result(res)
      expect(r.rec.endpointWait, JSON.stringify(res)).toBeUndefined()
    }
  })

  it('picks up an open wait after a restart', async () => {
    const r = rig({ probe: () => ({ kind: 'probed', url: 'http://127.0.0.1:8402', probed: 'http://127.0.0.1:8402', reachable: true }) })
    r.rec.endpointWait = { state: 'waiting', since: '2026-11-03T13:50:00Z', host: '__local__', where: 'this Mac', resumes: 0 } as SessionEndpointWait
    expect(await r.waiter.resumeOpen()).toBe(1)
    await r.advance(10_000)
    expect(r.sent).toHaveLength(1)
  })

  it('WALNUT_ENDPOINT_WAIT=0 turns it off', async () => {
    process.env.WALNUT_ENDPOINT_WAIT = '0'
    const r = rig()
    await r.result({ isError: true, result: REFUSED })
    expect(r.rec.endpointWait).toBeUndefined()
    expect(recordInEndpointWait(r.rec)).toBe(false)
    delete process.env.WALNUT_ENDPOINT_WAIT
  })
})

describe('the status of a task whose turn could not reach its endpoint', () => {
  const base = { hasSession: true, processStatus: 'error', errorMessage: REFUSED, errorReason: 'api_error' }
  const wait = { state: 'waiting' as const, where: 'this Mac', since: '2026-11-03T14:00:00Z', url: 'http://127.0.0.1:8402', resumes: 0 }

  it.each(['NEED_ACTION', 'IN_PROGRESS', 'WAITING'])('reads Waiting on its machine in %s, with a lead or without', (phase) => {
    for (const hasLeader of [true, false]) {
      const s = deriveUserStatus({ ...base, phase, hasLeader, endpointWait: wait })
      expect(s.state, `${phase} lead=${hasLeader}`).toBe('waiting')
      expect(s.kind).toBe('machine')
      expect(s.stoppedBy).toBe('machine')
    }
  })

  it('without the wait the same error is the user\'s to retry (what it read before)', () => {
    const s = deriveUserStatus({ ...base, phase: 'NEED_ACTION', hasLeader: false })
    expect(s.state).toBe('needs')
  })

  it('a turn running again reads Working, and an ask of its own still speaks', () => {
    expect(deriveUserStatus({ ...base, phase: 'IN_PROGRESS', processStatus: 'running', endpointWait: wait }).state).toBe('working')
    const ask = { state: 'needs' as const, ask: 'Pick the release name', at: new Date().toISOString() }
    expect(deriveUserStatus({ ...base, phase: 'NEED_ACTION', endpointWait: wait, report: ask, statusSince: '2026-11-03T13:00:00Z' }).state).toBe('needs')
  })
})
