/**
 * The picker re-lists an errored host when it comes back, and ONLY then.
 *
 * Regression (review of the host-problem slice): every listing error entered the
 * "errored" set, and every frame with `connected: true` re-listed it. A folder
 * the host cannot list (EACCES, kind 'listing') or a request that failed has a
 * host that IS connected, so each host:status frame (readiness answers, clock
 * ticks) sent one more list-dirs and flickered the note. Now only a connect
 * failure or a give-up waits, and it re-lists once, on the way from not
 * connected to connected (the frame at failure time counts).
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { parseHTML } from 'linkedom'
import { createElement, act } from '../../../web/node_modules/react/index.js'
import { createRoot } from '../../../web/node_modules/react-dom/client.js'
import type { HostStatus } from '../../../web/src/api/hosts'

const listDirsCached = vi.hoisted(() => vi.fn())
vi.mock('@/api/sessions', () => ({ listDirsCached }))
// The server's answer to a hydrate: the latest frame pushed (a hydrate replaces the store map).
const server = vi.hoisted(() => ({ latest: null as unknown }))
vi.mock('@/api/hosts', () => ({
  fetchHostStatus: async () => (server.latest ? [server.latest] : []),
  connectHost: async () => undefined, checkHostReadiness: async () => undefined,
}))
const ws = vi.hoisted(() => {
  const handlers = new Map<string, Set<(data: unknown) => void>>()
  return {
    wsClient: {
      state: 'connected',
      onEvent(name: string, cb: (data: unknown) => void) {
        if (!handlers.has(name)) handlers.set(name, new Set())
        handlers.get(name)!.add(cb)
      },
      offEvent(name: string, cb: (data: unknown) => void) { handlers.get(name)?.delete(cb) },
    },
    emit(name: string, data: unknown) { for (const cb of handlers.get(name) ?? []) cb(data) },
  }
})
vi.mock('@/api/ws', () => ({ wsClient: ws.wsClient }))

const { useLiveDirs, isConnectFailureState, shouldRelistAfterError, watchFrom } = await import('../../../web/src/components/sessions/path-selector/useLiveDirs')
const { __resetHostStatusForTests } = await import('../../../web/src/hooks/useHostStatus')

const T0 = 1_900_000_000_000
let at = T0
const frame = (o: Partial<HostStatus>): HostStatus => ({
  host: 'devbox', label: 'Dev box', hostname: 'devbox.example.com', connected: true, phase: 'connected', phaseLabel: '',
  steps: [], phaseElapsedMs: 0, connectElapsedMs: 0, at: ++at, ...o,
} as HostStatus)
const CONNECTED = { connected: true, phase: 'connected' } as const
const FAILED = { connected: false, phase: 'failed', kind: 'auth', error: 'Permission denied (publickey).' } as const

let root: { render: (n: unknown) => void; unmount: () => void } | null = null
let host: HTMLElement

beforeAll(() => {
  const dom = parseHTML('<!DOCTYPE html><html><head></head><body></body></html>')
  const g = globalThis as unknown as Record<string, unknown>
  g.window = dom.window
  g.document = dom.document
  g.IS_REACT_ACT_ENVIRONMENT = true
})
afterAll(() => { vi.useRealTimers() })

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(T0)
  listDirsCached.mockReset()
  server.latest = null
  __resetHostStatusForTests()
  host = (globalThis as unknown as { document: Document }).document.createElement('div')
})
afterEach(async () => {
  if (root) { await act(async () => { root!.unmount() }); root = null }
})

const HOSTS = [{ alias: 'devbox', label: 'Dev box', hostname: 'devbox.example.com' }]
function Probe() {
  useLiveDirs('/srv/data/', 'devbox', HOSTS as never)
  return null
}

async function mount(): Promise<void> {
  root = createRoot(host)
  await act(async () => { root!.render(createElement(Probe)) })
  await act(async () => { await vi.advanceTimersByTimeAsync(200) })
}
async function push(o: Partial<HostStatus>): Promise<void> {
  const f = frame(o)
  server.latest = f
  await act(async () => { ws.emit('host:status', f); await vi.advanceTimersByTimeAsync(0) })
}

describe('useLiveDirs: an errored host re-lists once, when it comes back', () => {
  it('a folder the host cannot list (EACCES): frames of the connected host send no more list-dirs', async () => {
    await push(CONNECTED)
    listDirsCached.mockResolvedValue({ dirs: [], parent: '/srv/data/', exists: true, hostError: { kind: 'listing', message: 'EACCES: permission denied', hint: 'Check the folder.' } })
    await mount()
    expect(listDirsCached).toHaveBeenCalledTimes(1)
    for (let i = 0; i < 4; i++) await push(CONNECTED)
    expect(listDirsCached).toHaveBeenCalledTimes(1)
  })

  it('a request that failed (network) is not a connect failure either', async () => {
    await push(CONNECTED)
    listDirsCached.mockRejectedValue(new TypeError('Failed to fetch'))
    await mount()
    expect(listDirsCached).toHaveBeenCalledTimes(1)
    for (let i = 0; i < 3; i++) await push(CONNECTED)
    expect(listDirsCached).toHaveBeenCalledTimes(1)
  })

  it('a connect failure re-lists on the first connected frame after it, and only once', async () => {
    await push(FAILED)
    listDirsCached.mockResolvedValueOnce({ dirs: [], parent: '', exists: true, hostError: { kind: 'auth', message: 'Permission denied (publickey).', hint: 'Check the key.' } })
    await mount()
    expect(listDirsCached).toHaveBeenCalledTimes(1)
    await push(FAILED)
    expect(listDirsCached).toHaveBeenCalledTimes(1)
    listDirsCached.mockResolvedValue({ dirs: ['/srv/data/a'], parent: '/srv/data/', exists: true })
    await push(CONNECTED)
    expect(listDirsCached).toHaveBeenCalledTimes(2)
    await push(CONNECTED)
    await push(CONNECTED)
    expect(listDirsCached).toHaveBeenCalledTimes(2)
  })

  it('a connect failure reported while the store still says connected waits for a real down-then-up', async () => {
    await push(CONNECTED)
    listDirsCached.mockResolvedValueOnce({ dirs: [], parent: '', exists: true, hostError: { kind: 'timeout', message: 'timed out', hint: 'Check the VPN.' } })
    await mount()
    await push(CONNECTED)
    expect(listDirsCached).toHaveBeenCalledTimes(1)
    listDirsCached.mockResolvedValue({ dirs: ['/srv/data/a'], parent: '/srv/data/', exists: true })
    await push({ connected: false, phase: 'reconnecting' })
    await push(CONNECTED)
    expect(listDirsCached).toHaveBeenCalledTimes(2)
  })
})

describe('the rules, as pure functions', () => {
  it('only connect kinds and give-ups count as connect failures', () => {
    const err = (o: object) => ({ status: 'error' as const, parent: '', exists: true, dirs: [], ...o })
    expect(isConnectFailureState(err({ hostError: { kind: 'auth', message: '', hint: '' } }))).toBe(true)
    expect(isConnectFailureState(err({ giveUp: true, hostError: { kind: 'timeout', message: '', hint: '' } }))).toBe(true)
    expect(isConnectFailureState(err({ hostError: { kind: 'listing', message: '', hint: '' } }))).toBe(false)
    expect(isConnectFailureState(err({ hostError: { kind: 'ephemeral', message: '', hint: '' } }))).toBe(false)
    expect(isConnectFailureState(err({ error: 'Failed to fetch' }))).toBe(false)
    expect(isConnectFailureState({ status: 'done', parent: '', exists: true, dirs: [] })).toBe(false)
  })

  it('the watch re-lists on up only after a down', () => {
    const w = watchFrom({ connected: true })
    expect(shouldRelistAfterError(w, { connected: true })).toBe(false)
    expect(shouldRelistAfterError(w, { connected: false })).toBe(false)
    expect(shouldRelistAfterError(w, { connected: true })).toBe(true)
    expect(shouldRelistAfterError(watchFrom({ connected: false }), { connected: true })).toBe(true)
  })
})
