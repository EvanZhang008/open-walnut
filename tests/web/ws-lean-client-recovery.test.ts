import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LEAN_SIGNATURE } from '../../src/lib/ws-lean-protocol.js'

interface Socket {
  url: string
  readyState: number
  onopen: (() => void) | null
  onclose: ((event: { code: number; reason: string }) => void) | null
  onmessage: ((event: { data: string }) => void) | null
  close: ReturnType<typeof vi.fn>
}
let sockets: Socket[]
let dispose: (() => void) | undefined

beforeEach(() => {
  vi.resetModules()
  vi.useFakeTimers()
  sockets = []
  const Fake = function (_url: string) {
    const socket: Socket = { url: _url, readyState: 1, onopen: null, onclose: null, onmessage: null, close: vi.fn() }
    sockets.push(socket)
    return socket
  } as unknown as typeof WebSocket
  ;(Fake as unknown as { OPEN: number }).OPEN = 1
  vi.stubGlobal('WebSocket', Fake)
  vi.stubGlobal('window', { location: { protocol: 'http:', host: 'localhost' } })
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {}, removeItem: () => {} })
})
afterEach(() => {
  dispose?.()
  dispose = undefined
  vi.clearAllTimers()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

function event(socket: Socket, data: unknown) {
  socket.onmessage?.({ data: JSON.stringify({ type: 'event', name: 'task:updated', data, seq: 1 }) })
}
const first = { task: { id: 'x', note: 'original note' }, lean: { v: 1, kind: 'task', omit: [], keep: ['note'] } }
const omitted = { task: { id: 'x', note: null }, lean: { v: 1, kind: 'task', omit: ['note'], keep: [] } }

async function client() {
  const { wsClient } = await import('@/api/ws')
  dispose = () => wsClient.disconnect()
  wsClient.connect()
  sockets[0].onopen?.()
  return wsClient
}

describe('lean socket recovery at the client boundary', () => {
  it('a missing baseline reconnects, resets caches and receives a fresh baseline', async () => {
    const wsClient = await client()
    const seen: unknown[] = []
    wsClient.onEvent('task:updated', d => seen.push(d))
    const old = sockets[0]
    event(old, omitted)
    expect(old.close).toHaveBeenCalledWith(4000, 'lean_resync')
    expect(seen).toEqual([])
    old.onclose?.({ code: 4000, reason: 'lean_resync' })
    await vi.advanceTimersByTimeAsync(1100)
    const next = sockets[1]
    expect(next.url).toContain(`lean=${LEAN_SIGNATURE}`)
    next.onopen?.()
    event(next, first)
    event(next, omitted)
    expect(seen).toEqual([{ task: first.task }, { task: first.task }])
    // A late event from the retired socket cannot overwrite the new socket baseline.
    event(old, { task: { id: 'x', note: 'old socket' }, lean: { v: 1, kind: 'task', omit: [], keep: ['note'] } })
    event(next, omitted)
    expect(seen).toHaveLength(3)
    expect(seen[2]).toEqual({ task: first.task })
  })

  it('three failed baselines in five minutes fall back to whole frames', async () => {
    const wsClient = await client()
    const seen: unknown[] = []
    wsClient.onEvent('task:updated', d => seen.push(d))
    for (let i = 0; i < 3; i++) {
      event(sockets[i], omitted)
      sockets[i].onclose?.({ code: 4000, reason: 'lean_resync' })
      await vi.advanceTimersByTimeAsync(1100)
      sockets[i + 1].onopen?.()
    }
    expect(sockets[3].url).toBe('ws://localhost/ws')
    event(sockets[3], { task: { id: 'x', note: 'whole frame' } })
    expect(seen).toEqual([{ task: { id: 'x', note: 'whole frame' } }])
  })

  it('a whole null payload remains valid instead of causing a false resync', async () => {
    const wsClient = await client()
    const seen: unknown[] = []
    wsClient.onEvent('task:updated', d => seen.push(d))
    event(sockets[0], null)
    expect(seen).toEqual([null])
    expect(sockets[0].close).not.toHaveBeenCalled()
  })

  it('server restart resets the old baseline rather than reusing its omitted fields', async () => {
    const wsClient = await client()
    const seen: unknown[] = []
    wsClient.onEvent('task:updated', d => seen.push(d))
    event(sockets[0], first)
    sockets[0].onclose?.({ code: 1012, reason: 'restart' })
    await vi.advanceTimersByTimeAsync(1100)
    sockets[1].onopen?.()
    event(sockets[1], omitted)
    expect(sockets[1].close).toHaveBeenCalledWith(4000, 'lean_resync')
    expect(seen).toHaveLength(1)
  })
})
