/**
 * Settings > General, "Went ahead without asking": the same step from the same task, several times,
 * is one entry with its count at the place of its newest (2026-11-22 audit: five near-identical
 * lines read as a wall).
 */
import { describe, expect, it } from 'vitest'
import { groupSame } from '../../web/src/components/settings/sections/ApprovalsAskRow.js'
import type { Approval } from '../../web/src/api/approvals.js'

const step = (id: string, what: string, taskId: string | undefined, at: string): Approval =>
  ({ id, what, createdAt: at, requester: { host: 'local', taskId, taskTitle: taskId ? `Task ${taskId}` : undefined } }) as unknown as Approval

describe('groupSame', () => {
  it('folds the same step of the same task, keeping newest-first order and the newest as lead', () => {
    const items = [
      step('a3', 'Gave the password to the sign-in', 't1', '2026-11-20T10:03:00Z'),
      step('b1', 'Upload a file', 't2', '2026-11-20T10:02:00Z'),
      step('a2', 'Gave the password to the sign-in', 't1', '2026-11-20T10:01:00Z'),
      step('a1', 'Gave the password to the sign-in', 't1', '2026-11-20T10:00:00Z'),
    ]
    const groups = groupSame(items)
    expect(groups.map((g) => [g.lead.id, g.all.length])).toEqual([['a3', 3], ['b1', 1]])
  })

  it('keeps the same words from another task, or from no task, apart', () => {
    const items = [
      step('x', 'Post the changelog', 't1', '2026-11-20T10:02:00Z'),
      step('y', 'Post the changelog', 't2', '2026-11-20T10:01:00Z'),
      step('z', 'Post the changelog', undefined, '2026-11-20T10:00:00Z'),
    ]
    expect(groupSame(items).map((g) => g.all.length)).toEqual([1, 1, 1])
  })
})
