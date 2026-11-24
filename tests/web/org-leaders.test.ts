/**
 * The leaders under a VP (web/src/components/org/org-leaders.ts): open tasks that lead their own
 * team, by the project they are in (the VP's projects in the chart's order), the leaders under each
 * leader below it, a project with none left out (2026-11-20, the user).
 */
import { describe, it, expect } from 'vitest'
import type { Task } from '../../src/core/types.js'
import { buildOrgTree, type OrgTaskLike } from '../../src/core/org/org-tree.js'
import { buildChannels } from '../../web/src/components/org/org-channels-model.js'
import { vpCards } from '../../web/src/components/org/org-chart-model.js'
import { directorProjectsByVp, directorRows, directorsLabel, flatDirectors, foldGroups, leaderGroups, leaderTotal, leadersMatch, sourcesOf } from '../../web/src/components/org/org-leaders.js'
import type { ChannelRow } from '../../web/src/components/org/org-channels-model.js'

let n = 0
const t = (project: string, over: Partial<OrgTaskLike> = {}): OrgTaskLike => {
  n++
  return { id: `t${n}`, title: `task ${n}`, project, phase: 'TODO', created_at: `2026-10-01T00:00:${String(n).padStart(2, '0')}Z`, ...over }
}

function groupsOf(all: OrgTaskLike[], vp: string) {
  const { projects } = buildChannels(buildOrgTree(all), all as unknown as Task[], () => null)
  const card = vpCards(projects).find((c) => c.name === vp)!
  const byId = new Map(all.map((x) => [x.id, x as unknown as Task] as const))
  return leaderGroups(sourcesOf(card.projects), byId)
}

describe('leaders under a VP', () => {
  it('lists only tasks with open workers, by project, with the leaders under them', () => {
    const lead = t('Garden', { org_role: 'lead', title: 'Garden lead', org_leads: ['Seeds', 'Tools'] })
    const solo = t('Garden', { title: 'Solo task' })
    const team = t('Garden', { title: 'Beds team', phase: 'IN_PROGRESS', watched_at: '2026-11-20T00:00:00Z' })
    const w1 = t('Garden', { parent_task_id: team.id, title: 'Bed one' })
    const sub = t('Garden', { parent_task_id: team.id, title: 'Bed two lead' })
    const subWorker = t('Garden', { parent_task_id: sub.id, title: 'Bed two worker' })
    const seedsTeam = t('Seeds', { title: 'Seed buying' })
    const seedsWorker = t('Seeds', { parent_task_id: seedsTeam.id, title: 'Find tomatoes' })
    const tools = t('Tools', { title: 'Tools alone' })
    const done = t('Garden', { title: 'Old team' })
    const doneWorker = t('Garden', { parent_task_id: done.id, phase: 'COMPLETE', title: 'Finished worker' })
    const all = [lead, solo, team, w1, sub, subWorker, seedsTeam, seedsWorker, tools, done, doneWorker]
    const groups = groupsOf(all, 'Garden')
    // Garden and Seeds have leaders; Tools has none and is not drawn.
    expect(groups.map((g) => g.name)).toEqual(['Garden', 'Seeds'])
    const garden = groups[0]!
    expect(garden.leaders.map((l) => l.title)).toEqual(['Beds team'])
    const beds = garden.leaders[0]!
    expect(beds).toMatchObject({ leads: 2, watched: true })
    // One level only (2026-11-24, the user): the leader inside its team is not listed anywhere.
    expect(groups.flatMap((g) => g.leaders).some((l) => l.title === 'Bed two lead')).toBe(false)
    // A team whose only worker is finished leads no one now.
    expect(garden.leaders.some((l) => l.title === 'Old team')).toBe(false)
    expect(groups[1]!.leaders.map((l) => l.title)).toEqual(['Seed buying'])
    expect(leaderTotal(groups)).toBe(2)
  })

  it('a VP with one project still names it; a VP with no leaders has no groups', () => {
    const team = t('Solo', { title: 'Only team' })
    const worker = t('Solo', { parent_task_id: team.id })
    const quiet = [t('Quiet'), t('Quiet')]
    const all = [team, worker, ...quiet]
    expect(groupsOf(all, 'Solo').map((g) => [g.name, g.leaders.length])).toEqual([['Solo', 1]])
    expect(groupsOf(all, 'Quiet')).toEqual([])
  })

  it('honours the Director choice: yes lists a task with no team, no passes its sub-leaders up', () => {
    const lead = t('Choice', { org_role: 'lead', title: 'Choice VP' })
    const promoted = t('Choice', { title: 'Promoted alone', director: 'yes' })
    const demoted = t('Choice', { title: 'Demoted leader', director: 'no' })
    const plain = t('Choice', { parent_task_id: demoted.id, title: 'Plain worker' })
    const sub = t('Choice', { parent_task_id: demoted.id, title: 'Sub leader' })
    const subWorker = t('Choice', { parent_task_id: sub.id, title: 'Sub worker' })
    const pickedWorker = t('Choice', { parent_task_id: sub.id, title: 'Picked worker', director: 'yes' })
    const groups = groupsOf([lead, promoted, demoted, plain, sub, subWorker, pickedWorker], 'Choice')
    const leaders = groups[0]!.leaders
    // The demoted leader is gone; its sub-leader lifts to the top.
    expect(leaders.map((l) => [l.title, l.leads]).sort()).toEqual([['Promoted alone', 0], ['Sub leader', 2]])
    // A worker chosen as a Director inside a Director's team is not listed: one level only.
    expect(leaders.some((l) => l.title === 'Picked worker')).toBe(false)
    expect(leaderTotal(groups)).toBe(2)
  })

  it('counts and search', () => {
    // 2026-11-20, the user: "the tab leader should change to directors".
    expect(directorsLabel(1)).toBe('1 director')
    expect(directorsLabel(0)).toBe('0 directors')
    expect(directorsLabel(6)).toBe('6 directors')
    const team = t('Find', { title: 'Pipeline watch leader' })
    const sub = t('Find', { parent_task_id: team.id, title: 'Deep resolver' })
    const subWorker = t('Find', { parent_task_id: sub.id })
    const groups = groupsOf([team, sub, subWorker], 'Find')
    expect(leadersMatch(groups, 'pipeline WATCH')).toBe(true)
    // A leader inside a Director's team is not listed, so not found either.
    expect(leadersMatch(groups, 'resolver')).toBe(false)
    expect(leadersMatch(groups, 'pipeline nothing')).toBe(false)
    expect(leadersMatch(groups, '  ')).toBe(false)
  })

  it('with the project names off, the fold is one group with no name, in the same order', () => {
    const lead = t('Hall', { org_role: 'lead', title: 'Hall VP', org_leads: ['Annex'] })
    const a = t('Hall', { title: 'Hall team' })
    const b = t('Annex', { title: 'Annex team' })
    const all = [lead, a, t('Hall', { parent_task_id: a.id }), b, t('Annex', { parent_task_id: b.id })]
    const groups = groupsOf(all, 'Hall')
    expect(groups.map((g) => g.name)).toEqual(['Hall', 'Annex'])
    expect(foldGroups(groups, true)).toBe(groups)
    const flat = foldGroups(groups, false)
    expect(flat.map((g) => [g.name, g.leaders.map((l) => l.title)])).toEqual([['', ['Hall team', 'Annex team']]])
    expect(foldGroups([], false)).toEqual([])
  })

  it('the DIRECTORS section: one level, by VP in the list order, never a Director inside a Director\'s team', () => {
    const lead = t('Wharf', { org_role: 'lead', title: 'Wharf VP' })
    const top = t('Wharf', { title: 'Dock team' })
    const sub = t('Wharf', { parent_task_id: top.id, title: 'Crane lead' })
    const all = [lead, top, sub, t('Wharf', { parent_task_id: sub.id }), t('Wharf', { title: 'Lone promoted', director: 'yes' })]
    const groups = groupsOf(all, 'Wharf')
    expect(flatDirectors(groups).map((d) => d.title).sort()).toEqual(['Dock team', 'Lone promoted'])
    const order = flatDirectors(groups).map((d) => d.title)
    // A task never started reads "Not started", never the tab's "Waiting".
    expect(flatDirectors(groups).find((d) => d.title === 'Lone promoted')!.stateText).toBe('Not started')
    const vpA = { key: 'project:wharf', name: 'Wharf', vpName: 'Harbour' } as ChannelRow
    const vpB = { key: 'project:other', name: 'Other' } as ChannelRow
    const groupsOf2 = (r: ChannelRow) => (r.key === vpA.key ? groups : [])
    const rows = directorRows([vpB, vpA], groupsOf2)
    expect(rows.map((r) => [r.vp.key, r.director.title])).toEqual(order.map((title) => [vpA.key, title]))
    // A search shows the Directors it finds, or every Director of a VP whose name it finds.
    expect(directorRows([vpA], groupsOf2, 'dock').map((r) => r.director.title)).toEqual(['Dock team'])
    expect(directorRows([vpA], groupsOf2, 'crane')).toEqual([])
    expect(directorRows([vpA], groupsOf2, 'harbour')).toHaveLength(2)
    expect(directorRows([vpA], groupsOf2, 'nothing here')).toEqual([])
  })
})

describe('the projects a New Director may go to', () => {
  it('lists the projects each VP leads, the Inbox VP\'s too, the Inbox by its name', () => {
    // 2026-11-21: the Inbox is a project with its VP, so a Director may go there like anywhere.
    const cards = [
      { key: 'project:', projects: [{ project: '', name: 'Inbox' }] },
      { key: 'project:growth', projects: [{ project: 'Growth', name: 'Growth' }, { project: 'Ads', name: 'Ads' }] },
    ] as unknown as Parameters<typeof directorProjectsByVp>[0]
    const by = directorProjectsByVp(cards)
    expect(by.get('project:')).toEqual([{ project: 'Inbox', name: 'Inbox' }])
    expect(by.get('project:growth')).toEqual([{ project: 'Growth', name: 'Growth' }, { project: 'Ads', name: 'Ads' }])
  })
})
