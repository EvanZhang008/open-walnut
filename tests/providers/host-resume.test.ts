/**
 * A legacy session at rest, handed to its host as a resume (src/providers/host-resume.ts): the
 * at-rest decision (each reason that keeps a session legacy), and the runner's delivery with it:
 * handed with its lines when at rest, the legacy path when not, once after a refusal, and after a
 * lost answer either the host's (its born row) or the legacy path once (the lost-start time), never
 * both.
 *
 * Real: SessionRunner and its processNext, the session store, the disk queue, judge-of and the
 * hand-over's claim. Faked: the leader side's requests to the host, the daemon's status probe, and
 * the CLI (the harness records a legacy resume instead of spawning one).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMockConstants } from '../helpers/mock-constants.js'

const probe = vi.hoisted(() => ({ answer: { alive: false } as { alive: boolean } | null, calls: 0, gate: null as Promise<void> | null }))
vi.mock('../../src/constants.js', () => createMockConstants('walnut-host-resume'))
vi.mock('../../src/providers/daemon-connection.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  disconnectAllDaemons: vi.fn(),
  probeDaemonSession: vi.fn(async () => { probe.calls++; if (probe.gate) await probe.gate; return probe.answer }),
}))
vi.mock('../../src/providers/cloud-session-link.js', () => ({ CloudSessionLink: vi.fn() }))

import { SID, harness, probeSetup, probeTeardown, settle, type Harness } from '../helpers/runner-probe-harness.js'
import { notAtRestReason, resumeHostOf, _resetHostResumeForTesting, type RestFacts } from '../../src/providers/host-resume.js'
import { _resetHostJudgedRunnerForTesting, noteHostStartBorn } from '../../src/providers/host-judged-runner.js'
import { HOST_START_LOST_REASON, _resetHostHandOverForTesting, handOverPending, handStartToHost, noteHostLinked, takeSessionBack } from '../../src/providers/host-handover.js'
import { handsNow } from '../../src/core/session-channel/handed-sessions.js'
import { applyHostChannelBatch } from '../../src/core/session-tracker.js'
import { _resetHostJudgedSendForTesting, _waitingForTesting, redeliverWaitingFor } from '../../src/providers/host-judged-send.js'
import { rearmHandOversAtBoot } from '../../src/providers/host-resume.js'
import { clearHandOverMark } from '../../src/core/session-channel/handover-marks.js'
import { hostStartedSaid } from '../../src/core/session-channel/leader-tasks.js'
import { ClaudeCodeSession } from '../../src/providers/claude-code-session.js'
import { _resetJudgeOfForTesting, judgingHostOf, setHostJudgeProbe } from '../../src/core/sessions/judge-of.js'
import { _setActiveLeaderSideForTesting, _setHostResumesForTesting } from '../../src/core/session-channel/leader-boot.js'
import { _setHostSwitchForTesting } from '../../src/core/session-channel/resume-hosts.js'
import { _resetHostSessionTasksForTesting } from '../../src/core/session-channel/leader-tasks.js'
import { _resetRemoteJudgedSessionsForTesting } from '../../src/providers/remote-judged-session.js'
import { HostRequestNotSent, type LeaderSide } from '../../src/core/session-channel/leader-side.js'
import { createSessionRecord, getSessionByClaudeId, updateSessionRecord } from '../../src/core/session-tracker.js'
import { enqueueMessage, getQueue } from '../../src/core/session-message-queue.js'
import { bus, EventNames } from '../../src/core/event-bus.js'

describe('the at-rest decision', () => {
  const rest: RestFacts = {
    row: { host: 'devbox' }, hostResumes: true, sdk: false, wrapperLive: false, turnInFlight: false,
    restartInFlight: false, preparing: false, transferRunning: false, lineOut: false, linesWaiting: true, cli: false,
  }
  it('a session nothing of which runs anywhere is at rest', () => {
    expect(notAtRestReason(rest)).toBeNull()
  })
  it.each<[string, Partial<RestFacts>]>([
    ['no_row', { row: null }],
    ['host_judged', { row: { host: 'devbox', judge: 'host' } }],
    ['acp_engine', { row: { host: 'devbox', engine: 'codex' } }],
    ['host_takes_no_resume', { hostResumes: false }],
    ['sdk_session', { sdk: true }],
    ['live_process', { wrapperLive: true }],
    ['turn_in_flight', { turnInFlight: true }],
    ['restart_in_flight', { restartInFlight: true }],
    ['delivery_preparing', { preparing: true }],
    ['start_in_flight', { row: { host: 'devbox', status_reason: 'awaiting_spawn' } }],
    ['start_in_flight', { row: { host: 'devbox', status_reason: 'spawn_outcome_unknown' } }],
    ['stop_pending', { row: { host: 'devbox', stopRequest: { state: 'pending' } as never } }],
    ['transfer_running', { transferRunning: true }],
    ['line_out', { lineOut: true }],
    ['nothing_waiting', { linesWaiting: false }],
    ['cli_alive', { cli: true }],
    ['cli_unknown', { cli: null }],
  ])('%s keeps it legacy', (why, change) => {
    expect(notAtRestReason({ ...rest, ...change })).toBe(why)
  })
})

function fakeSide(o: { refuse?: boolean; lost?: boolean; notSent?: boolean; sendAnswer?: Record<string, unknown>; interruptAnswer?: Record<string, unknown>; unlinked?: boolean } = {}) {
  const sent: Array<{ op: string; host: string; body: Record<string, any> }> = []
  const side = {
    startOnHost: async (host: string, body: Record<string, unknown>) => {
      sent.push({ op: 'start', host, body })
      if (o.notSent) throw new HostRequestNotSent(host, new Error('the host devbox is not connected'))
      if (o.lost) throw new Error('request timed out after 120000 ms')
      if (o.refuse) return { ok: false, error: 'the session is not at rest on this host', why: 'not_at_rest' }
      return { ok: true, sessionId: body.resumeSessionId as string, title: '' }
    },
    // A host that does not own the session yet answers its sends so (host-routes.ts NOT_OWN_SESSION).
    sendToHost: async (host: string, body: Record<string, unknown>) => { sent.push({ op: 'send', host, body }); return o.sendAnswer ?? { ok: true } },
    interruptOnHost: async (host: string, body: Record<string, unknown>) => { sent.push({ op: 'interrupt', host, body }); return o.interruptAnswer ?? { ok: true } },
    callHost: async () => null,
    // The host's session channel is linked (a re-armed hand-over's clock runs at once).
    linked: () => o.unlinked !== true,
  }
  _setActiveLeaderSideForTesting(side as unknown as LeaderSide)
  return { sent }
}

/** A legacy session of devbox that ended: its record stopped, the runner's object of it dead. */
async function legacyAtRest(o: { running?: boolean } = {}): Promise<Harness> {
  const h = harness({ running: o.running ?? false })
  if (!o.running) Object.assign(h.session, { _active: false, _transport: undefined, pid: null })
  await updateSessionRecord(SID, { host: 'devbox', process_status: 'stopped', pid: undefined } as never)
  h.runner.init()
  await settle(100)
  await enqueueMessage(SID, 'hello again', { id: 'qm-rest-1', sentBy: 'person' })
  return h
}

const kick = () => bus.emit(EventNames.SESSION_SEND, { sessionId: SID, message: 'hello again' }, ['*'], { source: 'ui' })
const found = (h: Harness) => (h.internals.sessions as Map<string, unknown>).size

beforeEach(async () => {
  await probeSetup()
  _resetJudgeOfForTesting()
  _resetRemoteJudgedSessionsForTesting()
  _resetHostJudgedRunnerForTesting()
  _resetHostSessionTasksForTesting()
  _resetHostResumeForTesting()
  probe.answer = { alive: false }
  probe.calls = 0
  probe.gate = null
  setHostJudgeProbe((host) => host === 'devbox')
  _setHostSwitchForTesting((host) => host === 'devbox')
  _setHostResumesForTesting('devbox', true)
})
afterEach(async () => {
  // No lost check or release outlives its test (its store is gone after the teardown).
  _resetHostJudgedRunnerForTesting()
  _setActiveLeaderSideForTesting(null)
  _resetJudgeOfForTesting()
  _resetRemoteJudgedSessionsForTesting()
  delete process.env.WALNUT_HOST_START_LOST_MS
  await probeTeardown()
})

describe('a send to a legacy session at rest on a host that judges', () => {
  it('goes to the host as a resume with its lines; the row is the host\'s and nothing runs here', async () => {
    const h = await legacyAtRest()
    const { sent } = fakeSide()
    kick()
    await vi.waitFor(() => expect(sent.filter((s) => s.op === 'start')).toHaveLength(1))
    const body = sent[0].body
    expect(body).toMatchObject({ resumeSessionId: SID, message: '', resumeRow: { claudeSessionId: SID, host: 'devbox', judge: 'host' } })
    expect(body.queued).toEqual([{ id: 'qm-rest-1', message: 'hello again', sentBy: 'person' }])
    await vi.waitFor(async () => expect(await getQueue(SID)).toEqual([]))
    expect((await getSessionByClaudeId(SID))?.judge).toBe('host')
    expect(judgingHostOf(SID)).toBe('devbox')
    await settle(50)
    expect(h.resumes).toEqual([])
    expect(h.writes).toEqual([])
    // The runner's dead object of it is gone: its lookups answer the host's proxy.
    expect(found(h)).toBe(0)
    // Host-judged now: the next send is a plain send to the host.
    await enqueueMessage(SID, 'and more', { id: 'qm-rest-2', sentBy: 'person' })
    bus.emit(EventNames.SESSION_SEND, { sessionId: SID, message: 'and more' }, ['*'], { source: 'ui' })
    await vi.waitFor(() => expect(sent.filter((s) => s.op === 'send')).toHaveLength(1))
  })

  it('a refusal delivers it here, once, and the row stays the leader\'s', async () => {
    const h = await legacyAtRest()
    const { sent } = fakeSide({ refuse: true })
    kick()
    await vi.waitFor(() => expect(h.resumes).toHaveLength(1), { timeout: 8000 })
    expect(h.resumes[0]).toContain('hello again')
    expect(sent.filter((s) => s.op === 'start')).toHaveLength(1)
    expect((await getSessionByClaudeId(SID))?.judge).toBeUndefined()
    expect(judgingHostOf(SID)).toBeNull()
    // Held legacy: the same session is not handed again at once.
    expect(resumeHostOf(SID)).toBeNull()
    await settle(80)
    expect(h.resumes).toHaveLength(1)
  })

  it('a resume that never reached the host is delivered here', async () => {
    const h = await legacyAtRest()
    fakeSide({ notSent: true })
    kick()
    await vi.waitFor(() => expect(h.resumes).toHaveLength(1), { timeout: 8000 })
    expect((await getSessionByClaudeId(SID))?.judge).toBeUndefined()
  })

  it('a lost answer with no born row: nothing runs here until the lost-start time, then (the host does not hold it) the legacy resume, once', async () => {
    process.env.WALNUT_HOST_START_LOST_MS = '150'
    const h = await legacyAtRest()
    const { sent } = fakeSide({ lost: true, sendAnswer: { ok: false, error: 'not_own_session' } })
    kick()
    await vi.waitFor(() => expect(sent.filter((s) => s.op === 'start')).toHaveLength(1))
    await vi.waitFor(async () => expect((await getQueue(SID)).map((m) => `${m.id}:${m.status}`)).toEqual(['qm-rest-1:pending']))
    expect(judgingHostOf(SID)).toBe('devbox')
    await settle(40)
    expect(h.resumes).toEqual([])
    await vi.waitFor(() => expect(h.resumes).toHaveLength(1), { timeout: 3_000 })
    expect((await getSessionByClaudeId(SID))?.judge).toBeUndefined()
    await settle(200)
    expect(h.resumes).toHaveLength(1)
  })

  it('a lost answer whose born row comes: its lines go to the host again, nothing runs here', async () => {
    process.env.WALNUT_HOST_START_LOST_MS = '150'
    const h = await legacyAtRest()
    const { sent } = fakeSide({ lost: true })
    kick()
    await vi.waitFor(() => expect(sent.filter((s) => s.op === 'start')).toHaveLength(1))
    await settle(20)
    noteHostStartBorn(SID)
    await vi.waitFor(() => expect(sent.filter((s) => s.op === 'send')).toHaveLength(1))
    expect(sent.find((s) => s.op === 'send')!.body.queued).toEqual([{ id: 'qm-rest-1', message: 'hello again', sentBy: 'person' }])
    await settle(300)
    expect(h.resumes).toEqual([])
    expect((await getSessionByClaudeId(SID))?.judge).toBe('host')
  })
})

describe('a session that is not at rest, or a host that does not judge, stays legacy', () => {
  it.each<[string, () => void]>([
    ['the switch is off for its host', () => { setHostJudgeProbe(() => false); _setHostSwitchForTesting(() => false) }],
    ['its host\'s service is not linked or does not judge', () => setHostJudgeProbe(() => false)],
    ['its host takes no resume (an older service)', () => _setHostResumesForTesting('devbox', false)],
    ['its CLI runs on the host', () => { probe.answer = { alive: true } }],
    ['the host\'s runtime gives no answer', () => { probe.answer = null }],
  ])('%s', async (_name, arrange) => {
    const h = await legacyAtRest()
    const { sent } = fakeSide()
    arrange()
    kick()
    await vi.waitFor(() => expect(h.resumes).toHaveLength(1), { timeout: 8000 })
    expect(sent).toEqual([])
    expect((await getSessionByClaudeId(SID))?.judge).toBeUndefined()
  })

  it('the switch off asks the host\'s runtime nothing', async () => {
    setHostJudgeProbe(() => false)
    _setHostSwitchForTesting(() => false)
    const h = await legacyAtRest()
    fakeSide()
    kick()
    await vi.waitFor(() => expect(h.resumes).toHaveLength(1), { timeout: 8000 })
    expect(probe.calls).toBe(0)
  })

  it('a live CLI here is written to, never handed over', async () => {
    const h = await legacyAtRest({ running: true })
    const { sent } = fakeSide()
    kick()
    await vi.waitFor(() => expect(h.writes).toHaveLength(1), { timeout: 8000 })
    expect(sent).toEqual([])
    expect(h.resumes).toEqual([])
  })

  it('an ACP session stays legacy', async () => {
    const h = await legacyAtRest()
    await updateSessionRecord(SID, { engine: 'codex' } as never)
    const { sent } = fakeSide()
    kick()
    await settle(200)
    expect(sent).toEqual([])
    // Never down the Claude path either (acp-native-guard.ts).
    expect(h.resumes).toEqual([])
  })
})

describe('B1: while the host has not answered, the session is neither the host\'s for sends nor parked', () => {
  /** A resume whose answer was lost, its lines waiting here; the host does not own the session yet. */
  async function unanswered(lostMs = 5_000) {
    process.env.WALNUT_HOST_START_LOST_MS = String(lostMs)
    const h = await legacyAtRest()
    const side = fakeSide({ lost: true, sendAnswer: { ok: false, error: 'not_own_session' } })
    kick()
    await vi.waitFor(() => expect(side.sent.filter((s) => s.op === 'start')).toHaveLength(1))
    await vi.waitFor(() => expect(handOverPending(SID)).toBe(true))
    return { h, ...side }
  }
  const sends = (sent: Array<{ op: string }>) => sent.filter((s) => s.op === 'send')

  it('a send in the window waits here: never sent, never counted as a refusal, never parked; the host\'s row sends every line once', async () => {
    const { h, sent } = await unanswered()
    await enqueueMessage(SID, 'and one more', { id: 'qm-rest-2', sentBy: 'person' })
    bus.emit(EventNames.SESSION_SEND, { sessionId: SID, message: 'and one more' }, ['*'], { source: 'ui' })
    await settle(150)
    expect(sends(sent)).toEqual([])
    expect(_waitingForTesting(SID).refusals).toBe(0)
    expect((await getQueue(SID)).map((m) => `${m.id}:${m.status}`)).toEqual(['qm-rest-1:pending', 'qm-rest-2:pending'])
    // The host's row: the window ends, every line goes to it once (by id: a no-op for those it has).
    fakeSide()
    noteHostStartBorn(SID)
    await vi.waitFor(async () => expect(await getQueue(SID)).toEqual([]))
    expect(h.resumes).toEqual([])
    expect((await getSessionByClaudeId(SID))?.judge).toBe('host')
  })

  it('a relink in the window sends nothing (the redelivery waits too)', async () => {
    const { sent } = await unanswered()
    await redeliverWaitingFor('devbox')
    await settle(60)
    expect(sends(sent)).toEqual([])
    expect(_waitingForTesting(SID).refusals).toBe(0)
  })

  it('the host\'s row cleared on disk (the channel\'s transaction) ends the window though this process missed it', async () => {
    const { h } = await unanswered(150)
    fakeSide()
    clearHandOverMark(SID)
    await settle(400)
    expect(h.resumes).toEqual([])
    expect((await getSessionByClaudeId(SID))?.judge).toBe('host')
    await vi.waitFor(async () => expect(await getQueue(SID)).toEqual([]))
  })

  it('a leader restart in the window keeps it waiting, and its lost check runs again at boot', async () => {
    const { h, sent } = await unanswered()
    // The restart: what lived in memory goes, the hand-over's mark stays on disk.
    _resetHostHandOverForTesting({ keepDisk: true })
    _resetJudgeOfForTesting()
    _resetHostSessionTasksForTesting()
    _resetHostJudgedSendForTesting()
    _resetHostResumeForTesting()
    // A delivery before the boot armed it again (the first thing that asks after the restart): not
    // run here, not sent.
    await h.runner.processNext(SID)
    await settle(300)
    expect(handOverPending(SID)).toBe(true)
    expect(judgingHostOf(SID)).toBe('devbox')
    expect(h.resumes).toEqual([])
    expect(sends(sent)).toEqual([])
    process.env.WALNUT_HOST_START_LOST_MS = '150'
    expect(await rearmHandOversAtBoot(h.runner)).toBe(1)
    // A resume: its born row says no session:started here (N3).
    expect(hostStartedSaid(SID)).toBe(true)
    // No row from the host, its runtime runs no CLI of it: delivered here, once.
    await vi.waitFor(() => expect(h.resumes).toHaveLength(1), { timeout: 3_000 })
    expect(handOverPending(SID)).toBe(false)
    expect((await getSessionByClaudeId(SID))?.judge).toBeUndefined()
    await settle(200)
    expect(h.resumes).toHaveLength(1)
  })
})

describe('S2: the lost check resumes here only when the host\'s runtime runs no CLI of it', () => {
  it.each<[string, { alive: boolean } | null]>([['its CLI runs there', { alive: true }], ['the host\'s runtime gives no answer', null]])('%s: it waits on, nothing runs here', async (_name, answer) => {
    process.env.WALNUT_HOST_START_LOST_MS = '120'
    const h = await legacyAtRest()
    // The host says it does not own it: the runtime's word decides.
    fakeSide({ lost: true, sendAnswer: { ok: false, error: 'not_own_session' } })
    kick()
    await vi.waitFor(() => expect(handOverPending(SID)).toBe(true))
    probe.answer = answer
    const before = probe.calls
    // Past two waits: asked each time, never resumed here.
    await vi.waitFor(() => expect(probe.calls).toBeGreaterThanOrEqual(before + 2), { timeout: 3_000 })
    expect(h.resumes).toEqual([])
    expect(handOverPending(SID)).toBe(true)
    expect((await getSessionByClaudeId(SID))?.judge).toBe('host')
    // The CLI ended there with no row of it here: the next check delivers here, once.
    probe.answer = { alive: false }
    await vi.waitFor(() => expect(h.resumes).toHaveLength(1), { timeout: 3_000 })
    expect((await getSessionByClaudeId(SID))?.judge).toBeUndefined()
  })
})

describe('S3, N1, N3: the hand-over\'s own checks', () => {
  it('S3: a Restart begun while the host\'s runtime was asked keeps the session legacy', async () => {
    const h = await legacyAtRest()
    const { sent } = fakeSide()
    let open!: () => void
    probe.gate = new Promise<void>((r) => { open = r })
    kick()
    await vi.waitFor(() => expect(probe.calls).toBe(1))
    const restarts = (h.runner as unknown as { nativeSessionReinitializations: Map<string, Promise<void>> }).nativeSessionReinitializations
    restarts.set(SID, new Promise<void>((r) => setTimeout(() => { restarts.delete(SID); r() }, 50)))
    open()
    await vi.waitFor(() => expect(h.resumes).toHaveLength(1), { timeout: 8000 })
    expect(sent).toEqual([])
    expect((await getSessionByClaudeId(SID))?.judge).toBeUndefined()
  })

  it('N1: a delivery with no line waiting hands nothing over and asks the host nothing', async () => {
    const h = await legacyAtRest()
    const { sent } = fakeSide()
    const { removeProcessed, deleteMessage } = await import('../../src/core/session-message-queue.js')
    await deleteMessage(SID, 'qm-rest-1')
    await removeProcessed(SID)
    await h.runner.processNext(SID)
    await settle(80)
    expect(sent).toEqual([])
    expect(probe.calls).toBe(0)
    expect((await getSessionByClaudeId(SID))?.judge).toBeUndefined()
  })

  it('N3: a resume that falls back leaves no session:started claim behind', async () => {
    const h = await legacyAtRest()
    fakeSide({ refuse: true })
    kick()
    await vi.waitFor(() => expect(h.resumes).toHaveLength(1), { timeout: 8000 })
    expect(hostStartedSaid(SID)).toBe(false)
  })
})

describe('S4: the runner lets go of every object of a session it hands over', () => {
  it('a stopped object that still has a pipe is dropped and detached, so lookups answer the host\'s proxy', async () => {
    const h = await legacyAtRest()
    const detach = vi.fn()
    Object.assign(h.session, { _active: false, _processStatus: 'stopped', _transport: { hasPipe: true, detach, stopTail: () => {} } })
    expect(h.runner.holdsLiveSession(SID)).toBe(false)
    h.runner.resumeView().dropDeadWrapper(SID)
    expect(found(h)).toBe(0)
    expect(detach).toHaveBeenCalled()
  })

  it('a live object is never dropped', async () => {
    const h = await legacyAtRest({ running: true })
    h.runner.resumeView().dropDeadWrapper(SID)
    expect(found(h)).toBe(1)
    expect(h.session).toBeInstanceOf(ClaudeCodeSession)
  })
})

describe('S-A: a host-judged session whose host no longer holds it is never stuck', () => {
  beforeEach(() => { process.env.WALNUT_HOST_DISOWN_CONFIRM_MS = '20' })
  afterEach(() => { delete process.env.WALNUT_HOST_DISOWN_CONFIRM_MS })
  const NOT_OWN = { ok: false, error: 'not_own_session' }

  /** A session the host resumed: host-judged, its hand-over answered. */
  async function hostJudged() {
    const h = await legacyAtRest()
    fakeSide()
    kick()
    await vi.waitFor(async () => expect((await getSessionByClaudeId(SID))?.judge).toBe('host'), { timeout: 5_000 })
    await vi.waitFor(async () => expect(await getQueue(SID)).toEqual([]), { timeout: 5_000 })
    await vi.waitFor(() => expect(handOverPending(SID)).toBe(false), { timeout: 5_000 })
    return h
  }

  it('a send its host refuses as not its own, confirmed once, takes it back; the next delivery hands it over again with the line, once, never parked', async () => {
    const h = await hostJudged()
    const { sent } = fakeSide({ sendAnswer: NOT_OWN })
    await enqueueMessage(SID, 'after the reset', { id: 'qm-rest-3', sentBy: 'person' })
    bus.emit(EventNames.SESSION_SEND, { sessionId: SID, message: 'after the reset' }, ['*'], { source: 'ui' })
    await vi.waitFor(() => expect(sent.filter((x) => x.op === 'start')).toHaveLength(1), { timeout: 5_000 })
    const again = sent.find((x) => x.op === 'start')!.body
    expect(again).toMatchObject({ resumeSessionId: SID })
    expect((again.queued as Array<{ id: string }>).map((l) => l.id)).toEqual(['qm-rest-3'])
    await vi.waitFor(async () => expect(await getQueue(SID)).toEqual([]))
    expect((await getSessionByClaudeId(SID))?.judge).toBe('host')
    // The send, then the one confirmation: never counted as a refusal, never parked, never run here.
    expect(sent.filter((x) => x.op === 'send')).toHaveLength(2)
    expect(_waitingForTesting(SID).refusals).toBe(0)
    expect(h.resumes).toEqual([])
  })

  it('a host that holds it after all (the second answer is yes) keeps it', async () => {
    await hostJudged()
    let calls = 0
    _setActiveLeaderSideForTesting({
      startOnHost: async () => { throw new Error('no start expected') },
      sendToHost: async () => (++calls === 1 ? NOT_OWN : { ok: true }),
      interruptOnHost: async () => ({ ok: true }), callHost: async () => null,
    } as unknown as LeaderSide)
    await enqueueMessage(SID, 'still yours', { id: 'qm-rest-4', sentBy: 'person' })
    bus.emit(EventNames.SESSION_SEND, { sessionId: SID, message: 'still yours' }, ['*'], { source: 'ui' })
    await vi.waitFor(() => expect(calls).toBeGreaterThanOrEqual(2), { timeout: 5_000 })
    await settle(80)
    expect((await getSessionByClaudeId(SID))?.judge).toBe('host')
    expect(judgingHostOf(SID)).toBe('devbox')
  })

  it('an interrupt refused the same way goes through the same recovery', async () => {
    await hostJudged()
    fakeSide({ interruptAnswer: NOT_OWN, sendAnswer: NOT_OWN })
    bus.emit(EventNames.SESSION_INTERRUPT, { sessionId: SID }, ['*'], { source: 'ui' })
    await vi.waitFor(async () => expect((await getSessionByClaudeId(SID))?.judge).toBeUndefined(), { timeout: 5_000 })
    expect(judgingHostOf(SID)).toBeNull()
  })
})

describe('the hand of a hand-over (handed-sessions.ts): a resume hands its session, a take-back drops it', () => {
  const hostRow = (host: string) => ({ claudeSessionId: SID, taskId: '', project: 'test', host, judge: 'host', process_status: 'running', startedAt: 'x', lastActiveAt: 'x', messageCount: 3 })
  it('a resume records the hand; the host\'s whole row of it applies, another host\'s does not; a take-back drops the hand', async () => {
    await legacyAtRest()
    fakeSide()
    kick()
    await vi.waitFor(async () => expect((await getSessionByClaudeId(SID))?.judge).toBe('host'), { timeout: 5_000 })
    expect(handsNow().filter((x) => x.sid === SID)).toEqual([{ host: 'devbox', sid: SID }])
    // The host claims the leader's row (now the host's): its row, as a resume's first record, applies.
    expect((await applyHostChannelBatch({ hostId: 'devbox', renames: [], cursor: { logId: 'L-r', seq: 1 }, rows: [{ sid: SID, born: true, patch: hostRow('devbox'), seq: 1 }] })).written).toEqual([SID])
    expect((await applyHostChannelBatch({ hostId: 'devbox-b', renames: [], cursor: { logId: 'L-b', seq: 1 }, rows: [{ sid: SID, born: true, patch: hostRow('devbox-b'), seq: 1 }] })).written).toEqual([])
    // Taken back (a host that disowns it): no hand of it stands for that host.
    await handStartToHost(SID, 'devbox', 'resume')
    expect(handsNow().some((x) => x.sid === SID)).toBe(true)
    await takeSessionBack(SID, 'devbox')
    expect(handsNow().filter((x) => x.sid === SID)).toEqual([])
  })
})

describe('S-B, N1: a start re-armed at boot', () => {
  const SEED = '30000000-0000-4000-8000-0000000000b7'
  /** A start handed to devbox whose answer never came, then a leader restart. */
  async function restartedWithStart() {
    process.env.WALNUT_HOST_START_LOST_MS = '100'
    await legacyAtRest()
    await createSessionRecord(SEED, '', 'test', '/w', { host: 'devbox', initialProcessStatus: 'idle', initialStatusReason: 'awaiting_spawn' } as never)
    expect(await handStartToHost(SEED, 'devbox', 'start')).toBe(true)
    expect(handsNow().filter((x) => x.sid === SEED)).toEqual([{ host: 'devbox', sid: SEED }])
    await enqueueMessage(SEED, 'while it starts', { id: 'qm-seed-1', sentBy: 'person' })
    _resetHostHandOverForTesting({ keepDisk: true })
    _resetJudgeOfForTesting()
    const failed = vi.fn(async () => {})
    return { failed, runner: { resumeView: () => { throw new Error('no resume here') }, failLostHostStart: failed } }
  }

  it('its clock waits for the host\'s first link; then the host says it holds it: the host\'s, never failed', async () => {
    const { failed, runner } = await restartedWithStart()
    const { sent } = fakeSide({ unlinked: true })
    expect(await rearmHandOversAtBoot(runner as never)).toBe(1)
    await settle(300)
    // No link yet: nothing asked, nothing failed.
    expect(handOverPending(SEED)).toBe(true)
    expect(sent).toEqual([])
    noteHostLinked('devbox')
    await vi.waitFor(() => expect(handOverPending(SEED)).toBe(false), { timeout: 3_000 })
    expect(failed).not.toHaveBeenCalled()
    expect((await getSessionByClaudeId(SEED))?.judge).toBe('host')
  })

  it('the host does not hold it and its runtime runs no CLI of it: it fails, and the line sent meanwhile parks with why', async () => {
    const { failed, runner } = await restartedWithStart()
    fakeSide({ sendAnswer: { ok: false, error: 'not_own_session' } })
    await rearmHandOversAtBoot(runner as never)
    noteHostLinked('devbox')
    await vi.waitFor(() => expect(failed).toHaveBeenCalledTimes(1), { timeout: 3_000 })
    expect((await getSessionByClaudeId(SEED))?.judge).toBeUndefined()
    // The lost check took it back: its hand is gone, so a born row of it now is refused.
    expect(handsNow().filter((x) => x.sid === SEED)).toEqual([])
    await vi.waitFor(async () => expect((await getQueue(SEED)).map((m) => `${m.id}:${m.status}`)).toEqual(['qm-seed-1:parked']))
    expect((await getQueue(SEED))[0].parkedReason).toMatch(new RegExp(`^${HOST_START_LOST_REASON}`))
  })
})
