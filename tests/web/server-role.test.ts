/**
 * The page's server role (web/src/api/server-role.ts, hooks/useServerRole.ts).
 *
 * Only a REAL answer is kept: a failed /api/config used to stay cached as "the Mac"
 * for the page's life, so a replica page that booted during a stall kept showing
 * Retry buttons that could never work. The answer is read again when the server
 * under the page may have changed: a host replica hands the page over with a
 * 4001/4002 close (the socket reconnects) and the Mac's presence flips, with no reload.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { parseHTML } from 'linkedom'
import { createElement, act } from '../../web/node_modules/react/index.js'
import { createRoot } from '../../web/node_modules/react-dom/client.js'

type Facts = { replica: boolean; capabilities: readonly string[] }
const fetchServerRole = vi.hoisted(() => vi.fn<(opts?: { strict?: boolean; fresh?: boolean }) => Promise<Facts>>())
vi.mock('@/api/config', () => ({ fetchServerRole }))
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
const presence = vi.hoisted(() => {
  const listeners = new Set<() => void>()
  let answers = true
  return {
    getLeaderPresence: () => ({ answers }),
    subscribeLeaderPresence: (cb: () => void) => { listeners.add(cb); return () => { listeners.delete(cb) } },
    set(a: boolean) { answers = a; for (const l of listeners) l() },
    reset() { answers = true; listeners.clear() },
  }
})
vi.mock('@/api/leader-presence', () => ({ getLeaderPresence: presence.getLeaderPresence, subscribeLeaderPresence: presence.subscribeLeaderPresence }))

const { __resetServerRoleForTests } = await import('../../web/src/api/server-role')
const { useIsReplicaServer, useServerCapability, useSettledServerRole } = await import('../../web/src/hooks/useServerRole')

const REPLICA: Facts = { replica: true, capabilities: [] }
const COMPANION: Facts = { replica: true, capabilities: ['public-door', 'bridge-door', 'cloud-exec', 'backup-leader'] }
const MAC: Facts = { replica: false, capabilities: [] }

let root: { render: (n: unknown) => void; unmount: () => void } | null = null
let seen: Array<{ replica: boolean; publicDoor: boolean; settled: Facts | null }> = []
function Probe() {
  seen.push({ replica: useIsReplicaServer(), publicDoor: useServerCapability('public-door'), settled: useSettledServerRole() })
  return null
}

beforeAll(() => {
  const dom = parseHTML('<!DOCTYPE html><html><head></head><body></body></html>')
  const g = globalThis as unknown as Record<string, unknown>
  g.window = dom.window
  g.document = dom.document
  g.IS_REACT_ACT_ENVIRONMENT = true
})
beforeEach(() => {
  vi.useFakeTimers()
  fetchServerRole.mockReset()
  __resetServerRoleForTests()
  ws.clear()
  presence.reset()
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
const flush = () => act(async () => { await vi.advanceTimersByTimeAsync(0) })

describe('server role', () => {
  it('asks strictly, and a failed ask is retried instead of kept as the Mac', async () => {
    fetchServerRole.mockRejectedValueOnce(new TypeError('Failed to fetch')).mockResolvedValue(REPLICA)
    await mount()
    expect(fetchServerRole).toHaveBeenCalledWith({ strict: true })
    expect(last()).toEqual({ replica: false, publicDoor: false, settled: null })
    await act(async () => { await vi.advanceTimersByTimeAsync(2_100) })
    expect(fetchServerRole).toHaveBeenCalledTimes(2)
    expect(last()).toEqual({ replica: true, publicDoor: false, settled: REPLICA })
  })

  it('a spent retry schedule reads as the Mac (settled); the socket coming back asks again', async () => {
    fetchServerRole.mockRejectedValue(new TypeError('Failed to fetch'))
    await mount()
    await act(async () => { await vi.advanceTimersByTimeAsync(40_000) })
    const spent = fetchServerRole.mock.calls.length
    expect(spent).toBe(5)
    expect(last()).toEqual({ replica: false, publicDoor: false, settled: MAC })
    fetchServerRole.mockResolvedValue(COMPANION)
    await act(async () => { ws.emit('_ws:reconnected'); await vi.advanceTimersByTimeAsync(0) })
    expect(fetchServerRole).toHaveBeenCalledTimes(spent + 1)
    expect(last()).toEqual({ replica: true, publicDoor: true, settled: COMPANION })
  })

  it('a host replica handing the page over (reconnect) flips the answer with no reload', async () => {
    fetchServerRole.mockResolvedValue(MAC)
    await mount()
    await flush()
    expect(last().replica).toBe(false)
    // 4001: the Mac went quiet, the replica answers this page itself now.
    fetchServerRole.mockResolvedValue(REPLICA)
    await act(async () => { ws.emit('_ws:reconnected'); await vi.advanceTimersByTimeAsync(0) })
    expect(last().replica).toBe(true)
    // 4002: the Mac is back, the replica forwards /api/config to it again.
    fetchServerRole.mockResolvedValue(MAC)
    await act(async () => { ws.emit('_ws:reconnected'); await vi.advanceTimersByTimeAsync(0) })
    expect(last().replica).toBe(false)
  })

  it('a change of the Mac\'s presence re-reads a fresh answer', async () => {
    fetchServerRole.mockResolvedValue(MAC)
    await mount()
    await flush()
    fetchServerRole.mockResolvedValue(REPLICA)
    await act(async () => { presence.set(false); await vi.advanceTimersByTimeAsync(0) })
    expect(fetchServerRole).toHaveBeenLastCalledWith({ strict: true, fresh: true })
    expect(last().replica).toBe(true)
    // The same presence again is no change: no read.
    const calls = fetchServerRole.mock.calls.length
    await act(async () => { presence.set(false); await vi.advanceTimersByTimeAsync(0) })
    expect(fetchServerRole).toHaveBeenCalledTimes(calls)
  })

  it('a failed re-read keeps the last answer', async () => {
    fetchServerRole.mockResolvedValue(REPLICA)
    await mount()
    await flush()
    fetchServerRole.mockRejectedValue(new TypeError('Failed to fetch'))
    await act(async () => { ws.emit('_ws:reconnected'); await vi.advanceTimersByTimeAsync(0) })
    expect(last().replica).toBe(true)
  })

  it('an older answer that lands after a newer one is dropped', async () => {
    fetchServerRole.mockResolvedValue(MAC)
    await mount()
    await flush()
    let slow: (f: Facts) => void = () => {}
    fetchServerRole.mockImplementationOnce(() => new Promise<Facts>((r) => { slow = r }))
    fetchServerRole.mockResolvedValueOnce(REPLICA)
    await act(async () => { ws.emit('_ws:reconnected'); ws.emit('_ws:reconnected'); await vi.advanceTimersByTimeAsync(0) })
    expect(last().replica).toBe(true)
    await act(async () => { slow(MAC); await vi.advanceTimersByTimeAsync(0) })
    expect(last().replica).toBe(true)
  })

  it('every mount shares one answer (one ask for the page)', async () => {
    fetchServerRole.mockResolvedValue(MAC)
    await mount()
    await flush()
    await act(async () => { root!.unmount() })
    root = null
    await mount()
    expect(fetchServerRole).toHaveBeenCalledTimes(1)
    expect(last().replica).toBe(false)
  })
})
