/**
 * A task moved to another project stays there when a list answer read before the
 * move lands after it. The move's own WS echo is eaten by the echo guard, so a
 * stale answer used to draw the task back in its old project until some later
 * refetch (a 2026-10-01 WebKit run of folder-cross-project-drop caught it: the
 * server had the move, the list still showed the row in Inbox).
 *
 * Pinned here:
 *   1. a stale answer while the move is unanswered keeps the move (and leaves the folder);
 *   2. a stale answer after the move was written keeps it too (it left before the move);
 *   3. an answer that left after the move was written is server truth again.
 * Real React mounts over linkedom (same technique as tasks-failed-mutation-resync).
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { parseHTML } from 'linkedom'
import { createElement, act } from '../../web/node_modules/react/index.js'
import { createRoot } from '../../web/node_modules/react-dom/client.js'

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
  // Each list request is answered by `nextList` (set per test), else by `rows`.
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

const row = (id: string, project: string, group_id?: string): Row => ({
  id, title: id.toUpperCase(), project, ...(group_id ? { group_id } : {}), status: 'active', phase: 'TODO', priority: 'none',
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
  api.rows = [row('a', '', 'g1'), row('b', ''), row('c', 'Q')]
  api.nextList = null
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
  expect(latest!.tasks.map((t) => t.id)).toEqual(['a', 'b', 'c'])
}

const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)) })
const taskA = () => latest!.tasks.find((t) => t.id === 'a')!

describe('a moved task is not drawn back by a list answer read before the move', () => {
  it('keeps the move, out of its folder, while the move is unanswered', async () => {
    await mount()
    const list = deferred<Row[]>()
    api.nextList = () => list.promise
    const write = deferred<unknown>()
    api.updateTask.mockReturnValue(write.promise)

    await act(async () => { latest!.refetch() })
    await act(async () => { latest!.moveTask('a', 'Q') })
    expect(taskA()).toMatchObject({ project: 'Q', group_id: undefined })

    // The list was read before the move reached the server.
    await act(async () => { list.resolve([row('a', '', 'g1'), row('b', ''), row('c', 'Q')]) })
    await flush()
    expect(taskA().project).toBe('Q')
    expect(taskA().group_id).toBeUndefined()

    api.rows = [row('a', 'Q'), row('b', ''), row('c', 'Q')]
    await act(async () => { write.resolve({}) })
    await flush()
    expect(api.reorderTasks).toHaveBeenCalledWith('Q', expect.arrayContaining(['a', 'c']))
    expect(taskA().project).toBe('Q')
  })

  it('keeps it when the move was written before the stale answer landed', async () => {
    await mount()
    const list = deferred<Row[]>()
    api.nextList = () => list.promise
    api.updateTask.mockResolvedValue({})

    await act(async () => { latest!.refetch() })
    await act(async () => { latest!.moveTask('a', 'Q') })
    await flush()
    await act(async () => { list.resolve([row('a', '', 'g1'), row('b', ''), row('c', 'Q')]) })
    await flush()
    expect(taskA()).toMatchObject({ project: 'Q', group_id: undefined })
  })

  it('takes the server back as truth once a list request leaves after the write', async () => {
    await mount()
    api.updateTask.mockResolvedValue({})
    await act(async () => { latest!.moveTask('a', 'Q') })
    await flush()
    // Something else put it back server-side; a fresh list says so.
    api.rows = [row('a', '', 'g1'), row('b', ''), row('c', 'Q')]
    await act(async () => { latest!.refetch() })
    await flush()
    expect(taskA()).toMatchObject({ project: '', group_id: 'g1' })
  })
})
