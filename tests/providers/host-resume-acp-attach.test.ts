/**
 * Every attach of a legacy ACP session goes through the resume decision (src/providers/host-resume.ts
 * "ACP"; claude-code-session.ts maybeAttachAcpSession): an attach starts the session's worker, so a
 * read that attaches (the panel's GET /controls, the model catalog) hands a session at rest to a host
 * whose service resumes ACP sessions, lines or none, and answers with the host's proxy. An attach that
 * the hand-over overtakes (before it is marked in flight, or while its worker starts) goes, and never
 * becomes a second judge of the session.
 *
 * Real: SessionRunner, its attach, the session store, judge-of and the hand-over's claim. Faked:
 * AcpSession (its establish waits on a gate the test opens), the leader side, the daemon's probes.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMockConstants } from '../helpers/mock-constants.js'

const fake = vi.hoisted(() => ({
  built: [] as Array<{ cfg: Record<string, unknown>; detach: ReturnType<typeof import('vitest').vi.fn>; kill: ReturnType<typeof import('vitest').vi.fn> }>,
  gate: null as Promise<void> | null,
}))
vi.mock('../../src/constants.js', () => createMockConstants('walnut-host-resume-acp-attach'))
vi.mock('../../src/providers/daemon-connection.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  disconnectAllDaemons: vi.fn(),
  probeDaemonSession: vi.fn(async () => ({ alive: false })),
  probeAcpWorker: vi.fn(async () => false),
}))
vi.mock('../../src/providers/cloud-session-link.js', () => ({ CloudSessionLink: vi.fn() }))
vi.mock('../../src/providers/acp-session.js', async (importOriginal) => {
  const real = await importOriginal<Record<string, unknown>>()
  const { vi: v } = await import('vitest')
  class FakeAcpSession {
    readonly runtimeId: string
    readonly engineId: string
    readonly mode = 'bypass'
    sessionId: string | null = null
    active = false
    activity = 'idle'
    hasPendingPermission = false
    outlivingWork: string[] = []
    cursorCommitting = false
    detach = v.fn()
    kill = v.fn(async () => {})
    constructor(readonly cfg: Record<string, unknown>) {
      this.runtimeId = String(cfg.runtimeId)
      this.engineId = String(cfg.engine)
      fake.built.push(this as never)
    }
    async establish(): Promise<string> {
      if (fake.gate) await fake.gate
      this.active = true
      this.sessionId = String(this.cfg.providerSessionId)
      return this.sessionId
    }
    async send(): Promise<void> {}
    async abortTurn(): Promise<void> {}
  }
  return { ...real, AcpSession: FakeAcpSession }
})

import { SID, harness, probeSetup, probeTeardown, settle, type Harness } from '../helpers/runner-probe-harness.js'
import { _resetHostResumeForTesting } from '../../src/providers/host-resume.js'
import { _resetHostJudgedRunnerForTesting } from '../../src/providers/host-judged-runner.js'
import { _resetJudgeOfForTesting, judgingHostOf, noteHostJudged, setHostJudgeProbe } from '../../src/core/sessions/judge-of.js'
import { _setActiveLeaderSideForTesting } from '../../src/core/session-channel/leader-boot.js'
import { _setHostResumesForTesting, _setHostSwitchForTesting, forgetHostResumes } from '../../src/core/session-channel/resume-hosts.js'
import { _resetHostSessionTasksForTesting } from '../../src/core/session-channel/leader-tasks.js'
import { _resetRemoteJudgedSessionsForTesting } from '../../src/providers/remote-judged-session.js'
import type { LeaderSide } from '../../src/core/session-channel/leader-side.js'
import { updateSessionRecord } from '../../src/core/session-tracker.js'

const RUNTIME = 'acp-8899aabbccddeeff'

function fakeSide() {
  const sent: Array<{ op: string; body: Record<string, any> }> = []
  _setActiveLeaderSideForTesting({
    startOnHost: async (_host: string, body: Record<string, unknown>) => { sent.push({ op: 'start', body }); return { ok: true, sessionId: body.resumeSessionId as string, title: '' } },
    sendToHost: async (_host: string, body: Record<string, unknown>) => { sent.push({ op: 'send', body }); return { ok: true } },
    interruptOnHost: async () => ({ ok: true }),
    callHost: async () => null,
    linked: () => true,
  } as unknown as LeaderSide)
  return { sent }
}

type Attach = {
  acpSessions: Map<string, unknown>
  maybeAttachAcpSession(sid: string, o?: { asked?: boolean }): Promise<unknown>
}
const attach = (h: Harness) => h.internals as unknown as Attach

/** A legacy Codex session of devbox that ended, no ACP object of it here, no line waiting. */
async function stoppedAcp(): Promise<Harness> {
  const h = harness({ running: false })
  Object.assign(h.session, { _active: false, _transport: undefined, pid: null })
  await updateSessionRecord(SID, { host: 'devbox', process_status: 'stopped', pid: undefined, engine: 'codex', acpRuntimeId: RUNTIME } as never)
  h.runner.init()
  await settle(100)
  return h
}

beforeEach(async () => {
  await probeSetup()
  _resetJudgeOfForTesting()
  _resetRemoteJudgedSessionsForTesting()
  _resetHostJudgedRunnerForTesting()
  _resetHostSessionTasksForTesting()
  _resetHostResumeForTesting()
  fake.built = []
  fake.gate = null
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

describe('a read that attaches a legacy ACP session at rest (the panel\'s controls)', () => {
  it('hands it to its host with no line, builds no worker here, and answers with the host\'s proxy', async () => {
    const h = await stoppedAcp()
    const { sent } = fakeSide()
    const got = await h.runner.findOrAttachAcpSession(SID) as unknown as { hostJudged?: boolean } | undefined
    expect(sent.filter((s) => s.op === 'start')).toHaveLength(1)
    expect(sent[0].body).toMatchObject({ resumeSessionId: SID, queued: [], resumeRow: { acpRuntimeId: RUNTIME, judge: 'host' } })
    expect(fake.built).toEqual([])
    expect(judgingHostOf(SID)).toBe('devbox')
    expect(got?.hostJudged).toBe(true)
  })

  it('on a host that resumes only native sessions it attaches here, as before', async () => {
    _setHostResumesForTesting('devbox', true)
    const h = await stoppedAcp()
    const { sent } = fakeSide()
    await h.runner.findOrAttachAcpSession(SID)
    expect(sent).toEqual([])
    expect(fake.built).toHaveLength(1)
  })

  it('with the switch off it attaches here, as before, and asks nothing', async () => {
    setHostJudgeProbe(() => false)
    _setHostSwitchForTesting(null)
    const h = await stoppedAcp()
    const { sent } = fakeSide()
    await h.runner.findOrAttachAcpSession(SID)
    expect(sent).toEqual([])
    expect(fake.built).toHaveLength(1)
  })
})

describe('an attach the hand-over overtakes', () => {
  it('before it is marked in flight (while it reads the row): it goes, building nothing', async () => {
    const h = await stoppedAcp()
    fakeSide()
    const p = attach(h).maybeAttachAcpSession(SID, { asked: true })
    // The hand-over lands while the attach awaits its row (no await between its last check and here).
    noteHostJudged(SID, 'devbox')
    expect(await p).toBeUndefined()
    expect(fake.built).toEqual([])
    expect(attach(h).acpSessions.size).toBe(0)
  })

  it('while its worker starts: the object goes, its worker is left (never killed), nothing is linked here', async () => {
    const h = await stoppedAcp()
    fakeSide()
    let open!: () => void
    fake.gate = new Promise<void>((r) => { open = r })
    const p = attach(h).maybeAttachAcpSession(SID, { asked: true })
    await vi.waitFor(() => expect(fake.built).toHaveLength(1))
    noteHostJudged(SID, 'devbox')
    open()
    expect(await p).toBeUndefined()
    expect(attach(h).acpSessions.size).toBe(0)
    expect(fake.built[0].detach).toHaveBeenCalled()
    expect(fake.built[0].kill).not.toHaveBeenCalled()
  })

  it('with nothing overtaking it, it is kept', async () => {
    const h = await stoppedAcp()
    fakeSide()
    expect(await attach(h).maybeAttachAcpSession(SID, { asked: true })).toBe(fake.built[0])
    expect(attach(h).acpSessions.get(SID)).toBe(fake.built[0])
  })
})
