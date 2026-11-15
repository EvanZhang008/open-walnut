/**
 * The panels locked on Home stay locked beside the Org node they belong to (2026-11-04, the user, on
 * a VP: "when i clcik [the VP], the lcok view is not there, the lock should always show for that vp").
 * homeLocksFor picks them from Home's saved strip, in Home's order; taskRowKey places a task under its
 * VP (its own project or one it leads), else the CEO.
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, it, expect } from 'vitest'
import type { Task } from '../../src/core/types.js'
import { HOME_OFF_VIEW, homeLocksFor, releaseHomeTakeoff } from '../../web/src/components/org/org-side-columns.js'
import { viewKey } from '../../web/src/utils/view-memory.js'
import { taskRowKey } from '../../web/src/components/org/org-task-tabs.js'
import type { ChannelRow } from '../../web/src/components/org/org-channels-model.js'

const task = (id: string, project: string, extra: Partial<Task> = {}): Task =>
  ({ id, title: id, project, session_id: `s-${id}`, status: 'todo', phase: 'TODO', ...extra }) as unknown as Task
const row = (key: string, project: string, led: string[] = []): ChannelRow =>
  ({ key, project, led: led.map((p) => ({ project: p })) }) as unknown as ChannelRow

describe('the panels Home locked, beside their node', () => {
  const main = row('main', '')
  const atlas = row('project:atlas', 'Atlas', ['Courier'])
  const walnut = row('project:walnut', 'Walnut')
  const rowKeyOf = taskRowKey(main, [atlas, walnut])
  const tasks = [
    task('sync', 'Atlas'), task('route', 'Courier'), task('notes', 'Walnut'), task('inbox', 'Inbox'),
    task('lead', 'Atlas', { org_role: 'lead' } as Partial<Task>),
  ]
  const home = [
    { id: 's-route', locked: true }, { id: 's-notes', locked: true }, { id: 's-sync', locked: true },
    { id: 's-inbox', locked: true }, { id: 's-lead', locked: true }, { id: 'draft:1', locked: true }, { id: 's-free', locked: false },
  ]

  it('places a task under the VP whose work holds its project, else the CEO', () => {
    expect(rowKeyOf(tasks[0])).toBe('project:atlas')
    expect(rowKeyOf(tasks[1])).toBe('project:atlas')
    expect(rowKeyOf(tasks[2])).toBe('project:walnut')
    expect(rowKeyOf(tasks[3])).toBe('main')
  })

  it('gives each node its own locked panels in Home\'s order, never the node\'s own chat, a draft or an unlocked one', () => {
    expect(homeLocksFor('project:atlas', home, tasks, rowKeyOf)).toEqual([
      { id: 'session:s-route', locked: true }, { id: 'session:s-sync', locked: true },
    ])
    expect(homeLocksFor('project:walnut', home, tasks, rowKeyOf)).toEqual([{ id: 'session:s-notes', locked: true }])
    expect(homeLocksFor('main', home, tasks, rowKeyOf)).toEqual([{ id: 'session:s-inbox', locked: true }])
  })

  it('leaves out the ones taken off on the Org page, and a lock of a task it does not know', () => {
    expect(homeLocksFor('project:atlas', home, tasks, rowKeyOf, new Set(['session:s-sync']))).toEqual([{ id: 'session:s-route', locked: true }])
    expect(homeLocksFor('project:atlas', [{ id: 's-gone', locked: true }], tasks, rowKeyOf)).toEqual([])
  })

  it('a lock button pressed on Home ends the Org page\'s taking-off of that panel, and only that one', () => {
    const store = new Map<string, string>()
    const g = globalThis as unknown as { localStorage?: unknown }
    const before = g.localStorage
    g.localStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v) }, removeItem: (k: string) => { store.delete(k) } }
    try {
      const key = viewKey('org', HOME_OFF_VIEW)
      store.set(key, JSON.stringify(['session:s-sync', 'session:s-route']))
      releaseHomeTakeoff('s-sync')
      expect(JSON.parse(store.get(key)!)).toEqual(['session:s-route'])
      releaseHomeTakeoff('s-other')
      expect(JSON.parse(store.get(key)!)).toEqual(['session:s-route'])
    } finally { g.localStorage = before }
    const main = fs.readFileSync(path.resolve(import.meta.dirname, '../../web/src/pages/MainPage.tsx'), 'utf8')
    expect(main).toMatch(/const handleToggleLockSession = use(?:Lean)?Callback\(\(sessionId: string\) => \{[\s\S]{0,200}releaseHomeTakeoff\(sessionId\)/)
  })

  it('is wired into the Org page: the strip holds them, the page writes back only its own', () => {
    const page = fs.readFileSync(path.resolve(import.meta.dirname, '../../web/src/pages/OrgPage.tsx'), 'utf8')
    expect(page).toMatch(/phone \? \[\] : homeLocksFor\(selected\.key, homeLocks, tasks, rowKeyOf, new Set\(homeOff\)\)/)
    // Where they do not fit beside the chat they wait as tabs at the edge, never laid over the chat.
    expect(page).toMatch(/const fromHome = useMemo\(\(\) => \(overlays \? \[\] : homeHere\)/)
    expect(page).toMatch(/data-testid="org-locked-dock-item"/)
    // Unlocked or closed on the Org page, one leaves it, and its kept row with it.
    expect(page).toMatch(/if \(homeIdsOf\(id\)\.length && strip\.some\(\(c\) => c\.id === id && c\.locked\)\) \{ closePanel\(id\); return; \}/)
    expect(page).toMatch(/lockedTaskIds\(\[\.\.\.pins, \.\.\.homeLocksHere\]/)
    expect(page).toMatch(/orgStripView\(\[\.\.\.fromHome, \.\.\.pins\.filter/)
    expect(page).toMatch(/writeStrip\(strip\.filter\(\(s\) => !fromHome\.some/)
  })
})
