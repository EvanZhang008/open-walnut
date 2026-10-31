/**
 * A leader's status carries its subtasks' questions for the user (rollUpAsks in
 * src/core/user-status.ts, 2026-10-31: asks roll up level by level), and agents read them on the
 * leader's task_list row as `asks_below` (src/ops/tasks.ts). Pure.
 */
import { describe, it, expect } from 'vitest'
import { rollUpAsks, ROLLED_ASKS_MAX, type UserStatus } from '../../src/core/user-status.js'
import { leanTaskRow } from '../../src/ops/tasks.js'

const needs = (ask: string, extra: Partial<UserStatus> = {}): UserStatus => ({ state: 'needs', source: 'session', ask, checkedAt: '2026-10-31T10:00:00.000Z', unverified: true, ...extra }) as UserStatus

describe('rollUpAsks', () => {
  it('carries each open subtask\'s own ask, then the ones it carries, naming the way up', () => {
    const asks = rollUpAsks([
      { id: 'w1', title: 'Parser', user_status: { ...needs('Which format?'), asks: [{ id: 'd1', title: 'Lexer', ask: 'Keep tabs?' }] } },
      { id: 'w2', title: 'Docs', phase: 'COMPLETE', user_status: needs('Publish?') },
      { id: 'w3', title: 'Snoozed', user_status: needs('Later?', { snoozed: { until: '2026-11-05' } } as never) },
      { id: 'w4', title: 'Busy', user_status: { state: 'working' } as UserStatus },
    ])
    expect(asks).toEqual([
      { id: 'w1', title: 'Parser', ask: 'Which format?', checkedAt: '2026-10-31T10:00:00.000Z' },
      { id: 'd1', title: 'Lexer', ask: 'Keep tabs?', via: 'w1' },
    ])
    // Its age is read at the asking task: a clock passing rewrites no leader.
    expect(asks[0]).not.toHaveProperty('unverified')
  })

  it('never carries its own ask back up a parent loop, never one twice, and at most the cap', () => {
    const loop = rollUpAsks([{ id: 'b', title: 'B', user_status: { ...needs('B?'), asks: [{ id: 'a', title: 'A', ask: 'A?' }, { id: 'b', title: 'B', ask: 'B?' }] } }], 'a')
    expect(loop.map((x) => x.id)).toEqual(['b'])
    const many = rollUpAsks(Array.from({ length: ROLLED_ASKS_MAX + 5 }, (_, i) => ({ id: `t${i}`, title: `T${i}`, user_status: needs(`Q${i}?`) })))
    expect(many).toHaveLength(ROLLED_ASKS_MAX)
  })
})

describe('the agent-facing task row', () => {
  it('lists the asks below a leader as asks_below, and none when there are none', () => {
    const row = leanTaskRow({ id: 'lead', title: 'Lead', phase: 'IN_PROGRESS', project: 'Garden', user_status: { state: 'waiting', asks: [{ id: 'w1', title: 'Parser', ask: 'Which format?', checkedAt: 'x', via: 'y' }] } }) as Record<string, unknown>
    expect(row.asks_below).toEqual([{ id: 'w1', title: 'Parser', ask: 'Which format?' }])
    const plain = leanTaskRow({ id: 'w', title: 'W', phase: 'IN_PROGRESS', project: 'Garden', user_status: { state: 'working' } }) as Record<string, unknown>
    expect(plain).not.toHaveProperty('asks_below')
  })
})
