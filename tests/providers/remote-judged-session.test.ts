/**
 * RemoteJudgedSession (src/providers/remote-judged-session.ts): one object per session id (the
 * identity fences in session-snapshot-apply.ts and session-reconcile.ts compare them), sync
 * getters from the newest `live` state, every other member a call to the host, and a teardown
 * mark whose undo is local and asks the host to undo its own.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

/** The Walnut subagents this leader runs, per parent session (subagents/registry.ts lightSubagentRows). */
const lightRows = vi.hoisted(() => new Map<string, Array<{ taskId: string; taskType: string; status: string }>>())
vi.mock('../../src/core/subagents/registry.js', () => ({ lightSubagentRows: (sid: string) => lightRows.get(sid) ?? [] }))

import { bus, EventNames, type BusEvent } from '../../src/core/event-bus.js'
import {
  _resetRemoteJudgedSessionsForTesting, forgetRemoteJudgedSession, markHostLiveUnknown, noteLiveState, peekRemoteJudgedSession, remoteJudgedSession, renameRemoteJudgedSession,
  setRemoteJudgedCaller, withLeaderSubagentRows, type HostCallBody,
} from '../../src/providers/remote-judged-session.js'
import { callArgsIn, callArgsOut, hostCallAllowed } from '../../src/core/session-channel/host-calls.js'

afterEach(() => { _resetRemoteJudgedSessionsForTesting(); lightRows.clear() })

function fakeHost() {
  const calls: Array<{ host: string } & HostCallBody> = []
  setRemoteJudgedCaller(async (host, body) => {
    calls.push({ host, ...body })
    if (!hostCallAllowed(body.target, body.member)) throw new Error(`not allowed: ${body.target}.${body.member}`)
    if (body.member === 'markExpectedTeardown') return { undoId: 'u-1' }
    return { echoed: body.member }
  })
  return calls
}

describe('RemoteJudgedSession', () => {
  it('hands a call\'s arguments on as given; the wire encodes them once, and the host reads each unset one as unset', async () => {
    const calls = fakeHost()
    const p = remoteJudgedSession('s1', 'devbox', 'native')
    // The leader's prompt answer (session-lifecycle.ts respondSessionPermission) names every parameter;
    // an optionId sent as null read as given on the host, which refused it as an unknown option.
    await p.resolvePermissionRequest('req-1', true, undefined, undefined, undefined)
    await p.resolvePermissionRequest('req-2', true, undefined, { answers: { q: 'a' } }, undefined)
    expect(calls.map((c) => c.args)).toEqual([['req-1', true, undefined, undefined, undefined], ['req-2', true, undefined, { answers: { q: 'a' } }, undefined]])
    // The wire (leader-side.ts callHost, companion-host-ops.ts): trailing ones off, an inner one named.
    const wire = calls.map((c) => JSON.parse(JSON.stringify(callArgsOut(c.args as unknown[]))))
    expect(wire).toEqual([{ args: ['req-1', true] }, { args: ['req-2', true, null, { answers: { q: 'a' } }], unset: [2] }])
    expect(wire.map((w) => callArgsIn(w.args, w.unset))).toEqual([['req-1', true], ['req-2', true, undefined, { answers: { q: 'a' } }]])
    // A null the caller sent stays null; a bad `unset` restores nothing.
    expect(callArgsIn(['a', null], [1])).toEqual(['a', undefined])
    expect(callArgsIn(['a', 'b', null], [1, -1, 9, 1.5, 'x'])).toEqual(['a', 'b', null])
  })

  it('is one stable object per session id, also across a rename', () => {
    const a = remoteJudgedSession('s1', 'devbox', 'native')
    expect(remoteJudgedSession('s1', 'devbox', 'native')).toBe(a)
    renameRemoteJudgedSession('s1', 's2')
    expect(peekRemoteJudgedSession('s1')).toBeUndefined()
    expect(remoteJudgedSession('s2', 'devbox', 'native')).toBe(a)
    expect(a.sessionId).toBe('s2')
  })

  it('answers its getters from the newest live state, also one that came before the lookup', () => {
    noteLiveState('s1', { turnGen: 4, processStatus: 'running', inTurn: true, pendingPermission: true, mode: 'plan', teamActive: true, outliving: ['background'] })
    const p = remoteJudgedSession('s1', 'devbox', 'native')
    expect(p.turnGen).toBe(4)
    expect(p.processStatus).toBe('running')
    expect(p.inTurn).toBe(true)
    expect(p.hasPendingPermission).toBe(true)
    expect(p.mode).toBe('plan')
    expect(p.teamActive).toBe(true)
    expect(p.workOutlivesTurn).toBe(true)
    // The runner's rule: an armed /loop alone keeps the work list, not the turn open.
    noteLiveState('s1', { turnGen: 4, processStatus: 'idle', outliving: ['loop'] })
    expect(p.outlivingWork).toEqual(['loop'])
    expect(p.workOutlivesTurn).toBe(false)
    noteLiveState('s1', { turnGen: 5, processStatus: 'idle' })
    expect(p.turnGen).toBe(5)
    expect(p.processStatus).toBe('idle')
    expect(p.inTurn).toBe(false)
    // A session nothing was heard of reads as one this server does not run.
    const q = remoteJudgedSession('s9', 'devbox', 'native')
    expect(q.processStatus).toBe('stopped')
    expect(q.controlChannelState).toBe('dead')
    expect(q.getPendingPermissionRequests()).toEqual([])
  })

  it('forwards every other member to its host, with the target its kind names, and only allowlisted members', async () => {
    const calls = fakeHost()
    const p = remoteJudgedSession('s1', 'devbox', 'native')
    await expect(p.getContextUsage()).resolves.toEqual({ echoed: 'getContextUsage' })
    await p.gracefulStop('why')
    await p.transport.prepareOutbound('x')
    await p.bashCallMatchingOp('task_get', undefined, ['t1'])
    const a = remoteJudgedSession('a1', 'devbox', 'acp')
    await a.setModel('m')
    await a.gracefulStop()
    expect(calls.map((c) => `${c.host}:${c.target}.${c.member}`)).toEqual([
      'devbox:session.getContextUsage', 'devbox:session.gracefulStop', 'devbox:session.prepareOutbound',
      'devbox:session.bashCallMatchingOp', 'devbox:acp.setModel', 'devbox:acp.gracefulStop',
    ])
    expect(calls[1].args).toEqual(['why'])
    // The snapshot writers are no-ops: nothing is sent.
    p.setProcessStatusFromReconciler()
    p.setForegroundFromSnapshot()
    p.resetConsumedOffsetFromSnapshot()
    p.setCronArmedFromSnapshot()
    expect(calls).toHaveLength(6)
  })

  it('R2-L3: an ACP proxy never reaches its host\'s native lookups: detach and kill go to its ACP object, the catalog and teardown mark stay here', async () => {
    const calls = fakeHost()
    noteLiveState('a1', { acp: { modelCatalog: { models: ['m1'] } } })
    const a = remoteJudgedSession('a1', 'devbox', 'acp')
    a.detach()
    a.kill()
    a.invalidateModelCatalog()
    await expect(a.getModelCatalog()).resolves.toEqual({ models: ['m1'] })
    const undo = a.markExpectedTeardown('task_completed')
    expect(a.teardownReason).toBe('task_completed')
    undo()
    await vi.waitFor(() => expect(calls.map((c) => `${c.target}.${c.member}`)).toEqual(['acp.detach', 'acp.kill']))
    await new Promise((r) => setTimeout(r, 10))
    expect(calls.every((c) => hostCallAllowed(c.target, c.member))).toBe(true)
    expect(calls).toHaveLength(2)
  })

  it('R2-M1: a host\'s {gone} state reads not running; a link down past its bound reads unknown; a delete forgets the proxy', () => {
    noteLiveState('s1', { turnGen: 2, processStatus: 'running', turnRunning: true, pendingPermission: true }, 'devbox')
    noteLiveState('s9', { processStatus: 'running', turnRunning: true }, 'another-box')
    const p = remoteJudgedSession('s1', 'devbox', 'native')
    expect(p.turnRunning).toBe(true)
    expect(markHostLiveUnknown('devbox')).toBe(1)
    expect(p.liveUnknown).toBe(true)
    expect(p.turnRunning).toBe(false)
    expect(p.hasPendingPermission).toBe(false)
    expect(p.active).toBe(false)
    // Another host's session keeps its state.
    expect(remoteJudgedSession('s9', 'another-box', 'native').turnRunning).toBe(true)
    // The host linked again and sent its state; then the session ended there.
    noteLiveState('s1', { processStatus: 'running', turnRunning: true }, 'devbox')
    expect(p.liveUnknown).toBe(false)
    expect(p.turnRunning).toBe(true)
    noteLiveState('s1', { gone: true }, 'devbox')
    expect(p.turnRunning).toBe(false)
    expect(p.processStatus).toBe('stopped')
    forgetRemoteJudgedSession('s1')
    expect(peekRemoteJudgedSession('s1')).toBeUndefined()
  })

  it('a teardown mark is local at once, and its undo puts it back and asks the host to undo', async () => {
    const calls = fakeHost()
    const p = remoteJudgedSession('s1', 'devbox', 'native')
    const undo = p.markExpectedTeardown('restart')
    expect(p.teardownReason).toBe('restart')
    undo()
    undo()
    expect(p.teardownReason).toBeUndefined()
    await new Promise((r) => setTimeout(r, 0))
    expect(calls.map((c) => c.member)).toEqual(['markExpectedTeardown', 'undoExpectedTeardown'])
    // The host's undo is named by the id it answered the mark with.
    expect(calls[1].args).toEqual(['u-1'])
  })

  it('its Background panel is its host\'s ledger with the subagents this leader runs for it, said here', () => {
    const calls = fakeHost()
    const p = remoteJudgedSession('s1', 'devbox', 'native')
    // Nothing on either side: no panel, as a session here answers.
    expect(p.backgroundTasksSnapshot('s1')).toBeNull()
    noteLiveState('s1', { backgroundTasks: { sessionId: 's1', inFlight: 1, tasks: [{ taskId: 'cli-agent-1', taskType: 'local_agent', status: 'running' }], phases: [], agents: [] } })
    lightRows.set('s1', [{ taskId: 'sa-1', taskType: 'walnut_subagent', status: 'running' }])
    expect(p.backgroundTasksSnapshot('s1')).toMatchObject({ sessionId: 's1', inFlight: 1, tasks: [{ taskId: 'cli-agent-1' }, { taskId: 'sa-1' }] })
    // Only the leader's subagents: a panel of its own.
    lightRows.set('s2', [{ taskId: 'sa-2', taskType: 'walnut_subagent', status: 'done' }])
    expect(remoteJudgedSession('s2', 'devbox', 'native').backgroundTasksSnapshot('s2')).toMatchObject({ sessionId: 's2', inFlight: 0, tasks: [{ taskId: 'sa-2' }] })
    // An update is said on this bus (the registry asks it when a subagent moves), never asked of the host.
    const seen: BusEvent[] = []
    bus.subscribe('proxy-panel-test', (e) => { seen.push(e) }, { global: true, interest: [EventNames.SESSION_BACKGROUND_TASKS] })
    try {
      p.emitBackgroundTasks()
      expect(seen.map((e) => (e.data as { tasks: Array<{ taskId: string }> }).tasks.map((t) => t.taskId))).toEqual([['cli-agent-1', 'sa-1']])
      expect(calls).toEqual([])
    } finally { bus.unsubscribe('proxy-panel-test') }
    // The host's re-emitted ledger gets the leader's rows too; a host row of the same id is replaced.
    expect(withLeaderSubagentRows({ sessionId: 's1', tasks: [{ taskId: 'sa-1', status: 'stale' }, { taskId: 'x' }] }, 's1').tasks).toEqual([{ taskId: 'x' }, { taskId: 'sa-1', taskType: 'walnut_subagent', status: 'running' }])
  })

  it('a call with no link to the host fails with words, and a fire-and-forget one never throws', async () => {
    const p = remoteJudgedSession('s1', 'devbox', 'native')
    await expect(p.getUsage()).rejects.toThrow(/runs on devbox/)
    expect(() => p.kill()).not.toThrow()
  })
})
