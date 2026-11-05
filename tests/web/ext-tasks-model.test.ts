/**
 * The side panel's Tasks tab (web/src/popout/ext-tasks-model.ts): their Focus tasks (the board's
 * Focus tier, whatever they need), then what else needs the person (To read drawn with it), each
 * task once, never a finished one or a plugin's own; a Needs you row says what tells it apart;
 * and a page saved as a task names the page and its address.
 */
import { describe, expect, it } from 'vitest'
import type { Task } from '@open-walnut/core'
import { askedOf, extTaskLists, inFocus, keepTaskLists, keptTaskLists, KEPT_MAX_AGE_MS, needsRowLine, pageTaskInput, rowLine } from '../../web/src/popout/ext-tasks-model'

let n = 0
const task = (over: Partial<Task>): Task => ({
  id: `t${++n}`, title: `Task ${n}`, status: 'todo', phase: 'TODO', priority: 'none', category: '', project: '',
  source: 'local', session_ids: [], created_at: '2026-11-01T00:00:00Z', updated_at: `2026-11-0${(n % 9) + 1}T00:00:00Z`,
  description: '', summary: '', note: '', ...over,
} as Task)

describe('the Tasks tab lists', () => {
  it('Focus is every open task of the Focus tier; Needs you the rest; each once; never done or a plugin\'s', () => {
    const needs = task({ title: 'Review the plan', phase: 'NEED_ACTION', user_status: { state: 'needs', source: 'session', ask: 'Pick a design', category: 'decide' } as never })
    const read = task({ title: 'Report ready', phase: 'NEED_ACTION', user_status: { state: 'read', source: 'session', toRead: 'result', waitingOn: 'The report is done' } as never, pinned: true, focus_tier: 'focus' })
    const focus = task({ title: 'Write the release notes', phase: 'IN_PROGRESS', pinned: true, focus_tier: 'focus', user_status: { state: 'working', source: 'session' } as never })
    const satellite = task({ title: 'Someday', phase: 'TODO', pinned: true })
    const done = task({ title: 'Shipped', phase: 'COMPLETE', status: 'done', pinned: true, focus_tier: 'focus' })
    const plugin = task({ title: 'Plugin chore', phase: 'NEED_ACTION', plugin_only: 'x' } as never)
    const lists = extTaskLists([needs, read, focus, satellite, done, plugin])
    expect(lists.needs.map((r) => r.task.title)).toEqual(['Review the plan'])
    // A Focus task that needs the person is listed under Focus, with what it needs on its row.
    expect(lists.focus.map((r) => r.task.title).sort()).toEqual(['Report ready', 'Write the release notes'])
    expect(lists.focus.find((r) => r.task.title === 'Report ready')!.state).toBe('needs')
    const row = lists.needs.find((r) => r.task.title === 'Review the plan')!
    expect(row.state).toBe('needs')
    expect(row.label).toBe('Needs you')
    expect(row.line).toContain('Pick a design')
    expect(lists.focus.find((r) => r.task.title === 'Write the release notes')!.label).toBe('Working')
  })

  it('a row does not repeat its section; one answered here stays, with its new state', () => {
    const t = task({ title: 'Pick a design', phase: 'NEED_ACTION', user_status: { state: 'needs', source: 'session', ask: 'A or B?', category: 'decide' } as never })
    const row = extTaskLists([t]).needs[0]
    expect(rowLine(row, 'needs')).not.toMatch(/^Needs you/)
    expect(rowLine(row, 'needs')).toContain('A or B?')
    expect(rowLine({ label: 'Working', line: '' }, 'focus')).toBe('Working')
    // Under Focus a row that needs the person leads with what to do, which says it needs them.
    expect(rowLine({ label: 'Needs you', line: 'Decide: A or B?' }, 'focus')).toBe('Decide: A or B?')
    expect(rowLine({ label: 'Needs you', line: '' }, 'focus')).toBe('Needs you')
    // Answered: the task works again, needs the person no more, yet stays listed where it was.
    const working = { ...t, phase: 'IN_PROGRESS', user_status: { state: 'working', source: 'session' } } as Task
    expect(extTaskLists([working]).needs).toHaveLength(0)
    const kept = extTaskLists([working], new Set([t.id])).needs
    expect(kept.map((r) => r.task.id)).toEqual([t.id])
    expect(rowLine(kept[0], 'needs')).toMatch(/^Working/)
    expect(inFocus({ ...t, pinned: true, focus_tier: 'focus' } as Task)).toBe(true)
    expect(inFocus({ ...t, pinned: true } as Task)).toBe(false)
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

describe('the Focus list and count read the Focus mark', () => {
  // Every mix of state and tier a task can have: the Focus section (its count is its rows) holds
  // exactly the open tasks a row would mark as in Focus, and Needs you none of them.
  it('for every phase, status and tier, a task wears the mark if and only if Focus lists it', () => {
    const statuses = [undefined, { state: 'needs', source: 'session', ask: 'Pick one' }, { state: 'read', toRead: 'turn', waitingOn: 'x' }, { state: 'working' }, { state: 'waiting', kind: 'task', waitingOn: 'y' }]
    const phases = ['TODO', 'IN_PROGRESS', 'NEED_ACTION', 'WAITING', 'COMPLETE'] as const
    const tiers: Array<Partial<Task>> = [{}, { pinned: true }, { pinned: true, focus_tier: 'focus' }, { pinned: true, focus_tier: 'wait' }, { focus_tier: 'focus' }]
    const all: Task[] = []
    for (const phase of phases) for (const us of statuses) for (const tier of tiers) {
      all.push(task({ phase, status: phase === 'COMPLETE' ? 'done' : 'todo', ...(us ? { user_status: us as never } : {}), ...tier }))
    }
    const lists = extTaskLists(all)
    const focusIds = new Set(lists.focus.map((r) => r.task.id))
    const shown = [...lists.focus, ...lists.needs]
    expect(new Set(shown.map((r) => r.task.id)).size).toBe(shown.length)
    for (const r of shown) expect(inFocus(r.task), r.task.id).toBe(focusIds.has(r.task.id))
    // Each open Focus task Home shows is in the list (a parked one Home hides is hidden here too).
    const homeFocus = all.filter((t) => inFocus(t) && t.phase !== 'COMPLETE' && !(t.phase === 'WAITING' && !['working', 'read'].includes(String((t.user_status as { state?: string } | undefined)?.state))))
    expect([...focusIds].sort()).toEqual(homeFocus.map((t) => t.id).sort())
  })

  it('a task answered here and then added to Focus moves to Focus, not two places', () => {
    const t = task({ phase: 'IN_PROGRESS', pinned: true, focus_tier: 'focus', user_status: { state: 'working' } as never })
    const lists = extTaskLists([t], new Set([t.id]))
    expect(lists.focus.map((r) => r.task.id)).toEqual([t.id])
    expect(lists.needs).toEqual([])
  })
})

describe('a Needs you row says what tells it apart', () => {
  const words = (text: string) => ({ text, at: '2026-11-04T00:00:00Z', session_id: 's' })
  it('the task\'s own ask, else its last words, else the category word alone', () => {
    expect(needsRowLine(task({ phase: 'NEED_ACTION', user_status: { state: 'needs', source: 'session', ask: 'Ship to beta today?', category: 'decide' } as never, last_words: words('Other words') } as never))).toBe('Decide: Ship to beta today?')
    const turn = { state: 'read', source: 'session', toRead: 'turn', waitingOn: 'Its turn ended without asking you anything' }
    expect(needsRowLine(task({ phase: 'NEED_ACTION', user_status: turn as never, last_words: words('Hellebores flower in late winter.') } as never))).toBe('Take a look: Hellebores flower in late winter.')
    expect(needsRowLine(task({ phase: 'NEED_ACTION', user_status: turn as never }))).toBe('Take a look')
    // Set to need the person by hand: Walnut's stock sentence is no ask of the task's own.
    expect(needsRowLine(task({ phase: 'NEED_ACTION', user_status: { state: 'needs', ask: 'It was set to need you by hand: open it.' } as never }))).toBe('Decide')
    expect(needsRowLine(task({ phase: 'NEED_ACTION' }))).toBe('')
  })

  it('rows that ended their turn differently read differently, and no line holds a stock sentence', () => {
    const turn = { state: 'read', source: 'session', toRead: 'turn', waitingOn: 'Its turn ended without asking you anything' }
    const rows = extTaskLists([
      task({ phase: 'NEED_ACTION', user_status: turn as never, last_words: words('The tests pass on both engines.') } as never),
      task({ phase: 'NEED_ACTION', user_status: turn as never, last_words: words('I could not reach the host.') } as never),
      task({ phase: 'NEED_ACTION', user_status: { state: 'needs', ask: 'It was set to need you by hand: open it.' } as never }),
    ]).needs
    const lines = rows.map((r) => rowLine(r, 'needs'))
    expect(new Set(lines).size).toBe(3)
    for (const l of lines) expect(l).not.toMatch(/turn ended without asking|set to need you by hand/)
  })
})
