/**
 * A server event that lands while a list request is in flight outranks that list's
 * copy of the row when both carry the same updated_at. Many writes leave
 * updated_at alone (a read marker, user_status, result_report, a team stop), so the
 * event and a snapshot read before it carry one stamp, and the snapshot used to win:
 * a read ask came back as unread in a frame that never refetched (2026-11-07 review,
 * the extension's Tasks view kept it under Needs you). A row an optimistic write
 * replaced after the event still takes the snapshot's copy on a tie
 * (task-list-merge.test.ts, "accepts server corrections").
 * Real React mounts over linkedom (same technique as task-move-stale-list).
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { parseHTML } from 'linkedom'
import { createElement, act } from '../../web/node_modules/react/index.js'
import { createRoot } from '../../web/node_modules/react-dom/client.js'
import { mergeFetchedTasks } from '@/hooks/task-list-merge'

const ws = vi.hoisted(() => ({
  state: 'connected' as string,
  onConnectionChange: () => {},
  offConnectionChange: () => {},
}))
vi.mock('@/api/ws', () => ({ wsClient: ws }))
const events = vi.hoisted(() => ({ handlers: new Map<string, (data: unknown) => void>() }))
vi.mock('@/hooks/useWebSocket', () => ({
  useEvent: (name: string, fn: (data: unknown) => void) => { events.handlers.set(name, fn) },
}))
const logMock = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }))
vi.mock('@/utils/log', () => ({ log: logMock }))
vi.mock('@/api/test-run', () => ({ forThisWindow: <T,>(t: T) => t }))

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

let latest: ReturnType<typeof useTasks> | null = null
function Probe() {
  latest = useTasks()
  return null
}

const AT = '2026-11-06T00:00:00.000Z'
const row = (id: string, over: Partial<Row> = {}): Row => ({
  id, title: id.toUpperCase(), project: '', status: 'active', phase: 'NEED_ACTION', priority: 'none',
  created_at: AT, updated_at: AT, ...over,
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
  events.handlers.clear()
  api.rows = [row('ask', { unread: true }), row('other')]
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
  expect(latest!.tasks.map((t) => t.id)).toEqual(['ask', 'other'])
}

const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)) })
const ask = () => latest!.tasks.find((t) => t.id === 'ask')! as unknown as Row

describe('an event during an in-flight list request, with the same updated_at', () => {
  it('keeps the event row (a read marker another window wrote)', async () => {
    await mount()
    expect(ask().unread).toBe(true)
    const list = deferred<Row[]>()
    api.nextList = () => list.promise
    await act(async () => { latest!.refetch() })
    // Another window marked it read: the write leaves updated_at alone.
    await act(async () => { events.handlers.get('task:updated')!({ task: row('ask', { unread: false }) }) })
    expect(ask().unread).toBe(false)
    // The list was read before that write.
    await act(async () => { list.resolve([row('ask', { unread: true }), row('other')]) })
    await flush()
    expect(ask().unread).toBe(false)
  })

  it('an event before the first list answer, carrying the raw task, keeps what the list adds (its read marker)', async () => {
    const list = deferred<Row[]>()
    api.nextList = () => list.promise
    const host = doc.createElement('div')
    doc.body.appendChild(host)
    root = createRoot(host as unknown as Element) as unknown as typeof root
    await act(async () => { root!.render(createElement(Probe)) })
    // The user status sync writes the ask while the first list is on its way: its event has no read marker.
    const { unread: _drop, ...raw } = row('ask', { unread: true, user_status: { state: 'read' } })
    await act(async () => { events.handlers.get('task:updated')!({ task: raw }) })
    await act(async () => { list.resolve([row('ask', { unread: true }), row('other')]) })
    await flush()
    expect(ask().unread).toBe(true)
    expect(ask().user_status).toEqual({ state: 'read' })
  })

  it('still takes a later stamp from the list', async () => {
    await mount()
    const list = deferred<Row[]>()
    api.nextList = () => list.promise
    await act(async () => { latest!.refetch() })
    await act(async () => { events.handlers.get('task:updated')!({ task: row('ask', { unread: false }) }) })
    await act(async () => { list.resolve([row('ask', { unread: true, updated_at: '2026-11-06T00:00:01.000Z' }), row('other')]) })
    await flush()
    expect(ask().unread).toBe(true)
  })

  it('a list that left after the event is the server again', async () => {
    await mount()
    await act(async () => { events.handlers.get('task:updated')!({ task: row('ask', { unread: false }) }) })
    // A new answer of the server (unread again, a new answer arrived) with the same stamp.
    api.rows = [row('ask', { unread: true }), row('other')]
    await act(async () => { latest!.refetch() })
    await flush()
    expect(ask().unread).toBe(true)
  })
})

describe('mergeFetchedTasks on an equal stamp', () => {
  const base = row('a1', { unread: true }) as never
  it('what the row a server event left says wins', () => {
    const eventRow = { ...(base as object), unread: false } as never
    const out = mergeFetchedTasks([eventRow], [base], new Set(['a1']), new Map([['a1', eventRow]]))
    expect((out[0] as unknown as Row).unread).toBe(false)
  })
  it('a field the event row leaves out keeps the snapshot\'s value (an event carries the raw task)', () => {
    const { unread: _drop, ...raw } = base as unknown as Row
    const eventRow = { ...raw, title: 'Renamed' } as never
    const out = mergeFetchedTasks([eventRow], [base], new Set(['a1']), new Map([['a1', eventRow]]))
    expect((out[0] as unknown as Row).unread).toBe(true)
    expect((out[0] as unknown as Row).title).toBe('Renamed')
  })
  it('a row an optimistic write replaced since the event loses the tie', () => {
    const eventRow = { ...(base as object), unread: false } as never
    const optimistic = { ...(eventRow as object), title: 'optimistic' } as never
    const out = mergeFetchedTasks([optimistic], [base], new Set(['a1']), new Map([['a1', eventRow]]))
    expect(out[0]).toBe(base)
  })
})
