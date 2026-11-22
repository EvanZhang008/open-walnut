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
  _resetRemoteJudgedSessionsForTesting, noteLiveState, peekRemoteJudgedSession, remoteJudgedSession, renameRemoteJudgedSession,
  setRemoteJudgedCaller, withLeaderSubagentRows, type HostCallBody,
} from '../../src/providers/remote-judged-session.js'
import { hostCallAllowed } from '../../src/core/session-channel/host-calls.js'

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
