/**
 * `useTasks` refetches the task list 1s after the socket connects, because a list
 * read that the server answered BEFORE this socket joined the broadcast set can
 * be missing a commit whose event this socket never got. That refetch threw away
 * a perfectly good answer on every reload: the first list request sat ~2s in the
 * browser's connection queue, left well after the socket was up, and the
 * post-connect refetch bumped the generation and discarded it, so the list
 * painted at 10.8s instead of ~5.5s (2026-09-23).
 *
 * The rule pinned here: refetch after a connect UNLESS the current list request
 * left the admission queue after that connect (or has not left it yet). Cases:
 *   1. dispatched after the connect → no second list request;
 *   2. still queued when the debounce fires → no second list request;
 *   3. dispatched before the connect → refetch (the old reason still holds);
 *   4. a reconnect later → refetch;
 *   5. the list request failed (for good, or waiting to retry) → the connect
 *      fetches again at once.
 * The folder registry is refreshed on every connect regardless.
 *
 * Real React mounts over linkedom, the same technique as
 * tests/web/use-integrations-cache.test.ts.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { parseHTML } from 'linkedom'
import { createElement, act } from '../../web/node_modules/react/index.js'
import { createRoot } from '../../web/node_modules/react-dom/client.js'

const ws = vi.hoisted(() => {
  const listeners = new Set<(s: string) => void>()
  return {
    state: 'connecting' as string,
    onConnectionChange: (fn: (s: string) => void) => { listeners.add(fn) },
    offConnectionChange: (fn: (s: string) => void) => { listeners.delete(fn) },
    emit(s: string) { this.state = s; for (const l of [...listeners]) l(s) },
    reset() { listeners.clear(); this.state = 'connecting' },
  }
})
vi.mock('@/api/ws', () => ({ wsClient: ws }))
vi.mock('@/hooks/useWebSocket', () => ({ useEvent: () => {} }))
const logMock = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }))
vi.mock('@/utils/log', () => ({ log: logMock }))

interface ListCall { onDispatch?: () => void; resolve: (t: unknown[]) => void; reject: (e: unknown) => void }
const listCalls: ListCall[] = []
const api = vi.hoisted(() => ({
  fetchTasks: vi.fn(),
  fetchTaskGroups: vi.fn(async () => []),
}))
vi.mock('@/api/tasks', () => api)

const { useTasks } = await import('@/hooks/useTasks')
const { ApiError } = await import('@/api/client')

function Probe() {
  useTasks()
  return null
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
  // Every case states its own clock, socket and request log.
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })
  vi.clearAllMocks()
  ws.reset()
  listCalls.length = 0
  api.fetchTasks.mockImplementation((opts?: { onDispatch?: () => void }) =>
    new Promise((resolve, reject) => { listCalls.push({ onDispatch: opts?.onDispatch, resolve, reject }) }))
  api.fetchTaskGroups.mockResolvedValue([])
})

afterEach(async () => {
  await act(async () => { root?.unmount() })
  root = null
  vi.useRealTimers()
})

async function mount() {
  const host = doc.createElement('div')
  doc.body.appendChild(host)
  root = createRoot(host as unknown as Element) as unknown as typeof root
  await act(async () => { root!.render(createElement(Probe)) })
}

async function advance(ms: number) {
  await act(async () => { vi.advanceTimersByTime(ms) })
}

async function connect() {
  await act(async () => { ws.emit('connected') })
}

async function settle(call: ListCall) {
  await act(async () => { call.resolve([]) })
}

describe('post-connect task list refetch', () => {
  it('skips the refetch when the list request left the queue after the connect', async () => {
    // Reload shape: the socket is up in ~0.1s, the list request gets a slot a
    // little later, before the 1s post-connect debounce fires.
    await mount()
    expect(listCalls).toHaveLength(1)
    const groupsBefore = api.fetchTaskGroups.mock.calls.length
    await advance(100)
    await connect()
    await advance(500)
    listCalls[0].onDispatch?.()

    await advance(1_000)
    await settle(listCalls[0])
    expect(listCalls).toHaveLength(1)
    // The folder registry still refreshes on connect.
    expect(api.fetchTaskGroups.mock.calls.length).toBeGreaterThan(groupsBefore)
    expect(logMock.info).toHaveBeenCalledWith('tasks',
      'ws connected → list request left after the connect; no refetch', expect.objectContaining({ queued: false }))
  })

  it('skips the refetch while the list request is still waiting in the queue', async () => {
    // The list request waits in the queue for longer than the debounce.
    await mount()
    await connect()
    await advance(2_000)
    expect(listCalls).toHaveLength(1)
    expect(logMock.info).toHaveBeenCalledWith('tasks',
      'ws connected → list request left after the connect; no refetch', expect.objectContaining({ queued: true }))
    listCalls[0].onDispatch?.()
    await settle(listCalls[0])
    expect(listCalls).toHaveLength(1)
  })

  it('refetches when the list request left BEFORE the socket connected', async () => {
    await mount()
    listCalls[0].onDispatch?.()
    await advance(50)
    await connect()
    await advance(1_000)
    expect(listCalls).toHaveLength(2)
  })

  it('refetches after a later reconnect', async () => {
    await mount()
    await connect()
    listCalls[0].onDispatch?.()
    await advance(1_000)
    await settle(listCalls[0])
    expect(listCalls).toHaveLength(1)

    // Socket drops and comes back: events in the gap are lost, so fetch again.
    await act(async () => { ws.emit('disconnected') })
    await advance(5_000)
    await connect()
    await advance(1_000)
    expect(listCalls).toHaveLength(2)
  })

  it('fetches again on connect when the list request failed for good', async () => {
    await mount()
    listCalls[0].onDispatch?.()
    // A 4xx is not retried: the list is in its error state.
    await act(async () => { listCalls[0].reject(new ApiError(400, 'bad request')) })
    await connect()
    await advance(1_000)
    expect(listCalls).toHaveLength(2)
  })

  it('fetches at once on connect when the list request failed and is only waiting to retry', async () => {
    await mount()
    listCalls[0].onDispatch?.()
    await advance(10)
    await connect()
    // A retryable failure AFTER the connect: the retry is 2s away, but nothing
    // landed, so the debounce must not count that request as covering the connect.
    await act(async () => { listCalls[0].reject(new DOMException('queue timeout', 'TimeoutError')) })
    await advance(1_000)
    expect(listCalls).toHaveLength(2)
    // The superseded retry never fires on top of the new read.
    await advance(5_000)
    expect(listCalls).toHaveLength(2)
  })

  it('a hook mounted with the socket already up does not refetch its own first read', async () => {
    ws.state = 'connected'
    await mount()
    listCalls[0].onDispatch?.()
    await advance(1_000)
    expect(listCalls).toHaveLength(1)
  })
})
