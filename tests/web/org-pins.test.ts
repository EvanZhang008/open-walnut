/**
 * Pins on an Org node, read by the page (src/core/org/org-tree.ts nodePins,
 * web/src/components/org/org-task-tabs.ts). 2026-10-31, the user picked "B: a Pinned tab first",
 * and the node's pins under its chat in the Org list: a pin names the row it shows under, so the
 * server's node keys and the page's row keys must be the same strings.
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, it, expect } from 'vitest'
import type { Task } from '../../src/core/types.js'
import { ORG_MAIN_NODE, buildOrgTree, isPinnedTo, nodePins, orgProjectNode, pinnedNodesOf } from '../../src/core/org/org-tree.js'
import { resolvePinNode } from '../../src/core/org/org-pins.js'
import { USER_STATE_LABELS } from '../../src/core/user-status.js'
import { MAIN_KEY, buildChannels, projectRowKey, type AlertProbe } from '../../web/src/components/org/org-channels-model.js'
import { ORG_RAIL_TABS, ORG_RAIL_TAB_LABELS, ORG_TASK_TABS, TAB_DOT, orgTaskTabs, rowPinNodes, stateTab } from '../../web/src/components/org/org-task-tabs.js'

const NOW = Date.UTC(2026, 9, 31, 12, 0)
const at = (m: number) => new Date(NOW - m * 60_000).toISOString()
const t = (id: string, project: string, phase: Task['phase'], extra: Partial<Task> = {}): Task => ({
  id, title: `${id} title`, project, phase, status: phase === 'COMPLETE' ? 'done' : 'todo', priority: 'none',
  created_at: at(600), updated_at: at(10), ...extra,
}) as Task
const pin = (node: string, minsAgo: number) => ({ node, at: at(minsAgo), by: 'human' as const })
const noAlerts: AlertProbe = () => null

describe('a pin names the row it shows under', () => {
  it('uses the page\'s own row keys, for the CEO and every kind of project name', () => {
    expect(ORG_MAIN_NODE).toBe(MAIN_KEY)
    for (const p of ['', 'Walnut', '  Mixed Case  ', 'garden-2', 'Caf\u00e9 \u82b1\u56ed']) expect(orgProjectNode(p)).toBe(projectRowKey(p))
  })

  it('reads the node a caller names: the CEO, a VP by its name, a project, a node key, the Inbox', () => {
    const tasks = [
      t('lead', 'Orchard', 'IN_PROGRESS', { org_role: 'lead', org_name: 'Fruit' }),
      t('a', 'Orchard', 'IN_PROGRESS'),
      t('i', '', 'TODO'),
    ]
    expect(resolvePinNode('CEO', tasks)).toBe('main')
    expect(resolvePinNode('main', tasks)).toBe('main')
    expect(resolvePinNode('Fruit VP', tasks)).toBe('project:orchard')
    expect(resolvePinNode('Fruit', tasks)).toBe('project:orchard')
    expect(resolvePinNode('ORCHARD', tasks)).toBe('project:orchard')
    expect(resolvePinNode('project:Orchard', tasks)).toBe('project:orchard')
    expect(resolvePinNode('Inbox', tasks)).toBe('project:')
    // A VP with no name of its own goes by its project, "VP" or not (the CEO's rail calls it so).
    expect(resolvePinNode('Orchard VP', tasks)).toBe('project:orchard')
    expect(resolvePinNode('orchard lead', tasks)).toBe('project:orchard')
    expect(resolvePinNode('PROJECT:Orchard', tasks)).toBe('project:orchard')
    expect(resolvePinNode('Nowhere', tasks)).toBeNull()
    expect(resolvePinNode('project:nowhere', tasks)).toBeNull()
    expect(resolvePinNode('  ', tasks)).toBeNull()
  })
})

describe('a project another VP leads', () => {
  const tasks: Task[] = [
    t('lead', 'Alpha', 'IN_PROGRESS', { org_role: 'lead', org_leads: ['Beta'], user_status: { state: 'working' } }),
    t('b1', 'Beta', 'IN_PROGRESS', { user_status: { state: 'working' }, org_pins: [pin('project:beta', 9)] }),
    t('a1', 'Alpha', 'IN_PROGRESS', { user_status: { state: 'working' }, org_pins: [pin('project:alpha', 3)] }),
  ]
  it('is pinned to the VP\'s row, the row it shows under', () => {
    expect(resolvePinNode('Beta', tasks)).toBe('project:alpha')
    expect(resolvePinNode('project:beta', tasks)).toBe('project:alpha')
  })
  it('keeps a pin made before it moved there in view on that VP\'s row', () => {
    const { rows } = buildChannels(buildOrgTree(tasks), tasks, noAlerts)
    const alpha = rows.find((r) => r.project === 'Alpha')!
    expect(rowPinNodes(alpha)).toEqual(['project:alpha', 'project:beta'])
    expect(orgTaskTabs(alpha, rows, tasks, NOW).pinned.map((x) => x.id)).toEqual(['b1', 'a1'])
    expect(pinnedNodesOf(tasks[1]!, rowPinNodes(alpha))).toEqual(['project:beta'])
  })
})

describe('the Pinned tab', () => {
  const tasks: Task[] = [
    t('main', 'Ask Walnut', 'IN_PROGRESS', { org_role: 'main', walnut_agent: true }),
    t('wl', 'Walnut', 'IN_PROGRESS', { org_role: 'lead', title: 'Walnut lead', user_status: { state: 'working' } }),
    t('late', 'Walnut', 'IN_PROGRESS', { user_status: { state: 'working', now: 'Writing' }, org_pins: [pin('project:walnut', 5)] }),
    t('early', 'Walnut', 'NEED_ACTION', { user_status: { state: 'needs', source: 'session', ask: 'Pick one' }, org_pins: [pin('project:walnut', 50), pin('main', 1)] }),
    // Done, and in another project: a pin is the user's, so it still shows.
    t('shipped', 'Garden', 'COMPLETE', { completed_at: at(60 * 24 * 30), user_status: { state: 'done' }, org_pins: [pin('project:walnut', 20)] }),
    t('hidden', 'Walnut', 'IN_PROGRESS', { plugin_only: 'mail', org_pins: [pin('project:walnut', 2)] }),
    t('tl', 'Garden', 'IN_PROGRESS', { org_role: 'lead', title: 'Garden lead', user_status: { state: 'working' } }),
  ]
  const { main, rows } = buildChannels(buildOrgTree(tasks), tasks, noAlerts)
  const walnut = rows.find((r) => r.project === 'Walnut')!

  it('comes first, then the four status tabs', () => {
    expect(ORG_RAIL_TABS).toEqual(['pinned', ...ORG_TASK_TABS])
    expect(ORG_RAIL_TAB_LABELS.pinned).toBe('Pinned')
  })

  it('lists the node\'s pins in pin order, done ones too, never a plugin\'s own task', () => {
    expect(orgTaskTabs(walnut, rows, tasks, NOW).pinned.map((x) => x.id)).toEqual(['early', 'shipped', 'late'])
    expect(orgTaskTabs(main, rows, tasks, NOW).pinned.map((x) => x.id)).toEqual(['early'])
    expect(nodePins(tasks, 'project:garden')).toEqual([])
    expect(isPinnedTo(tasks.find((x) => x.id === 'early')!, 'main')).toBe(true)
  })

  it('draws each pinned task with its own state\'s dot and words, for every user state', () => {
    const src = fs.readFileSync(path.resolve(import.meta.dirname, '../../src/core/user-status.ts'), 'utf8')
    const states = [...src.match(/export type UserState = ((?:'[a-z]+'\s*\|\s*)+'[a-z]+');/)![1]!.matchAll(/'([a-z]+)'/g)].map((m) => m[1]!)
    expect(states.length).toBeGreaterThan(3)
    for (const s of states) {
      const task = t(`s-${s}`, 'Walnut', s === 'done' ? 'COMPLETE' : 'IN_PROGRESS', { user_status: { state: s } as Task['user_status'] })
      const tab = stateTab(task)
      expect(tab, s).toBe(s)
      expect(TAB_DOT[tab], s).toBeTruthy()
      expect(USER_STATE_LABELS[tab], s).toBeTruthy()
    }
  })
})
