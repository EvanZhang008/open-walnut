/** The Org page's rows (web/src/components/org/org-channels-model.ts). */
import { describe, it, expect } from 'vitest'
import type { Task } from '../../src/core/types.js'
import { buildOrgTree } from '../../src/core/org/org-tree.js'
import {
  MAIN_KEY, alertText, buildChannels, channelState, filterChannels, initials, mainTeamColumns, pickChannel,
  projectRowKey, teamColumns, type AlertProbe,
} from '../../web/src/components/org/org-channels-model.js'

const at = (min: number) => new Date(Date.UTC(2026, 9, 25, 12, min)).toISOString()

function t(id: string, project: string, phase: Task['phase'], extra: Partial<Task> = {}): Task {
  return {
    id, title: `${id} title`, project, phase, status: phase === 'COMPLETE' ? 'done' : 'todo', priority: 'none',
    created_at: at(0), updated_at: at(0), ...extra,
  } as Task
}

const noAlerts: AlertProbe = () => null

const tasks: Task[] = [
  t('main', 'Ask Walnut', 'IN_PROGRESS', { org_role: 'main', walnut_agent: true, updated_at: at(50) }),
  // Walnut: a lead, one running team, one handed back, a worker that asks a question.
  t('wl', 'Walnut', 'NEED_ACTION', { org_role: 'lead', title: 'Walnut lead', unread: true }),
  t('w1', 'Walnut', 'IN_PROGRESS', { updated_at: at(10) }),
  t('w2', 'Walnut', 'NEED_ACTION', { updated_at: at(20) }),
  t('w3', 'Walnut', 'TODO', { parent_task_id: 'w2', updated_at: at(30) }),
  // Tax: a lead with only parked work.
  t('tl', 'Tax', 'NEED_ACTION', { org_role: 'lead', title: 'Tax lead' }),
  t('t1', 'Tax', 'WAITING', { updated_at: at(5) }),
  t('t2', 'Tax', 'WAITING', { updated_at: at(6) }),
  // Health: one task and no lead (Main talks to it); Personal: two tasks, no lead yet.
  t('h1', 'Health', 'NEED_ACTION', { updated_at: at(40) }),
  t('p1', 'Personal', 'TODO', { updated_at: at(1) }),
  t('p2', 'Personal', 'TODO', { updated_at: at(2) }),
  // Done work never shows.
  t('d1', 'Walnut', 'COMPLETE'),
]

describe('org channels', () => {
  it('orders rows by state, then newest first, and picks each row\'s line', () => {
    const { main, rows } = buildChannels(buildOrgTree(tasks), tasks, noAlerts)
    expect(rows.map((r) => [r.name, r.state])).toEqual([
      ['Walnut', 'working'], ['Health', 'quiet'], ['Personal', 'quiet'], ['Tax', 'parked'],
    ])
    const walnut = rows[0]!
    expect(walnut.contactId).toBe('wl')
    expect(walnut.isLead).toBe(true)
    expect(walnut.unread).toBe(true)
    expect(walnut.latest).toBe('Working on: w1 title')
    expect(walnut.lastAt).toBe(Date.parse(at(30)))
    expect(rows.find((r) => r.name === 'Health')!.latest).toBe('Handed back: h1 title')
    expect(rows.find((r) => r.name === 'Health')!.contactId).toBe('h1')
    expect(rows.find((r) => r.name === 'Tax')!.latest).toBe('Parked: t2 title')
    // No lead yet: the row names the lead the first chat makes.
    const personal = rows.find((r) => r.name === 'Personal')!
    expect(personal.contactId).toBeUndefined()
    expect(personal.contactTitle).toBe('Personal lead')
    expect(main.key).toBe(MAIN_KEY)
    expect(main.latest).toBe('4 leads · 1 working')
  })

  it('puts a project whose work waits on a prompt first, with the prompt as its line', () => {
    const probe: AlertProbe = (task) => (task.id === 'w3' ? { kind: 'question' } : task.id === 't1' ? { kind: 'permission', tool: 'Bash' } : null)
    const { main, rows } = buildChannels(buildOrgTree(tasks), tasks, probe)
    expect(rows.map((r) => r.name).slice(0, 2)).toEqual(['Walnut', 'Tax'])
    expect(rows[0]!.state).toBe('alert')
    expect(rows[0]!.latest).toBe('Asks you: w3 title')
    expect(rows[1]!.latest).toBe('Wants approval (Bash): t1 title')
    expect(main.latest).toBe('4 leads · 1 working · 2 need you')
  })

  it('counts a lead\'s own prompt and a failed session as needing the user', () => {
    const probe: AlertProbe = (task) => (task.id === 'tl' ? { kind: 'error' } : null)
    const tax = buildChannels(buildOrgTree(tasks), tasks, probe).rows[0]!
    expect(tax.name).toBe('Tax')
    expect(tax.alerts).toEqual([{ taskId: 'tl', title: 'Tax lead', kind: 'error' }])
    expect(alertText(tax.alerts[0]!)).toBe('Failed: Tax lead')
  })

  it('states', () => {
    expect(channelState({ open: 2, running: 0, needsYou: 0, waiting: 2 }, [])).toBe('parked')
    expect(channelState({ open: 2, running: 0, needsYou: 1, waiting: 1 }, [])).toBe('quiet')
    expect(channelState({ open: 2, running: 1, needsYou: 0, waiting: 0 }, [{ taskId: 'x', title: 'x', kind: 'question' }])).toBe('alert')
  })

  it('searches every word over the name, the contact and the line', () => {
    const { rows } = buildChannels(buildOrgTree(tasks), tasks, noAlerts)
    expect(filterChannels(rows, 'walnut').map((r) => r.name)).toEqual(['Walnut'])
    expect(filterChannels(rows, 'TAX lead').map((r) => r.name)).toEqual(['Tax'])
    expect(filterChannels(rows, 'handed h1').map((r) => r.name)).toEqual(['Health'])
    expect(filterChannels(rows, '  ').length).toBe(4)
    expect(filterChannels(rows, 'nothing-like-this')).toEqual([])
  })

  it('picks the URL\'s row, else the first lead, else Main', () => {
    const channels = buildChannels(buildOrgTree(tasks), tasks, noAlerts)
    expect(pickChannel(channels, projectRowKey('tax')).name).toBe('Tax')
    expect(pickChannel(channels, MAIN_KEY).kind).toBe('main')
    expect(pickChannel(channels, 'project:gone').name).toBe('Walnut')
    expect(pickChannel(channels, null).name).toBe('Walnut')
    const empty = buildChannels(buildOrgTree([]), [], noAlerts)
    expect(empty.rows).toEqual([])
    expect(pickChannel(empty, null).kind).toBe('main')
  })

  it('lays a project\'s teams out by state, a team holding a prompt under Needs you', () => {
    const probe: AlertProbe = (task) => (task.id === 'w3' ? { kind: 'question' } : null)
    const walnut = buildChannels(buildOrgTree(tasks), tasks, probe).rows[0]!
    expect(teamColumns(walnut, tasks).map((c) => [c.label, c.items.map((i) => i.id)])).toEqual([
      ['Needs you', ['w2']], ['Working', ['w1']],
    ])
    const plain = buildChannels(buildOrgTree(tasks), tasks, noAlerts).rows[0]!
    const cols = teamColumns(plain, tasks)
    expect(cols.map((c) => c.label)).toEqual(['Working', 'Handed back'])
    expect(cols[1]!.items[0]).toMatchObject({ id: 'w2', workers: 1, lastAt: Date.parse(at(30)) })
  })

  it('Main\'s Team is its leads by state, each selecting its row', () => {
    const { rows } = buildChannels(buildOrgTree(tasks), tasks, noAlerts)
    const cols = mainTeamColumns(rows)
    expect(cols.map((c) => [c.label, c.items.map((i) => i.title)])).toEqual([
      ['Working', ['Walnut']], ['Quiet', ['Health', 'Personal']], ['Parked', ['Tax']],
    ])
    expect(cols[0]!.items[0]!.rowKey).toBe(projectRowKey('Walnut'))
  })

  it('initials', () => {
    expect(initials('Walnut')).toBe('WA')
    expect(initials('Marina Ops Team')).toBe('MO')
    expect(initials('virtual-teammate-import')).toBe('VT')
    // Two CJK words: one character each (test data, escaped).
    expect(initials('\u4e2a\u4eba \u4e8b\u52a1')).toBe('\u4e2a\u4e8b')
    expect(initials('')).toBe('?')
  })
})
