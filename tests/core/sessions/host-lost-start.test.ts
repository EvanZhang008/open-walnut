/**
 * task_start on another host for a task whose session runs on a host that is gone
 * (sessions/host-lost.ts hostGone): the start moves the task there, then sends its own
 * message the usual way (a reply request, hands_on), instead of the refusal "already has its
 * active session (host ...)", which named a host nobody could reach (2026-11-07). A host that
 * answers keeps the usual path. One that does not but is not gone is refused with why: its
 * sign-in failed (it may still run the session), it was down only a moment, or this machine
 * may be the one offline. An ACP session keeps the refusal (its worker could not be stopped
 * once the host is back).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createMockConstants } from '../../helpers/mock-constants.js'

const M = vi.hoisted(() => ({ moves: [] as Array<Record<string, unknown>>, sends: [] as Array<Record<string, unknown>>, made: 0, pending: false }))
vi.mock('../../../src/constants.js', () => createMockConstants('host-lost-start'))
vi.mock('../../../src/core/sessions/engine-switch.js', async (orig) => ({
  ...(await orig<typeof import('../../../src/core/sessions/engine-switch.js')>()),
  isSwitching: () => false,
  requestEngineSwitch: async (req: Record<string, unknown>) => {
    M.moves.push(req)
    // The host answered after all and the move waits on its turn there.
    if (M.pending) return { state: 'pending', taskId: req.taskId, switchId: 'es-1', fromSessionId: 'x', engine: 'claude', host: req.host }
    const { createSessionRecord, updateSessionRecord, getSessionsForTask } = await import('../../../src/core/session-tracker.js')
    // The real move retires the old session first (engine-switch.ts retire).
    const { engineSwitchedReason } = await import('../../../src/core/sessions/engine-switch-marker.js')
    for (const r of await getSessionsForTask(String(req.taskId))) await updateSessionRecord(r.claudeSessionId, { archived: true, archive_reason: engineSwitchedReason('claude') } as never)
    const sid = `moved-sid-${++M.made}`
    await createSessionRecord(sid, String(req.taskId), 'Marina', '/work/marina')
    await updateSessionRecord(sid, { host: String(req.host), process_status: 'idle' } as never)
    return { state: 'done', taskId: req.taskId, switchId: 'es-1', sessionId: sid, engine: 'claude', host: req.host, fromHost: 'laptop' }
  },
}))
vi.mock('../../../src/core/sessions/task-session-claim.js', async (orig) => ({
  ...(await orig<typeof import('../../../src/core/sessions/task-session-claim.js')>()),
  continueTaskConversation: async (record: { claudeSessionId: string }, opts: Record<string, unknown>) => {
    M.sends.push({ to: record.claudeSessionId, ...opts })
    return { sessionId: record.claudeSessionId, requestId: opts.expectReply ? 'rq-1' : undefined, delivery: 'queued' }
  },
}))

import { addTask, _resetForTesting } from '../../../src/core/task-manager.js'
import { closeDb as closeTaskDb } from '../../../src/core/task-db.js'
import { closeDb as closeSessionDb } from '../../../src/core/session-db.js'
import { createSessionRecord, updateSessionRecord, _resetSessionTrackerForTesting } from '../../../src/core/session-tracker.js'
import { moveFromLostHost } from '../../../src/core/sessions/task-start.js'
import { __setHostProbeForTesting, HOST_GONE_AFTER_MS, hostGone } from '../../../src/core/sessions/host-lost.js'

const probed: string[] = []
beforeEach(() => {
  closeTaskDb(); closeSessionDb(); _resetForTesting(); _resetSessionTrackerForTesting()
  M.moves.length = 0; M.sends.length = 0; probed.length = 0; M.pending = false
})
afterEach(() => { __setHostProbeForTesting(null) })

let n = 0
async function taskOnLaptop(status: 'running' | 'idle' | 'stopped' = 'running', engine?: string) {
  const { task } = await addTask({ title: 'Parser', project: 'Marina', description: 'Make the parser faster.' } as never)
  // One session id per test: the session store outlives a test's reset.
  const sid = `laptop-sid-${++n}`
  await createSessionRecord(sid, task.id, 'Marina', '/work/marina')
  await updateSessionRecord(sid, { host: 'laptop', process_status: status, messageCount: 3, ...(engine ? { engine } : {}) } as never)
  return { task, sid }
}
/** laptop does not answer (`everyone`: nor does any host); the move's new host does. */
const unreachable = (error = 'ssh: connect to host laptop port 22: Operation timed out', facts?: Parameters<typeof __setHostProbeForTesting>[1], everyone = false) =>
  __setHostProbeForTesting(async (host) => { probed.push(host); return host === 'laptop' || everyone ? { reachable: false, error } : { reachable: true } }, facts)

describe('a start on another host when the session host is gone', () => {
  it('moves the task there, then sends the start\'s message with its reply request', async () => {
    const { task, sid } = await taskOnLaptop()
    unreachable()
    const res = await moveFromLostHost(task, { taskIdPrefix: task.id, host: 'clouddev', message: 'Carry on with the parser.', source: 'test', expectReply: true, callerSid: 'lead-sid' })
    expect(res).toMatchObject({ taskId: task.id, sessionId: expect.stringMatching(/^moved-sid-/), requestId: 'rq-1', started: true, continued: true, hostLost: { from: 'laptop', fromSessionId: sid } })
    // The move itself carries no message: the start's message rides the usual send.
    expect(M.moves).toEqual([expect.objectContaining({ taskId: task.id, host: 'clouddev', message: '', engine: 'claude', callerSid: 'lead-sid' })])
    expect(M.sends).toEqual([expect.objectContaining({ to: res!.sessionId, text: 'Carry on with the parser.', expectReply: true, callerSid: 'lead-sid' })])
    // The new host answering shows this machine is online; then laptop is dialled.
    expect(probed).toEqual(['clouddev', 'laptop'])
  })

  it('a start with no message sends the task\'s description, as a continue does; a stopped conversation moves too', async () => {
    const { task } = await taskOnLaptop('stopped')
    unreachable()
    expect(await moveFromLostHost(task, { taskIdPrefix: task.id, host: 'clouddev', source: 'test' })).toMatchObject({ hostLost: { from: 'laptop' } })
    expect(M.sends[0]).toMatchObject({ text: 'Make the parser faster.' })
  })

  it('a host that answers keeps the usual path; one that does not but is not gone is refused with why', async () => {
    const { task } = await taskOnLaptop()
    const start = () => moveFromLostHost(task, { taskIdPrefix: task.id, host: 'clouddev', message: 'Go on.', source: 'test' })
    __setHostProbeForTesting(async () => ({ reachable: true }))
    expect(await start(), 'it answers').toBeNull()
    const refusals: Array<[string, () => void, RegExp]> = [
      ['its sign-in failed', () => unreachable('Permission denied (publickey).'), /sign-in/],
      ['down for a moment', () => unreachable(undefined, { lostSince: () => Date.now() - 30_000 }), /only 30 s/],
      ['the new host does not answer either', () => unreachable(undefined, undefined, true), /this machine may be the one offline/],
      ['no network here', () => unreachable(undefined, { online: () => false }), /no network connection/],
      ['the connect failed here', () => unreachable('ssh: connect to host laptop port 22: Network is unreachable'), /own network/],
    ]
    for (const [why, arm, words] of refusals) {
      arm()
      await expect(start(), why).rejects.toMatchObject({ statusCode: 409, body: { code: 'host_unreachable' }, message: expect.stringMatching(words) })
    }
    unreachable()
    probed.length = 0
    expect(await moveFromLostHost(task, { taskIdPrefix: task.id, host: 'laptop', source: 'test' })).toBeNull()
    expect(probed).toEqual([])
    expect(M.moves).toEqual([])
    expect(M.sends).toEqual([])
  })

  it('a move that does not finish at once refuses the start, so its message is never dropped', async () => {
    const { task } = await taskOnLaptop()
    unreachable()
    M.pending = true
    await expect(moveFromLostHost(task, { taskIdPrefix: task.id, host: 'clouddev', message: 'Go on.', source: 'test' }))
      .rejects.toMatchObject({ statusCode: 409, body: { code: 'move_under_way' }, message: expect.stringContaining('was not sent') })
    expect(M.sends).toEqual([])
  })

  it('an ACP session on a gone host keeps the refusal', async () => {
    const { task } = await taskOnLaptop('idle', 'codex')
    unreachable()
    expect(await moveFromLostHost(task, { taskIdPrefix: task.id, host: 'clouddev', source: 'test' })).toBeNull()
    expect(M.moves).toEqual([])
  })
})

describe('hostGone', () => {
  const now = Date.parse('2026-11-07T10:00:00Z')
  const longAgo = () => now - HOST_GONE_AFTER_MS - 1

  it('needs the link down a while, a reason other than a sign-in, and this machine online', async () => {
    unreachable(undefined, { lostSince: longAgo, otherHosts: async () => ({ configured: 1, connected: 1 }) })
    expect(await hostGone('laptop', { now })).toMatchObject({ gone: true })
    unreachable(undefined, { lostSince: () => now - 5_000 })
    probed.length = 0
    expect(await hostGone('laptop', { now })).toMatchObject({ gone: false, unreachable: true, why: expect.stringContaining('only 5 s') })
    // What this server already knows answers first: no dial (up to 8 s) for a host down a moment.
    expect(probed).toEqual([])
    // Never reached since this server started, a minute ago: too soon to tell.
    unreachable(undefined, { lostSince: () => null, uptimeMs: () => 60_000 })
    expect(await hostGone('laptop', { now })).toMatchObject({ gone: false })
    unreachable('Host key verification failed.')
    expect(await hostGone('laptop', { now })).toMatchObject({ gone: false, why: expect.stringContaining('sign-in') })
    expect(await hostGone('__local__', { now })).toMatchObject({ gone: false })
    __setHostProbeForTesting(async () => ({ reachable: true }))
    expect(await hostGone('laptop', { now })).toEqual({ gone: false, why: 'it answers' })
  })

  it('a Mac that slept overnight does not count its sleep as the host being away', async () => {
    unreachable(undefined, { lostSince: () => now - 9 * 3600_000, awakeDownMs: () => 20_000 })
    expect(await hostGone('laptop', { now })).toMatchObject({ gone: false, why: expect.stringContaining('only 20 s') })
    unreachable(undefined, { lostSince: () => now - 9 * 3600_000, awakeDownMs: () => HOST_GONE_AFTER_MS + 1 })
    expect(await hostGone('laptop', { now })).toMatchObject({ gone: true })
  })

  it('this machine offline is never read as the host gone', async () => {
    // The move's new host does not answer either.
    unreachable(undefined, { lostSince: longAgo }, true)
    expect(await hostGone('laptop', { now, target: 'clouddev' })).toMatchObject({ gone: false, why: expect.stringContaining('this machine may be the one offline') })
    // Moving to this Mac: some other host must answer, when there is one.
    unreachable(undefined, { lostSince: longAgo, otherHosts: async () => ({ configured: 2, connected: 0 }) })
    expect(await hostGone('laptop', { now, target: '__local__' })).toMatchObject({ gone: false, why: expect.stringContaining('may be the one offline') })
    // No other host to ask: this machine's own address and the failure's words tell.
    unreachable(undefined, { lostSince: longAgo, online: () => false })
    expect(await hostGone('laptop', { now })).toMatchObject({ gone: false, why: 'this machine has no network connection' })
    unreachable('ssh: connect to host laptop port 22: Network is unreachable', { lostSince: longAgo })
    expect(await hostGone('laptop', { now })).toMatchObject({ gone: false, why: expect.stringContaining("own network") })
    unreachable(undefined, { lostSince: longAgo })
    expect(await hostGone('laptop', { now, target: 'clouddev' })).toMatchObject({ gone: true })
  })
})
