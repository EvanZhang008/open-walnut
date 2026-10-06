/**
 * A folder's or a project's Pinned and plugin-field rows act on its OPEN tasks and read what
 * they share. Pure logic (no renderer): which tasks count, the mixed-state reading, the rows
 * the menu draws, and when a pick asks first.
 */
import { describe, expect, it, vi } from 'vitest'
import type { Task } from '@open-walnut/core'
import {
  BULK_CONFIRM_AT, buildFieldRows, buildPinnedPills, bulkConfirmCopy, commonTier, commonValue,
  folderMemberTasks, projectMemberTasks, type TierPillOption,
} from '@/components/tasks/bulk-task-settings'

const task = (id: string, over: Partial<Task> = {}): Task => ({
  id, title: id, phase: 'TODO', status: 'todo', project: 'Marina', ...over,
} as Task)

const OPTIONS: TierPillOption[] = [
  { value: 'focus', label: 'Focus', color: 'blue' },
  { value: 'satellite', label: 'Satellite', color: 'purple' },
  { value: 'wait', label: 'Parked', color: 'amber' },
]

describe('which tasks a group acts on', () => {
  const tasks = [
    task('a', { group_id: 'g1' }),
    task('b', { group_id: 'g2' }),
    task('c', { group_id: 'g1', phase: 'COMPLETE', status: 'done' }),
    task('d', { group_id: 'other' }),
    task('e', { project: 'marina ' }),
    task('f', { project: '' }),
  ]

  it('a folder: its own and its subfolders\' open tasks, never a completed one', () => {
    expect(folderMemberTasks(tasks, new Set(['g1', 'g2'])).map((t) => t.id)).toEqual(['a', 'b'])
  })

  it('a project: case- and space-insensitive like the server; the Inbox is the empty project', () => {
    expect(projectMemberTasks(tasks, 'MARINA').map((t) => t.id)).toEqual(['a', 'b', 'd', 'e'])
    expect(projectMemberTasks(tasks, '').map((t) => t.id)).toEqual(['f'])
  })
})

describe('commonTier', () => {
  const tierOf = (t: Task) => (t.focus_tier as string | undefined) ?? 'satellite'

  it('nothing pinned, or no tasks at all, reads unpinned', () => {
    expect(commonTier([task('a'), task('b')], tierOf)).toEqual({ kind: 'unpinned' })
    expect(commonTier([], tierOf)).toEqual({ kind: 'unpinned' })
  })

  it('every task in one tier reads that tier', () => {
    const pinned = [task('a', { pinned: true, focus_tier: 'focus' }), task('b', { pinned: true, focus_tier: 'focus' })]
    expect(commonTier(pinned, tierOf)).toEqual({ kind: 'pinned', tier: 'focus' })
  })

  it('some pinned, or pinned in different tiers, reads mixed', () => {
    expect(commonTier([task('a', { pinned: true }), task('b')], tierOf)).toEqual({ kind: 'mixed' })
    expect(commonTier([task('a', { pinned: true, focus_tier: 'focus' }), task('b', { pinned: true })], tierOf))
      .toEqual({ kind: 'mixed' })
  })
})

describe('commonValue', () => {
  const read = (t: Task) => t.sprint
  it('none, same and mixed', () => {
    expect(commonValue([task('a'), task('b')], read)).toEqual({ kind: 'none' })
    expect(commonValue([task('a', { sprint: 'S1' }), task('b', { sprint: 'S1' })], read)).toEqual({ kind: 'same', value: 'S1' })
    expect(commonValue([task('a', { sprint: 'S1' }), task('b')], read)).toEqual({ kind: 'mixed' })
    expect(commonValue([], read)).toEqual({ kind: 'none' })
  })
})

describe('buildPinnedPills', () => {
  it('one pill per tier on one row; the heading says Pin to until every task is pinned', () => {
    const pills = buildPinnedPills({ options: OPTIONS, common: { kind: 'unpinned' }, count: 3, noun: 'folder', onPick: vi.fn() })
    expect(pills.map((p) => [p.label, p.pill?.group, p.pill?.label, p.checked])).toEqual([
      ['Focus', 'pinned', 'Pin to', false], ['Satellite', 'pinned', 'Pin to', false], ['Parked', 'pinned', 'Pin to', false],
    ])
    expect(pills[0].title).toBe('Pin the 3 open tasks to Focus')
  })

  it('the lit pill is the pin: clicking it again unpins, another pill moves them', () => {
    const onPick = vi.fn()
    const pills = buildPinnedPills({ options: OPTIONS, common: { kind: 'pinned', tier: 'wait' }, count: 2, noun: 'project', onPick })
    expect(pills.find((p) => p.checked)?.label).toBe('Parked')
    expect(pills[0].pill?.label).toBe('Pinned')
    pills[2].onSelect?.()
    pills[0].onSelect?.()
    expect(onPick.mock.calls).toEqual([[null], ['focus']])
    expect(pills[2].title).toBe('Unpin the 2 open tasks')
  })

  it('mixed lights nothing; a group with no open task keeps the row, disabled with the reason', () => {
    expect(buildPinnedPills({ options: OPTIONS, common: { kind: 'mixed' }, count: 4, noun: 'folder', onPick: vi.fn() })
      .some((p) => p.checked)).toBe(false)
    const empty = buildPinnedPills({ options: OPTIONS, common: { kind: 'unpinned' }, count: 0, noun: 'folder', onPick: vi.fn() })
    expect(empty.every((p) => p.disabled)).toBe(true)
    expect(empty[0].title).toBe('No open tasks in this folder')
  })
})

describe('buildFieldRows', () => {
  it('reads the shared value, Mixed or Set… and opens that field', () => {
    const onOpen = vi.fn()
    const rows = buildFieldRows({
      fields: [
        { id: 'p.sprint', label: 'Sprint', common: { kind: 'same', value: 'S7' } },
        { id: 'p.area', label: 'Area', common: { kind: 'mixed' } },
        { id: 'p.size', label: 'Size', common: { kind: 'none' } },
      ],
      count: 5,
      noun: 'project',
      onOpen,
    })
    expect(rows.map((r) => [r.label, r.value])).toEqual([['Sprint', 'S7'], ['Area', 'Mixed'], ['Size', 'Set…']])
    rows[0].onSelect?.()
    expect(onOpen).toHaveBeenCalledWith('p.sprint')
  })
})

describe('bulkConfirmCopy', () => {
  it('asks only from the threshold up', () => {
    expect(bulkConfirmCopy({ kind: 'tier', tierLabel: 'Focus' }, BULK_CONFIRM_AT - 1)).toBeNull()
    expect(bulkConfirmCopy({ kind: 'tier', tierLabel: 'Focus' }, BULK_CONFIRM_AT)?.title).toBe(`Pin ${BULK_CONFIRM_AT} tasks to Focus?`)
    expect(bulkConfirmCopy({ kind: 'tier', tierLabel: null }, 30)?.title).toBe('Unpin 30 tasks?')
    expect(bulkConfirmCopy({ kind: 'field', fieldLabel: 'Sprint', valueLabel: 'S7' }, 30)?.title).toBe('Set Sprint to S7 on 30 tasks?')
    expect(bulkConfirmCopy({ kind: 'field', fieldLabel: 'Sprint', valueLabel: null }, 30)?.title).toBe('Clear Sprint on 30 tasks?')
  })
})
