/**
 * A forced message into a COMPLETE task whose host-run session's folder is gone still reopens the
 * task at send time (src/providers/host-judged-send.ts inputEdgeOnPark).
 *
 * 2026-11-25 23:17 and 11-26 01:00, the Walnut VP's forced task_sends to tasks 2a6ec4cb and fd717c01:
 * each parked on the removed workspace before the host took it, so its input edge (taken only once the
 * host took the lines) never ran; the redelivery after the folder came back carries 'folder-moved',
 * which reopens nothing. Each task worked on while it read COMPLETE, and the request was settled as
 * completed by the next turn edge with no answer.
 *
 * The class: every branch of deliver() that parks lines for good (the gone folder, a host that keeps
 * refusing) runs the input edge; the ratchet below fails on a new park that does not.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-host-judged-park-reopen'))
vi.mock('../../src/providers/daemon-connection.js', () => ({ disconnectAllDaemons: vi.fn() }))
vi.mock('../../src/providers/cloud-session-link.js', () => ({ CloudSessionLink: vi.fn() }))
vi.mock('../../src/providers/session-folder-prep.js', async (orig) => ({
  ...(await orig<typeof import('../../src/providers/session-folder-prep.js')>()),
  prepareHostSessionFolder: vi.fn(async () => ({ ok: false, error: 'Working directory no longer exists on devbox: /work/ws', folder: { cwd: '/work/ws', host: 'devbox' } })),
}))

import { harness, probeSetup, probeTeardown, settle } from '../helpers/runner-probe-harness.js'
import { _resetHostJudgedRunnerForTesting } from '../../src/providers/host-judged-runner.js'
import { _resetJudgeOfForTesting, noteHostJudged } from '../../src/core/sessions/judge-of.js'
import { _setActiveLeaderSideForTesting } from '../../src/core/session-channel/leader-boot.js'
import { _resetHostSessionTasksForTesting } from '../../src/core/session-channel/leader-tasks.js'
import { _resetRemoteJudgedSessionsForTesting } from '../../src/providers/remote-judged-session.js'
import type { LeaderSide } from '../../src/core/session-channel/leader-side.js'
import { applyHanded } from '../helpers/handed-rows.js'
import { bus, EventNames } from '../../src/core/event-bus.js'
import { addTask, getTask, updateTaskRaw } from '../../src/core/task-manager.js'

const SID = '50000000-0000-4000-8000-0000000000f7'
/**
 * The task's phase when the folder-gone error goes out. The server's own handler of that error
 * (web/server.ts, applySessionPhase 'session:error') then hands an IN_PROGRESS task back as Needs
 * you; the edge must come first, as the runner's handleSend has it.
 */
function phaseAtError(id: string): Promise<string> {
  return new Promise((resolve) => {
    const emit = bus.emit.bind(bus)
    vi.spyOn(bus, 'emit').mockImplementation((name: string, data: unknown, ...rest: unknown[]) => {
      if (name === EventNames.SESSION_ERROR && (data as { sessionId?: string })?.sessionId === SID) void getTask(id).then((t) => resolve(t.phase))
      return (emit as (...a: unknown[]) => unknown)(name, data, ...rest) as never
    })
  })
}

async function completedTaskOnHost(phase: 'COMPLETE' | 'NEED_ACTION' = 'COMPLETE'): Promise<string> {
  const id = (await addTask({ title: 'Order the club flyers', project: 'Garden' })).task.id
  await updateTaskRaw(id, phase === 'COMPLETE' ? { phase, status: 'done' } : { phase }, { source: 'test' })
  await applyHanded({
    hostId: 'devbox', renames: [], cursor: { logId: 'L', seq: 1 },
    rows: [{ sid: SID, born: true, patch: { claudeSessionId: SID, taskId: id, project: 'Garden', host: 'devbox', judge: 'host', process_status: 'idle', cwd: '/work/ws', startedAt: 'x', lastActiveAt: 'x', messageCount: 0 } }],
  })
  noteHostJudged(SID, 'devbox')
  return id
}

beforeEach(async () => {
  await probeSetup()
  _resetJudgeOfForTesting()
  _resetRemoteJudgedSessionsForTesting()
  _resetHostJudgedRunnerForTesting()
  _resetHostSessionTasksForTesting()
  _setActiveLeaderSideForTesting({ sendToHost: async () => ({ ok: true }) } as unknown as LeaderSide)
})
afterEach(async () => {
  vi.restoreAllMocks()
  _setActiveLeaderSideForTesting(null)
  _resetHostJudgedRunnerForTesting()
  _resetJudgeOfForTesting()
  _resetRemoteJudgedSessionsForTesting()
  await probeTeardown()
})

describe('a send that parks on the gone folder of a host-run session', () => {
  it('a peer\'s forced message reopens the COMPLETE task at send time', async () => {
    const h = harness()
    h.runner.init()
    await settle(100)
    const id = await completedTaskOnHost()
    const atError = phaseAtError(id)
    const { enqueueMessage, getQueue } = await import('../../src/core/session-message-queue.js')
    await enqueueMessage(SID, 'You marked it complete; answer my request first', { id: 'qm-park-peer', sentBy: 'agent' })
    bus.emit(EventNames.SESSION_SEND, { sessionId: SID, message: 'You marked it complete; answer my request first' }, ['*'], { source: 'peer' })
    await vi.waitFor(async () => expect((await getQueue(SID)).find((m) => m.id === 'qm-park-peer')?.status).toBe('parked'))
    // Reopened before the folder-gone error goes out, so that error hands it back as Needs you.
    expect(await atError).toBe('IN_PROGRESS')
    await settle(300)
    expect((await getTask(id)).phase).not.toBe('COMPLETE')
  })

  it('a task waiting on the user gets the edge before the park\'s error, never after it', async () => {
    const h = harness()
    h.runner.init()
    await settle(100)
    const id = await completedTaskOnHost('NEED_ACTION')
    const atError = phaseAtError(id)
    const { enqueueMessage, getQueue } = await import('../../src/core/session-message-queue.js')
    await enqueueMessage(SID, 'one more thing', { id: 'qm-park-na', sentBy: 'agent' })
    bus.emit(EventNames.SESSION_SEND, { sessionId: SID, message: 'one more thing' }, ['*'], { source: 'peer' })
    await vi.waitFor(async () => expect((await getQueue(SID)).find((m) => m.id === 'qm-park-na')?.status).toBe('parked'))
    // The edge came before the error, which hands it back; nothing moves it to Working after.
    expect(await atError).toBe('IN_PROGRESS')
    await settle(300)
    expect((await getTask(id)).phase).toBe('IN_PROGRESS')
  })

  it('Walnut\'s own redelivery of it reopens nothing by itself', async () => {
    const h = harness()
    h.runner.init()
    await settle(100)
    const id = await completedTaskOnHost()
    const { enqueueMessage, getQueue } = await import('../../src/core/session-message-queue.js')
    await enqueueMessage(SID, 'a notice', { id: 'qm-park-notice', sentBy: 'agent' })
    bus.emit(EventNames.SESSION_SEND, { sessionId: SID, message: '' }, ['*'], { source: 'folder-moved' })
    await vi.waitFor(async () => expect((await getQueue(SID)).find((m) => m.id === 'qm-park-notice')?.status).toBe('parked'))
    await settle(200)
    expect((await getTask(id)).phase).toBe('COMPLETE')
  })
})

describe('the gone-folder park in deliver() is the send\'s input edge', () => {
  it('runs inputEdgeBeforePark before it parks, so the park\'s error comes after the edge', () => {
    const src = fs.readFileSync(path.resolve(import.meta.dirname, '../../src/providers/host-judged-send.ts'), 'utf-8')
    const body = src.slice(src.indexOf('async function deliver('), src.indexOf('\n}\n', src.indexOf('async function deliver(')))
    const parks = [...body.matchAll(/await parkWaitingOnGoneFolder\(/g)]
    expect(parks.length).toBeGreaterThanOrEqual(1)
    for (const p of parks) expect(body.slice(Math.max(0, p.index! - 80), p.index!)).toMatch(/await inputEdgeBeforePark\(sid, o\)\s*$/)
  })
})
