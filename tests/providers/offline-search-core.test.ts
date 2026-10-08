/**
 * `search` on a host while the server cannot answer
 * (src/providers/offline-search-core.ts): a keyword search of the host's
 * tasks, sessions and memory copy, in the server's row shape.
 */
import { describe, it, expect } from 'vitest'
import { createOfflineSearch, type OfflineSearchTask } from '../../src/providers/offline-search-core.js'

const search = createOfflineSearch()

const TASKS: OfflineSearchTask[] = [
  { id: 'mtask-1', title: 'Fix the flaky build step', description: 'The release build fails on Friday after the rollback drill.' },
  { id: 'mtask-2', title: 'Release notes', description: 'Draft the notes for the build.', parent_task_id: 'mtask-1' },
  { id: 'mtask-3', title: 'Old build cleanup', description: 'Remove the flaky cache.', phase: 'COMPLETE' },
  { id: 'mtask-4', title: 'Lunch \u5348\u996d plans', description: 'Book a table.' },
]
const SESSIONS = [
  { id: 'aaaaaaaa-1111-4111-8111-111111111111', title: 'Leader', taskId: 'mtask-1', taskTitle: 'Fix the flaky build step' },
  { id: 'bbbbbbbb-2222-4222-8222-222222222222', title: 'Rollback drill run', taskId: 'mtask-2' },
]
const MEMORY = [{ path: 'MEMORY.md', title: 'MEMORY.md', content: '# Memory\n- deploy with the script\n- the build runs on the big box\n' }]
const all = (q: unknown, extra: Record<string, unknown> = {}) => search.run({ q, tasks: TASKS, sessions: SESSIONS, memory: MEMORY, ...extra })

describe('offline search', () => {
  it('every word first: a row with all the words beats a row with some', () => {
    const r = all('flaky build')
    expect(r.ok).toBe(true)
    if (!r.ok) return
    // mtask-1 holds both in its title; mtask-3 holds both but is finished; the session's task title holds both.
    expect(r.results.map((x) => (x.type === 'session' ? x.sessionId : x.taskId))).toEqual(['mtask-1', SESSIONS[0].id, 'mtask-3'])
    expect(r.results.every((x) => x.coveredTermHits === 2)).toBe(true)
    expect(r.results[0]).toMatchObject({ type: 'task', title: 'Fix the flaky build step', matchField: 'title' })
  })

  it('a body hit has a snippet around the word, and names its field', () => {
    const r = all('rollback')
    if (!r.ok) throw new Error(r.error)
    const task = r.results.find((x) => x.taskId === 'mtask-1')!
    expect(task).toMatchObject({ matchField: 'description' })
    expect(task.snippet).toContain('rollback drill')
    // The session whose title holds it ranks above the task whose body does.
    expect(r.results[0]).toMatchObject({ type: 'session', sessionId: SESSIONS[1].id })
  })

  it('no row has every word: the rows with the most of them', () => {
    const r = all('build zebra')
    if (!r.ok) throw new Error(r.error)
    expect(r.results.length).toBeGreaterThan(0)
    expect(r.results.every((x) => x.coveredTermHits === 1)).toBe(true)
  })

  it('memory rows carry the path, and a type filter keeps to its types', () => {
    const r = all('deploy script', { types: 'memory' })
    if (!r.ok) throw new Error(r.error)
    expect(r.types).toEqual(['memory'])
    expect(r.results).toEqual([expect.objectContaining({ type: 'memory', path: 'MEMORY.md', title: 'MEMORY.md' })])
    expect(r.results[0].snippet).toContain('deploy with the script')
  })

  it('a child task names its parent', () => {
    const r = all('release notes', { types: ['task'] })
    if (!r.ok) throw new Error(r.error)
    expect(r.results[0]).toMatchObject({ taskId: 'mtask-2', parentTaskId: 'mtask-1' })
  })

  it('CJK text is found by substring', () => {
    const r = all('\u5348\u996d')
    if (!r.ok) throw new Error(r.error)
    expect(r.results.map((x) => x.taskId)).toEqual(['mtask-4'])
  })

  it('a task id finds its task', () => {
    const r = all('mtask-4')
    if (!r.ok) throw new Error(r.error)
    expect(r.results[0]?.taskId).toBe('mtask-4')
  })

  it('limit, and its bounds', () => {
    const one = all('build', { limit: 1 })
    expect(one.ok && one.results).toHaveLength(1)
    const many = all('build', { limit: 10_000 })
    expect(many.ok && many.results.length).toBeLessThanOrEqual(100)
    const junk = all('build', { limit: 'abc' })
    expect(junk.ok).toBe(true)
  })

  it('refuses an empty query and an unknown type', () => {
    expect(all('  ')).toEqual({ ok: false, error: 'q is required' })
    expect(all(42)).toEqual({ ok: false, error: 'q is required' })
    expect(all('x', { types: 'task,note' })).toEqual({ ok: false, error: 'invalid types: note (valid: task, memory, session)' })
    expect(all('x', { types: { a: 1 } }).ok).toBe(false)
  })

  it('nothing found is an empty list, and bad rows are skipped', () => {
    const r = search.run({ q: 'nothing-like-this', tasks: [null as unknown as OfflineSearchTask, ...TASKS], sessions: [], memory: [] })
    expect(r).toMatchObject({ ok: true, results: [] })
  })

  it('survives fn.toString() (the source twin inlines it)', () => {
    // eslint-disable-next-line no-new-func
    const rebuilt = new Function(`return (${createOfflineSearch.toString()})`)() as typeof createOfflineSearch
    const r = rebuilt().run({ q: 'flaky', tasks: TASKS, sessions: [], memory: [] })
    expect(r.ok && r.results[0]?.taskId).toBe('mtask-1')
  })
})
