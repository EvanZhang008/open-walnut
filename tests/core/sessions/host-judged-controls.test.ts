/**
 * The controls a leader hands whole to the host that runs a session (host-judged-controls.ts):
 * a stop and a mode change go as one `lifecycle` call to that host; the leader writes only its own
 * fields and moves the task's slots.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const m = vi.hoisted(() => ({
  proxy: null as null | { host?: string; call: ReturnType<typeof vi.fn> },
  rows: new Map<string, Record<string, unknown>>(),
  updates: [] as Array<[string, Record<string, unknown>]>,
  slots: [] as unknown[][],
}))

vi.mock('../../../src/providers/host-judged-runner.js', () => ({ hostJudgedSession: () => m.proxy }))
vi.mock('../../../src/core/session-tracker.js', () => ({
  getSessionByClaudeId: async (sid: string) => m.rows.get(sid) ?? null,
  updateSessionRecord: async (sid: string, u: Record<string, unknown>) => {
    m.updates.push([sid, u])
    const row = { ...(m.rows.get(sid) ?? {}), ...u }
    m.rows.set(sid, row)
    return row
  },
}))
vi.mock('../../../src/core/sessions/session-lifecycle.js', () => ({
  reconcileModeSlots: async (...args: unknown[]) => { m.slots.push(args) },
}))

import { HostNeedsUpdateError, changeModeOnHost, onJudgingHost, terminateOnHost } from '../../../src/core/sessions/host-judged-controls.js'
import { _resetSessionCommandGateForTesting, noteHostTakesChecks } from '../../../src/core/sessions/session-command-gate.js'

describe('host-judged controls', () => {
  beforeEach(() => {
    m.proxy = { call: vi.fn() }
    m.rows.clear()
    m.updates = []
    m.slots = []
  })

  it('a stop is the host\'s answer, asked as a lifecycle call', async () => {
    m.proxy!.call.mockResolvedValue({ status: 'terminated', sessionId: 's1', tookMs: 3 })
    expect(await terminateOnHost('s1', { force: true, by: 'person' })).toEqual({ status: 'terminated', sessionId: 's1', tookMs: 3 })
    expect(m.proxy!.call).toHaveBeenCalledWith('terminateSession', [{ force: true, by: 'person' }], 'lifecycle')
  })

  it('a stop the host answered as done is in the leader\'s row at once, so a send right after it meets no stop fence', async () => {
    m.rows.set('s1', { claudeSessionId: 's1', judge: 'host', host: 'devbox', stopRequest: { id: 'st1', requestedAt: '2026-11-24T00:00:00.000Z', state: 'pending' } })
    m.proxy!.call.mockResolvedValue({ status: 'terminated', sessionId: 's1', stopRequest: { id: 'st1', requestedAt: '2026-11-24T00:00:00.000Z', state: 'confirmed' } })
    await terminateOnHost('s1', { force: true })
    expect(m.updates).toEqual([['s1', { stopRequest: { id: 'st1', requestedAt: '2026-11-24T00:00:00.000Z', state: 'confirmed' } }]])
  })

  it('a pending stop, a stop with no record, a later stop already here and a row no host judges are left to the channel', async () => {
    const later = { id: 'st2', requestedAt: '2026-11-24T00:05:00.000Z', state: 'pending' }
    for (const [row, answer] of [
      [{ judge: 'host', host: 'devbox' }, { status: 'pending', sessionId: 's1', stopRequest: { id: 'st1', requestedAt: '2026-11-24T00:00:00.000Z', state: 'pending' } }],
      [{ judge: 'host', host: 'devbox' }, { status: 'terminated', sessionId: 's1' }],
      [{ judge: 'host', host: 'devbox', stopRequest: later }, { status: 'terminated', sessionId: 's1', stopRequest: { id: 'st1', requestedAt: '2026-11-24T00:00:00.000Z', state: 'confirmed' } }],
      [{ host: 'devbox' }, { status: 'terminated', sessionId: 's1', stopRequest: { id: 'st1', requestedAt: '2026-11-24T00:00:00.000Z', state: 'confirmed' } }],
    ] as const) {
      m.rows.set('s1', { claudeSessionId: 's1', ...row })
      m.proxy!.call.mockResolvedValue(answer)
      await terminateOnHost('s1', {})
    }
    expect(m.updates).toEqual([])
  })

  it('a mode change goes to the host; the leader writes its own fields and moves the slots', async () => {
    m.rows.set('s1', { claudeSessionId: 's1', mode: 'bypass', title: 'Old' })
    m.proxy!.call.mockResolvedValue({ mode: 'plan' })
    const row = await changeModeOnHost({ claudeSessionId: 's1', mode: 'bypass' } as never, 's1', 'plan', { title: 'New' })
    expect(m.proxy!.call).toHaveBeenCalledWith('changeSessionModeOf', ['plan'], 'lifecycle')
    // The mode is not written here: the host's row record brings it back.
    expect(m.updates).toEqual([['s1', { title: 'New' }]])
    expect(m.slots).toHaveLength(1)
    expect(m.slots[0].slice(1)).toEqual(['s1', 'bypass', 'plan'])
    expect(row).toMatchObject({ title: 'New', mode: 'plan' })
  })

  it('a mode change with no leader field writes nothing here', async () => {
    m.rows.set('s1', { claudeSessionId: 's1', mode: 'bypass' })
    m.proxy!.call.mockResolvedValue({ mode: 'plan' })
    await changeModeOnHost({ claudeSessionId: 's1', mode: 'bypass' } as never, 's1', 'plan', {})
    expect(m.updates).toEqual([])
  })

  it('a session no host runs is refused', async () => {
    m.proxy = null
    await expect(terminateOnHost('s1', {})).rejects.toThrow(/not run by a host/)
  })

  it('a check (supervision, a line\'s fate, a pending start\'s cancel) goes only to a host that names the checks capability', async () => {
    _resetSessionCommandGateForTesting()
    m.proxy = { host: 'devbox', call: vi.fn().mockResolvedValue(true) }
    for (const member of ['readSessionSupervision', 'lineAlreadyRan', 'cancelPendingStart'] as const) {
      await expect(onJudgingHost('s1', member, [])).rejects.toBeInstanceOf(HostNeedsUpdateError)
    }
    expect(m.proxy.call).not.toHaveBeenCalled()
    // A stop is no check: an older host takes it as before.
    m.proxy.call.mockResolvedValue({ status: 'terminated', sessionId: 's1' })
    await terminateOnHost('s1', { force: true })
    expect(m.proxy.call).toHaveBeenCalledTimes(1)
    noteHostTakesChecks('devbox', true)
    m.proxy.call.mockResolvedValue(true)
    expect(await onJudgingHost('s1', 'lineAlreadyRan', ['u1', []])).toBe(true)
    expect(m.proxy.call).toHaveBeenLastCalledWith('lineAlreadyRan', ['u1', []], 'lifecycle')
  })
})
