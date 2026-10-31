/**
 * No Needs you count without a card saying what it is (2026-10-31, the user, on a VP whose rail
 * read "Needs you 1" over "Its ask is in the chat."): every count of the Org page (a row's badge,
 * the CEO's summary, the detail's pill, the rail's tab) counts the same asks the rail draws as
 * cards, the node's own ask first and named for the node, and every card says what it asks and
 * when that was checked (or Not verified).
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, it, expect } from 'vitest'
import type { Task } from '../../src/core/types.js'
import { buildOrgTree } from '../../src/core/org/org-tree.js'
import { buildChannels, cardChecked, type AlertProbe } from '../../web/src/components/org/org-channels-model.js'
import { orgTaskTabs, ownAskFirst } from '../../web/src/components/org/org-task-tabs.js'
import { askSummary } from '../../web/src/components/org/org-ask-form.js'

const NOW = Date.UTC(2026, 9, 31, 12, 0)
const at = (m: number) => new Date(NOW - m * 60_000).toISOString()
const t = (id: string, project: string, extra: Partial<Task> = {}): Task => ({
  id, title: `${id} title`, project, phase: 'IN_PROGRESS', status: 'todo', priority: 'none',
  created_at: at(600), updated_at: at(10), ...extra,
}) as Task
const needs = (ask: string, extra: Record<string, unknown> = {}) => ({ user_status: { state: 'needs', source: 'session', ask, checkedAt: at(30), ...extra } }) as Partial<Task>

const tasks: Task[] = [
  t('main', 'Ask Walnut', { org_role: 'main', walnut_agent: true, ...needs('Pick a VP for the new project') }),
  // A VP that itself needs the user (its own ask), with workers that do too.
  t('lead', 'Marina', { org_role: 'lead', title: 'Marina lead', ...needs('Approve the cleanup plan') }),
  t('w1', 'Marina', { parent_task_id: 'lead', ...needs('Which region first?', { checkedAt: at(60 * 6), unverified: true }) }),
  t('w2', 'Marina', { parent_task_id: 'lead', phase: 'NEED_ACTION', user_status: { state: 'needs', source: 'letter', ask: 'Read the letter' } as Task['user_status'] }),
  t('w3', 'Marina', { parent_task_id: 'lead', user_status: { state: 'working' } as Task['user_status'] }),
  // A task with a live prompt: no check time, its session asks now.
  t('w4', 'Marina', { parent_task_id: 'lead', user_status: { state: 'needs', source: 'prompt' } as Task['user_status'] }),
  // A project with no VP yet.
  t('g1', 'Garden', needs('Water on Sunday?')),
  t('g2', 'Garden', { user_status: { state: 'waiting' } as Task['user_status'] }),
]
const probe: AlertProbe = (task) => (task.id === 'w4' ? { kind: 'question', tool: 'AskUserQuestion' } : null)
const { main, rows } = buildChannels(buildOrgTree(tasks), tasks, probe)

describe('every Needs you count has its cards', () => {
  it('a row counts the asks its rail draws, its own ask first and named for it', () => {
    expect(rows.length).toBeGreaterThan(1)
    for (const row of rows) {
      const cards = ownAskFirst(orgTaskTabs(row, rows, tasks, NOW).needs, row.contactId)
      expect(row.needs, row.key).toBe(cards.length)
      expect(row.alerts.length, row.key).toBe(cards.length)
      if (row.contactId && cards.some((a) => a.taskId === row.contactId)) expect(cards[0]!.taskId).toBe(row.contactId)
    }
    const marina = rows.find((r) => r.project === 'Marina')!
    expect(ownAskFirst(orgTaskTabs(marina, rows, tasks, NOW).needs, marina.contactId).map((a) => a.taskId)[0]).toBe('lead')
  })

  it('the CEO counts every card of its rail, its own and every VP\'s', () => {
    const cards = orgTaskTabs(main, rows, tasks, NOW).needs
    expect(main.needs).toBe(cards.length)
    expect(new Set(cards.map((a) => a.taskId))).toEqual(new Set(['main', 'lead', 'w1', 'w2', 'w4', 'g1']))
  })

  it('every card says what it asks and when it was checked, or Not verified', () => {
    const cards = orgTaskTabs(main, rows, tasks, NOW).needs
    for (const a of cards) {
      expect(askSummary(a).summary.trim(), a.taskId).not.toBe('')
      expect(cardChecked(a).text.trim(), a.taskId).not.toBe('')
    }
    const by = new Map(cards.map((a) => [a.taskId, cardChecked(a)]))
    expect(by.get('lead')!.text).toMatch(/^Checked /)
    expect(by.get('w1')).toMatchObject({ unverified: true })
    expect(by.get('w2')).toEqual({ text: 'Not verified', unverified: true })
    expect(by.get('w4')!.text).toBe('Open in its session now')
  })

  it('the rail draws no count it has no card for', () => {
    const web = path.resolve(import.meta.dirname, '../../web/src/components/org')
    const rail = fs.readFileSync(path.join(web, 'OrgTaskRail.tsx'), 'utf8')
    expect(rail).not.toMatch(/in the chat\./)
    const detail = fs.readFileSync(path.join(web, 'OrgNodeDetail.tsx'), 'utf8')
    // The rail gets every ask the tab counts: ordered, never filtered.
    expect(detail).toMatch(/alertsShown = useMemo\(\(\) => ownAskFirst\(tabs\.needs, row\.contactId\)/)
    expect(detail).not.toMatch(/tabs\.needs\.filter\(/)
  })
})
