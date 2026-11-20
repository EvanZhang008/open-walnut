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
import { leaderGroups, leaderTotal, leadersLabel, leadersMatch, sourcesOf, subsMatch } from '../../web/src/components/org/org-leaders.js'

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
    // The leader under it; a worker that leads no one is not a leader.
    expect(beds.subs.map((s) => [s.title, s.leads])).toEqual([['Bed two lead', 1]])
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

  it('counts and search', () => {
    expect(leadersLabel(1)).toBe('1 leader')
    expect(leadersLabel(6)).toBe('6 leaders')
    const team = t('Find', { title: 'Pipeline watch leader' })
    const sub = t('Find', { parent_task_id: team.id, title: 'Deep resolver' })
    const subWorker = t('Find', { parent_task_id: sub.id })
    const groups = groupsOf([team, sub, subWorker], 'Find')
    expect(leadersMatch(groups, 'pipeline WATCH')).toBe(true)
    // A leader at any depth is found.
    expect(leadersMatch(groups, 'resolver')).toBe(true)
    expect(leadersMatch(groups, 'pipeline nothing')).toBe(false)
    expect(leadersMatch(groups, '  ')).toBe(false)
    // The fold above a deeper match opens; one with nothing under it that matches does not.
    const top = groups[0]!.leaders[0]!
    expect(subsMatch(top, 'resolver')).toBe(true)
    expect(subsMatch(top, 'pipeline')).toBe(false)
  })
})
