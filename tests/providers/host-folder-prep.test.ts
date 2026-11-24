/**
 * A session its host runs (or is about to run) whose task's isolated workspace was released, woken
 * by a message: this leader makes the folder ready before it hands anything to the host, the way the
 * runner's own spawn does (src/providers/session-folder-prep.ts). 2026-11-24: the host's resume of
 * such a session failed with "Working directory no longer exists" on every wake and nothing made
 * the workspace again; the message never reached the model.
 *
 * Real: SessionRunner and its delivery, host-resume, host-judged-send, the session store, the disk
 * queue, judge-of, the folder preparation. Faked: the leader side's requests to the host, the
 * daemon's folder check and status probe (a flag says whether the folder is there), and the
 * workspace remake (it makes the folder, or cannot).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMockConstants } from '../helpers/mock-constants.js'

const disk = vi.hoisted(() => ({ present: true, remake: 'present' as 'present' | 'pending' | 'no', checks: [] as Array<{ cwd: string; host?: string }>, remakes: [] as unknown[][], noted: [] as unknown[][] }))
vi.mock('../../src/constants.js', () => createMockConstants('walnut-host-folder-prep'))
vi.mock('../../src/providers/daemon-connection.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  disconnectAllDaemons: vi.fn(),
  probeDaemonSession: vi.fn(async () => ({ alive: false })),
}))
vi.mock('../../src/providers/cloud-session-link.js', () => ({ CloudSessionLink: vi.fn() }))
vi.mock('../../src/providers/cwd-check.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  checkCwdExists: vi.fn(async (cwd: string, host?: string) => {
    disk.checks.push({ cwd, host })
    return disk.present ? { ok: true } : { ok: false, error: `Working directory no longer exists on ${host}: ${cwd}` }
  }),
}))
vi.mock('../../src/core/workspaces/remake.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  remakeForGoneFolder: vi.fn(async (...args: unknown[]) => {
    disk.remakes.push(args)
    if (disk.remake === 'present') disk.present = true
    return disk.remake
  }),
}))
vi.mock('../../src/core/sessions/folder-gone.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  noteFolderGone: vi.fn(async (...args: unknown[]) => { disk.noted.push(args); return null }),
}))

import { SID, harness, probeSetup, probeTeardown, settle, type Harness } from '../helpers/runner-probe-harness.js'
import { _resetHostResumeForTesting } from '../../src/providers/host-resume.js'
import { _resetHostJudgedRunnerForTesting, startOnJudgingHost } from '../../src/providers/host-judged-runner.js'
import { _resetJudgeOfForTesting, judgingHostOf, noteHostJudged, setHostJudgeProbe } from '../../src/core/sessions/judge-of.js'
import { _setActiveLeaderSideForTesting, _setHostResumesForTesting } from '../../src/core/session-channel/leader-boot.js'
import { _setHostSwitchForTesting } from '../../src/core/session-channel/resume-hosts.js'
import { _resetHostSessionTasksForTesting } from '../../src/core/session-channel/leader-tasks.js'
import { _resetRemoteJudgedSessionsForTesting, setRemoteJudgedCaller, type HostCallBody } from '../../src/providers/remote-judged-session.js'
import type { LeaderSide } from '../../src/core/session-channel/leader-side.js'
import { updateSessionRecord } from '../../src/core/session-tracker.js'
import { enqueueMessage, getQueue } from '../../src/core/session-message-queue.js'
import { updateConfig } from '../../src/core/config-manager.js'
import { applyHanded } from '../helpers/handed-rows.js'
import { noteHostFolderGone } from '../../src/providers/session-folder-prep.js'
import { folderIsBack, sendFolderWaiting } from '../../src/core/sessions/folder-gone.js'
import { parkMessages } from '../../src/core/session-message-queue.js'
import { CwdMissingError } from '../../src/providers/cwd-check.js'
import { bus, EventNames } from '../../src/core/event-bus.js'

const WS = '/work/worktrees/released-ws'
/** The first import of a module a step loads can take a while under a full run: wait on the work, generously. */
const WAIT = { timeout: 10_000 }
const HOST_SID = '50000000-0000-4000-8000-0000000000f1'

function fakeSide() {
  const sent: Array<{ op: string; host: string; body: Record<string, any> }> = []
  const side = {
    startOnHost: async (host: string, body: Record<string, unknown>) => {
      sent.push({ op: 'start', host, body })
      return { ok: true, sessionId: (body.resumeSessionId as string) ?? (body.preassignedSessionId as string) ?? HOST_SID, title: '' }
    },
    sendToHost: async (host: string, body: Record<string, unknown>) => { sent.push({ op: 'send', host, body }); return { ok: true } },
    interruptOnHost: async () => ({ ok: true }),
    callHost: async () => null,
    linked: () => true,
    resyncNow: () => {},
  }
  _setActiveLeaderSideForTesting(side as unknown as LeaderSide)
  return { sent }
}

/** A legacy session of devbox that ended, in its task's released workspace. */
async function legacyAtRest(): Promise<Harness> {
  const h = harness({ running: false })
  Object.assign(h.session, { _active: false, _transport: undefined, pid: null })
  await updateSessionRecord(SID, { host: 'devbox', cwd: WS, process_status: 'stopped', pid: undefined } as never)
  h.runner.init()
  await settle(100)
  await enqueueMessage(SID, 'wake up', { id: 'qm-fp-1', sentBy: 'person' })
  return h
}

/** A session devbox runs and judges, stopped there, in its task's released workspace. */
async function hostJudgedStopped(status: 'stopped' | 'idle' = 'stopped'): Promise<Harness> {
  const h = harness()
  h.runner.init()
  await settle(100)
  await applyHanded({
    hostId: 'devbox', renames: [], cursor: { logId: 'L', seq: 1 },
    rows: [{ sid: HOST_SID, born: true, patch: { claudeSessionId: HOST_SID, taskId: 'gate-task-b', project: 'p', host: 'devbox', cwd: WS, judge: 'host', process_status: status, startedAt: 'x', lastActiveAt: 'x', messageCount: 0 } }],
  })
  noteHostJudged(HOST_SID, 'devbox')
  return h
}

const send = (sid: string) => bus.emit(EventNames.SESSION_SEND, { sessionId: sid, message: 'wake up' }, ['*'], { source: 'ui' })

beforeEach(async () => {
  await probeSetup()
  await updateConfig({ hosts: { devbox: { hostname: 'devbox' } } } as never)
  _resetJudgeOfForTesting()
  _resetRemoteJudgedSessionsForTesting()
  _resetHostJudgedRunnerForTesting()
  _resetHostSessionTasksForTesting()
  _resetHostResumeForTesting()
  setHostJudgeProbe((host) => host === 'devbox')
  _setHostSwitchForTesting((host) => host === 'devbox')
  _setHostResumesForTesting('devbox', true)
  Object.assign(disk, { present: false, remake: 'present', checks: [], remakes: [], noted: [] })
})
afterEach(async () => {
  _resetHostJudgedRunnerForTesting()
  _setActiveLeaderSideForTesting(null)
  _resetJudgeOfForTesting()
  _resetRemoteJudgedSessionsForTesting()
  await probeTeardown()
})

describe('a woken session whose released workspace is made again before its host gets it', () => {
  it('a legacy session at rest: the workspace is made again on the leader, then the resume goes to the host with the message, once', async () => {
    const h = await legacyAtRest()
    const { sent } = fakeSide()
    send(SID)
    await vi.waitFor(() => expect(sent.filter((s) => s.op === 'start')).toHaveLength(1), WAIT)
    expect(disk.remakes).toHaveLength(1)
    expect(disk.remakes[0].slice(0, 3)).toEqual(['gate-task', WS, 'devbox'])
    expect(disk.remakes[0][3]).toMatchObject({ resume: true })
    // Checked on the host (with its target), not on this machine's disk.
    expect(disk.checks.every((c) => c.host === 'devbox' && c.cwd === WS)).toBe(true)
    expect(sent[0].body.queued).toEqual([{ id: 'qm-fp-1', message: 'wake up', sentBy: 'person' }])
    await vi.waitFor(async () => expect(await getQueue(SID)).toEqual([]), WAIT)
    expect(judgingHostOf(SID)).toBe('devbox')
    await settle(60)
    expect(sent.filter((s) => s.op === 'start')).toHaveLength(1)
    expect(h.resumes).toEqual([])
  })

  it('a legacy session whose folder cannot be made again stays legacy: delivered here, nothing goes to the host', async () => {
    disk.remake = 'no'
    const h = await legacyAtRest()
    const { sent } = fakeSide()
    send(SID)
    await vi.waitFor(() => expect(disk.remakes.length).toBeGreaterThan(0), WAIT)
    // Its legacy delivery runs here, whose own spawn takes the folder-gone way.
    await vi.waitFor(() => expect(h.resumes).toHaveLength(1), WAIT)
    expect(sent.filter((s) => s.op === 'start')).toEqual([])
    expect(judgingHostOf(SID)).toBeNull()
  })

  it('a host-judged session stopped on its host: the send makes the workspace again first, then its line goes to the host once', async () => {
    await hostJudgedStopped()
    const { sent } = fakeSide()
    await enqueueMessage(HOST_SID, 'wake up', { id: 'qm-fp-2', sentBy: 'person' })
    send(HOST_SID)
    await vi.waitFor(() => expect(sent.filter((s) => s.op === 'send')).toHaveLength(1), WAIT)
    expect(disk.remakes).toHaveLength(1)
    expect(disk.remakes[0].slice(0, 3)).toEqual(['gate-task-b', WS, 'devbox'])
    expect(sent[0].body.queued).toEqual([{ id: 'qm-fp-2', message: 'wake up', sentBy: 'person' }])
    await vi.waitFor(async () => expect(await getQueue(HOST_SID)).toEqual([]), WAIT)
    await settle(60)
    expect(sent.filter((s) => s.op === 'send')).toHaveLength(1)
  })

  it('a host-judged session whose folder cannot be made again: its line parks here the folder-gone way, nothing goes', async () => {
    disk.remake = 'no'
    await hostJudgedStopped()
    const { sent } = fakeSide()
    const errors: unknown[] = []
    bus.subscribe('test-folder-prep', (e) => { if (e.name === EventNames.SESSION_ERROR) errors.push(e.data) }, { global: true, interest: [EventNames.SESSION_ERROR] })
    await enqueueMessage(HOST_SID, 'wake up', { id: 'qm-fp-3', sentBy: 'person' })
    send(HOST_SID)
    await vi.waitFor(async () => expect((await getQueue(HOST_SID)).map((m) => `${m.id}:${m.status}`)).toEqual(['qm-fp-3:parked']), WAIT)
    const [row] = await getQueue(HOST_SID)
    expect((row as { parkedReason?: string }).parkedReason).toMatch(/Working directory no longer exists/)
    await vi.waitFor(() => expect(disk.noted).toEqual([[HOST_SID, { cwd: WS, host: 'devbox' }]]), WAIT)
    await vi.waitFor(() => expect(errors).toEqual([expect.objectContaining({ sessionId: HOST_SID, errorKind: 'delivery_failed', parked: true })]), WAIT)
    expect(sent).toEqual([])
    bus.unsubscribe('test-folder-prep')
  })

  it('a host-judged send never waits for the remake: its line waits parked here, quietly, and goes once the workspace is there', async () => {
    disk.remake = 'pending'
    await hostJudgedStopped()
    const { sent } = fakeSide()
    const errors: unknown[] = []
    bus.subscribe('test-folder-prep-pending', (e) => { if (e.name === EventNames.SESSION_ERROR) errors.push(e.data) }, { global: true, interest: [EventNames.SESSION_ERROR] })
    try {
      await enqueueMessage(HOST_SID, 'wake up', { id: 'qm-fp-5', sentBy: 'person' })
      send(HOST_SID)
      await vi.waitFor(async () => expect((await getQueue(HOST_SID)).map((m) => `${m.id}:${m.status}`)).toEqual(['qm-fp-5:parked']), WAIT)
      // Asked for, never waited for here: the session's command chain (a Stop) is not held behind it.
      expect(disk.remakes[0][3]).toMatchObject({ waitMs: 0, resume: true })
      // The background remake follows it (noteFolderGone: kickRemake), and nothing failed yet.
      await vi.waitFor(() => expect(disk.noted).toEqual([[HOST_SID, { cwd: WS, host: 'devbox' }]]), WAIT)
      expect(errors).toEqual([])
      expect(sent).toEqual([])
      // The remake ends: what waited goes to the host, once.
      disk.present = true
      await folderIsBack(HOST_SID, 'gate-task-b')
      await vi.waitFor(() => expect(sent.filter((s) => s.op === 'send')).toHaveLength(1), WAIT)
      expect(sent[0].body.queued).toEqual([expect.objectContaining({ id: 'qm-fp-5', message: 'wake up' })])
      await vi.waitFor(async () => expect(await getQueue(HOST_SID)).toEqual([]), WAIT)
      await settle(60)
      expect(sent.filter((s) => s.op === 'send')).toHaveLength(1)
      expect(errors).toEqual([])
    } finally {
      bus.unsubscribe('test-folder-prep-pending')
    }
  })

  it('a host-judged session whose CLI runs there: a send asks nothing about its folder', async () => {
    await hostJudgedStopped('idle')
    const { sent } = fakeSide()
    await enqueueMessage(HOST_SID, 'more', { id: 'qm-fp-4', sentBy: 'person' })
    send(HOST_SID)
    await vi.waitFor(() => expect(sent.filter((s) => s.op === 'send')).toHaveLength(1), WAIT)
    expect(disk.checks).toEqual([])
    expect(disk.remakes).toEqual([])
  })

  it('a new start on a host in a gone folder that cannot be made again fails here, as the spawn fails it; nothing goes', async () => {
    disk.remake = 'no'
    const { sent } = fakeSide()
    await expect(startOnJudgingHost({ taskId: 'gate-task', message: 'go', host: 'devbox', cwd: WS }, async () => {})).rejects.toBeInstanceOf(CwdMissingError)
    expect(disk.remakes).toHaveLength(1)
    expect(sent).toEqual([])
  })

  it('a new start on a host in a released workspace: made again, then started there', async () => {
    const { sent } = fakeSide()
    await startOnJudgingHost({ taskId: 'gate-task', message: 'go', host: 'devbox', cwd: WS, preassignedSessionId: HOST_SID } as never, async () => {})
    expect(disk.remakes).toHaveLength(1)
    expect(sent.filter((s) => s.op === 'start')).toHaveLength(1)
  })
})

describe('a host that still refuses on a gone folder', () => {
  it('a host-judged session takes the folder-gone way here; a legacy one is its runner\'s own', async () => {
    await hostJudgedStopped()
    await noteHostFolderGone(HOST_SID, `Working directory no longer exists: ${WS}`)
    expect(disk.noted).toEqual([[HOST_SID]])
    await noteHostFolderGone(HOST_SID, 'some other error')
    await noteHostFolderGone(SID, `Working directory no longer exists: ${WS}`)
    expect(disk.noted).toHaveLength(1)
  })

  it('once the folder is back, the host is asked to send what it parked on it (it holds those rows)', async () => {
    await hostJudgedStopped()
    const calls: HostCallBody[] = []
    setRemoteJudgedCaller(async (_host, body) => { calls.push(body); return body.member === 'sendFolderWaiting' ? 2 : null })
    try {
      expect(await folderIsBack(HOST_SID, 'gate-task-b')).toBe(2)
      expect(calls.filter((c) => c.member === 'sendFolderWaiting')).toEqual([expect.objectContaining({ sid: HOST_SID, target: 'lifecycle' })])
    } finally {
      setRemoteJudgedCaller(null)
    }
  })

  it('on the host: what it parked on the gone folder goes out again, and nothing it parked for another reason', async () => {
    harness({ running: false })
    await enqueueMessage(SID, 'parked on the folder', { id: 'qm-fp-h1', sentBy: 'person' })
    await enqueueMessage(SID, 'parked by a stop', { id: 'qm-fp-h2', sentBy: 'person' })
    const rows = await getQueue(SID)
    await parkMessages([rows[0]], `Working directory no longer exists: ${WS}`)
    await parkMessages([rows[1]], 'Stopped by the user')
    const kicks: unknown[] = []
    bus.subscribe('test-folder-back-kick', (e) => { if (e.name === EventNames.SESSION_SEND) kicks.push(e.data) }, { global: true, interest: [EventNames.SESSION_SEND] })
    try {
      expect(await sendFolderWaiting(SID, null, null)).toBe(1)
      expect((await getQueue(SID)).map((m) => `${m.id}:${m.status}`)).toEqual(['qm-fp-h1:pending', 'qm-fp-h2:parked'])
      await vi.waitFor(() => expect(kicks).toEqual([expect.objectContaining({ sessionId: SID })]), WAIT)
    } finally {
      bus.unsubscribe('test-folder-back-kick')
    }
  })
})
