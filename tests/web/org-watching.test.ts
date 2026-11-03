/**
 * The Org page's Watching: Home's one Watching list (Task.watched_at), read by the page
 * (web/src/components/org/org-task-tabs.ts). 2026-11-02, the user: "if it watching then concideras
 * pinnedl rename this to watching ... same wathcing as regular home pannel". A node's Watching tab
 * holds the watched tasks of its work, the Org list shows each under the row its work belongs to,
 * and the server's node keys (org-pins.ts) and the page's row keys are the same strings.
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, it, expect } from 'vitest'
import type { Task } from '../../src/core/types.js'
import { ORG_MAIN_NODE, buildOrgTree, orgProjectNode } from '../../src/core/org/org-tree.js'
import { resolvePinNode, watchNodeOf } from '../../src/core/org/org-pins.js'
import { USER_STATE_LABELS } from '../../src/core/user-status.js'
import { MAIN_KEY, buildChannels, projectRowKey, type AlertProbe } from '../../web/src/components/org/org-channels-model.js'
import { ORG_RAIL_TABS, ORG_RAIL_TAB_LABELS, ORG_TASK_TABS, TAB_DOT, isKeptRailTab, orgTaskTabs, railTabShown, stateTab, watchedByRow } from '../../web/src/components/org/org-task-tabs.js'
import { STATUS_SECTION_LABELS } from '../../web/src/components/tasks/status-sections.js'

const NOW = Date.UTC(2026, 9, 31, 12, 0)
const at = (m: number) => new Date(NOW - m * 60_000).toISOString()
const t = (id: string, project: string, phase: Task['phase'], extra: Partial<Task> = {}): Task => ({
  id, title: `${id} title`, project, phase, status: phase === 'COMPLETE' ? 'done' : 'todo', priority: 'none',
  created_at: at(600), updated_at: at(10), ...extra,
}) as Task
const noAlerts: AlertProbe = () => null

describe('a node key names the row a task shows under', () => {
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
    t('b1', 'Beta', 'IN_PROGRESS', { user_status: { state: 'working' }, watched_at: at(9) }),
    t('a1', 'Alpha', 'IN_PROGRESS', { user_status: { state: 'working' }, watched_at: at(3) }),
  ]
  it('names the VP\'s row, the row it shows under', () => {
    expect(resolvePinNode('Beta', tasks)).toBe('project:alpha')
    expect(resolvePinNode('project:beta', tasks)).toBe('project:alpha')
    expect(watchNodeOf(tasks[1]!, tasks)).toBe('project:alpha')
  })
  it('shows its watched tasks on that VP\'s Watching tab and under its row, in the order they were watched', () => {
    const { main, rows } = buildChannels(buildOrgTree(tasks), tasks, noAlerts)
    const alpha = rows.find((r) => r.project === 'Alpha')!
    expect(orgTaskTabs(alpha, rows, tasks, NOW).watching.map((x) => x.id)).toEqual(['b1', 'a1'])
    expect(watchedByRow(main, rows, tasks).get(alpha.key)?.map((x) => x.id)).toEqual(['b1', 'a1'])
  })
})

describe('the Watching tab', () => {
  const tasks: Task[] = [
    t('main', 'Ask Walnut', 'IN_PROGRESS', { org_role: 'main', walnut_agent: true }),
    t('wl', 'Walnut', 'IN_PROGRESS', { org_role: 'lead', title: 'Walnut lead', user_status: { state: 'working' } }),
    t('late', 'Walnut', 'IN_PROGRESS', { user_status: { state: 'working', now: 'Writing' }, watched_at: at(5) }),
    t('early', 'Walnut', 'NEED_ACTION', { user_status: { state: 'needs', source: 'session', ask: 'Pick one' }, watched_at: at(50) }),
    // Done: a watch is the user's, so it still shows, as on Home.
    t('shipped', 'Walnut', 'COMPLETE', { completed_at: at(60 * 24 * 30), user_status: { state: 'done' }, watched_at: at(20) }),
    t('hidden', 'Walnut', 'IN_PROGRESS', { plugin_only: 'mail', watched_at: at(2) }),
    // An old Org pin with no watch is not a second list: the server carries it over (org-pins.ts).
    t('pinOnly', 'Walnut', 'IN_PROGRESS', { org_pins: [{ node: 'project:walnut', at: at(4), by: 'human' }] }),
    t('tl', 'Garden', 'IN_PROGRESS', { org_role: 'lead', title: 'Garden lead', user_status: { state: 'working' } }),
    t('g1', 'Garden', 'TODO', { user_status: { state: 'waiting' }, watched_at: at(30) }),
    t('inbox', '', 'TODO', { user_status: { state: 'waiting' }, watched_at: at(40) }),
  ]
  const { main, rows } = buildChannels(buildOrgTree(tasks), tasks, noAlerts)
  const walnut = rows.find((r) => r.project === 'Walnut')!
  const garden = rows.find((r) => r.project === 'Garden')!

  it('comes first, then the four status tabs, under Home\'s own name', () => {
    expect(ORG_RAIL_TABS).toEqual(['watching', ...ORG_TASK_TABS])
    expect(ORG_RAIL_TAB_LABELS.watching).toBe(STATUS_SECTION_LABELS.watching)
    expect(ORG_RAIL_TAB_LABELS.watching).toBe('Watching')
  })

  it('opens Watching where an older build kept the Pinned tab', () => {
    expect(isKeptRailTab('pinned')).toBe(true)
    expect(railTabShown('pinned')).toBe('watching')
    for (const tab of ORG_RAIL_TABS) expect(railTabShown(tab)).toBe(tab)
    expect(isKeptRailTab('nope')).toBe(false)
  })

  it('lists a VP\'s watched work in watch order, done ones too, never a plugin\'s own task', () => {
    expect(orgTaskTabs(walnut, rows, tasks, NOW).watching.map((x) => x.id)).toEqual(['early', 'shipped', 'late'])
    expect(orgTaskTabs(garden, rows, tasks, NOW).watching.map((x) => x.id)).toEqual(['g1'])
  })

  it('lists every watched task on the CEO, the same count as Home\'s Watching', () => {
    const home = tasks.filter((x) => x.watched_at && !x.plugin_only)
    const ceo = orgTaskTabs(main, rows, tasks, NOW).watching
    expect(ceo.map((x) => x.id)).toEqual(['early', 'inbox', 'g1', 'shipped', 'late'])
    expect(ceo).toHaveLength(home.length)
  })

  it('puts each watched task under one row of the Org list: its VP, the Inbox row for the Inbox', () => {
    const by = watchedByRow(main, rows, tasks)
    const all = [...by.values()].flat().map((x) => x.id).sort()
    expect(all).toEqual(['early', 'g1', 'inbox', 'late', 'shipped'])
    expect(by.get(walnut.key)?.map((x) => x.id)).toEqual(['early', 'shipped', 'late'])
    expect(by.get(garden.key)?.map((x) => x.id)).toEqual(['g1'])
  })

  it('draws each watched task with its own state\'s dot and words, for every user state', () => {
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

// The class: a second list of tasks to keep in view, apart from Home's watch. Every Org page file
// is read; one that reads or writes Task.org_pins, or offers "Pin" / "Unpin" / "Pinned" on a task,
// brings the second list back.
describe('the Org page keeps one list, the watch', () => {
  const dir = path.resolve(import.meta.dirname, '../../web/src/components/org')
  const files = [
    ...fs.readdirSync(dir).filter((f) => /\.(tsx?|css)$/.test(f)).map((f) => path.join(dir, f)),
    path.resolve(import.meta.dirname, '../../web/src/pages/OrgPage.tsx'),
    path.resolve(import.meta.dirname, '../../web/src/styles/org-rail.css'),
  ]
  it.each(files.map((f) => [path.relative(process.cwd(), f), f]))('%s', (_rel, file) => {
    const src = fs.readFileSync(file, 'utf8')
    expect(src).not.toMatch(/org_pins|setOrgPin|nodePins|isPinnedTo|pinnedNodesOf|\borg-pin(?!s\.ts)/)
    expect(src).not.toMatch(/['">`]\s*(Pin|Unpin|Pinned)\b(?! on top)/)
  })
})
