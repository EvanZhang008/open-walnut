/**
 * useIsCloudReplica keeps only a REAL answer. A failed /api/config used to
 * resolve `false` through the facts fallback and stay cached for the page's
 * life, so a replica page that booted during a stall kept showing Retry
 * buttons that could never work. Now the ask retries on the registry
 * schedule, and asks again when the socket comes back.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { parseHTML } from 'linkedom'
import { createElement, act } from '../../web/node_modules/react/index.js'
import { createRoot } from '../../web/node_modules/react-dom/client.js'

const fetchIsCloudReplica = vi.hoisted(() => vi.fn<(opts?: { strict?: boolean }) => Promise<boolean>>())
vi.mock('@/api/config', () => ({ fetchIsCloudReplica }))
vi.mock('@/utils/log', () => ({ log: { info: () => {}, warn: () => {}, error: () => {} } }))
const ws = vi.hoisted(() => {
  const handlers = new Map<string, Set<() => void>>()
  return {
    wsClient: { onEvent(name: string, cb: () => void) { if (!handlers.has(name)) handlers.set(name, new Set()); handlers.get(name)!.add(cb) } },
    emit(name: string) { for (const cb of handlers.get(name) ?? []) cb() },
    clear() { handlers.clear() },
  }
})
vi.mock('@/api/ws', () => ({ wsClient: ws.wsClient }))

const { useIsCloudReplica, __resetCloudReplicaForTests } = await import('../../web/src/hooks/useIsCloudReplica')

let root: { render: (n: unknown) => void; unmount: () => void } | null = null
let seen: boolean[] = []
function Probe() { seen.push(useIsCloudReplica()); return null }

beforeAll(() => {
  const dom = parseHTML('<!DOCTYPE html><html><head></head><body></body></html>')
  const g = globalThis as unknown as Record<string, unknown>
  g.window = dom.window
  g.document = dom.document
  g.IS_REACT_ACT_ENVIRONMENT = true
})
beforeEach(() => {
  vi.useFakeTimers()
  fetchIsCloudReplica.mockReset()
  __resetCloudReplicaForTests()
  ws.clear()
  seen = []
})
afterEach(async () => {
  if (root) { await act(async () => { root!.unmount() }); root = null }
  vi.useRealTimers()
})

async function mount(): Promise<void> {
  const el = (globalThis as unknown as { document: Document }).document.createElement('div')
  root = createRoot(el)
  await act(async () => { root!.render(createElement(Probe)) })
}
const last = () => seen[seen.length - 1]

describe('useIsCloudReplica', () => {
  it('asks strictly, and a failed ask is retried instead of cached as false', async () => {
    fetchIsCloudReplica.mockRejectedValueOnce(new TypeError('Failed to fetch')).mockResolvedValue(true)
    await mount()
    expect(fetchIsCloudReplica).toHaveBeenCalledWith({ strict: true })
    expect(last()).toBe(false)
    await act(async () => { await vi.advanceTimersByTimeAsync(2_100) })
    expect(fetchIsCloudReplica).toHaveBeenCalledTimes(2)
    expect(last()).toBe(true)
  })

  it('a spent retry schedule leaves the answer unknown; the socket coming back asks again', async () => {
    fetchIsCloudReplica.mockRejectedValue(new TypeError('Failed to fetch'))
    await mount()
    await act(async () => { await vi.advanceTimersByTimeAsync(40_000) })
    const spent = fetchIsCloudReplica.mock.calls.length
    expect(spent).toBe(5)
    expect(last()).toBe(false)
    fetchIsCloudReplica.mockResolvedValue(true)
    await act(async () => { ws.emit('_ws:reconnected'); await vi.advanceTimersByTimeAsync(0) })
    expect(fetchIsCloudReplica).toHaveBeenCalledTimes(spent + 1)
    expect(last()).toBe(true)
    // A known answer is kept: another reconnect does not ask again.
    await act(async () => { ws.emit('_ws:reconnected'); await vi.advanceTimersByTimeAsync(0) })
    expect(fetchIsCloudReplica).toHaveBeenCalledTimes(spent + 1)
  })

  it('every mount shares one answer (one ask for the page)', async () => {
    fetchIsCloudReplica.mockResolvedValue(false)
    await mount()
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    await act(async () => { root!.unmount() })
    root = null
    await mount()
    expect(fetchIsCloudReplica).toHaveBeenCalledTimes(1)
    expect(last()).toBe(false)
  })
})
