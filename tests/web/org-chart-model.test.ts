/** The org chart's drop rules (web/src/components/org/org-chart-model.ts). */
import { describe, it, expect } from 'vitest'
import { buildOrgTree, type OrgTaskLike } from '../../src/core/org/org-tree.js'
import { contactLine, countsLine, dropAction, indexOrg } from '../../web/src/components/org/org-chart-model.js'

const t = (id: string, project: string, parent?: string): OrgTaskLike => ({
  id, title: id, project, phase: 'TODO', created_at: '2026-10-01T00:00:00Z', updated_at: '2026-10-01T00:00:00Z',
  ...(parent ? { parent_task_id: parent } : {}),
})

const tree = buildOrgTree([t('a', 'Walnut'), t('b', 'Walnut', 'a'), t('c', 'Walnut', 'b'), t('d', 'Walnut'), t('e', 'Health')])
const index = indexOrg(tree)

describe('org chart drops', () => {
  it('onto a task makes the dragged task its worker', () => {
    expect(dropAction(index, 'd', { kind: 'task', id: 'a' })).toEqual({ kind: 'reparent', taskId: 'd', parentId: 'a' })
    expect(dropAction(index, 'e', { kind: 'task', id: 'c' })).toEqual({ kind: 'reparent', taskId: 'e', parentId: 'c' })
  })

  it('refuses itself, its own worker at any depth, and its current parent', () => {
    expect(dropAction(index, 'a', { kind: 'task', id: 'a' })).toBeNull()
    expect(dropAction(index, 'a', { kind: 'task', id: 'c' })).toBeNull()
    expect(dropAction(index, 'b', { kind: 'task', id: 'a' })).toBeNull()
    expect(dropAction(index, 'zzz', { kind: 'task', id: 'a' })).toBeNull()
  })

  it('onto a project column makes it a team there', () => {
    expect(dropAction(index, 'b', { kind: 'project', project: 'Walnut' }))
      .toEqual({ kind: 'team', taskId: 'b', project: 'Walnut', moveProject: false, clearParent: true })
    expect(dropAction(index, 'e', { kind: 'project', project: 'walnut' }))
      .toEqual({ kind: 'team', taskId: 'e', project: 'walnut', moveProject: true, clearParent: false })
    expect(dropAction(index, 'd', { kind: 'project', project: 'Walnut' })).toBeNull()
  })

  it('says who Main talks to and counts only what is there', () => {
    const walnut = tree.projects.find((p) => p.project === 'Walnut')!
    const health = tree.projects.find((p) => p.project === 'Health')!
    expect(contactLine(walnut)).toBe('No lead yet: Chat makes one')
    expect(contactLine(health)).toBe('Main talks to this task directly')
    expect(countsLine({ open: 3, needsYou: 0, running: 1, waiting: 0 })).toBe('3 open · 1 running')
  })
})
