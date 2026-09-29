/**
 * A failed mutation puts server truth back for the rows it touched, not the
 * whole list. The old `onOpError` refetched all ~6.5k tasks (a 5MB response,
 * parsed on the browser's main thread) after EVERY failed request, and a request
 * that kept failing kept the list fetch repeating with it: eight full fetches in
 * 30s from two windows during the 2026-09-28 dictation incident.
 *
 * Pinned here:
 *   1. a failed single-row update re-reads that one row and no list;
 *   2. a failed delete brings the optimistically removed row back from the server;
 *   3. a row the server no longer has leaves the list;
 *   4. when the row re-read itself fails, the list refetch is the fallback.
 * Real React mounts over linkedom (same technique as tasks-connect-refetch-skip).
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

const api = vi.hoisted(() => ({
  fetchTasks: vi.fn(),
  fetchTasksByIds: vi.fn(),
  fetchTaskGroups: vi.fn(async () => []),
  updateTask: vi.fn(),
  deleteTask: vi.fn(),
}))
vi.mock('@/api/tasks', () => api)

const { useTasks } = await import('@/hooks/useTasks')
const { ApiError } = await import('@/api/client')

type Hook = ReturnType<typeof useTasks>
let latest: Hook | null = null
function Probe() {
  latest = useTasks()
  return null
}

const row = (id: string, title: string) => ({
  id, title, project: 'P', status: 'active', phase: 'TODO', priority: 'none',
  created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z',
})

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
  api.fetchTasks.mockResolvedValue([row('a', 'A'), row('b', 'B'), row('c', 'C')])
  api.fetchTaskGroups.mockResolvedValue([])
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

const titles = () => Object.fromEntries(latest!.tasks.map((t) => [t.id, t.title]))

describe('failed mutations re-read their own rows', () => {
  it('a rejected update re-reads that row only and never the list', async () => {
    await mount()
    const listFetches = api.fetchTasks.mock.calls.length
    api.updateTask.mockRejectedValue(new ApiError(400, 'nope'))
    api.fetchTasksByIds.mockResolvedValue([row('a', 'A')])

    // The rejection settles inside the same act, so the row is already put
    // back by the time we look; the optimistic flip is covered by the store tests.
    await act(async () => { latest!.update('a', { title: 'A2' }) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })

    expect(api.fetchTasksByIds).toHaveBeenCalledWith(['a'])
    expect(api.fetchTasks.mock.calls.length).toBe(listFetches)
    expect(titles()).toEqual({ a: 'A', b: 'B', c: 'C' })
    expect(latest!.operationError).toBe('nope')
  })

  it('a rejected delete brings the row back from the server', async () => {
    await mount()
    api.deleteTask.mockRejectedValue(new ApiError(409, 'has a live session'))
    api.fetchTasksByIds.mockResolvedValue([row('b', 'B')])

    let ok: boolean | undefined
    await act(async () => { ok = await latest!.deleteTask('b') })
    expect(ok).toBe(false)
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    expect(api.fetchTasksByIds).toHaveBeenCalledWith(['b'])
    expect(latest!.tasks.map((t) => t.id).sort()).toEqual(['a', 'b', 'c'])
  })

  it('a row the server no longer has leaves the list on resync', async () => {
    await mount()
    api.updateTask.mockRejectedValue(new ApiError(404, 'gone'))
    api.fetchTasksByIds.mockResolvedValue([])

    await act(async () => { latest!.update('c', { title: 'C2' }) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    expect(latest!.tasks.map((t) => t.id)).toEqual(['a', 'b'])
  })

  it('falls back to a list refetch when the row re-read fails', async () => {
    await mount()
    const listFetches = api.fetchTasks.mock.calls.length
    api.updateTask.mockRejectedValue(new ApiError(400, 'nope'))
    api.fetchTasksByIds.mockRejectedValue(new Error('network'))

    await act(async () => { latest!.update('a', { title: 'A2' }) })
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    expect(api.fetchTasks.mock.calls.length).toBe(listFetches + 1)
  })
})
