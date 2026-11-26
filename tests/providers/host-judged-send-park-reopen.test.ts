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
 * The class (2026-11-26, the Walnut VP: every path, not only the gone folder): every way a send's
 * wait ends (settle, the one place) runs the input edge of a kick that never reached the host: the
 * gone folder and a host that keeps refusing park the lines and run it before the park's error; a
 * session the leader takes back, or whose host is gone, runs it as the wait ends. The ratchets below
 * fail on a wait ended another way, or a settle that says the edge was given where none ran.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-host-judged-park-reopen'))
vi.mock('../../src/providers/daemon-connection.js', () => ({ disconnectAllDaemons: vi.fn() }))
vi.mock('../../src/providers/cloud-session-link.js', () => ({ CloudSessionLink: vi.fn() }))
const folder = vi.hoisted(() => ({ gone: true }))
vi.mock('../../src/providers/session-folder-prep.js', async (orig) => ({
  ...(await orig<typeof import('../../src/providers/session-folder-prep.js')>()),
  prepareHostSessionFolder: vi.fn(async () => folder.gone
    ? { ok: false, error: 'Working directory no longer exists on devbox: /work/ws', folder: { cwd: '/work/ws', host: 'devbox' } }
    : { ok: true }),
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
import { forgetWaitingLines, handHeldToHost, redeliverWaitingFor } from '../../src/providers/host-judged-send.js'

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
  folder.gone = true
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

describe('every other way a send\'s wait ends', () => {
  const sendPeer = async (id: string) => {
    const { enqueueMessage } = await import('../../src/core/session-message-queue.js')
    await enqueueMessage(SID, 'answer my request first', { id: `qm-peer-${id}`, sentBy: 'agent' })
    bus.emit(EventNames.SESSION_SEND, { sessionId: SID, message: 'answer my request first' }, ['*'], { source: 'peer' })
  }

  it('a host that keeps refusing: the lines park, and the task is reopened before the park\'s error', async () => {
    folder.gone = false
    let sent = 0
    _setActiveLeaderSideForTesting({ sendToHost: async () => { sent++; return { ok: false, error: 'busy' } } } as unknown as LeaderSide)
    const h = harness()
    h.runner.init()
    await settle(100)
    const id = await completedTaskOnHost()
    const atError = phaseAtError(id)
    await sendPeer('refused')
    for (let i = 2; i <= 3; i++) {
      await vi.waitFor(() => expect(sent).toBe(i - 1))
      await redeliverWaitingFor('devbox')
    }
    expect(await atError).toBe('IN_PROGRESS')
    // A delivery failure's error moves no phase on the server: the park hands it back itself.
    await vi.waitFor(async () => expect((await getTask(id)).phase).toBe('NEED_ACTION'))
  })

  it('a peer\'s kick waiting for its host keeps its source when a hold is handed on after it', async () => {
    folder.gone = false
    const side = { down: true }
    _setActiveLeaderSideForTesting({ sendToHost: async () => { if (side.down) throw new Error('the host devbox is not connected'); return { ok: true } } } as unknown as LeaderSide)
    const h = harness()
    h.runner.init()
    await settle(100)
    const id = await completedTaskOnHost()
    await sendPeer('kept-source')
    await settle(300)
    expect((await getTask(id)).phase).toBe('COMPLETE')
    side.down = false
    // An automated hand (queue-hold) takes the lines to the host: the peer's send is what reopens.
    handHeldToHost(SID)
    await vi.waitFor(async () => expect((await getTask(id)).phase).toBe('IN_PROGRESS'))
  })

  it('a late retry of a send whose task was completed after it reopens nothing', async () => {
    folder.gone = false
    _setActiveLeaderSideForTesting({ sendToHost: async () => { throw new Error('the host devbox is not connected') } } as unknown as LeaderSide)
    const h = harness()
    h.runner.init()
    await settle(100)
    const id = await completedTaskOnHost('NEED_ACTION')
    await sendPeer('late')
    await settle(300)
    await updateTaskRaw(id, { phase: 'COMPLETE', status: 'done', completed_at: new Date(Date.now() + 1000).toISOString() }, { source: 'test' })
    await forgetWaitingLines(SID)
    await settle(200)
    expect((await getTask(id)).phase).toBe('COMPLETE')
  })

  it('a session the leader takes back with the send still waiting for its host: the task is reopened', async () => {
    folder.gone = false
    _setActiveLeaderSideForTesting({ sendToHost: async () => { throw new Error('the host devbox is not connected') } } as unknown as LeaderSide)
    const h = harness()
    h.runner.init()
    await settle(100)
    const id = await completedTaskOnHost()
    await sendPeer('taken-back')
    await settle(300)
    expect((await getTask(id)).phase).toBe('COMPLETE')
    forgetWaitingLines(SID)
    await vi.waitFor(async () => expect((await getTask(id)).phase).toBe('IN_PROGRESS'))
  })
})

describe('a send\'s wait ends in one place, and its edge is never skipped', () => {
  const src = fs.readFileSync(path.resolve(import.meta.dirname, '../../src/providers/host-judged-send.ts'), 'utf-8')
  it('only settle ends a wait', () => {
    const deletes = [...src.matchAll(/waiting\.delete\(/g)].map((m) => m.index!)
    const settleBody = src.slice(src.indexOf('function settle('), src.indexOf('\n}\n', src.indexOf('function settle(')))
    expect(deletes).toHaveLength(1)
    expect(settleBody).toContain('waiting.delete(sid)')
    expect(settleBody).toMatch(/return w\?\.kick && !o\.edgeGiven \? kickEdge\(sid, w\.kick\)/)
    const edge = src.slice(src.indexOf('async function kickEdge('), src.indexOf('\n}\n', src.indexOf('async function kickEdge(')))
    expect(edge).toMatch(/noteHostSessionSend\(sid, kick\.source, kick\.endsWait\)/)
  })
  it('a settle that says the edge was given follows an edge before a park, or the host taking the lines', () => {
    const given = [...src.matchAll(/settle\(sid, \{ edgeGiven: true \}\)/g)]
    expect(given.length).toBeGreaterThanOrEqual(3)
    for (const g of given) {
      const before = src.slice(Math.max(0, g.index! - 1400), g.index!)
      const after = src.slice(g.index!, g.index! + 600)
      expect(/await inputEdgeBeforePark\(sid, o\)/.test(before.slice(before.lastIndexOf('settle(sid') + 1)) || /noteHostSessionSend\(sid, told\.source/.test(after), `settle at offset ${g.index}`).toBe(true)
    }
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
