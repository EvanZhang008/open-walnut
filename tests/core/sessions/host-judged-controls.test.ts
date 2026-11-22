/**
 * The controls a leader hands whole to the host that runs a session (host-judged-controls.ts):
 * a stop and a mode change go as one `lifecycle` call to that host; the leader writes only its own
 * fields and moves the task's slots.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const m = vi.hoisted(() => ({
  proxy: null as null | { call: ReturnType<typeof vi.fn> },
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

import { changeModeOnHost, terminateOnHost } from '../../../src/core/sessions/host-judged-controls.js'

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
})
