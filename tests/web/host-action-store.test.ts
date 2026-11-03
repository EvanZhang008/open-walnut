/**
 * One attempt per host, shared by every surface (banner placement slice,
 * spec 2.1; C48): two readers see the same pending, a second run while one is
 * in flight sends no second request, and the 'same result' receipt lasts 5s.
 * The host status store is a small fake here: the store only needs a status
 * read, a write that notifies, and a subscription.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { HostStatus } from '../../web/src/api/hosts'

let clock = 1_000_000
const statuses = new Map<string, HostStatus>()
const statusListeners = new Set<() => void>()
vi.mock('@/hooks/useHostStatus', () => ({
  serverNow: () => clock,
  getHostStatus: (a: string) => statuses.get(a),
  seedHostStatus: (s: HostStatus | null | undefined) => { if (s) { statuses.set(s.host, s); for (const l of statusListeners) l() } },
  subscribeHostStatus: (cb: () => void) => { statusListeners.add(cb); return () => { statusListeners.delete(cb) } },
}))
const connect = vi.fn<(alias: string, opts?: { agents?: boolean }) => Promise<HostStatus>>()
const check = vi.fn<(alias: string) => Promise<HostStatus>>()
vi.mock('@/api/hosts', () => ({ connectHost: (a: string, o?: { agents?: boolean }) => connect(a, o), checkHostReadiness: (a: string) => check(a) }))
vi.mock('@/utils/log', () => ({ log: { info: () => {}, warn: () => {}, error: () => {} } }))

const store = await import('../../web/src/utils/host-action-store')
const { getUserRetryingHosts, __resetUserRetryForTests } = await import('../../web/src/utils/host-user-retrying')

const failed = (at: number): HostStatus => ({
  host: 'devbox', label: 'Dev box', hostname: 'dev.example.com', connected: false, phase: 'failed', kind: 'unreachable',
  error: 'ssh: connect to host dev.example.com port 22: No route to host', phaseLabel: '', steps: [], phaseElapsedMs: 0, connectElapsedMs: 0, at,
} as HostStatus)

beforeEach(() => {
  vi.useFakeTimers()
  clock = 1_000_000
  statuses.clear()
  statusListeners.clear()
  connect.mockReset()
  check.mockReset()
  store.__resetHostActionStoreForTests()
  __resetUserRetryForTests()
  statuses.set('devbox', failed(clock - 60_000))
})
afterEach(() => { vi.useRealTimers() })

describe('host action store', () => {
  it('an Install no fix answers within 30s says so on the line instead of quietly going back', async () => {
    connect.mockResolvedValue(failed(clock))
    await store.runHostAction('devbox', 'fix', 'install')
    expect(store.getHostActionSnapshot('devbox').fixStart).not.toBeNull()
    vi.advanceTimersByTime(30_000)
    expect(store.getHostActionSnapshot('devbox')).toMatchObject({ fixStart: null, receipt: store.fixNotStartedText('install') })
    expect(store.fixNotStartedText('install')).toBe('Install did not start. Run the command below on that machine, or Check again.')
    vi.advanceTimersByTime(15_000)
    expect(store.getHostActionSnapshot('devbox').receipt).toBeNull()
  })

  it('only Install / Update asks the server for the coding agent (Walnut never installs one by itself)', async () => {
    connect.mockResolvedValue(failed(clock))
    await store.runHostAction('devbox', 'retry')
    expect(connect).toHaveBeenLastCalledWith('devbox', { agents: false })
    vi.advanceTimersByTime(30_000)
    await store.runHostAction('devbox', 'fix', 'install')
    expect(connect).toHaveBeenLastCalledWith('devbox', { agents: true })
  })

  it('two readers share one pending, and a second run while pending sends no request', async () => {
    let answer!: (s: HostStatus) => void
    connect.mockImplementation(() => new Promise((r) => { answer = r }))
    const seen: (string | null)[][] = [[], []]
    const stops = [0, 1].map((i) => store.subscribeHostActions(() => { seen[i].push(store.getHostActionSnapshot('devbox').pending) }))
    const first = store.runHostAction('devbox', 'retry')
    expect(store.getHostActionSnapshot('devbox').pending).toBe('retry')
    expect(seen[0]).toEqual(['retry'])
    expect(seen[1]).toEqual(['retry'])
    // The user Retry reads as theirs on every surface.
    expect(getUserRetryingHosts().has('devbox')).toBe(true)
    await store.runHostAction('devbox', 'retry')
    await store.runHostAction('devbox', 'check')
    expect(connect).toHaveBeenCalledTimes(1)
    expect(check).not.toHaveBeenCalled()
    clock += 2_000
    answer(failed(clock))
    await first
    expect(store.getHostActionSnapshot('devbox').pending).toBeNull()
    expect(getUserRetryingHosts().has('devbox')).toBe(false)
    stops.forEach((s) => s())
  })

  it('a same result receipt lasts RECEIPT_MS, then goes, and is announced once', async () => {
    const events: { alias: string; kind: string; text: string }[] = []
    store.subscribeHostActionEvents((e) => { events.push(e) })
    connect.mockImplementation(async () => { clock += 500; return failed(clock) })
    await store.runHostAction('devbox', 'retry')
    const receipt = 'Tried again just now: same result'
    expect(store.getHostActionSnapshot('devbox').receipt).toBe(receipt)
    expect(events).toEqual([{ alias: 'devbox', kind: 'receipt', text: receipt }])
    vi.advanceTimersByTime(store.RECEIPT_MS - 1)
    expect(store.getHostActionSnapshot('devbox').receipt).toBe(receipt)
    vi.advanceTimersByTime(1)
    expect(store.getHostActionSnapshot('devbox').receipt).toBeNull()
    expect(store.RECEIPT_MS).toBe(5_000)
  })

  it('a request that fails says so, the same for every reader, and the next run may go', async () => {
    const events: string[] = []
    store.subscribeHostActionEvents((e) => { events.push(`${e.kind}:${e.text}`) })
    connect.mockRejectedValueOnce(new Error('network'))
    await store.runHostAction('devbox', 'retry')
    expect(store.getHostActionSnapshot('devbox')).toMatchObject({ pending: null, failed: 'retry' })
    expect(events).toEqual([`failed:${store.RETRY_FAILED_TEXT}`])
    connect.mockImplementation(async () => { clock += 500; return failed(clock) })
    await store.runHostAction('devbox', 'retry')
    expect(connect).toHaveBeenCalledTimes(2)
    expect(store.getHostActionSnapshot('devbox').failed).toBeNull()
  })

  it('an attempt no frame answers ends at its cap (20s check), and the status listener goes', async () => {
    check.mockImplementation(() => new Promise(() => {}))
    void store.runHostAction('devbox', 'check')
    expect(store.getHostActionSnapshot('devbox').pending).toBe('check')
    expect(statusListeners.size).toBe(1)
    vi.advanceTimersByTime(20_000)
    expect(store.getHostActionSnapshot('devbox').pending).toBeNull()
    expect(statusListeners.size).toBe(0)
  })
})

describe('a fix the server starts by itself is held under its own action', () => {
  it('gcc set up on a new host is held as install-compiler, so no Claude line reads "Installing Claude Code"', () => {
    const fixing = (action: string, startedAt: number) => ({
      ...failed(clock), connected: true, phase: 'connected',
      readiness: { checkedAt: clock - 1, problems: [], fixing: { action, text: 'Installing gcc', startedAt } },
    } as unknown as HostStatus)
    store.observeHostStatus('devbox', fixing('install-compiler', clock))
    expect(store.getHostActionSnapshot('devbox').fixStart).toMatchObject({ verb: 'install', action: 'install-compiler' })
    // The next fix of the same round (dtach) replaces it.
    store.observeHostStatus('devbox', fixing('build-dtach', clock + 5))
    expect(store.getHostActionSnapshot('devbox').fixStart).toMatchObject({ action: 'build-dtach', at: clock + 5 })
  })

  it('a click on Install, before the server names its fix, has no action yet, and stays asked through gcc', async () => {
    connect.mockResolvedValue(failed(clock))
    await store.runHostAction('devbox', 'fix', 'install')
    expect(store.getHostActionSnapshot('devbox').fixStart).toEqual({ verb: 'install', at: clock, asked: true })
    const gcc = {
      ...failed(clock), connected: true, phase: 'connected',
      readiness: { checkedAt: clock - 1, problems: [], fixing: { action: 'install-compiler', text: 'Installing gcc', startedAt: clock + 10 } },
    } as unknown as HostStatus
    store.observeHostStatus('devbox', gcc)
    expect(store.getHostActionSnapshot('devbox').fixStart).toMatchObject({ action: 'install-compiler', asked: true })
  })
})

describe('a connect attempt settles on its own answer, never on a frame pushed before it (C23, C48)', () => {
  const seedFrame = (s: HostStatus): void => { statuses.set(s.host, s); for (const l of statusListeners) l() }

  it('C48: the pre-click frame, re-read inside the 1s slack by any mount, keeps Retry pending until the POST answers', async () => {
    statuses.set('devbox', failed(clock - 200))
    let answer!: (s: HostStatus) => void
    connect.mockImplementation(() => new Promise((r) => { answer = r }))
    const run = store.runHostAction('devbox', 'retry')
    // A second mount (the notification panel) observes the frame it already holds.
    store.observeHostStatus('devbox', statuses.get('devbox'))
    seedFrame(failed(clock - 200))
    expect(store.getHostActionSnapshot('devbox').pending).toBe('retry')
    // A second click on the new mount sends nothing.
    await store.runHostAction('devbox', 'retry')
    expect(connect).toHaveBeenCalledTimes(1)
    clock += 2_000
    answer(failed(clock))
    await run
    expect(store.getHostActionSnapshot('devbox')).toMatchObject({ pending: null, receipt: 'Tried again just now: same result' })
  })

  it('C23: a frame re-stamped with the OLD kind just before a different result gives no same-result receipt', async () => {
    let answer!: (s: HostStatus) => void
    connect.mockImplementation(() => new Promise((r) => { answer = r }))
    const run = store.runHostAction('devbox', 'retry')
    clock += 1_500
    // The route's first push: the old kind with a fresh `at`.
    seedFrame(failed(clock))
    expect(store.getHostActionSnapshot('devbox').pending).toBe('retry')
    clock += 1
    const next = { ...failed(clock), kind: 'auth', error: 'Permission denied (publickey).' } as HostStatus
    seedFrame(next)
    answer(next)
    await run
    expect(store.getHostActionSnapshot('devbox')).toMatchObject({ pending: null, receipt: null })
  })
})
