/**
 * The leader's start and resume of a host-run session, for the two blockers of turning the switch
 * on by default (docs/plan/one-service-every-host.md, phase 2):
 *
 *   one machine, two names   a start (or a resume) on the ssh name of a box whose one service
 *                            goes by its host-network name goes to that service under that name:
 *                            its seed moves with the hand-over, the hand and the host's rows name
 *                            one key, and the born row from the service's channel applies
 *   the switch's copy lags   a host that says host_runs_sessions_off while this leader says on
 *                            for it is caught up (its config copy goes now) and asked once more:
 *                            the start runs there, the resume is handed over, not delivered here
 *
 * Real: SessionRunner, the session store, the disk queue, judge-of, the hand-over and its hands.
 * Faked: the leader side's requests to the host, the daemon's status probe, the CLI, and the config
 * copy round (copy-kind.ts copyKindNow: the host's answer to it).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMockConstants } from '../helpers/mock-constants.js'

const copies = vi.hoisted(() => ({ asked: [] as string[], took: true }))
vi.mock('../../src/constants.js', () => createMockConstants('walnut-host-start-machine'))
vi.mock('../../src/providers/daemon-connection.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  disconnectAllDaemons: vi.fn(),
  probeDaemonSession: vi.fn(async () => ({ alive: false })),
}))
vi.mock('../../src/providers/cloud-session-link.js', () => ({ CloudSessionLink: vi.fn() }))
vi.mock('../../src/core/replication/kinds/copy-kind.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  copyKindNow: vi.fn(async (kind: string) => {
    copies.asked.push(kind)
    return copies.took ? [{ kind, target: 'host:devbox', action: 'synced' }] : []
  }),
}))

import { SID, harness, probeSetup, probeTeardown, settle, type Harness } from '../helpers/runner-probe-harness.js'
import { _resetHostResumeForTesting } from '../../src/providers/host-resume.js'
import { _resetHostJudgedRunnerForTesting } from '../../src/providers/host-judged-runner.js'
import { _resetJudgeOfForTesting, judgingHostOf, setHostJudgeProbe } from '../../src/core/sessions/judge-of.js'
import { _setActiveLeaderSideForTesting, _setHostResumesForTesting } from '../../src/core/session-channel/leader-boot.js'
import { _setHostSwitchForTesting } from '../../src/core/session-channel/resume-hosts.js'
import { _resetHostSessionTasksForTesting } from '../../src/core/session-channel/leader-tasks.js'
import { _resetRemoteJudgedSessionsForTesting } from '../../src/providers/remote-judged-session.js'
import { setRevokedHostResolver } from '../../src/core/session-channel/revoked-hosts.js'
import { HOST_SESSIONS_OFF } from '../../src/core/session-channel/host-api.js'
import type { LeaderSide } from '../../src/core/session-channel/leader-side.js'
import { applyHostChannelBatch, createSessionRecord, getSessionByClaudeId, updateSessionRecord } from '../../src/core/session-tracker.js'
import { handsNow } from '../../src/core/session-channel/handed-sessions.js'
import { enqueueMessage, getQueue } from '../../src/core/session-message-queue.js'
import { bus, EventNames } from '../../src/core/event-bus.js'

/** The box's service goes by NET; SSH is its ssh row (one daemon); FAR is another machine. */
const NET = 'devbox'
const SSH = 'devbox-ssh'
const FAR = 'farbox'

function fakeSide(o: { offFirst?: number; on?: boolean; refuse?: boolean } = {}) {
  const sent: Array<{ op: string; host: string; body: Record<string, any> }> = []
  let off = o.offFirst ?? 0
  const side = {
    startOnHost: async (host: string, body: Record<string, unknown>) => {
      sent.push({ op: 'start', host, body })
      if (off > 0) { off--; return { ok: false, error: HOST_SESSIONS_OFF } }
      if (o.refuse) return { ok: false, error: 'no claude here' }
      return { ok: true, sessionId: (body.resumeSessionId ?? body.preassignedSessionId ?? 'started-on-host') as string, title: '' }
    },
    sendToHost: async (host: string, body: Record<string, unknown>) => { sent.push({ op: 'send', host, body }); return { ok: true } },
    interruptOnHost: async () => ({ ok: true }),
    callHost: async () => null,
    resyncNow: () => {},
    linked: () => true,
    switchOn: () => o.on !== false,
    whenLinked: async () => true,
  }
  _setActiveLeaderSideForTesting(side as unknown as LeaderSide)
  return { sent }
}

beforeEach(async () => {
  await probeSetup()
  _resetJudgeOfForTesting()
  _resetRemoteJudgedSessionsForTesting()
  _resetHostJudgedRunnerForTesting()
  _resetHostSessionTasksForTesting()
  _resetHostResumeForTesting()
  copies.asked = []
  copies.took = true
  // NET's service judges; a start on SSH goes to it (leader-side.ts startKeyOf); FAR stays legacy.
  setHostJudgeProbe((host) => (host === NET ? true : host === SSH ? NET : false))
  setRevokedHostResolver({ machineOf: (k) => ({ [NET]: 'm-1', [SSH]: 'm-1', [FAR]: 'm-2' } as Record<string, string>)[k] ?? null, aliasesOf: (k) => (k === NET ? [SSH] : k === SSH ? [NET] : []), sameDaemonNow: (k) => (k === NET ? [SSH] : k === SSH ? [NET] : []) })
  _setHostSwitchForTesting((host) => host === NET || host === SSH)
  _setHostResumesForTesting(NET, true)
})
afterEach(async () => {
  _resetHostJudgedRunnerForTesting()
  _setActiveLeaderSideForTesting(null)
  setRevokedHostResolver(null)
  _resetJudgeOfForTesting()
  _resetRemoteJudgedSessionsForTesting()
  await probeTeardown()
})

const SEED = '50000000-0000-4000-8000-0000000000f1'

async function seeded(host: string, task = 'gate-task-b') {
  const { updateTask } = await import('../../src/core/task-manager.js')
  await updateTask(task, { phase: 'TODO' })
  await createSessionRecord(SEED, task, 'p', '/w', { host, title: 'Seeded', initialProcessStatus: 'idle', initialStatusReason: 'awaiting_spawn' })
}

describe('one machine, two names: a start on the ssh name', () => {
  it('goes to the machine\'s service under the name it goes by; the seed moves; the service\'s born row applies', async () => {
    const h = harness()
    await seeded(SSH)
    const { sent } = fakeSide()
    const r = await h.runner.startSession({ taskId: 'gate-task-b', message: 'go', host: SSH, preassignedSessionId: SEED } as never, 'test')
    expect(r.claudeSessionId).toBe(SEED)
    expect(sent.map((s) => `${s.op}@${s.host}`)).toEqual([`start@${NET}`])
    expect(sent[0].body.host).toBe(NET)
    expect(await getSessionByClaudeId(SEED)).toMatchObject({ host: NET, judge: 'host' })
    expect(judgingHostOf(SEED)).toBe(NET)
    // The service names itself NET in its rows; its channel comes in under NET.
    const applied = await applyHostChannelBatch({
      hostId: NET, renames: [], cursor: { logId: 'L', seq: 1 },
      rows: [{ sid: SEED, born: true, seq: 1, patch: { claudeSessionId: SEED, taskId: 'gate-task-b', project: 'p', host: NET, judge: 'host', process_status: 'running', startedAt: 'x', lastActiveAt: 'x', messageCount: 1 } }],
    })
    expect(applied).toMatchObject({ written: [SEED], skipped: [] })
    expect(applied.refused).toBeUndefined()
    expect(handsNow()).toEqual([])
  })

  it('a refused start gives the seed back under the name it had (S3 of the round 1 review)', async () => {
    const h = harness()
    await seeded(SSH)
    fakeSide({ refuse: true })
    await expect(h.runner.startSession({ taskId: 'gate-task-b', message: 'go', host: SSH, preassignedSessionId: SEED } as never, 'test')).rejects.toThrow(/no claude here/)
    const row = await getSessionByClaudeId(SEED)
    expect(row?.host).toBe(SSH)
    expect(row?.judge).toBeUndefined()
    expect(handsNow()).toEqual([])
  })

  it('another machine\'s name is not that service: a start on it stays here', async () => {
    const h = harness()
    const { sent } = fakeSide()
    await h.runner.startSession({ taskId: 'gate-task-c', message: 'go', host: FAR } as never, 'test').catch(() => {})
    expect(sent).toEqual([])
  })
})

describe('the host\'s copy of the switch lags: refused as off once, caught up, asked once more', () => {
  it('a start: the config copy goes now and the start runs on the host, not failed here', async () => {
    const h = harness()
    await seeded(NET)
    const { sent } = fakeSide({ offFirst: 1 })
    const r = await h.runner.startSession({ taskId: 'gate-task-b', message: 'go', host: NET, preassignedSessionId: SEED } as never, 'test')
    expect(r.claudeSessionId).toBe(SEED)
    expect(sent.filter((s) => s.op === 'start')).toHaveLength(2)
    expect(copies.asked).toEqual(['config'])
    expect(await getSessionByClaudeId(SEED)).toMatchObject({ host: NET, judge: 'host' })
  })

  it('a start the host still refuses after the copy fails once more, never a third ask', async () => {
    const h = harness()
    await seeded(NET)
    const { sent } = fakeSide({ offFirst: 5 })
    await expect(h.runner.startSession({ taskId: 'gate-task-b', message: 'go', host: NET, preassignedSessionId: SEED } as never, 'test')).rejects.toThrow(HOST_SESSIONS_OFF)
    expect(sent.filter((s) => s.op === 'start')).toHaveLength(2)
    expect((await getSessionByClaudeId(SEED))?.judge).toBeUndefined()
  })

  it('a resume (the evidence of 2026-11-23): handed to the host after the catch-up, not delivered here', async () => {
    const h = await legacyAtRest(NET)
    const { sent } = fakeSide({ offFirst: 1 })
    bus.emit(EventNames.SESSION_SEND, { sessionId: SID, message: 'hello again' }, ['*'], { source: 'ui' })
    await vi.waitFor(async () => expect(await getQueue(SID)).toEqual([]), { timeout: 8000 })
    expect(sent.filter((s) => s.op === 'start').map((s) => s.host)).toEqual([NET, NET])
    expect(copies.asked).toEqual(['config'])
    expect((await getSessionByClaudeId(SID))?.judge).toBe('host')
    await settle(50)
    expect(h.resumes).toEqual([])
  })

  it('a host whose copy did not come back keeps its refusal: the resume is delivered here, once', async () => {
    copies.took = false
    const h = await legacyAtRest(NET)
    const { sent } = fakeSide({ offFirst: 1 })
    bus.emit(EventNames.SESSION_SEND, { sessionId: SID, message: 'hello again' }, ['*'], { source: 'ui' })
    await vi.waitFor(() => expect(h.resumes).toHaveLength(1), { timeout: 8000 })
    expect(sent.filter((s) => s.op === 'start')).toHaveLength(1)
  })
})

describe('one machine, two names: a resume of a legacy session of the ssh name', () => {
  it('is handed to the machine\'s service under its name; the row moves to that name', async () => {
    const h = await legacyAtRest(SSH)
    const { sent } = fakeSide()
    bus.emit(EventNames.SESSION_SEND, { sessionId: SID, message: 'hello again' }, ['*'], { source: 'ui' })
    await vi.waitFor(() => expect(sent.filter((s) => s.op === 'start')).toHaveLength(1), { timeout: 8000 })
    expect(sent[0].host).toBe(NET)
    expect(sent[0].body.resumeRow).toMatchObject({ claudeSessionId: SID, host: NET, judge: 'host' })
    await vi.waitFor(async () => expect(await getQueue(SID)).toEqual([]))
    expect(await getSessionByClaudeId(SID)).toMatchObject({ host: NET, judge: 'host' })
    await settle(50)
    expect(h.resumes).toEqual([])
  })
})

/** A legacy session of `host` that ended, with a line waiting (host-resume.test.ts legacyAtRest). */
async function legacyAtRest(host: string): Promise<Harness> {
  const h = harness({ running: false })
  Object.assign(h.session, { _active: false, _transport: undefined, pid: null })
  await updateSessionRecord(SID, { host, process_status: 'stopped', pid: undefined } as never)
  h.runner.init()
  await settle(100)
  await enqueueMessage(SID, 'hello again', { id: 'qm-rest-1', sentBy: 'person' })
  return h
}
