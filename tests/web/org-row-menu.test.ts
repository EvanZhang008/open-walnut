/**
 * A right-click on an Org row (web/src/components/org/org-row-menu.ts): the menu stays short, a
 * list of VPs or of projects is one row that opens a picker, and a VP is named the way a person
 * says it (2026-10-26, the user: "too messy ... create a dedicated VP for this project").
 */
import { describe, it, expect, vi } from 'vitest'
import type { Task } from '../../src/core/types.js'
import { buildOrgTree, type OrgTaskLike } from '../../src/core/org/org-tree.js'
import { buildChannels, movedProjects } from '../../web/src/components/org/org-channels-model.js'
import { vpCards } from '../../web/src/components/org/org-chart-model.js'
import { orgRowMenu, type OrgRowPick } from '../../web/src/components/org/org-row-menu.js'

let n = 0
const t = (project: string, over: Partial<OrgTaskLike> = {}): OrgTaskLike => {
  n++
  return { id: `t${n}`, title: `task ${n}`, project, phase: 'TODO', created_at: `2026-10-01T00:00:${String(n).padStart(2, '0')}Z`, ...over }
}

function setup(tasks: OrgTaskLike[]) {
  const ch = buildChannels(buildOrgTree(tasks), tasks as unknown as Task[], () => null)
  const cards = vpCards(ch.projects)
  const select = vi.fn()
  const openChart = vi.fn()
  const picks: OrgRowPick[] = []
  const menu = (name: string) => orgRowMenu({
    target: { row: ch.rows.find((r) => r.name === name)! }, cards, select, openChart, pick: (p) => { picks.push(p) },
  })
  return { ch, cards, select, openChart, picks, menu, moved: movedProjects(ch, tasks as unknown as Task[]) }
}

const labels = (items: ReturnType<typeof orgRowMenu>) => items.filter((i) => !i.divider).map((i) => String(i.label))

describe('the Org row menu', () => {
  const projects = ['Garden', 'Seeds', 'Kitchen', 'Shed', 'Pond'].flatMap((p) => [t(p), t(p, { phase: 'IN_PROGRESS' })])

  it('moves a project with one row that opens the VPs, never a row per VP', () => {
    const { menu, picks, openChart } = setup(projects)
    const items = menu('Seeds')
    expect(labels(items)).toEqual(['Seeds', 'Open chat', 'Open team', 'Move under another VP…'])
    items.find((i) => i.key === 'move')!.onSelect!()
    expect(picks).toHaveLength(1)
    expect(picks[0]!.label).toBe('Move Seeds under')
    // Named the way a person says it, the row's own VP left out.
    expect(picks[0]!.options.map((o) => o.label).sort()).toEqual(['Garden VP', 'Kitchen VP', 'Pond VP', 'Shed VP'])
    const garden = picks[0]!.options.find((o) => o.label === 'Garden VP')!
    picks[0]!.onPick(garden.value)
    expect(openChart).toHaveBeenCalledWith({ project: 'project:seeds', to: garden.value })
  })

  it('a VP leading one other project offers a dedicated VP for it by name', () => {
    const lead = t('Garden', { org_role: 'lead', title: 'Garden lead', org_leads: ['Seeds'] })
    const { menu, openChart, picks } = setup([...projects, lead])
    const items = menu('Garden')
    const own = items.find((i) => i.key === 'own:project:seeds')!
    expect(own.label).toBe('Create a dedicated VP for Seeds…')
    own.onSelect!()
    expect(openChart).toHaveBeenCalledWith({ project: 'project:seeds', to: null })
    expect(picks).toHaveLength(0)
    expect(labels(items).some((l) => /Give|its own VP|'s VP/.test(l))).toBe(false)
  })

  it('a VP leading several projects offers one row that opens them', () => {
    const lead = t('Garden', { org_role: 'lead', title: 'Garden lead', org_leads: ['Seeds', 'Shed', 'Pond'] })
    const { menu, openChart, picks } = setup([...projects, lead])
    const items = menu('Garden')
    // Short whatever the org's size: its name, its tabs, one move row, one dedicated-VP row.
    expect(labels(items)).toEqual(['Garden', 'Open chat', 'Open team', 'Move under another VP…', 'Create a dedicated VP…'])
    items.find((i) => i.key === 'own')!.onSelect!()
    expect(picks[0]!.label).toBe('Create a dedicated VP for')
    expect(picks[0]!.options.map((o) => o.label).sort()).toEqual(['Pond', 'Seeds', 'Shed'])
    picks[0]!.onPick('project:shed')
    expect(openChart).toHaveBeenCalledWith({ project: 'project:shed', to: null })
  })

  it('a moved project under Archived: open its VP, or create a dedicated VP for it', () => {
    const lead = t('Garden', { org_role: 'lead', title: 'Garden lead', org_leads: ['Seeds'] })
    const { moved: all, cards, select, openChart } = setup([...projects, lead])
    const moved = all.find((m) => m.project === 'Seeds')!
    const items = orgRowMenu({ target: { moved }, cards, select, openChart, pick: () => {} })
    expect(labels(items)).toEqual(['Seeds', 'Open the Garden VP', 'Create a dedicated VP for Seeds…'])
  })
})
