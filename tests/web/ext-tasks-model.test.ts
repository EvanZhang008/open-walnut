/**
 * The side panel's Tasks tab (web/src/popout/ext-tasks-model.ts): what needs the person first
 * (To read drawn with it), then their Focus tasks, each task once, never a finished one or a
 * plugin's own; and a page saved as a task names the page and its address.
 */
import { describe, expect, it } from 'vitest'
import type { Task } from '@open-walnut/core'
import { askedOf, extTaskLists, keepTaskLists, keptTaskLists, KEPT_MAX_AGE_MS, pageTaskInput } from '../../web/src/popout/ext-tasks-model'

let n = 0
const task = (over: Partial<Task>): Task => ({
  id: `t${++n}`, title: `Task ${n}`, status: 'todo', phase: 'TODO', priority: 'none', category: '', project: '',
  source: 'local', session_ids: [], created_at: '2026-11-01T00:00:00Z', updated_at: `2026-11-0${(n % 9) + 1}T00:00:00Z`,
  description: '', summary: '', note: '', ...over,
} as Task)

describe('the Tasks tab lists', () => {
  it('needs you (and to read) first, then Focus; each once; never done or a plugin\'s', () => {
    const needs = task({ title: 'Review the plan', phase: 'NEED_ACTION', user_status: { state: 'needs', source: 'session', ask: 'Pick a design', category: 'decide' } as never })
    const read = task({ title: 'Report ready', phase: 'NEED_ACTION', user_status: { state: 'read', source: 'session', toRead: 'result', waitingOn: 'The report is done' } as never, pinned: true, focus_tier: 'focus' })
    const focus = task({ title: 'Write the release notes', phase: 'IN_PROGRESS', pinned: true, focus_tier: 'focus', user_status: { state: 'working', source: 'session' } as never })
    const satellite = task({ title: 'Someday', phase: 'TODO', pinned: true })
    const done = task({ title: 'Shipped', phase: 'COMPLETE', status: 'done', pinned: true, focus_tier: 'focus' })
    const plugin = task({ title: 'Plugin chore', phase: 'NEED_ACTION', plugin_only: 'x' } as never)
    const lists = extTaskLists([needs, read, focus, satellite, done, plugin])
    expect(lists.needs.map((r) => r.task.title).sort()).toEqual(['Report ready', 'Review the plan'])
    expect(lists.focus.map((r) => r.task.title)).toEqual(['Write the release notes'])
    const row = lists.needs.find((r) => r.task.title === 'Review the plan')!
    expect(row.state).toBe('needs')
    expect(row.label).toBe('Needs you')
    expect(row.line).toContain('Pick a design')
    expect(lists.focus[0].label).toBe('Working')
  })

  it('a page saved as a task names the page, and its address to come back to', () => {
    expect(pageTaskInput({ url: 'https://docs.example.test/notes', title: 'Release notes 4.2' })).toEqual({ title: 'Release notes 4.2', description: 'From the browser: https://docs.example.test/notes' })
    expect(pageTaskInput({ url: 'https://docs.example.test/notes' }).title).toBe('docs.example.test')
  })
})

const memoryStore = () => { const m = new Map<string, string>(); return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, v) } } }

describe('the lists kept for the next open', () => {
  it('keep what a row draws and the conversation a reply goes to, and come back while young', () => {
    const s = memoryStore()
    const t = task({ title: 'Review the plan', phase: 'NEED_ACTION', exec_session_id: 'sess-1', description: 'long private words', user_status: { state: 'needs', source: 'session', ask: 'Pick a design', category: 'decide' } as never })
    keepTaskLists(extTaskLists([t]), s, 1000)
    const back = keptTaskLists(s, 2000)!
    expect(back.needs).toHaveLength(1)
    expect(back.needs[0].task).toEqual({ id: t.id, title: 'Review the plan', session_id: 'sess-1' })
    expect(back.needs[0].line).toContain('Pick a design')
    expect(back.focus).toEqual([])
  })

  it('a week old, broken or missing is nothing: the tab shows its loading line', () => {
    const s = memoryStore()
    keepTaskLists({ needs: [], focus: [] }, s, 0)
    expect(keptTaskLists(s, KEPT_MAX_AGE_MS + 1)).toBeNull()
    s.setItem('walnut.ext-tasks.lists', '{not json')
    expect(keptTaskLists(s)).toBeNull()
    expect(keptTaskLists(memoryStore())).toBeNull()
  })
})

describe('what an open row says the task asked', () => {
  it('its status line in full, then its last words when they add to it', () => {
    const t = task({ last_words: { text: 'Should I ship the build to the beta channel today?', at: '2026-11-04T00:00:00Z', session_id: 's' } } as never)
    expect(askedOf(t, 'Take a look: Its turn ended without asking you anything')).toEqual([
      'Take a look: Its turn ended without asking you anything',
      'Should I ship the build to the beta channel today?',
    ])
    expect(askedOf(t, 'Decide: Should I ship the build to the beta channel today?')).toEqual(['Decide: Should I ship the build to the beta channel today?'])
    expect(askedOf(task({}), '')).toEqual([])
  })
})
