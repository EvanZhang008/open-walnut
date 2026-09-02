/**
 * The PROJECT right-click menu's row list, as a plain function.
 *
 * `buildProjectMenuItems` is the ONE definition of what a project row offers, and
 * both surfaces that draw a project (the main list's header, the pinned tier's
 * label) pass only the handlers they can honour. That makes the interesting part a
 * GATING MATRIX rather than markup: named project vs Inbox (''), favorite on/off,
 * collapsed on/off, a request in flight, and which surface is asking. Pinning it
 * here (pure logic, node env, no renderer, sibling of context-menu-rules.test.ts)
 * is what lets the browser spec test gestures instead of re-checking every
 * combination of rows through a real menu.
 *
 * Inbox is the reason this file exists: it is stored as '' (falsy), so every
 * registry row has to be gated on the NAME, and a truthiness slip would offer
 * "Delete project" on a bucket that has no project to delete.
 */
import { describe, expect, it, vi } from 'vitest'
import {
  buildProjectMenuItems,
  type ProjectMenuActions,
  type ProjectMenuDialogs,
  type ProjectMenuTarget,
} from '@/components/tasks/ProjectContextMenu'
import { normalizeContextMenuItems } from '@/utils/context-menu'

/** No dialog in flight: the common case. */
function dialogs(over: Partial<ProjectMenuDialogs> = {}): ProjectMenuDialogs {
  return { busy: false, rename: vi.fn(), remove: vi.fn(), ...over }
}

/**
 * The handler set the PINNED TIER's project label passes (TierProjectLabel.tsx).
 * It is the fullest surface: it owns divider lines, so it is the only one that
 * passes `onNewSeparator`.
 */
function tierActions(over: Partial<ProjectMenuActions> = {}): ProjectMenuActions {
  return {
    onToggleCollapse: vi.fn(),
    onNewTask: vi.fn(),
    onNewFolder: vi.fn(),
    onNewSession: vi.fn(),
    onNewSeparator: vi.fn(),
    onToggleFavorite: vi.fn(),
    onViewDetails: vi.fn(),
    ...over,
  }
}

/** The MAIN LIST header's set (TodoPanel's ProjectHeaderRow): no separator row,
 *  because a line's position is defined by a tier's view mode and the list has
 *  none. */
function listActions(over: Partial<ProjectMenuActions> = {}): ProjectMenuActions {
  const full = tierActions()
  delete full.onNewSeparator
  return { ...full, ...over }
}

/** What the user actually sees: `when: false` rows dropped, dividers collapsed.
 *  `label` is typed as a ReactNode (the menu can host one), but every row here is
 *  plain text, and String() keeps that fact visible if one ever stops being. */
function labels(target: ProjectMenuTarget, actions: ProjectMenuActions, d = dialogs()): string[] {
  return normalizeContextMenuItems(buildProjectMenuItems(target, actions, d))
    .filter((i) => !i.divider)
    .map((i) => String(i.label ?? ''))
}

function row(target: ProjectMenuTarget, actions: ProjectMenuActions, key: string, d = dialogs()) {
  return buildProjectMenuItems(target, actions, d).find((i) => i.key === key)
}

describe('buildProjectMenuItems: a NAMED project', () => {
  it('offers every row, in the order the two surfaces agreed on', () => {
    expect(labels({ project: 'Marina' }, tierActions())).toEqual([
      'Collapse project',
      'New task',
      'New folder',
      'New task with session',
      'Add separator',
      'Rename project',
      'Favorite project',
      'View project details',
      'Delete project',
    ])
  })

  it('words Collapse/Expand from the CURRENT fold state', () => {
    expect(labels({ project: 'Marina', collapsed: false }, tierActions())).toContain('Collapse project')
    expect(labels({ project: 'Marina', collapsed: true }, tierActions())).toContain('Expand project')
    expect(labels({ project: 'Marina', collapsed: true }, tierActions())).not.toContain('Collapse project')
  })

  it('words Favorite/Unfavorite from the CURRENT favorite state', () => {
    expect(labels({ project: 'Marina', favorite: false }, tierActions())).toContain('Favorite project')
    expect(labels({ project: 'Marina', favorite: true }, tierActions())).toContain('Unfavorite project')
  })

  it('passes the project, not the visible label, to every handler', () => {
    const actions = tierActions()
    const d = dialogs()
    const target: ProjectMenuTarget = { project: 'Marina' }
    for (const item of buildProjectMenuItems(target, actions, d)) item.onSelect?.()
    expect(actions.onToggleCollapse).toHaveBeenCalledWith('Marina')
    expect(actions.onNewTask).toHaveBeenCalledWith('Marina')
    expect(actions.onNewFolder).toHaveBeenCalledWith('Marina')
    expect(actions.onNewSession).toHaveBeenCalledWith('Marina')
    expect(actions.onNewSeparator).toHaveBeenCalledWith('Marina')
    expect(actions.onToggleFavorite).toHaveBeenCalledWith('Marina')
    expect(actions.onViewDetails).toHaveBeenCalledWith('Marina')
    // Rename/Delete are not a surface's to own: they come from useProjectActions,
    // so ONE definition holds the prompt copy and the delete semantics.
    expect(d.rename).toHaveBeenCalledWith('Marina')
    expect(d.remove).toHaveBeenCalledWith('Marina')
  })

  it('keeps rename and delete even on a surface that passes no handlers at all', () => {
    // Deliberate: those two rows are gated on the NAME only, so a new surface gets
    // them for free and cannot half-implement the registry actions.
    expect(labels({ project: 'Marina' }, {})).toEqual(['Rename project', 'Delete project'])
  })
})

describe('buildProjectMenuItems: Inbox is the ABSENCE of a project', () => {
  const inbox: ProjectMenuTarget = { project: '' }

  it('keeps only the rows that need no registry row', () => {
    expect(labels(inbox, tierActions())).toEqual([
      'Collapse project',
      'New task',
      'New folder',
      'Add separator',
    ])
  })

  it('drops rename, favorite, details, delete and the session launch', () => {
    for (const key of ['rename', 'favorite', 'details', 'delete', 'new-session']) {
      expect(row(inbox, tierActions(), key)?.when, key).toBe(false)
    }
  })

  it('still folds and still takes new tasks, with the empty string as the argument', () => {
    const actions = tierActions()
    row(inbox, actions, 'collapse')?.onSelect?.()
    row(inbox, actions, 'new-task')?.onSelect?.()
    expect(actions.onToggleCollapse).toHaveBeenCalledWith('')
    expect(actions.onNewTask).toHaveBeenCalledWith('')
  })

  it('leaves no leading, trailing or doubled divider behind', () => {
    // Two of the four groups drop out on Inbox; a menu that showed the rules
    // anyway would draw a stray line under the last row.
    const items = normalizeContextMenuItems(buildProjectMenuItems(inbox, tierActions(), dialogs()))
    expect(items[0].divider).toBeFalsy()
    expect(items[items.length - 1].divider).toBeFalsy()
    for (let i = 1; i < items.length; i++) {
      expect(items[i].divider && items[i - 1].divider, 'two dividers in a row').toBeFalsy()
    }
  })
})

describe('buildProjectMenuItems: per-surface rows', () => {
  it('"Add separator" is a TIER row only (the main list has no view mode)', () => {
    expect(labels({ project: 'Marina' }, tierActions())).toContain('Add separator')
    expect(labels({ project: 'Marina' }, listActions())).not.toContain('Add separator')
    expect(row({ project: 'Marina' }, listActions(), 'new-separator')?.when).toBe(false)
  })

  it('drops exactly the row whose handler a surface withholds', () => {
    const cases: Array<[keyof ProjectMenuActions, string]> = [
      ['onToggleCollapse', 'Collapse project'],
      ['onNewTask', 'New task'],
      ['onNewFolder', 'New folder'],
      ['onNewSession', 'New task with session'],
      ['onNewSeparator', 'Add separator'],
      ['onToggleFavorite', 'Favorite project'],
      ['onViewDetails', 'View project details'],
    ]
    for (const [handler, label] of cases) {
      const actions = tierActions({ [handler]: undefined })
      expect(labels({ project: 'Marina' }, actions), handler).not.toContain(label)
      // ...and nothing else went with it.
      expect(labels({ project: 'Marina' }, actions).length, handler).toBe(8)
    }
  })
})

describe('buildProjectMenuItems: a request in flight', () => {
  const target: ProjectMenuTarget = { project: 'Marina' }

  it('disables rename and delete, and only those two', () => {
    const busy = dialogs({ busy: true })
    const actions = tierActions()
    expect(row(target, actions, 'rename', busy)?.disabled).toBe(true)
    expect(row(target, actions, 'delete', busy)?.disabled).toBe(true)
    for (const key of ['collapse', 'new-task', 'new-folder', 'new-session', 'new-separator', 'favorite', 'details']) {
      expect(row(target, actions, key, busy)?.disabled, key).toBeFalsy()
    }
    // Still LISTED, just dead: a row that vanished mid-request would move the
    // items under the cursor.
    expect(labels(target, actions, busy)).toContain('Delete project')
  })

  it('leaves both rows live when nothing is in flight', () => {
    expect(row(target, tierActions(), 'rename')?.disabled).toBe(false)
    expect(row(target, tierActions(), 'delete')?.disabled).toBe(false)
  })

  it('marks delete as the dangerous row', () => {
    expect(row(target, tierActions(), 'delete')?.danger).toBe(true)
  })
})
