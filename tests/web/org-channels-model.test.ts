/** The Org page's rows (web/src/components/org/org-channels-model.ts). */
import { describe, it, expect } from 'vitest'
import type { Task } from '../../src/core/types.js'
import { buildOrgTree } from '../../src/core/org/org-tree.js'
import {
  MAIN_KEY, alertText, buildChannels, channelState, filterChannels, initials, mainTeamColumns, movedProjects, pickChannel,
  projectRowKey, rowOf, teamColumns, type AlertProbe,
} from '../../web/src/components/org/org-channels-model.js'

const at = (min: number) => new Date(Date.UTC(2026, 9, 25, 12, min)).toISOString()

function t(id: string, project: string, phase: Task['phase'], extra: Partial<Task> = {}): Task {
  return {
    id, title: `${id} title`, project, phase, status: phase === 'COMPLETE' ? 'done' : 'todo', priority: 'none',
    created_at: at(0), updated_at: at(0), ...extra,
  } as Task
}

const noAlerts: AlertProbe = () => null

// A turn that ended hands the task back (NEED_ACTION), and its status says on whom it waits:
// every open task carries one on a current server (src/core/user-status.ts).
const handedBack = (waitingOn: string): Partial<Task> => ({ user_status: { state: 'waiting', kind: 'you', waitingOn } })

// A task with a live prompt: its status reads Needs you (the server derives it from the prompt).
const prompting = (ids: readonly string[]): Task[] => tasks.map((x) => (ids.includes(x.id)
  ? { ...x, user_status: { state: 'needs' as const, source: 'prompt' as const, ask: 'Answer its question' } } : x))

const tasks: Task[] = [
  t('main', 'Ask Walnut', 'IN_PROGRESS', { org_role: 'main', walnut_agent: true, updated_at: at(50) }),
  // Walnut: a lead, one running team, one handed back, a worker that asks a question.
  t('wl', 'Walnut', 'NEED_ACTION', { org_role: 'lead', title: 'Walnut lead', unread: true, ...handedBack('Your next message') }),
  t('w1', 'Walnut', 'IN_PROGRESS', { updated_at: at(10), user_status: { state: 'working', now: 'Writing the parser' } }),
  t('w2', 'Walnut', 'NEED_ACTION', { updated_at: at(20), user_status: { state: 'waiting', kind: 'lead', waitingOn: 'Its lead reads the result' } }),
  t('w3', 'Walnut', 'TODO', { parent_task_id: 'w2', updated_at: at(30) }),
  // Travel: a lead with only parked work.
  t('tl', 'Travel', 'NEED_ACTION', { org_role: 'lead', title: 'Travel lead', ...handedBack('Your next message') }),
  t('t1', 'Travel', 'WAITING', { updated_at: at(5) }),
  t('t2', 'Travel', 'WAITING', { updated_at: at(6) }),
  // Garden: one task and no lead (Main talks to it); Personal: two tasks, no lead yet.
  t('h1', 'Garden', 'NEED_ACTION', { updated_at: at(40), ...handedBack('Your reply') }),
  t('p1', 'Personal', 'TODO', { updated_at: at(1) }),
  t('p2', 'Personal', 'TODO', { updated_at: at(2) }),
  // Done work never shows.
  t('d1', 'Walnut', 'COMPLETE'),
]

describe('org channels', () => {
  it('orders rows by state, then newest first, and picks each row\'s line', () => {
    const { main, rows } = buildChannels(buildOrgTree(tasks), tasks, noAlerts)
    expect(rows.map((r) => [r.name, r.state])).toEqual([
      ['Walnut', 'working'], ['Garden', 'quiet'], ['Personal', 'quiet'], ['Travel', 'parked'],
    ])
    const walnut = rows[0]!
    expect(walnut.contactId).toBe('wl')
    expect(walnut.isLead).toBe(true)
    expect(walnut.unread).toBe(true)
    // The newest of the sessions' own words; a status with only Walnut's "waits on" comes after it.
    expect([walnut.latest, walnut.latestTask]).toEqual(['Writing the parser', 'w1 title'])
    expect(walnut.lastAt).toBe(Date.parse(at(30)))
    // A plain wait on the user ("Your reply") adds nothing to the title.
    expect(rows.find((r) => r.name === 'Garden')!.latest).toBe('Waiting: h1 title')
    expect(rows.find((r) => r.name === 'Garden')!.contactId).toBe('h1')
    expect(rows.find((r) => r.name === 'Travel')!.latest).toBe('Waiting: t2 title')
    expect(rows.every((r) => r.needs === 0)).toBe(true)
    // No lead yet: the row names the lead the first chat makes.
    const personal = rows.find((r) => r.name === 'Personal')!
    expect(personal.contactId).toBeUndefined()
    expect(personal.contactTitle).toBe('Personal VP')
    expect(main.key).toBe(MAIN_KEY)
    expect(main.latest).toBe('4 VPs · 1 Working')
  })

  it('puts a project whose work waits on a prompt first, with the prompt as its line', () => {
    const probe: AlertProbe = (task) => (task.id === 'w3' ? { kind: 'question' } : task.id === 't1' ? { kind: 'permission', tool: 'Bash' } : null)
    const live = prompting(['w3', 't1'])
    const { main, rows } = buildChannels(buildOrgTree(live), live, probe)
    expect(rows.map((r) => r.name).slice(0, 2)).toEqual(['Walnut', 'Travel'])
    expect(rows[0]!.state).toBe('alert')
    expect(rows[0]!.latest).toBe('Asks you: w3 title')
    expect(rows[1]!.latest).toBe('Wants approval (Bash): t1 title')
    expect(main.latest).toBe('4 VPs · 1 Working · 2 Needs you')
    expect([rows[0]!.needs, rows[1]!.needs, main.needs]).toEqual([1, 1, 2])
    // The count is the task's own status: a prompt its status does not read as Needs you yet
    // (answered a moment ago, or not derived) counts nothing.
    const stale = buildChannels(buildOrgTree(tasks), tasks, probe)
    expect(stale.main.needs).toBe(0)
  })

  it('counts a lead\'s own prompt and a failed session as needing the user', () => {
    const probe: AlertProbe = (task) => (task.id === 'tl' ? { kind: 'error' } : null)
    const failed = tasks.map((x) => (x.id === 'tl' ? { ...x, user_status: { state: 'needs' as const, source: 'error' as const, ask: 'Its session failed' } } : x))
    const travel = buildChannels(buildOrgTree(failed), failed, probe).rows[0]!
    expect(travel.name).toBe('Travel')
    expect(travel.alerts).toEqual([{ taskId: 'tl', title: 'Travel VP', kind: 'error' }])
    expect(alertText(travel.alerts[0]!)).toBe('Failed: Travel VP')
    // A failure its status reads as Waiting (a host gone a moment, a trigger armed) is no alert,
    // as on the Board: the row stays quiet and counts nothing.
    const waiting = buildChannels(buildOrgTree(tasks), tasks, probe).rows.find((r) => r.name === 'Travel')!
    expect([waiting.state, waiting.needs, waiting.alerts]).toEqual(['parked', 0, []])
  })

  it('lists a task whose status needs the user, with no prompt open, and counts it everywhere', () => {
    // A decision letter waits on the user: its session asks nothing, its status says so.
    const letter = t('p1', 'Personal', 'WAITING', { updated_at: at(1), user_status: { state: 'needs', source: 'letter', ask: 'Pick the renewal date' } })
    const list = tasks.map((x) => (x.id === 'p1' ? letter : x))
    const { main, rows } = buildChannels(buildOrgTree(list), list, noAlerts)
    const personal = rows[0]!
    expect(personal.name).toBe('Personal')
    expect(personal.state).toBe('alert')
    expect(personal.alerts).toEqual([{ taskId: 'p1', title: 'p1 title', kind: 'needs', ask: 'Pick the renewal date', source: 'letter' }])
    expect([personal.latest, personal.latestTask]).toEqual(['Needs you: Pick the renewal date', 'p1 title'])
    expect(personal.needs).toBe(1)
    expect(personal.counts.needsYou).toBe(1)
    expect(main.needs).toBe(1)
    expect(main.latest).toBe('4 VPs · 1 Working · 1 Needs you')
    expect(teamColumns(personal, list).map((c) => [c.key, c.items.map((i) => [i.id, i.note])])).toEqual([
      ['needs', [['p1', 'Pick the renewal date']]], ['waiting', [['p2', undefined]]],
    ])
  })

  it('says the team\'s newest news in its own words with its time, not only a title', () => {
    // 2026-10-26: a task passed a check and asked the user to sign; its row read "Waiting: <title>".
    const news = t('i9', 'Insurance', 'NEED_ACTION', {
      title: 'Follow up on the claim', updated_at: at(48), last_session_update: at(53),
      user_status: { state: 'waiting', kind: 'you', waitingOn: 'You, to read the latest turn (no rush)', now: 'The identity check passed; only your signature is left.', at: at(30) },
    })
    const older = t('i2', 'Insurance', 'IN_PROGRESS', { updated_at: at(55), user_status: { state: 'working', now: 'Reading the update', at: at(12) } })
    const list = [...tasks, news, older]
    const row = buildChannels(buildOrgTree(list), list, noAlerts).rows.find((r) => r.name === 'Insurance')!
    expect(row.latest).toBe('The identity check passed; only your signature is left.')
    expect(row.latestTask).toBe('Follow up on the claim')
    // Search finds the row by the task the line is about.
    expect(filterChannels(buildChannels(buildOrgTree(list), list, noAlerts).rows, 'the claim').map((r) => r.name)).toEqual(['Insurance'])
    expect(row.latestAt).toBe(Date.parse(at(30)))
    expect(row.lastAt).toBe(Date.parse(at(55)))
  })

  it('reads a task the server has not derived yet by its phase, as every surface does', () => {
    // NEED_ACTION with no status yet: Needs you (fallbackUserState), so the Org agrees with the Board.
    const fresh = tasks.map((x) => (x.id === 'h1' ? t('h1', 'Garden', 'NEED_ACTION', { updated_at: at(40) }) : x))
    const garden = buildChannels(buildOrgTree(fresh), fresh, noAlerts).rows[0]!
    expect([garden.name, garden.state, garden.latest, garden.needs]).toEqual(['Garden', 'alert', 'Needs you: h1 title', 1])
  })

  it('states', () => {
    expect(channelState({ open: 2, running: 0, needsYou: 0, waiting: 2 }, [])).toBe('parked')
    expect(channelState({ open: 2, running: 0, needsYou: 1, waiting: 1 }, [])).toBe('quiet')
    expect(channelState({ open: 2, running: 1, needsYou: 0, waiting: 0 }, [{ taskId: 'x', title: 'x', kind: 'question' }])).toBe('alert')
  })

  it('a snoozed task is parked like a WAITING one, and never an alert', () => {
    const snoozed = { state: 'waiting', kind: 'time', waitingOn: 'Snoozed until 2026-11-13', snoozed: { until: '2026-11-13' } } as Task['user_status']
    const garden = [
      t('g1', 'Garden', 'NEED_ACTION', { updated_at: at(3), user_status: snoozed }),
      t('g2', 'Garden', 'WAITING', { updated_at: at(4) }),
    ]
    const row = buildChannels(buildOrgTree(garden), garden, noAlerts).rows.find((r) => r.name === 'Garden')!
    expect([row.state, row.needs]).toEqual(['parked', 0])
    // With no status yet, a handed-back task still needs the user.
    const plain = [t('g1', 'Garden', 'NEED_ACTION', { updated_at: at(3) }), garden[1]!]
    const alert = buildChannels(buildOrgTree(plain), plain, noAlerts).rows.find((r) => r.name === 'Garden')!
    expect([alert.state, alert.needs]).toEqual(['alert', 1])
  })

  it('searches every word over the name, the contact and the line', () => {
    const { rows } = buildChannels(buildOrgTree(tasks), tasks, noAlerts)
    expect(filterChannels(rows, 'walnut').map((r) => r.name)).toEqual(['Walnut'])
    expect(filterChannels(rows, 'TRAVEL vp').map((r) => r.name)).toEqual(['Travel'])
    expect(filterChannels(rows, 'waiting h1').map((r) => r.name)).toEqual(['Garden'])
    expect(filterChannels(rows, '  ').length).toBe(4)
    expect(filterChannels(rows, 'nothing-like-this')).toEqual([])
  })

  it('picks the URL\'s row, else the first lead, else Main', () => {
    const channels = buildChannels(buildOrgTree(tasks), tasks, noAlerts)
    expect(pickChannel(channels, projectRowKey('travel')).name).toBe('Travel')
    expect(pickChannel(channels, MAIN_KEY).kind).toBe('main')
    expect(pickChannel(channels, 'project:gone').name).toBe('Walnut')
    expect(pickChannel(channels, null).name).toBe('Walnut')
    const empty = buildChannels(buildOrgTree([]), [], noAlerts)
    expect(empty.rows).toEqual([])
    expect(pickChannel(empty, null).kind).toBe('main')
  })

  it('lays a project\'s teams out by state, a team holding a prompt under Needs you', () => {
    const probe: AlertProbe = (task) => (task.id === 'w3' ? { kind: 'question' } : null)
    const live = prompting(['w3'])
    const walnut = buildChannels(buildOrgTree(live), live, probe).rows[0]!
    expect(teamColumns(walnut, live).map((c) => [c.label, c.items.map((i) => i.id)])).toEqual([
      ['Needs you', ['w2']], ['Working', ['w1']],
    ])
    const plain = buildChannels(buildOrgTree(tasks), tasks, noAlerts).rows[0]!
    const cols = teamColumns(plain, tasks)
    expect(cols.map((c) => [c.key, c.label])).toEqual([['working', 'Working'], ['waiting', 'Waiting / snoozed']])
    // Each with its own status's words: what it does, on whom it waits.
    expect(cols[0]!.items[0]).toMatchObject({ id: 'w1', note: 'Writing the parser' })
    expect(cols[1]!.items[0]).toMatchObject({ id: 'w2', workers: 1, lastAt: Date.parse(at(30)), note: 'Its lead reads the result' })
    // A team that sits in a column for one of its workers reads that worker's words, named.
    const asks = tasks.map((x) => (x.id === 'w3' ? { ...x, user_status: { state: 'needs' as const, source: 'choice' as const, ask: 'Pick a name' } } : x))
    const team = teamColumns(buildChannels(buildOrgTree(asks), asks, noAlerts).rows[0]!, asks)
    expect(team[0]).toMatchObject({ key: 'needs', items: [{ id: 'w2', note: 'w3 title: Pick a name' }] })
  })

  it('Main\'s Team is its leads by state, each selecting its row', () => {
    const { rows } = buildChannels(buildOrgTree(tasks), tasks, noAlerts)
    const cols = mainTeamColumns(rows)
    expect(cols.map((c) => [c.label, c.items.map((i) => i.title)])).toEqual([
      ['Working', ['Walnut']], ['Waiting / snoozed', ['Garden', 'Travel', 'Personal']],
    ])
    expect(cols[0]!.items[0]).toMatchObject({ rowKey: projectRowKey('Walnut'), note: 'Writing the parser' })
  })

  it('initials', () => {
    expect(initials('Walnut')).toBe('WA')
    expect(initials('Marina Ops Team')).toBe('MO')
    expect(initials('virtual-teammate-import')).toBe('VT')
    // Two CJK words: one character each (test data, escaped).
    expect(initials('\u4e2a\u4eba \u4e8b\u52a1')).toBe('\u4e2a\u4e8b')
    expect(initials('')).toBe('?')
  })

  it('a project put under another VP is part of that VP\'s row, not a row of its own', () => {
    // 2026-10-26: six projects moved under one VP still showed as channels of their own.
    const list: Task[] = [
      t('hl', 'Marina', 'NEED_ACTION', { org_role: 'lead', title: 'Marina lead', org_leads: ['Insights', 'Events'], ...handedBack('Your next message') }),
      t('h1', 'Marina', 'NEED_ACTION', { updated_at: at(1), ...handedBack('Your reply') }),
      t('i1', 'Insights', 'IN_PROGRESS', { updated_at: at(20), user_status: { state: 'working', now: 'Reading the audit' } }),
      t('i2', 'Insights', 'NEED_ACTION', { updated_at: at(30), user_status: { state: 'needs', source: 'session', ask: 'Approve the cleanup', at: at(30) } }),
      t('e1', 'Events', 'WAITING', { updated_at: at(5) }),
      t('il', 'Insights', 'COMPLETE', { org_role: 'lead', title: 'Insights lead' }),
      t('o1', 'Other', 'TODO', { updated_at: at(2) }),
    ]
    const channels = buildChannels(buildOrgTree(list), list, noAlerts)
    expect(channels.rows.map((r) => r.name)).toEqual(['Marina', 'Other'])
    const marina = channels.rows[0]!
    expect(marina.led?.map((l) => l.name).sort()).toEqual(['Events', 'Insights'])
    // Its work is the VP's: all three projects' teams, counts, asks and news.
    expect(marina.counts).toMatchObject({ open: 4, running: 1 })
    expect(marina.alerts.map((a) => a.taskId)).toEqual(['i2'])
    expect(marina.latest).toBe('Needs you: Approve the cleanup')
    expect(marina.node?.teams.map((n) => n.id).sort()).toEqual(['e1', 'h1', 'i1', 'i2'])
    // The chart still has one row per project, each with its own work.
    expect(channels.projects.map((r) => r.name).sort()).toEqual(['Events', 'Insights', 'Marina', 'Other'])
    expect(channels.projects.find((r) => r.name === 'Insights')!.counts.open).toBe(2)
    // A link to the moved project opens its VP; a search by its name finds the VP.
    expect(rowOf(channels, projectRowKey('Insights'))?.name).toBe('Marina')
    expect(pickChannel(channels, projectRowKey('Events')).name).toBe('Marina')
    expect(filterChannels(channels.rows, 'events').map((r) => r.name)).toEqual(['Marina'])
    // Both sit under "Archived", each saying where it went and what its own lead did.
    expect(movedProjects(channels, list).map((m) => [m.project, m.vpName, m.vpKey, m.from?.open])).toEqual([
      ['Events', 'Marina', projectRowKey('Marina'), undefined],
      ['Insights', 'Marina', projectRowKey('Marina'), false],
    ])
    // Main counts its VPs, not the projects under them.
    expect(channels.main.latest).toMatch(/^2 VPs/)
    expect(mainTeamColumns(channels.rows).flatMap((c) => c.items.map((i) => i.title)).sort()).toEqual(['Marina', 'Other'])
  })

  it('a team names its running tasks for the live action line, itself first, a worker by title', () => {
    const list = tasks.map((x) => (x.id === 'w3' ? { ...x, phase: 'IN_PROGRESS' as const, user_status: { state: 'working' as const } } : x))
    const walnut = buildChannels(buildOrgTree(list), list, noAlerts).rows.find((r) => r.name === 'Walnut')!
    const working = teamColumns(walnut, list).find((c) => c.key === 'working')!
    expect(working.items.map((i) => [i.id, i.live])).toEqual([
      ['w2', [{ id: 'w3', title: 'w3 title' }]],
      ['w1', [{ id: 'w1' }]],
    ])
    // A team with nothing running carries no live line; one that needs the user still shows what runs.
    const asking = list.map((x) => (x.id === 'w2' ? { ...x, user_status: { state: 'needs' as const, ask: 'Pick one' } } : x))
    const askRow = buildChannels(buildOrgTree(asking), asking, noAlerts).rows.find((r) => r.name === 'Walnut')!
    const needs = teamColumns(askRow, asking).find((c) => c.key === 'needs')!
    expect(needs.items.find((i) => i.id === 'w2')?.live).toEqual([{ id: 'w3', title: 'w3 title' }])
    const plain = buildChannels(buildOrgTree(tasks), tasks, noAlerts).rows.find((r) => r.name === 'Walnut')!
    expect(teamColumns(plain, tasks).flatMap((c) => c.items).filter((i) => i.live).map((i) => i.id)).toEqual(['w1'])
  })
})

