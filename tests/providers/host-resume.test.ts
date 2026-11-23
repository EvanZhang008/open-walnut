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

const probe = vi.hoisted(() => ({ answer: { alive: false } as { alive: boolean } | null, calls: 0 }))
vi.mock('../../src/constants.js', () => createMockConstants('walnut-host-resume'))
vi.mock('../../src/providers/daemon-connection.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  disconnectAllDaemons: vi.fn(),
  probeDaemonSession: vi.fn(async () => { probe.calls++; return probe.answer }),
}))
vi.mock('../../src/providers/cloud-session-link.js', () => ({ CloudSessionLink: vi.fn() }))

import { SID, harness, probeSetup, probeTeardown, settle, type Harness } from '../helpers/runner-probe-harness.js'
import { notAtRestReason, resumeHostOf, _resetHostResumeForTesting, type RestFacts } from '../../src/providers/host-resume.js'
import { _resetHostJudgedRunnerForTesting, noteHostStartBorn } from '../../src/providers/host-judged-runner.js'
import { _resetJudgeOfForTesting, judgingHostOf, setHostJudgeProbe } from '../../src/core/sessions/judge-of.js'
import { _setActiveLeaderSideForTesting, _setHostResumesForTesting } from '../../src/core/session-channel/leader-boot.js'
import { _resetHostSessionTasksForTesting } from '../../src/core/session-channel/leader-tasks.js'
import { _resetRemoteJudgedSessionsForTesting } from '../../src/providers/remote-judged-session.js'
import { HostRequestNotSent, type LeaderSide } from '../../src/core/session-channel/leader-side.js'
import { getSessionByClaudeId, updateSessionRecord } from '../../src/core/session-tracker.js'
import { enqueueMessage, getQueue } from '../../src/core/session-message-queue.js'
import { bus, EventNames } from '../../src/core/event-bus.js'

describe('the at-rest decision', () => {
  const rest: RestFacts = {
    row: { host: 'devbox' }, hostResumes: true, sdk: false, wrapperLive: false, turnInFlight: false,
    restartInFlight: false, preparing: false, transferRunning: false, lineOut: false, cli: false,
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
    ['cli_alive', { cli: true }],
    ['cli_unknown', { cli: null }],
  ])('%s keeps it legacy', (why, change) => {
    expect(notAtRestReason({ ...rest, ...change })).toBe(why)
  })
})

function fakeSide(o: { refuse?: boolean; lost?: boolean; notSent?: boolean } = {}) {
  const sent: Array<{ op: string; host: string; body: Record<string, any> }> = []
  const side = {
    startOnHost: async (host: string, body: Record<string, unknown>) => {
      sent.push({ op: 'start', host, body })
      if (o.notSent) throw new HostRequestNotSent(host, new Error('the host devbox is not connected'))
      if (o.lost) throw new Error('request timed out after 120000 ms')
      if (o.refuse) return { ok: false, error: 'the session is not at rest on this host', why: 'not_at_rest' }
      return { ok: true, sessionId: body.resumeSessionId as string, title: '' }
    },
    sendToHost: async (host: string, body: Record<string, unknown>) => { sent.push({ op: 'send', host, body }); return { ok: true } },
    interruptOnHost: async () => ({ ok: true }),
    callHost: async () => null,
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
  setHostJudgeProbe((host) => host === 'devbox')
  _setHostResumesForTesting('devbox', true)
})
afterEach(async () => {
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

  it('a lost answer with no born row: nothing runs here until the lost-start time, then the legacy resume, once', async () => {
    process.env.WALNUT_HOST_START_LOST_MS = '150'
    const h = await legacyAtRest()
    const { sent } = fakeSide({ lost: true })
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
    ['the switch is off for its host', () => setHostJudgeProbe(() => false)],
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
