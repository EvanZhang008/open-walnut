/**
 * A legacy ACP engine's session (Codex and the rest) at rest, handed to its host as a resume
 * (src/providers/host-resume.ts, "ACP"): only to a host whose service names session-resume-acp-v1,
 * asked before the runner attaches the session (an attach starts a worker), its runtime asked for
 * the worker by the row's runtime id, and the runner's ACP object counted live while it holds anything.
 *
 * Real: SessionRunner and its SESSION_SEND handling, the session store, the disk queue, judge-of and
 * the hand-over's claim. Faked: the leader side's requests to the host, the daemon's probes, and the
 * runner's ACP objects (plain stand-ins put in its map).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMockConstants } from '../helpers/mock-constants.js'

const probe = vi.hoisted(() => ({ acp: false as boolean | null, acpCalls: [] as string[], statusCalls: 0 }))
// A read waits for the host's first report at most this long here (claude-code-session.ts READ_HANDOVER_WAIT_MS).
vi.hoisted(() => { process.env.WALNUT_ACP_READ_HANDOVER_WAIT_MS = '300' })
vi.mock('../../src/constants.js', () => createMockConstants('walnut-host-resume-acp'))
vi.mock('../../src/providers/daemon-connection.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  disconnectAllDaemons: vi.fn(),
  probeDaemonSession: vi.fn(async () => { probe.statusCalls++; return { alive: false } }),
  probeAcpWorker: vi.fn(async (_host: string, runtimeId: string) => { probe.acpCalls.push(runtimeId); return probe.acp }),
}))
vi.mock('../../src/providers/cloud-session-link.js', () => ({ CloudSessionLink: vi.fn() }))

import { SID, harness, probeSetup, probeTeardown, settle, type Harness } from '../helpers/runner-probe-harness.js'
import { acpResumeHostOf, notAtRestReason, _resetHostResumeForTesting, type RestFacts } from '../../src/providers/host-resume.js'
import { _resetHostJudgedRunnerForTesting } from '../../src/providers/host-judged-runner.js'
import { _resetJudgeOfForTesting, judgingHostOf, noteHostJudged, setHostJudgeProbe } from '../../src/core/sessions/judge-of.js'
import { _setActiveLeaderSideForTesting } from '../../src/core/session-channel/leader-boot.js'
import { _setHostResumesForTesting, _setHostSwitchForTesting, forgetHostResumes } from '../../src/core/session-channel/resume-hosts.js'
import { _resetHostSessionTasksForTesting } from '../../src/core/session-channel/leader-tasks.js'
import { _resetRemoteJudgedSessionsForTesting } from '../../src/providers/remote-judged-session.js'
import { reportResumes, reportResumesAcp, type LeaderSide } from '../../src/core/session-channel/leader-side.js'
import { SESSION_JUDGE_CAP, SESSION_RESUME_ACP_CAP, SESSION_RESUME_CAP } from '../../src/core/session-channel/switch.js'
import { getSessionByClaudeId, updateSessionRecord } from '../../src/core/session-tracker.js'
import { enqueueMessage, getQueue } from '../../src/core/session-message-queue.js'
import { bus, EventNames } from '../../src/core/event-bus.js'

const RUNTIME = 'acp-0011223344556677'

describe('the at-rest decision of an ACP session', () => {
  const rest: RestFacts = {
    row: { host: 'devbox', engine: 'codex' }, hostResumes: true, hostResumesAcp: true, sdk: false, wrapperLive: false, turnInFlight: false,
    restartInFlight: false, preparing: false, transferRunning: false, lineOut: false, linesWaiting: true, cli: false,
  }
  it('at rest on a host that resumes ACP sessions', () => {
    expect(notAtRestReason(rest)).toBeNull()
  })
  it('legacy on a host that resumes only native sessions (an older service)', () => {
    expect(notAtRestReason({ ...rest, hostResumesAcp: false })).toBe('acp_engine')
    expect(notAtRestReason({ ...rest, hostResumesAcp: undefined })).toBe('acp_engine')
  })
  it('every other reason holds for it as for a native one', () => {
    expect(notAtRestReason({ ...rest, wrapperLive: true })).toBe('live_process')
    expect(notAtRestReason({ ...rest, cli: true })).toBe('cli_alive')
    expect(notAtRestReason({ ...rest, cli: null })).toBe('cli_unknown')
    expect(notAtRestReason({ ...rest, hostResumes: false })).toBe('host_takes_no_resume')
  })
})

describe('a host names an ACP resume only with the native one', () => {
  it.each([
    [[SESSION_JUDGE_CAP, SESSION_RESUME_CAP, SESSION_RESUME_ACP_CAP], true, true],
    [[SESSION_JUDGE_CAP, SESSION_RESUME_CAP], true, false],
    [[SESSION_JUDGE_CAP, SESSION_RESUME_ACP_CAP], false, false],
    [[], false, false],
  ])('%j', (capabilities, native, acp) => {
    expect(reportResumes({ capabilities })).toBe(native)
    expect(reportResumesAcp({ capabilities })).toBe(acp)
  })
})

function fakeSide(o: { refuse?: boolean } = {}) {
  const sent: Array<{ op: string; host: string; body: Record<string, any> }> = []
  _setActiveLeaderSideForTesting({
    startOnHost: async (host: string, body: Record<string, unknown>) => {
      sent.push({ op: 'start', host, body })
      if (o.refuse) return { ok: false, error: 'the session is not at rest on this host', why: 'not_at_rest' }
      return { ok: true, sessionId: body.resumeSessionId as string, title: '' }
    },
    sendToHost: async (host: string, body: Record<string, unknown>) => { sent.push({ op: 'send', host, body }); return { ok: true } },
    interruptOnHost: async () => ({ ok: true }),
    callHost: async () => null,
    linked: () => true,
  } as unknown as LeaderSide)
  return { sent }
}

/** A stand-in for the runner's ACP object of the session (what its at-rest test and its drop read). */
function acpObject(o: { active?: boolean; processing?: boolean; prompt?: boolean; afterTurn?: boolean; committing?: boolean } = {}) {
  return {
    sessionId: SID, runtimeId: RUNTIME, active: o.active === true, activity: o.processing ? 'processing' : 'idle',
    hasPendingPermission: o.prompt === true, outlivingWork: o.afterTurn ? ['background'] : [], cursorCommitting: o.committing === true,
    canSteer: false, hasTaken: () => false, detach: vi.fn(),
    // Its lifecycle contract, for a delivery that stays legacy (the runner's acpContract): sent nowhere here.
    establish: async () => SID, send: vi.fn(async () => {}), abortTurn: async () => {},
  }
}

/** The runner's ACP bookkeeping the at-rest test reads (claude-code-session.ts acpHoldsAnything). */
type AcpBooks = {
  acpAttachPromises: Map<string, Promise<unknown>>
  acpAttachingSessions: Set<unknown>
  acpRowTakes: Map<string, number>
  acpDeliverySettlements: Map<string, Promise<void>>
  acpAbortInProgress: Set<string>
  drainAcpQueue(session: unknown, sid: string, o?: { asked?: boolean }): Promise<void>
}
const books = (h: Harness) => h.internals as unknown as AcpBooks

type AcpMap = Map<string, ReturnType<typeof acpObject>>
const acpMap = (h: Harness) => (h.internals as unknown as { acpSessions: AcpMap }).acpSessions

/** A legacy Codex session of devbox that ended: its record stopped, a line waiting for it. */
async function acpAtRest(o: { object?: ReturnType<typeof acpObject>; noLine?: boolean } = {}): Promise<Harness> {
  const h = harness({ running: false })
  Object.assign(h.session, { _active: false, _transport: undefined, pid: null })
  await updateSessionRecord(SID, { host: 'devbox', process_status: 'stopped', pid: undefined, engine: 'codex', acpRuntimeId: RUNTIME } as never)
  if (o.object) { acpMap(h).set(RUNTIME, o.object); acpMap(h).set(SID, o.object) }
  h.runner.init()
  await settle(100)
  if (!o.noLine) await enqueueMessage(SID, 'hello codex', { id: 'qm-acp-1', sentBy: 'person' })
  return h
}

const kick = () => bus.emit(EventNames.SESSION_SEND, { sessionId: SID, message: 'hello codex' }, ['*'], { source: 'ui' })

beforeEach(async () => {
  await probeSetup()
  _resetJudgeOfForTesting()
  _resetRemoteJudgedSessionsForTesting()
  _resetHostJudgedRunnerForTesting()
  _resetHostSessionTasksForTesting()
  _resetHostResumeForTesting()
  probe.acp = false
  probe.acpCalls = []
  probe.statusCalls = 0
  setHostJudgeProbe((host) => host === 'devbox')
  _setHostSwitchForTesting((host) => host === 'devbox')
  _setHostResumesForTesting('devbox', true, { acp: true })
})
afterEach(async () => {
  _resetHostJudgedRunnerForTesting()
  _setActiveLeaderSideForTesting(null)
  _resetJudgeOfForTesting()
  _resetRemoteJudgedSessionsForTesting()
  forgetHostResumes()
  await probeTeardown()
})

describe('a send to a legacy ACP session at rest', () => {
  it('goes to a host that resumes ACP sessions, with its line; its worker asked by the runtime id; nothing attaches here', async () => {
    const h = await acpAtRest()
    const { sent } = fakeSide()
    kick()
    await vi.waitFor(() => expect(sent.filter((s) => s.op === 'start')).toHaveLength(1))
    expect(sent[0].body).toMatchObject({ resumeSessionId: SID, resumeRow: { claudeSessionId: SID, host: 'devbox', judge: 'host', engine: 'codex', acpRuntimeId: RUNTIME } })
    expect(sent[0].body.queued).toEqual([{ id: 'qm-acp-1', message: 'hello codex', sentBy: 'person' }])
    expect(probe.acpCalls).toContain(RUNTIME)
    expect(probe.statusCalls).toBe(0)
    await vi.waitFor(async () => expect(await getQueue(SID)).toEqual([]))
    expect(judgingHostOf(SID)).toBe('devbox')
    await settle(50)
    expect(acpMap(h).size).toBe(0)
    expect(sent.filter((s) => s.op === 'start')).toHaveLength(1)
  })

  it('an ACP object here that holds nothing (stopped, reaped) is at rest: dropped and let go on the hand-over', async () => {
    const object = acpObject()
    const h = await acpAtRest({ object })
    const { sent } = fakeSide()
    kick()
    await vi.waitFor(() => expect(sent.filter((s) => s.op === 'start')).toHaveLength(1))
    await vi.waitFor(() => expect(acpMap(h).size).toBe(0))
    expect(object.detach).toHaveBeenCalled()
  })

  it.each([
    ['its worker live here', { active: true }],
    ['a turn running', { processing: true }],
    ['a prompt waiting', { prompt: true }],
  ])('an ACP object here with %s keeps it legacy', async (_name, o) => {
    const object = acpObject(o)
    const h = await acpAtRest({ object })
    const { sent } = fakeSide()
    kick()
    await settle(300)
    expect(sent).toEqual([])
    expect(acpMap(h).get(SID)).toBe(object)
    expect(object.detach).not.toHaveBeenCalled()
    expect((await getSessionByClaudeId(SID))?.judge).toBeUndefined()
  })

  it.each([
    ['its worker runs on the host', true],
    ['the host\'s runtime does not say', null],
  ])('%s: legacy, nothing handed', async (_name, answer) => {
    probe.acp = answer
    const object = acpObject()
    await acpAtRest({ object })
    const { sent } = fakeSide()
    kick()
    await vi.waitFor(() => expect(probe.acpCalls).toContain(RUNTIME))
    await settle(200)
    expect(sent).toEqual([])
    expect((await getSessionByClaudeId(SID))?.judge).toBeUndefined()
  })

  it('a host that resumes only native sessions keeps it legacy, its runtime not asked', async () => {
    _setHostResumesForTesting('devbox', true)
    await acpAtRest({ object: acpObject() })
    const { sent } = fakeSide()
    kick()
    await settle(300)
    expect(sent).toEqual([])
    expect(probe.acpCalls).toEqual([])
  })

  it('the switch off reads no row and asks nothing', async () => {
    setHostJudgeProbe(() => false)
    _setHostSwitchForTesting(null)
    await acpAtRest({ object: acpObject() })
    expect(acpResumeHostOf(SID)).toBeNull()
    const { sent } = fakeSide()
    kick()
    await settle(300)
    expect(sent).toEqual([])
    expect(probe.acpCalls).toEqual([])
  })

  it('two deliveries at once hand it over once and deliver nothing here', async () => {
    const object = acpObject()
    const h = await acpAtRest({ object })
    const { sent } = fakeSide()
    kick()
    kick()
    await vi.waitFor(() => expect(sent.filter((s) => s.op === 'start')).toHaveLength(1))
    await settle(300)
    expect(sent.filter((s) => s.op === 'start')).toHaveLength(1)
    expect(acpMap(h).size).toBe(0)
  })
})

describe('every holder of the runner\'s ACP object keeps it legacy (acpHoldsAnything)', () => {
  const never = new Promise<never>(() => {})
  it.each<[string, (h: Harness, obj: ReturnType<typeof acpObject>) => void, Parameters<typeof acpObject>[0]?]>([
    ['work after its turn (outlivingWork)', () => {}, { afterTurn: true }],
    ['a cursor commit in flight', () => {}, { committing: true }],
    ['an attach in flight (its promise)', (h) => { books(h).acpAttachPromises.set(SID, never) }],
    ['an attach in flight (its establish)', (h, obj) => { books(h).acpAttachingSessions.add(obj) }],
    ['a row taken for delivery', (h) => { books(h).acpRowTakes.set(SID, 1) }],
    ['a delivery settling', (h) => { books(h).acpDeliverySettlements.set(SID, never) }],
    ['an abort in progress', (h) => { books(h).acpAbortInProgress.add(RUNTIME) }],
  ])('%s', async (_name, hold, o) => {
    const object = acpObject(o)
    const h = await acpAtRest({ object })
    hold(h, object)
    const { sent } = fakeSide()
    // The drain's own ask (no send's ask before it), which every holder must stop.
    await books(h).drainAcpQueue(object, SID).catch(() => {})
    await settle(100)
    expect(sent).toEqual([])
    expect(acpMap(h).get(SID)).toBe(object)
    expect((await getSessionByClaudeId(SID))?.judge).toBeUndefined()
  })
})

describe('the drain of an object left here', () => {
  it('delivers nothing for a session its host judges now (a dropped object\'s timer)', async () => {
    const object = acpObject()
    const h = await acpAtRest({ object })
    fakeSide()
    noteHostJudged(SID, 'devbox')
    await books(h).drainAcpQueue(object, SID)
    expect(object.send).not.toHaveBeenCalled()
    expect((await getQueue(SID)).map((m) => m.status)).toEqual(['pending'])
  })

  it('an object holding nothing asks before it would start a worker (the drain after a death): handed over', async () => {
    const object = acpObject()
    const h = await acpAtRest({ object })
    const { sent } = fakeSide()
    await books(h).drainAcpQueue(object, SID)
    expect(sent.filter((s) => s.op === 'start')).toHaveLength(1)
    expect(object.send).not.toHaveBeenCalled()
    expect(acpMap(h).size).toBe(0)
  })
})

describe('a read of a session whose object here holds nothing (the panel opened after a stop)', () => {
  it('hands it to its host, lines or none, and answers with the host\'s proxy', async () => {
    const object = acpObject()
    const h = await acpAtRest({ object, noLine: true })
    const { sent } = fakeSide()
    const got = await h.runner.findOrAttachAcpSession(SID) as unknown as { hostJudged?: boolean }
    expect(sent.filter((s) => s.op === 'start')).toHaveLength(1)
    expect(sent[0].body.queued).toEqual([])
    expect(got.hostJudged).toBe(true)
    expect(acpMap(h).size).toBe(0)
  })

  it('an object that holds something is answered here, nothing asked', async () => {
    const object = acpObject({ active: true })
    const h = await acpAtRest({ object, noLine: true })
    const { sent } = fakeSide()
    expect(await h.runner.findOrAttachAcpSession(SID)).toBe(object)
    expect(sent).toEqual([])
    expect(probe.acpCalls).toEqual([])
  })
})

describe('a processNext and a send asking at once', () => {
  it('hand it over once, and neither delivers here', async () => {
    const object = acpObject()
    const h = await acpAtRest({ object })
    const { sent } = fakeSide()
    kick()
    void (h.internals.processNext(SID) as Promise<void>).catch(() => {})
    await vi.waitFor(() => expect(sent.filter((s) => s.op === 'start')).toHaveLength(1))
    await settle(300)
    expect(sent.filter((s) => s.op === 'start')).toHaveLength(1)
    expect(object.send).not.toHaveBeenCalled()
    expect(judgingHostOf(SID)).toBe('devbox')
  })

  it('one that waited behind a refusal is held legacy and asks the host nothing more', async () => {
    const object = acpObject()
    const h = await acpAtRest({ object })
    const { sent } = fakeSide({ refuse: true })
    kick()
    void (h.internals.processNext(SID) as Promise<void>).catch(() => {})
    await vi.waitFor(() => expect(sent.filter((s) => s.op === 'start')).toHaveLength(1))
    await settle(400)
    expect(sent.filter((s) => s.op === 'start')).toHaveLength(1)
  })
})

describe('a host attaches an ACP session from its own row to its own daemon', () => {
  it('every AcpSession the runner builds from a row names its host as this server reaches it (execHostOf)', async () => {
    const { readFileSync } = await import('node:fs')
    const src = readFileSync(new URL('../../src/providers/claude-code-session.ts', import.meta.url), 'utf8')
    // Each construction's config: its lines up to the closing one at its own indent.
    const lines = src.split('\n')
    const builds: string[] = []
    lines.forEach((l, i) => {
      if (!l.includes('new AcpSession({')) return
      const indent = /^\s*/.exec(l)![0]
      const end = lines.findIndex((x, j) => j > i && x.startsWith(`${indent}})`))
      builds.push(lines.slice(i + 1, end).join('\n'))
    })
    expect(builds.length).toBeGreaterThanOrEqual(2)
    for (const cfg of builds) {
      // A row's raw host names this host itself on a host's own row: the self-host read link, which
      // carries no worker (2026-11-23: a resumed ACP session would have dialled it).
      expect(cfg).not.toMatch(/\b(record|rec|row)\.host\b/)
    }
    expect(builds.some((cfg) => cfg.includes('execHostOf(record)'))).toBe(true)
  })
})

describe('the host\'s own at-rest check of a resume (host-boot.ts runtimeHoldsCli)', () => {
  const conn = (answers: Record<string, unknown>) => {
    const asked: Array<{ cmd: string; params: Record<string, unknown> }> = []
    return { asked, send: async (cmd: string, params: Record<string, unknown>) => { asked.push({ cmd, params }); return answers[cmd] ?? null } }
  }
  const acpRow = { engine: 'codex' as const, acpRuntimeId: RUNTIME }

  it.each<[string, Record<string, unknown>, boolean | null]>([
    ['its worker runs here: not at rest', { acpState: { ok: true, result: {} } }, true],
    ['no worker of it here: at rest', { acpState: { ok: false, errorKind: 'no_worker' } }, false],
    ['a worker being adopted: no word', { acpState: { ok: false, errorKind: 'worker_adopting' } }, null],
  ])('an ACP row, asked by its runtime id: %s', async (_name, answers, want) => {
    const { runtimeHoldsCli } = await import('../../src/core/session-channel/host-boot.js')
    const c = conn(answers)
    expect(await runtimeHoldsCli(SID, acpRow, c)).toBe(want)
    expect(c.asked).toEqual([{ cmd: 'acpState', params: { sid: RUNTIME } }])
  })

  it('an ACP row with no runtime id is no word (refused), and the runtime is not asked', async () => {
    const { runtimeHoldsCli } = await import('../../src/core/session-channel/host-boot.js')
    const c = conn({})
    expect(await runtimeHoldsCli(SID, { engine: 'codex' }, c)).toBeNull()
    expect(c.asked).toEqual([])
  })

  it('a native row (or none) is asked by `status`, as before', async () => {
    const { runtimeHoldsCli } = await import('../../src/core/session-channel/host-boot.js')
    const c = conn({ status: { ok: true, exists: true, alive: true } })
    expect(await runtimeHoldsCli(SID, null, c)).toBe(true)
    expect(c.asked).toEqual([{ cmd: 'status', params: { sid: SID } }])
  })
})

describe('the host refuses a resume while anything of it runs there (host-boot.ts resumeNotAtRest)', () => {
  const runtime = (reply: unknown) => ({ send: vi.fn(async () => reply) })
  const leaderRow = { claudeSessionId: SID, engine: 'codex', acpRuntimeId: RUNTIME } as never

  it('its worker runs in this host\'s runtime: refused', async () => {
    const { resumeNotAtRest } = await import('../../src/core/session-channel/host-boot.js')
    expect(await resumeNotAtRest(SID, leaderRow, { holds: () => false, rowOf: async () => null, runtime: runtime({ ok: true }) })).toMatch(/its CLI runs/)
  })
  it('the runner holds something of it: refused, the runtime not asked', async () => {
    const { resumeNotAtRest } = await import('../../src/core/session-channel/host-boot.js')
    const r = runtime({ ok: false, errorKind: 'no_worker' })
    expect(await resumeNotAtRest(SID, leaderRow, { holds: () => true, rowOf: async () => null, runtime: r })).toMatch(/runner/)
    expect(r.send).not.toHaveBeenCalled()
  })
  it('no row in the resume: this host\'s own copy names the runtime id', async () => {
    const { resumeNotAtRest } = await import('../../src/core/session-channel/host-boot.js')
    const r = runtime({ ok: false, errorKind: 'no_worker' })
    expect(await resumeNotAtRest(SID, undefined, { holds: () => false, rowOf: async () => leaderRow, runtime: r })).toBeNull()
    expect(r.send).toHaveBeenCalledWith('acpState', { sid: RUNTIME }, 3_000)
  })
})
