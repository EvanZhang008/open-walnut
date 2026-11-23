/**
 * SessionRunner's routing of the sessions a host runs and judges (src/providers/host-judged-runner.ts):
 * a start on such a host goes to it with the leader's start bundle, a send and an interrupt go to
 * it, the runner's own turn-end handling (processNext, the record write, the queue drain) skips a
 * host's session, and the lookups and Table-B methods answer through the session's proxy. A legacy
 * session runs exactly as before.
 *
 * Real: SessionRunner and its bus subscription, the session store, judge-of. Faked: the leader
 * side's requests to the host (a recorder that answers as the host's door does).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-host-judged-runner'))
// The host's runtime runs no CLI of a session (a lost start's check asks it: host-handover.ts hostVerdict).
vi.mock('../../src/providers/daemon-connection.js', () => ({ disconnectAllDaemons: vi.fn(), probeDaemonSession: vi.fn(async () => ({ alive: false })) }))
vi.mock('../../src/providers/cloud-session-link.js', () => ({ CloudSessionLink: vi.fn() }))

import { SID, harness, probeSetup, probeTeardown, settle } from '../helpers/runner-probe-harness.js'
import { SessionRunner } from '../../src/providers/claude-code-session.js'
import { HOST_JUDGED_RUNNER_METHODS, HostRunsItError, _resetHostJudgedRunnerForTesting, attemptStartedOn, hostStartWorkIdle, hostStartsInFlight, noteHostStartBorn, installHostJudgedRouting, saidHereAlready, startAnnouncedHere, startGoesToHost } from '../../src/providers/host-judged-runner.js'
import { _resetJudgeOfForTesting, judgingHostOf, noteHostJudged, setHostJudgeProbe } from '../../src/core/sessions/judge-of.js'
import { _setActiveLeaderSideForTesting } from '../../src/core/session-channel/leader-boot.js'
import { _resetHostSessionTasksForTesting, startHostSessionTasks } from '../../src/core/session-channel/leader-tasks.js'
import { _resetRemoteJudgedSessionsForTesting, noteLiveState, setRemoteJudgedCaller, type HostCallBody, isRemoteJudgedSession } from '../../src/providers/remote-judged-session.js'
import { HostRequestNotSent, type LeaderSide } from '../../src/core/session-channel/leader-side.js'
import { applyHostChannelBatch, getSessionByClaudeId } from '../../src/core/session-tracker.js'
import { applyHanded } from '../helpers/handed-rows.js'
import { handsNow } from '../../src/core/session-channel/handed-sessions.js'
import { bus, EventNames } from '../../src/core/event-bus.js'
import { WALNUT_HOME } from '../../src/constants.js'
import { _resetLineParseCountForTesting, lineParsesOf } from '../../src/providers/line-parse-count.js'
import { _parsedJsonlLineForTesting } from '../../src/providers/remote-session-manager.js'
import { getRegisteredSessionManager } from '../../src/providers/session-manager.js'

const HOST_SID = '50000000-0000-4000-8000-0000000000c1'

function fakeSide(o: { refuse?: boolean; lost?: boolean; notSent?: boolean; notOwn?: boolean; answerSid?: string } = {}) {
  const sent: Array<{ op: string; host: string; body: Record<string, unknown> }> = []
  const calls: Array<{ host: string } & HostCallBody> = []
  const resyncs: Array<{ host: string; sids: readonly string[] }> = []
  const side = {
    resyncNow: (host: string, sids: readonly string[]) => { resyncs.push({ host, sids }) },
    startOnHost: async (host: string, body: Record<string, unknown>) => {
      sent.push({ op: 'start', host, body })
      if (o.notSent) throw new HostRequestNotSent(host, new Error('the host devbox is not connected'))
      if (o.lost) throw new Error('request timed out after 120000 ms')
      if (o.refuse) return { ok: false, error: 'no claude here' }
      return { ok: true, sessionId: o.answerSid ?? (body.preassignedSessionId as string | undefined) ?? 'started-on-host', title: 'Host title' }
    },
    // `notOwn`: a host that does not hold the session (it never took the start) says so.
    sendToHost: async (host: string, body: Record<string, unknown>) => { sent.push({ op: 'send', host, body }); return o.notOwn ? { ok: false, error: 'not_own_session' } : o.refuse ? { ok: false, error: 'busy' } : { ok: true } },
    interruptOnHost: async (host: string, body: Record<string, unknown>) => { sent.push({ op: 'interrupt', host, body }); return { ok: true } },
    callHost: async (host: string, body: HostCallBody) => { calls.push({ host, ...body }); return body.member === 'isBackgroundWorkActive' ? true : body.member === 'markExpectedTeardown' ? { undoId: 'u-1' } : null },
  }
  _setActiveLeaderSideForTesting(side as unknown as LeaderSide)
  setRemoteJudgedCaller((host, body) => side.callHost(host, body))
  return { sent, calls, resyncs }
}

async function hostRow(sid = HOST_SID, status = 'running') {
  await applyHanded({
    hostId: 'devbox', renames: [], cursor: { logId: 'L', seq: 1 },
    rows: [{ sid, born: true, patch: { claudeSessionId: sid, taskId: '', project: 'p', host: 'devbox', judge: 'host', process_status: status, startedAt: 'x', lastActiveAt: 'x', messageCount: 0 } }],
  })
  noteHostJudged(sid, 'devbox')
}

beforeEach(async () => {
  await probeSetup()
  _resetJudgeOfForTesting()
  _resetRemoteJudgedSessionsForTesting()
  _resetHostJudgedRunnerForTesting()
  _resetHostSessionTasksForTesting()
})
afterEach(async () => {
  _setActiveLeaderSideForTesting(null)
  _resetJudgeOfForTesting()
  _resetRemoteJudgedSessionsForTesting()
  await probeTeardown()
})

describe('the routing is installed on SessionRunner', () => {
  it('every method it wraps exists on the runner', () => {
    const proto = SessionRunner.prototype as unknown as Record<string, unknown>
    for (const m of HOST_JUDGED_RUNNER_METHODS) expect(typeof proto[m], m).toBe('function')
    // Installing again is a no-op (one wrap per method).
    expect(() => installHostJudgedRouting(SessionRunner.prototype)).not.toThrow()
  })
})

describe('a host-judged session', () => {
  it('a send and an interrupt go to its host, with their source; nothing is delivered here', async () => {
    const h = harness()
    h.runner.init()
    await settle(100)
    const { sent } = fakeSide()
    await hostRow()
    bus.emit(EventNames.SESSION_SEND, { sessionId: HOST_SID, message: 'hello' }, ['*'], { source: 'mobile' })
    bus.emit(EventNames.SESSION_INTERRUPT, { sessionId: HOST_SID }, ['*'], { source: 'mobile' })
    await settle(50)
    expect(sent.map((s) => `${s.op}:${s.host}`)).toEqual(['send:devbox', 'interrupt:devbox'])
    expect(sent[0].body).toMatchObject({ sessionId: HOST_SID, message: 'hello', busSource: 'mobile' })
    expect(h.writes).toEqual([])
  })

  it('a send takes the lines queued here for it to its host\'s queue; a refused one puts them back', async () => {
    const h = harness()
    h.runner.init()
    await settle(100)
    await hostRow()
    const { enqueueMessage, getQueue } = await import('../../src/core/session-message-queue.js')
    await enqueueMessage(HOST_SID, 'hello [with its hints]', { id: 'qm-host-1', sentBy: 'person' })
    const refused = fakeSide({ refuse: true })
    bus.emit(EventNames.SESSION_SEND, { sessionId: HOST_SID, message: 'hello' }, ['*'], { source: 'mobile' })
    await vi.waitFor(() => expect(refused.sent).toHaveLength(1))
    // Put back once the refusal is read (a loaded machine takes longer than a fixed pause).
    await vi.waitFor(async () => expect((await getQueue(HOST_SID)).map((m) => m.id)).toEqual(['qm-host-1']))
    const { sent } = fakeSide()
    bus.emit(EventNames.SESSION_SEND, { sessionId: HOST_SID, message: 'hello' }, ['*'], { source: 'mobile' })
    await vi.waitFor(() => expect(sent).toHaveLength(1))
    expect(sent[0].body.queued).toEqual([{ id: 'qm-host-1', message: 'hello [with its hints]', sentBy: 'person' }])
    await vi.waitFor(async () => expect(await getQueue(HOST_SID)).toEqual([]))
  })

  it('a row seeded for a start on that host is the host\'s before it answers, and its born row fills it; a refused start gives it back', async () => {
    const h = harness()
    setHostJudgeProbe((host) => host === 'devbox')
    const { createSessionRecord } = await import('../../src/core/session-tracker.js')
    const { updateTask } = await import('../../src/core/task-manager.js')
    await updateTask('gate-task-b', { phase: 'TODO' })
    const seeded = '50000000-0000-4000-8000-0000000000d1'
    await createSessionRecord(seeded, 'gate-task-b', 'p', '/w', { host: 'devbox', title: 'Seeded', initialProcessStatus: 'idle', initialStatusReason: 'awaiting_spawn' })
    fakeSide()
    const r = await h.runner.startSession({ taskId: 'gate-task-b', message: 'go', host: 'devbox', preassignedSessionId: seeded } as never, 'test')
    expect(r.claudeSessionId).toBe(seeded)
    // Its task side runs here (leader-tasks.ts): done before anything below.
    const { getTask } = await import('../../src/core/task-manager.js')
    await vi.waitFor(async () => expect((await getTask('gate-task-b')).phase).toBe('IN_PROGRESS'))
    expect((await getSessionByClaudeId(seeded))).toMatchObject({ judge: 'host', host: 'devbox', title: 'Seeded' })
    const applied = await applyHanded({
      hostId: 'devbox', renames: [], cursor: { logId: 'L', seq: 2 },
      rows: [{ sid: seeded, born: true, patch: { claudeSessionId: seeded, taskId: 'gate-task-b', project: 'p', host: 'devbox', judge: 'host', process_status: 'running', title: 'Host title', startedAt: 'x', lastActiveAt: 'x', messageCount: 1 } }],
    })
    expect(applied).toMatchObject({ written: [seeded], skipped: [], gone: [] })
    // The host's fields, the leader's own title.
    expect(await getSessionByClaudeId(seeded)).toMatchObject({ process_status: 'running', title: 'Seeded', judge: 'host' })
    // Another seed, a start the host refuses: the leader's again.
    const other = '50000000-0000-4000-8000-0000000000d2'
    await createSessionRecord(other, 'gate-task-c', 'p', '/w', { host: 'devbox', title: 'Seeded 2', initialProcessStatus: 'idle', initialStatusReason: 'awaiting_spawn' })
    fakeSide({ refuse: true })
    await expect(h.runner.startSession({ taskId: 'gate-task-c', message: 'go', host: 'devbox', preassignedSessionId: other } as never, 'test')).rejects.toThrow(/no claude here/)
    expect((await getSessionByClaudeId(other))?.judge).toBeUndefined()
    expect(isRemoteJudgedSession(h.runner.findSessionByClaudeId(other))).toBe(false)
  })

  it('R2-H2: a start whose answer never came stays the host\'s: not failed as the leader\'s, not run here; its born row says it started', async () => {
    const h = harness()
    setHostJudgeProbe((host) => host === 'devbox')
    const { createSessionRecord } = await import('../../src/core/session-tracker.js')
    const { updateTask } = await import('../../src/core/task-manager.js')
    await updateTask('gate-task-b', { phase: 'TODO' })
    const seeded = '50000000-0000-4000-8000-0000000000e1'
    await createSessionRecord(seeded, 'gate-task-b', 'p', '/w', { host: 'devbox', title: 'Seeded', initialProcessStatus: 'idle', initialStatusReason: 'awaiting_spawn' })
    fakeSide({ lost: true })
    const r = await h.runner.startSession({ taskId: 'gate-task-b', message: 'go', host: 'devbox', preassignedSessionId: seeded } as never, 'test')
    expect(r.claudeSessionId).toBe(seeded)
    const row = await getSessionByClaudeId(seeded)
    // The host's, as it was: no failure written on it here, no legacy run of it.
    expect(row).toMatchObject({ judge: 'host', host: 'devbox', process_status: 'idle', status_reason: 'awaiting_spawn' })
    expect(isRemoteJudgedSession(h.runner.findSessionByClaudeId(seeded))).toBe(true)
    // Still in flight until its born row: a rows frame keeps it untouched.
    expect(hostStartsInFlight().has(seeded)).toBe(true)
    noteHostStartBorn(seeded)
    expect(hostStartsInFlight().has(seeded)).toBe(false)
  })

  async function seededStart(o: { notSent?: boolean; lost?: boolean; notOwn?: boolean }) {
    const h = harness()
    setHostJudgeProbe((host) => host === 'devbox')
    const { createSessionRecord } = await import('../../src/core/session-tracker.js')
    const { updateTask } = await import('../../src/core/task-manager.js')
    await updateTask('gate-task-b', { phase: 'TODO' })
    const seeded = '50000000-0000-4000-8000-0000000000e2'
    await createSessionRecord(seeded, 'gate-task-b', 'p', '/w', { host: 'devbox', title: 'Seeded', initialProcessStatus: 'idle', initialStatusReason: 'awaiting_spawn' })
    fakeSide(o)
    return { h, seeded }
  }

  it('MF1: a start that never reached the host (no stream) fails here and its seed is the leader\'s again', async () => {
    const { h, seeded } = await seededStart({ notSent: true })
    await expect(h.runner.startSession({ taskId: 'gate-task-b', message: 'go', host: 'devbox', preassignedSessionId: seeded } as never, 'test')).rejects.toThrow(/did not get the start/)
    // The leader's own row again, as for any start that failed here (its caller writes the failure).
    expect((await getSessionByClaudeId(seeded))?.judge).toBeUndefined()
    expect(hostStartsInFlight().has(seeded)).toBe(false)
    expect(isRemoteJudgedSession(h.runner.findSessionByClaudeId(seeded))).toBe(false)
  })

  it('MF1: a start whose answer was lost and whose born row never comes is taken back and fails when its wait runs out (the host does not hold it, its runtime runs no CLI of it)', async () => {
    process.env.WALNUT_HOST_START_LOST_MS = '60'
    try {
      const { h, seeded } = await seededStart({ lost: true, notOwn: true })
      const r = await h.runner.startSession({ taskId: 'gate-task-b', message: 'go', host: 'devbox', preassignedSessionId: seeded } as never, 'test')
      expect(r.claudeSessionId).toBe(seeded)
      expect((await getSessionByClaudeId(seeded))?.judge).toBe('host')
      await vi.waitFor(async () => {
        const row = await getSessionByClaudeId(seeded)
        expect(row?.judge).toBeUndefined()
        expect(row).toMatchObject({ process_status: 'error', status_reason: 'api_error' })
      })
      expect(hostStartsInFlight().has(seeded)).toBe(false)
    } finally { delete process.env.WALNUT_HOST_START_LOST_MS }
  })

  it('S-B: a lost answer whose host holds the session when the wait runs out is the host\'s, never failed', async () => {
    process.env.WALNUT_HOST_START_LOST_MS = '60'
    try {
      const { h, seeded } = await seededStart({ lost: true })
      await h.runner.startSession({ taskId: 'gate-task-b', message: 'go', host: 'devbox', preassignedSessionId: seeded } as never, 'test')
      await vi.waitFor(() => expect(hostStartsInFlight().has(seeded)).toBe(false))
      await new Promise((r) => setTimeout(r, 150))
      expect(await getSessionByClaudeId(seeded)).toMatchObject({ judge: 'host', process_status: 'idle', status_reason: 'awaiting_spawn' })
    } finally { delete process.env.WALNUT_HOST_START_LOST_MS }
  })

  it('MF1: a lost answer whose born row comes in time stays the host\'s', async () => {
    process.env.WALNUT_HOST_START_LOST_MS = '60'
    try {
      const { h, seeded } = await seededStart({ lost: true })
      await h.runner.startSession({ taskId: 'gate-task-b', message: 'go', host: 'devbox', preassignedSessionId: seeded } as never, 'test')
      noteHostStartBorn(seeded)
      // Past the wait: nothing taken back, nothing failed.
      await new Promise((r) => setTimeout(r, 120))
      expect(await getSessionByClaudeId(seeded)).toMatchObject({ judge: 'host', process_status: 'idle', status_reason: 'awaiting_spawn' })
    } finally { delete process.env.WALNUT_HOST_START_LOST_MS }
  })

  it('B1: a send to a start whose answer was lost waits on the leader (never sent, never refused) until the host\'s row; then it goes once', async () => {
    process.env.WALNUT_HOST_START_LOST_MS = '5000'
    try {
      const { h, seeded } = await seededStart({ lost: true })
      const { sent } = fakeSide({ lost: true })
      await h.runner.startSession({ taskId: 'gate-task-b', message: 'go', host: 'devbox', preassignedSessionId: seeded } as never, 'test')
      const { enqueueMessage, getQueue } = await import('../../src/core/session-message-queue.js')
      const { bus, EventNames } = await import('../../src/core/event-bus.js')
      await enqueueMessage(seeded, 'and then', { id: 'qm-window-1', sentBy: 'person' })
      bus.emit(EventNames.SESSION_SEND, { sessionId: seeded, message: 'and then' }, ['*'], { source: 'ui' })
      await new Promise((r) => setTimeout(r, 150))
      expect(sent.filter((x) => x.op === 'send')).toEqual([])
      expect((await getQueue(seeded)).map((m) => `${m.id}:${m.status}`)).toEqual(['qm-window-1:pending'])
      // The host's row of it: the window ends and the line goes to the host, once.
      const after = fakeSide()
      noteHostStartBorn(seeded)
      await vi.waitFor(() => expect(after.sent.filter((x) => x.op === 'send')).toHaveLength(1))
      await vi.waitFor(async () => expect(await getQueue(seeded)).toEqual([]))
    } finally { delete process.env.WALNUT_HOST_START_LOST_MS }
  })

  it('its result runs no turn end here: no processNext, no record write; a legacy result still does', async () => {
    const h = harness()
    h.runner.init()
    await settle(100)
    fakeSide()
    await hostRow()
    const next = vi.spyOn(h.internals, 'processNext')
    bus.emit(EventNames.SESSION_RESULT, { sessionId: HOST_SID, result: 'done', taskId: '' }, ['*'], { source: 'host-channel' })
    await settle(80)
    expect(next).not.toHaveBeenCalledWith(HOST_SID)
    expect((await getSessionByClaudeId(HOST_SID))!.status_changed_by).toBeUndefined()
    // The runner's own session: today's path.
    bus.emit(EventNames.SESSION_RESULT, { sessionId: SID, result: 'done', taskId: 'gate-task' }, ['*'], { source: 'session' })
    await vi.waitFor(async () => expect((await getSessionByClaudeId(SID))!.status_changed_by).toBe('session-runner'))
  })

  it('the lookups answer with its one proxy, and Table B answers from the mirrored state or the host', async () => {
    const h = harness()
    const { calls } = fakeSide()
    await hostRow()
    noteLiveState(HOST_SID, { inTurn: true, teamActive: true, cronArmed: true, pendingPermission: true, timestamps: { lastClaudeOutputAt: 7, lastMessageDeliveryAt: 8 }, turnRunning: true, deliveryWait: { reason: 'r' } })
    const r = h.runner
    const p = r.findSessionByClaudeId(HOST_SID)
    expect(isRemoteJudgedSession(p)).toBe(true)
    expect(r.findByClaudeId(HOST_SID)).toBe(p)
    expect(await r.getOrAttachLiveSession(HOST_SID)).toBe(p)
    expect(r.findAcpSession(HOST_SID)).toBeUndefined()
    expect(r.isInTurn(HOST_SID)).toBe(true)
    expect(r.isTeamActive(HOST_SID)).toBe(true)
    expect(r.isCronArmed(HOST_SID)).toBe(true)
    expect(r.hasPendingPermission(HOST_SID)).toBe(true)
    expect(r.getSessionTimestamps(HOST_SID)).toEqual({ lastClaudeOutputAt: 7, lastMessageDeliveryAt: 8 })
    expect(r.isTurnRunning(HOST_SID)).toBe(true)
    expect(r.deliveryWait(HOST_SID)).toEqual({ reason: 'r' })
    await expect(r.isBackgroundWorkActive(HOST_SID)).resolves.toBe(true)
    // A callback member is refused by name: the host runs its own prompt refresh.
    await expect(r.respawnOnCurrentPrompt(HOST_SID, () => true, { folder: true })).rejects.toBeInstanceOf(HostRunsItError)
    r.syncLane(HOST_SID, 'lane-x')
    const undo = r.markExpectedTeardown(HOST_SID, 'restart')
    undo?.()
    await settle(20)
    expect(calls.map((c) => `${c.target}.${c.member}`)).toEqual([
      'runner.isBackgroundWorkActive', 'runner.syncLane', 'session.markExpectedTeardown', 'session.undoExpectedTeardown',
    ])
    // The sid rides the body, never args (host-calls.ts hostCallArgs).
    expect(calls[0]).toMatchObject({ sid: HOST_SID, args: [] })
    expect(calls[1]).toMatchObject({ sid: HOST_SID, args: ['lane-x'] })
    // The runner's own session is untouched by any of it.
    expect(isRemoteJudgedSession(r.findSessionByClaudeId(SID))).toBe(false)
    expect(r.findSessionByClaudeId('no-such-session')).toBeUndefined()
  })

  it('a start on a host whose service judges it goes there with the start bundle and the spilled text', async () => {
    const h = harness()
    const { sent } = fakeSide()
    setHostJudgeProbe((host) => host === 'devbox')
    const spill = path.join(WALNUT_HOME, 'spill.txt')
    await fsp.writeFile(spill, 'the whole long prompt')
    // A task with no session yet (gate-task already has the harness's own).
    const { getTask, updateTask } = await import('../../src/core/task-manager.js')
    await updateTask('gate-task-b', { phase: 'TODO' })
    const said: unknown[] = []
    bus.subscribe('test-started', (e) => { said.push(e.data) }, { global: true, interest: [EventNames.SESSION_STARTED] })
    const r = await h.runner.startSession({ taskId: 'gate-task-b', message: 'see file', host: 'devbox', largePromptFile: { localPath: spill, originalLength: 21 } } as never, 'test')
    bus.unsubscribe('test-started')
    expect(r).toEqual({ claudeSessionId: 'started-on-host', title: 'Host title' })
    // Its session:started is said here, with the id the host named (the channel skips the host's own).
    expect(said).toEqual([expect.objectContaining({ sessionId: 'started-on-host', taskId: 'gate-task-b', host: 'devbox' })])
    expect(startAnnouncedHere('started-on-host')).toBe(true)
    expect(sent).toHaveLength(1)
    expect(sent[0].op).toBe('start')
    expect(sent[0].body.largePrompt).toBe('the whole long prompt')
    expect(sent[0].body.largePromptFile).toBeUndefined()
    // The path its message names goes with it (the host points the message at its own file), and
    // this server's copy is gone: nothing here reads it again.
    expect(sent[0].body.largePromptPath).toBe(spill)
    expect(await fsp.stat(spill).then(() => true, () => false)).toBe(false)
    expect(sent[0].body.startBundle).toMatchObject({ hintsApplied: true, task: { id: 'gate-task-b' } })
    expect(sent[0].body.busSource).toBe('test')
    // The new session is the host's at once, before its row arrives.
    expect(isRemoteJudgedSession(h.runner.findSessionByClaudeId('started-on-host'))).toBe(true)
    // Its task is the leader's: linked and In Progress here (leader-tasks.ts).
    await vi.waitFor(async () => {
      const t = await getTask('gate-task-b')
      expect(t.session_id).toBe('started-on-host')
      expect(t.phase).toBe('IN_PROGRESS')
    })
    // A host whose service does not judge it: today's path.
    expect(startGoesToHost('other')).toBe(false)
    expect(startGoesToHost(undefined)).toBe(false)
  })

  it('a session its host began itself, with no start of the leader\'s: its born row is refused and links nothing (such sessions come through the host\'s journal)', async () => {
    harness()
    const stopTasks = startHostSessionTasks()
    try {
      const { getTask, updateTask } = await import('../../src/core/task-manager.js')
      await updateTask('gate-task-b', { phase: 'TODO' })
      const sid = '50000000-0000-4000-8000-0000000000e2'
      const r = await applyHostChannelBatch({
        hostId: 'devbox', renames: [], cursor: { logId: 'L', seq: 3 },
        rows: [{ sid, born: true, patch: { claudeSessionId: sid, taskId: 'gate-task-b', project: 'p', host: 'devbox', judge: 'host', process_status: 'running', mode: 'default', startedAt: 'x', lastActiveAt: 'x', messageCount: 0 } }],
      })
      expect(r.refused).toEqual([sid])
      expect(await getSessionByClaudeId(sid)).toBeNull()
      await settle(30)
      const t = await getTask('gate-task-b')
      expect(t.session_id).not.toBe(sid)
      expect(t.phase).toBe('TODO')
    } finally {
      stopTasks()
    }
  })

  it('a session the leader handed its host: its born row links the task here, moves it to In Progress and says one session:started', async () => {
    harness()
    const stopTasks = startHostSessionTasks()
    const said: unknown[] = []
    bus.subscribe('test-born-started', (e) => { said.push(e.data) }, { global: true, interest: [EventNames.SESSION_STARTED] })
    try {
      const { getTask, updateTask } = await import('../../src/core/task-manager.js')
      await updateTask('gate-task-b', { phase: 'TODO' })
      const sid = '50000000-0000-4000-8000-0000000000e1'
      // The channel's apply (leader-side.ts applyRecs): the row in its batch, then its facts through
      // the channel's emit (leader-boot.ts), the started said from the born row first.
      await applyHanded({
        hostId: 'devbox', renames: [], cursor: { logId: 'L', seq: 3 },
        rows: [{ sid, born: true, patch: { claudeSessionId: sid, taskId: 'gate-task-b', project: 'p', host: 'devbox', judge: 'host', process_status: 'running', mode: 'default', startedAt: 'x', lastActiveAt: 'x', messageCount: 0 } }],
      })
      noteHostJudged(sid, 'devbox')
      const channelEmit = (name: string, data: unknown) => { if (!saidHereAlready(name, data)) bus.emit(name, data, ['*'], { source: 'host-channel' }) }
      const started = { sessionId: sid, claudeSessionId: sid, taskId: 'gate-task-b', project: 'p', host: 'devbox' }
      channelEmit(EventNames.SESSION_STARTED, started)
      // The host's own session:started of it (an engine whose start names its id): not said again.
      channelEmit(EventNames.SESSION_STARTED, started)
      await vi.waitFor(async () => {
        const t = await getTask('gate-task-b')
        expect(t.session_id).toBe(sid)
        expect(t.exec_session_id).toBe(sid)
        expect(t.phase).toBe('IN_PROGRESS')
      })
      await settle(30)
      expect(said).toEqual([expect.objectContaining({ sessionId: sid, taskId: 'gate-task-b', host: 'devbox' })])
      // A handed start's answer that comes after says none either.
      expect(startAnnouncedHere(sid)).toBe(true)
    } finally {
      bus.unsubscribe('test-born-started')
      stopTasks()
    }
  })
})

describe('a host session renamed by its CLI', () => {
  it('moves its task\'s slot and link to the new id, and never reopens a finished task', async () => {
    harness()
    const { getTask, updateTask } = await import('../../src/core/task-manager.js')
    await updateTask('gate-task-b', { phase: 'COMPLETE' })
    const { noteHostSessionRenamed } = await import('../../src/core/session-channel/leader-tasks.js')
    const from = '50000000-0000-4000-8000-0000000000f1'
    const to = '50000000-0000-4000-8000-0000000000f2'
    const row = { claudeSessionId: from, taskId: 'gate-task-b', project: 'p', host: 'devbox', judge: 'host', process_status: 'running', mode: 'default', startedAt: 'x', lastActiveAt: 'x', messageCount: 0 }
    await applyHanded({ hostId: 'devbox', renames: [], cursor: { logId: 'L', seq: 4 }, rows: [{ sid: from, born: true, patch: row }] })
    await applyHanded({ hostId: 'devbox', rows: [], cursor: { logId: 'L', seq: 5 }, renames: [{ from, to, seq: 5 }] })
    await noteHostSessionRenamed(from, to)
    const t = await getTask('gate-task-b')
    expect(t.exec_session_id).toBe(to)
    expect(t.session_id).toBe(to)
    // A new id of the same session is no start: the task stays where its turns left it.
    expect(t.phase).toBe('COMPLETE')
  })
})

describe('the leader parses no line of a host-judged session', () => {
  it('its sends, results and lookups parse none and attach no session manager here; a line handed over as text is counted', async () => {
    _resetLineParseCountForTesting()
    const h = harness()
    h.runner.init()
    await settle(100)
    fakeSide()
    await hostRow()
    bus.emit(EventNames.SESSION_SEND, { sessionId: HOST_SID, message: 'hello' }, ['*'], { source: 'mobile' })
    bus.emit(EventNames.SESSION_TOOL_USE, { sessionId: HOST_SID, toolName: 'Bash', input: {} }, ['*'], { source: 'host-channel' })
    bus.emit(EventNames.SESSION_RESULT, { sessionId: HOST_SID, result: 'done', taskId: '' }, ['*'], { source: 'host-channel' })
    await h.runner.getOrAttachLiveSession(HOST_SID)
    h.runner.isInTurn(HOST_SID)
    await settle(80)
    expect(lineParsesOf(HOST_SID)).toBe(0)
    expect(getRegisteredSessionManager(HOST_SID)).toBeUndefined()
    // The counter counts: a line of a session this server runs, handed over as text.
    _parsedJsonlLineForTesting({ ev: 'jsonl', sid: SID, line: '{"type":"assistant"}' } as never)
    expect(lineParsesOf(SID)).toBe(1)
  })
})

describe('a start hands the host its session, and only that one (handed-sessions.ts)', () => {
  // A start's work after its answer (its commit, the task's link) runs on: it ends before the
  // store is removed, or a write reopens a store being deleted and wedges the next test.
  afterEach(async () => { await hostStartWorkIdle() })
  const bornOf = (sid: string, taskId = '', hand?: string) => applyHostChannelBatch({
    hostId: 'devbox', renames: [], cursor: { logId: 'L-hand', seq: 1 },
    rows: [{ sid, born: true, ...(hand ? { hand } : {}), patch: { claudeSessionId: sid, taskId, project: 'p', host: 'devbox', judge: 'host', process_status: 'running', startedAt: 'x', lastActiveAt: 'x', messageCount: 0 } }],
  })

  it('a start whose id the host names: its answer names the hand, so that born row applies and no other new id does; its row is asked for whole', async () => {
    const h = harness()
    setHostJudgeProbe((host) => host === 'devbox')
    const { updateTask } = await import('../../src/core/task-manager.js')
    await updateTask('gate-task-b', { phase: 'TODO' })
    const f = fakeSide({ answerSid: 'acp-named-1' })
    const r = await h.runner.startSession({ taskId: 'gate-task-b', message: 'go', host: 'devbox' } as never, 'test')
    expect(r.claudeSessionId).toBe('acp-named-1')
    expect(handsNow()).toEqual([{ host: 'devbox', sid: 'acp-named-1' }])
    // A host that does not echo the hand had its born row refused before this answer: the leader asks for it.
    expect(f.resyncs).toEqual([{ host: 'devbox', sids: ['acp-named-1'] }])
    expect((await bornOf('not-the-one')).refused).toEqual(['not-the-one'])
    expect((await bornOf('acp-named-1', 'gate-task-b')).written).toEqual(['acp-named-1'])
    expect(handsNow()).toEqual([])
  })

  it('the start carries its hand, and the host\'s born row that echoes it applies before any answer (S2); one for another task does not (S1)', async () => {
    const h = harness()
    setHostJudgeProbe((host) => host === 'devbox')
    const f = fakeSide({ lost: true })
    await expect(h.runner.startSession({ taskId: 'gate-task-b', message: 'go', host: 'devbox' } as never, 'test')).rejects.toThrow()
    const hand = f.sent[0]!.body.startHand as string
    expect(hand).toMatch(/^[0-9a-f]{18}$/)
    expect((await bornOf('acp-echo-other', 'some-other-task', hand)).refused).toEqual(['acp-echo-other'])
    expect((await bornOf('acp-no-echo', 'gate-task-b')).refused).toEqual(['acp-no-echo'])
    expect((await bornOf('acp-echo', 'gate-task-b', hand)).written).toEqual(['acp-echo'])
  })

  it('a seeded start keeps its hand on disk before it goes: the born row applies even with no seed row and no memory of it', async () => {
    const h = harness()
    setHostJudgeProbe((host) => host === 'devbox')
    const seeded = '50000000-0000-4000-8000-0000000000f1'
    fakeSide({ lost: true })
    await h.runner.startSession({ taskId: 'gate-task-b', message: 'go', host: 'devbox', preassignedSessionId: seeded } as never, 'test')
    expect(handsNow()).toEqual([{ host: 'devbox', sid: seeded }])
    // A restart forgets what was in memory; the hand is in the store.
    _resetJudgeOfForTesting()
    _resetHostJudgedRunnerForTesting()
    expect((await bornOf(seeded, 'gate-task-b')).written).toEqual([seeded])
  })

  it('an answer naming a session that is not the host\'s fails the start, and nothing of that session moves', async () => {
    const h = harness()
    setHostJudgeProbe((host) => host === 'devbox')
    const { createSessionRecord } = await import('../../src/core/session-tracker.js')
    await createSessionRecord('leader-own-1', '', 'p', undefined, { title: 'Leader own' })
    fakeSide({ answerSid: 'leader-own-1' })
    await expect(h.runner.startSession({ taskId: 'gate-task-b', message: 'go', host: 'devbox' } as never, 'test')).rejects.toThrow(/not its own/)
    expect(judgingHostOf('leader-own-1')).toBeNull()
    expect(await getSessionByClaudeId('leader-own-1')).toMatchObject({ title: 'Leader own' })
    expect((await getSessionByClaudeId('leader-own-1'))?.judge).toBeUndefined()
    expect(handsNow()).toEqual([])
  })

  it('a start aimed at a revoked host fails at once with the reason, on the host\'s path and the legacy one, and nothing goes (R2-S2)', async () => {
    const { setRevokedHosts } = await import('../../src/core/session-channel/revoked-hosts.js')
    const h = harness()
    const f = fakeSide()
    setRevokedHosts(['devbox'])
    try {
      setHostJudgeProbe((host) => host === 'devbox')
      await expect(h.runner.startSession({ taskId: 'gate-task-b', message: 'go', host: 'devbox' } as never, 'test')).rejects.toThrow(/the host devbox is revoked/)
      // With the channel cut the host no longer judges: today's path would run the CLI there itself.
      setHostJudgeProbe(() => false)
      await expect(h.runner.startSession({ taskId: 'gate-task-b', message: 'go', host: 'devbox' } as never, 'test')).rejects.toThrow(/the host devbox is revoked/)
      expect(f.sent).toEqual([])
      expect(handsNow()).toEqual([])
    } finally { setRevokedHosts([]) }
  })

  it('a start aimed at another name of a revoked machine fails the same way, on both paths', async () => {
    const { setRevokedHostResolver, setRevokedHosts } = await import('../../src/core/session-channel/revoked-hosts.js')
    const h = harness()
    const f = fakeSide()
    // Revoked as `devbox-net`, another row of the same daemon; the start names `devbox`.
    setRevokedHosts([{ hostKey: 'devbox-net', machineId: 'm-devbox' }])
    setRevokedHostResolver({ machineOf: () => null, aliasesOf: (k) => (k === 'devbox' ? ['devbox-net'] : []) })
    try {
      setHostJudgeProbe((host) => host === 'devbox')
      await expect(h.runner.startSession({ taskId: 'gate-task-b', message: 'go', host: 'devbox' } as never, 'test')).rejects.toThrow(/the host devbox is revoked \(another name of the revoked host devbox-net\)/)
      setHostJudgeProbe(() => false)
      await expect(h.runner.startSession({ taskId: 'gate-task-b', message: 'go', host: 'devbox' } as never, 'test')).rejects.toThrow(/the host devbox is revoked/)
      expect(f.sent).toEqual([])
      expect(handsNow()).toEqual([])
    } finally { setRevokedHosts([]); setRevokedHostResolver(null) }
  })

  it('a transfer attempt counts as started only on the host its start went to (R2-S1, fork-init)', async () => {
    const h = harness()
    setHostJudgeProbe((host) => host === 'devbox')
    fakeSide({ answerSid: 'acp-moved-1' })
    await h.runner.startSession({ taskId: 'gate-task-b', message: 'go', host: 'devbox', transferAttemptId: 'att-1' } as never, 'test')
    expect(attemptStartedOn('devbox', 'att-1')).toBe(true)
    expect(attemptStartedOn('devbox-b', 'att-1')).toBe(false)
    expect(attemptStartedOn('devbox', 'att-2')).toBe(false)
  })

  it('a start the host refuses, or one that never left, leaves no hand', async () => {
    const h = harness()
    setHostJudgeProbe((host) => host === 'devbox')
    fakeSide({ refuse: true })
    await expect(h.runner.startSession({ taskId: 'gate-task-b', message: 'go', host: 'devbox' } as never, 'test')).rejects.toThrow()
    expect(handsNow()).toEqual([])
    fakeSide({ notSent: true })
    await expect(h.runner.startSession({ taskId: 'gate-task-b', message: 'go', host: 'devbox', preassignedSessionId: '50000000-0000-4000-8000-0000000000f2' } as never, 'test')).rejects.toThrow()
    expect(handsNow()).toEqual([])
  })
})
