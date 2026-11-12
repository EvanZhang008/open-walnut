/** A task that routes by itself is a router row (Task.self_router), and stays work of its project. */
import { describe, it, expect } from 'vitest'
import type { Task } from '../../src/core/types.js'
import { buildOrgTree } from '../../src/core/org/org-tree.js'
import { buildChannels, selfRouterLine, type AlertProbe } from '../../web/src/components/org/org-channels-model.js'
import { selfRouterLine as overviewLine } from '../../web/src/components/org/OrgRouterOverview.js'

const at = new Date(Date.UTC(2026, 10, 11, 12)).toISOString()
const t = (id: string, project: string, extra: Partial<Task> = {}): Task => ({
  id, title: `${id} title`, project, phase: 'IN_PROGRESS', status: 'todo', priority: 'none', created_at: at, updated_at: at, ...extra,
} as Task)
const noAlerts: AlertProbe = () => null
const mark = (links: string[], name?: string) => ({ self_router: { links, at, by: 'human', ...(name ? { name } : {}) } })

describe('self routers on the Org page', () => {
  const tasks: Task[] = [
    t('vp', 'Marina', { org_role: 'lead', title: 'Marina VP' }),
    t('watch', 'Marina', { ...mark(['vp']), user_status: { state: 'working', now: 'Watching' } } as Partial<Task>),
    t('loop', 'Marina', { ...mark(['vp'], 'Dock loop'), parent_task_id: 'vp', user_status: { state: 'waiting', kind: 'outside', waitingOn: 'next check' } } as Partial<Task>),
    t('done', 'Marina', { ...mark(['vp']), phase: 'COMPLETE', status: 'done' }),
    t('vp2', 'Other', { org_role: 'lead', ...mark([]) }),
  ]

  it('lists each open marked task as a router row with its own state, never an org node or a closed one', () => {
    const tree = buildOrgTree(tasks)
    expect(tree.routers?.map((r) => [r.id, r.self, r.paused, r.name ?? null])).toEqual([['watch', true, false, null], ['loop', true, false, 'Dock loop']])
    const { routers } = buildChannels(tree, tasks, noAlerts)
    expect(routers.map((r) => [r.key, r.name, r.state, r.latest, r.selfRouter])).toEqual([
      ['router:watch', 'watch title', 'working', 'Runs its own loop · 1 VP link', true],
      ['router:loop', 'Dock loop', 'quiet', 'Runs its own loop · 1 VP link', true],
    ])
  })

  it('keeps it as work of its project', () => {
    const marina = buildOrgTree(tasks).projects.find((p) => p.project === 'Marina')
    const ids = JSON.stringify(marina)
    expect(ids).toContain('"watch"')
    expect(ids).toContain('"loop"')
  })

  it('says in one line what it is', () => {
    expect(selfRouterLine({ self_router: { links: ['a', 'b', 'a'], at, by: 'human' } })).toBe('Runs its own loop · 2 VP links')
    expect(overviewLine('Dock loop', 'Marina', ['Marina VP'])).toBe(
      'Dock loop routes by itself: its own triggers and loops do the work for Marina, and Walnut only lists it among the routers. It works with Marina VP.')
  })
})
