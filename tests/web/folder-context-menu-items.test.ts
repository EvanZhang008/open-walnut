/**
 * The FOLDER right-click menu's row list, as a plain function (sibling of
 * project-context-menu-items.test.ts). The Project row is a SETTING row: it reads the folder's
 * project on the row itself, and it is disabled (never missing) while the project is unknown.
 */
import { describe, expect, it, vi } from 'vitest'
import {
  buildFolderMenuItems,
  type FolderMenuActions,
  type FolderMenuTarget,
} from '@/components/tasks/folder-menu-items'
import { normalizeContextMenuItems } from '@/utils/context-menu'

const full = (): FolderMenuActions => ({
  onRename: vi.fn(), onToggleCollapse: vi.fn(), onMoveToProject: vi.fn(), onHide: vi.fn(), onDelete: vi.fn(),
})

const items = (target: FolderMenuTarget, actions: FolderMenuActions, open = vi.fn()) =>
  normalizeContextMenuItems(buildFolderMenuItems(target, actions, open))

describe('buildFolderMenuItems', () => {
  it('offers every row in order; the project move is a Project setting row', () => {
    const rows = items({ groupId: 'g1', label: 'Triage', project: 'Marina' }, full()).filter((i) => !i.divider)
    expect(rows.map((i) => String(i.label))).toEqual([
      'Rename folder', 'Collapse folder', 'Project', 'Hide from Focus', 'Delete folder',
    ])
  })

  it('the Project row shows the folder\'s project; Inbox reads Inbox', () => {
    const project = (p: string | undefined) =>
      items({ groupId: 'g1', label: 'Triage', project: p }, full()).find((i) => i.key === 'move-project')
    expect(project('Marina')?.value).toBe('Marina')
    expect(project('')?.value).toBe('Inbox')
  })

  it('an unknown project keeps the row, disabled with the reason, and running it does nothing', () => {
    const open = vi.fn()
    const row = items({ groupId: 'g1', label: 'Triage' }, full(), open).find((i) => i.key === 'move-project')
    expect(row?.disabled).toBe(true)
    expect(row?.title).toBe('Folder project still loading')
    row?.onSelect?.()
    expect(open).not.toHaveBeenCalled()
  })

  it('running the row opens the picker for this folder', () => {
    const open = vi.fn()
    const target = { groupId: 'g1', label: 'Triage', project: 'Marina' }
    items(target, full(), open).find((i) => i.key === 'move-project')?.onSelect?.()
    expect(open).toHaveBeenCalledWith(target)
  })

  it('a surface without a move handler draws no Project row; the rest follow the handlers', () => {
    const actions = full()
    delete actions.onMoveToProject
    delete actions.onHide
    const rows = items({ groupId: 'g1', label: 'Triage', project: 'Marina', collapsed: true }, actions).filter((i) => !i.divider)
    expect(rows.map((i) => String(i.label))).toEqual(['Rename folder', 'Expand folder', 'Delete folder'])
  })
})
