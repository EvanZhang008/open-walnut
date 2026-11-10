/**
 * A phase write for a task the board's list does not hold yet (a column's Complete on a slow
 * first load, TaskQuickActions) is held over the row when the list brings it (useTasks
 * holdOptimistic with the caller's `row`). Every later write for that task builds on the held
 * row, so an Undo made before the list came replaces the held COMPLETE: the list answer read
 * before both writes must not put COMPLETE back on screen while the server holds the old phase
 * (2026-11-10 review: the Undo's setPhase had no row, held nothing and cleared nothing, and the
 * write's own echo is eaten by the echo guard).
 * Real React mounts over linkedom (same technique as task-move-stale-list.test.ts).
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { parseHTML } from 'linkedom'
import { createElement, act } from '../../web/node_modules/react/index.js'
import { createRoot } from '../../web/node_modules/react-dom/client.js'
import type { Task } from '../../src/core/types'

const ws = vi.hoisted(() => ({
  state: 'connected' as string,
  onConnectionChange: () => {},
  offConnectionChange: () => {},
}))
vi.mock('@/api/ws', () => ({ wsClient: ws }))
vi.mock('@/hooks/useWebSocket', () => ({ useEvent: () => {} }))
const logMock = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }))
vi.mock('@/utils/log', () => ({ log: logMock }))

type Row = Record<string, unknown> & { id: string }
const api = vi.hoisted(() => ({
  rows: [] as Row[],
  nextList: null as null | (() => Promise<Row[]>),
  fetchTaskList: vi.fn(async (opts?: { onDispatch?: () => void }) => {
    opts?.onDispatch?.()
    const take = api.nextList
    api.nextList = null
    return { tasks: take ? await take() : api.rows.map((r) => ({ ...r })), completedHidden: 0 }
  }),
  RECENT_COMPLETED_DAYS: 7,
  fetchTasksByIds: vi.fn(async () => []),
  fetchTaskGroups: vi.fn(async () => []),
  updateTask: vi.fn(),
  reorderTasks: vi.fn(async () => {}),
}))
vi.mock('@/api/tasks', () => api)

const { useTasks } = await import('@/hooks/useTasks')

type Hook = ReturnType<typeof useTasks>
let latest: Hook | null = null
function Probe() {
  latest = useTasks()
  return null
}

const row = (id: string, phase: string): Row => ({
  id, title: id.toUpperCase(), project: 'P', status: phase === 'COMPLETE' ? 'done' : 'in_progress', phase, priority: 'none',
  created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z',
})

function deferred<T>() {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((r) => { resolve = r })
  return { promise, resolve }
}

let doc: Document
let root: { render: (el: unknown) => void; unmount: () => void } | null = null

beforeAll(() => {
  const dom = parseHTML('<!DOCTYPE html><html><head></head><body></body></html>')
  const g = globalThis as unknown as Record<string, unknown>
  g.window = dom.window
  g.document = dom.document
  g.IS_REACT_ACT_ENVIRONMENT = true
  doc = dom.document as unknown as Document
})

beforeEach(() => {
  vi.clearAllMocks()
  // The first list answer does not hold the column's task yet.
  api.rows = [row('other', 'TODO')]
  api.nextList = null
  api.updateTask.mockReturnValue(new Promise(() => {}))
})

afterEach(async () => {
  await act(async () => { root?.unmount() })
  root = null
  latest = null
})

async function mount() {
  const host = doc.createElement('div')
  doc.body.appendChild(host)
  root = createRoot(host as unknown as Element) as unknown as typeof root
  await act(async () => { root!.render(createElement(Probe)) })
  await act(async () => { await Promise.resolve() })
  expect(latest!.tasks.map((t) => t.id)).toEqual(['other'])
}

const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)) })
const phaseOfX = () => latest!.tasks.find((t) => t.id === 'x')?.phase

describe('a phase write for a row the list does not hold yet', () => {
  it('Complete is held over the row a list read before it brings', async () => {
    await mount()
    const list = deferred<Row[]>()
    api.nextList = () => list.promise
    await act(async () => { latest!.refetch() })
    await act(async () => { void latest!.setPhase('x', 'COMPLETE', { row: row('x', 'IN_PROGRESS') as unknown as Task }) })
    await act(async () => { list.resolve([row('other', 'TODO'), row('x', 'IN_PROGRESS')]) })
    await flush()
    expect(phaseOfX()).toBe('COMPLETE')
  })

  it('an Undo before the list came replaces the held COMPLETE', async () => {
    await mount()
    const list = deferred<Row[]>()
    api.nextList = () => list.promise
    await act(async () => { latest!.refetch() })
    await act(async () => { void latest!.setPhase('x', 'COMPLETE', { row: row('x', 'IN_PROGRESS') as unknown as Task }) })
    // The Undo's write names no row (TaskUndoContext restorePhase).
    await act(async () => { void latest!.setPhase('x', 'IN_PROGRESS') })
    await act(async () => { list.resolve([row('other', 'TODO'), row('x', 'IN_PROGRESS')]) })
    await flush()
    expect(phaseOfX()).toBe('IN_PROGRESS')
    expect(latest!.tasks.find((t) => t.id === 'x')?.status).toBe('in_progress')
  })
})
