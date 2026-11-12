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
import { ORG_RAIL_TABS, ORG_RAIL_TAB_LABELS, ORG_TASK_TABS, TAB_DOT, allTasksSections, orgTaskTabs, stateTab, keptByRow, lockedTaskIds, slotTaskIds } from '../../web/src/components/org/org-task-tabs.js'
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
    expect(keptByRow(main, rows, tasks).get(alpha.key)?.map((x) => x.task.id)).toEqual(['b1', 'a1'])
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

  it('All tasks draws a watched task once: in Watching, or its ask\'s card', () => {
    const tabs = orgTaskTabs(walnut, rows, tasks, NOW)
    const secs = allTasksSections(tabs, tabs.needs)
    const of = (tab: string) => secs.find((x) => x.tab === tab)?.tasks.map((t) => t.id) ?? []
    const asks = new Set(tabs.needs.map((a) => a.taskId))
    for (const id of of('watching')) {
      expect(asks.has(id)).toBe(false)
      for (const tab of ['working', 'waiting', 'notstarted', 'done']) expect(of(tab)).not.toContain(id)
    }
    // Finished a month ago, out of Completed's week: it stays in Watching rather than vanish.
    expect(of('watching')).toContain('shipped')
    expect(of('done')).not.toContain('shipped')
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
    const by = keptByRow(main, rows, tasks)
    const all = [...by.values()].flat().map((x) => x.task.id).sort()
    expect(all).toEqual(['early', 'g1', 'inbox', 'late', 'shipped'])
    expect(by.get(walnut.key)?.map((x) => x.task.id)).toEqual(['early', 'shipped', 'late'])
    expect(by.get(garden.key)?.map((x) => x.task.id)).toEqual(['g1'])
    expect([...by.values()].flat().every((x) => x.watched && !x.locked)).toBe(true)
  })

  it('draws each watched task with the dot and words of the group its state is drawn in, for every user state', () => {
    const src = fs.readFileSync(path.resolve(import.meta.dirname, '../../src/core/user-status.ts'), 'utf8')
    const states = [...src.match(/export type UserState = ((?:'[a-z]+'\s*\|\s*)+'[a-z]+');/)![1]!.matchAll(/'([a-z]+)'/g)].map((m) => m[1]!)
    expect(states.length).toBeGreaterThan(3)
    for (const s of states) {
      const task = t(`s-${s}`, 'Walnut', s === 'done' ? 'COMPLETE' : 'IN_PROGRESS', { user_status: { state: s } as Task['user_status'] })
      const tab = stateTab(task)
      // To read is drawn under Needs you (shownState, 2026-11-03); every other state is its own tab.
      expect(tab, s).toBe(s === 'read' ? 'needs' : s)
      expect(TAB_DOT[tab], s).toBeTruthy()
      expect(USER_STATE_LABELS[tab], s).toBeTruthy()
    }
  })
})

// The class: a second list of tasks to keep in view, apart from Home's watch. Every Org page file
// is read; one that reads or writes Task.org_pins, or offers "Pin" / "Unpin" / "Pinned" on a task,
// brings the second list back.
// 2026-11-02, the user: "if a taks is lock also show here, show icon of watch or lock".
describe('a task whose session panel is locked hangs under its row too', () => {
  const tasks: Task[] = [
    t('main', 'Ask Walnut', 'IN_PROGRESS', { org_role: 'main', walnut_agent: true, session_id: 's-main' }),
    t('wl', 'Walnut', 'IN_PROGRESS', { org_role: 'lead', session_id: 's-lead' }),
    t('w', 'Walnut', 'IN_PROGRESS', { watched_at: at(5), session_id: 's-w' }),
    t('both', 'Walnut', 'IN_PROGRESS', { watched_at: at(9), session_id: 's-both' }),
    t('home', 'Walnut', 'TODO', { exec_session_id: 's-exec', session_ids: ['s-old', 's-home'] }),
    t('org', 'Walnut', 'IN_PROGRESS', { session_id: 's-org' }),
    t('legacy', '', 'TODO', { legacy_session_ids: ['s-legacy'] }),
    t('plug', 'Walnut', 'IN_PROGRESS', { plugin_only: 'mail', session_id: 's-plug' }),
    t('free', 'Walnut', 'IN_PROGRESS', { session_id: 's-free' }),
  ]
  // Home's strips name sessions; the Org page's panels `task:` or `session:`.
  const slots = [
    { id: 's-home', locked: true },
    { id: 's-free', locked: false },
    { id: 'session:s-both', locked: true },
    { id: 'task:org', locked: true },
    { id: 's-legacy', locked: true },
    { id: 's-plug', locked: true },
    { id: 's-lead', locked: true },
    { id: 's-old', locked: true },
    { id: 'draft:1-1', locked: true },
    { id: 'pending:x', locked: true },
    { id: 'task:gone', locked: true },
    { id: 's-unknown', locked: true },
  ]
  const { main, rows } = buildChannels(buildOrgTree(tasks), tasks, noAlerts)
  const walnut = rows.find((r) => r.project === 'Walnut')!

  it('reads every strip\'s locked slot as its task, once, in lock order', () => {
    expect(lockedTaskIds(slots, tasks)).toEqual(['home', 'both', 'org', 'legacy', 'plug', 'wl'])
  })

  it('lists the watched first, then the only-locked, each saying why, never a lead\'s own task or a plugin\'s', () => {
    const by = keptByRow(main, rows, tasks, lockedTaskIds(slots, tasks))
    expect(by.get(walnut.key)?.map((x) => [x.task.id, x.watched, x.locked])).toEqual([
      ['both', true, true], ['w', true, false], ['home', false, true], ['org', false, true],
    ])
    const inbox = rows.find((r) => r.project === '')
    expect(by.get(inbox?.key ?? main.key)?.map((x) => [x.task.id, x.watched, x.locked])).toEqual([['legacy', false, true]])
  })

  it('reads every panel of a strip as its task, locked or not, for the open tint', () => {
    expect(slotTaskIds([{ id: 's-free', locked: false }, { id: 'task:org', locked: true }, { id: 'draft:1', locked: false }], tasks)).toEqual(['free', 'org'])
    expect(slotTaskIds([], tasks)).toEqual([])
  })

  it('leaves the list once unlocked, unless still watched', () => {
    const by = keptByRow(main, rows, tasks, [])
    expect(by.get(walnut.key)?.map((x) => [x.task.id, x.locked])).toEqual([['both', false], ['w', false]])
    expect([...by.values()].flat().map((x) => x.task.id)).toEqual(['both', 'w'])
  })
})

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
    // A task is watched on this page, never pinned (6ca3a4a00). A thread is pinned to the top
    // of the Threads view (1c262e635): that pin is the thread's own, so its words stay there.
    if (path.basename(file) === 'OrgThreads.tsx') return
    expect(src).not.toMatch(/['">`]\s*(Pin|Unpin|Pinned)\b(?! on top)/)
  })
})
