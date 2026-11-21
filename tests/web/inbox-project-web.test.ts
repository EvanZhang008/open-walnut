/**
 * The web client with the Inbox as a real project (src/core/inbox-project.ts).
 *
 * Tasks now arrive as `project: "Inbox"`, while an older row, client or saved view may still
 * say '' for it. Every surface groups, counts and filters both as ONE Inbox, in the place it
 * has always had: the web's group key for it stays '' (projectGroupKey), so its fold, sort and
 * order prefs keep working and it can never show as a second "Inbox" group beside its own.
 *
 * The board fixture mixes three Inbox rows (two `Inbox`, one stale '') with a real project.
 */
import { describe, expect, it } from 'vitest'
import type { Task } from '../../src/core/types'
import { projectDisplayName, projectGroupKey, projectIdentity, taskReferenceLabel } from '../../web/src/utils/project-display'
import {
  groupTasksByProject,
  openCountsByProject,
  railProjectNames,
  tasksOfRailSelection,
} from '../../web/src/components/tasks/tasks-page-sort'
import { projectRuns } from '../../web/src/components/tasks/status-sections'
import { orderFilterProjects } from '../../web/src/components/tasks/useHomeFilters'
import { footerStatusScope } from '../../web/src/components/tasks/footer-scope'
import { INBOX_TAB, projectFromUrl, projectToUrl, tabOfProject } from '../../web/src/components/tasks/task-tabs'
import { sameName } from '../../web/src/components/tasks/filter-bar-dims'
import { projectBookmark } from '../../web/src/components/tasks/filter-bar-model'
import { buildFilterEvalContext, dimPasses } from '../../web/src/components/tasks/filter-predicate'
import { computeFacetCounts } from '../../web/src/components/tasks/filter-facets'
import { DEFAULT_FILTER_STATE } from '../../web/src/components/tasks/filter-bar-types'
import { clusterTierByProject } from '../../web/src/utils/pinned-tier-order'
import { buildHomeBoard } from '../../web/src/components/tasks/home-board-model'

let seq = 0
function task(over: Partial<Task>): Task {
  seq += 1
  return {
    id: `t-${seq}`,
    title: `Task ${seq}`,
    status: 'todo',
    phase: 'TODO',
    priority: 'none',
    project: 'Inbox',
    created_at: '2026-11-01T00:00:00Z',
    updated_at: '2026-11-01T00:00:00Z',
    ...over,
  } as Task
}

const board = (): Task[] => [
  task({ id: 'i1', project: 'Inbox' }),
  task({ id: 'g1', project: 'Garden' }),
  task({ id: 'i2', project: 'Inbox' }),
  task({ id: 'i0', project: '' }), // a stale row from an older replica
  task({ id: 'g2', project: 'Garden', status: 'done', phase: 'COMPLETE' }),
]

describe('the Inbox key and labels', () => {
  it("files every spelling of the Inbox under the one key ''", () => {
    for (const p of ['Inbox', 'inbox', ' INBOX ', '', undefined, null]) {
      expect(projectGroupKey(p), String(p)).toBe('')
      expect(projectIdentity(p), String(p)).toBe('')
      expect(projectDisplayName(p), String(p)).toBe('Inbox')
    }
    expect(projectGroupKey('Garden')).toBe('Garden')
    expect(projectIdentity(' Garden ')).toBe('garden')
  })

  it('reads an Inbox task by its title alone, as a project-less one always did', () => {
    expect(taskReferenceLabel({ title: 'Buy milk', project: 'Inbox' })).toBe('Buy milk')
    expect(taskReferenceLabel({ title: 'Buy milk', project: '' })).toBe('Buy milk')
    expect(taskReferenceLabel({ title: 'Buy milk', project: 'Garden' })).toBe('Garden / Buy milk')
  })
})

describe('one Inbox group on every board', () => {
  it('the /tasks grouped table: one Inbox group, last, holding the stale row too', () => {
    const groups = groupTasksByProject(board(), [])
    expect(groups.map((g) => g.project)).toEqual(['Garden', ''])
    expect(groups[1].tasks.map((t) => t.id)).toEqual(['i1', 'i2', 'i0'])
  })

  it('the status sections: one Inbox run', () => {
    const runs = projectRuns(board())
    expect(runs.map((r) => r.project)).toEqual(['', 'Garden'])
    expect(runs[0].tasks).toHaveLength(3)
  })

  it('the home board: one Inbox project per column', () => {
    const cols = buildHomeBoard(board(), [], 'pin')
    for (const col of cols) {
      const keys = col.projects.map((p) => p.key)
      expect(new Set(keys).size, col.id).toBe(keys.length)
      expect(keys.filter((k) => k === ''), col.id).toHaveLength(keys.includes('') ? 1 : 0)
    }
  })

  it('a pinned tier: one Inbox run, in the slot ordering.projects gives it', () => {
    const rows = board().filter((t) => t.status !== 'done')
    const ids = rows.map((t) => t.id)
    // The Inbox's place in the hand-arranged order is stored as '' (ordering.projects).
    expect(clusterTierByProject(ids, rows, ['', 'Garden'])).toEqual(['i1', 'i2', 'i0', 'g1'])
  })

  it('the home filter lists the Inbox once, first', () => {
    expect(orderFilterProjects(board(), [])).toEqual(['', 'Garden'])
  })
})

describe('the /tasks rail', () => {
  it('has no Inbox project row: the Inbox is its own fixed entry', () => {
    expect(railProjectNames(['Garden'], board(), [])).toEqual(['Garden'])
    // Not from a registry that names it either.
    expect(railProjectNames(['Inbox', 'Garden'], board(), [])).toEqual(['Garden'])
  })

  it("counts every open Inbox task on its entry (key '')", () => {
    const counts = openCountsByProject(board())
    expect(counts.get('')).toBe(3)
    expect(counts.get('garden')).toBe(1)
    expect(counts.has('inbox')).toBe(false)
  })

  it('filters to the Inbox tasks, whichever way the selection or the rows name it', () => {
    for (const active of ['', 'Inbox']) {
      expect(tasksOfRailSelection(board(), active).map((t) => t.id), active).toEqual(['i1', 'i2', 'i0'])
    }
    expect(tasksOfRailSelection(board(), null)).toHaveLength(5)
  })
})

describe('the home project tab and filter', () => {
  it('the Inbox tab holds every Inbox row', () => {
    const scope = footerStatusScope({
      section: 'tasks', tasks: board(), activeProject: INBOX_TAB, customMemberIds: new Set(),
      showCompleted: false, waitingRevealed: false, recentSortMode: 'updated',
    } as Parameters<typeof footerStatusScope>[0])
    expect(scope.scope.map((t) => t.id)).toEqual(['i1', 'i2', 'i0'])
  })

  it('a saved Inbox tab, link or filter still opens the Inbox', () => {
    expect(tabOfProject('Inbox')).toBe(INBOX_TAB)
    expect(tabOfProject('')).toBe(INBOX_TAB)
    expect(projectBookmark([''])).toBe(INBOX_TAB)
    expect(projectBookmark(['Inbox'])).toBe(INBOX_TAB)
    expect(projectFromUrl('_inbox')).toBe(INBOX_TAB)
    expect(projectFromUrl('Inbox')).toBe(INBOX_TAB)
    expect(projectToUrl('Inbox')).toBe('_inbox')
    // '' stays the All tab in a URL.
    expect(projectFromUrl('')).toBe('')
    expect(sameName('', 'Inbox')).toBe(true)
    expect(sameName('inbox', 'Garden')).toBe(false)
  })

  it("a Project filter of '' (saved) or 'Inbox' keeps every Inbox row, and the facet counts them once", () => {
    for (const value of ['', 'Inbox']) {
      const state = { ...DEFAULT_FILTER_STATE, projects: [value] }
      const ctx = buildFilterEvalContext(board(), state)
      const kept = board().filter((t) => dimPasses(t, 'project', ctx)).map((t) => t.id)
      expect(kept, value).toEqual(['i1', 'i2', 'i0'])
    }
    const ctx = buildFilterEvalContext(board(), DEFAULT_FILTER_STATE)
    const facets = computeFacetCounts(board(), ctx, ['project'])
    expect(facets.project?.['']).toBe(3)
    expect(facets.project?.['Inbox']).toBeUndefined()
  })
})
