import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  CONNECT_KEY_CLEAR_MS, HOST_BANNER_DISMISS_KEY, LEGACY_LOCAL_DISMISS_KEY, LEGACY_SETUP_DISMISS_KEY, LOCAL_DISMISS_KEY,
  PRUNE_EVERY_MS, __resetHostBannerDismissForTests, addKeys, clearLocalDismissed, dismissHostKeys, dismissLocal,
  getHostDismissed, getLocalDismissed, hostHiddenFromBanner, isLocalDismissed, localDismissKey, pruneHostDismissed,
  pruneKeys, restoreHost, startHostDismissPruner, subscribeHostDismissed, subscribeLocalDismissed, undismissHostKeys,
  undismissLocal,
} from '../../web/src/utils/host-banner-dismiss'

// The host status store, faked: the pruner only reads statuses, the hydration
// state and the clock, and listens for frames (no banner is mounted here).
const fake = vi.hoisted(() => ({
  statuses: [] as unknown[], hydration: 'never' as string, clock: 0, listeners: new Set<() => void>(),
}))
vi.mock('@/hooks/useHostStatus', () => ({
  getAllHostStatus: () => fake.statuses,
  getHostStatusHydration: () => fake.hydration,
  serverNow: () => fake.clock,
  subscribeHostStatus: (cb: () => void) => { fake.listeners.add(cb); return () => { fake.listeners.delete(cb) } },
}))
const frame = () => { for (const l of fake.listeners) l() }
import type { HostStatusInput } from '../../src/core/hosts/host-problem'

// In-memory localStorage (node test env has none).
class MemStorage {
  private m = new Map<string, string>()
  getItem(k: string) { return this.m.has(k) ? this.m.get(k)! : null }
  setItem(k: string, v: string) { this.m.set(k, String(v)) }
  removeItem(k: string) { this.m.delete(k) }
  clear() { this.m.clear() }
}

const NOW = 2_000_000_000
const outdated = (minVersion: string): HostStatusInput => ({
  host: 'buildbox', label: 'Build box', connected: true, phase: 'connected', connectedAt: NOW - 1000, at: NOW,
  readiness: { checkedAt: NOW - 10, problems: [{ kind: 'claude_outdated', message: 'old', commands: [] }], claude: { version: '2.1.220', minVersion } },
})

beforeEach(() => {
  ;(globalThis as { localStorage?: unknown }).localStorage = new MemStorage()
  __resetHostBannerDismissForTests()
})

describe('host banner dismiss keys', () => {
  it('stores a JSON array under an open-walnut- key (synced by ui-prefs), max 50, oldest evicted', () => {
    expect(HOST_BANNER_DISMISS_KEY.startsWith('open-walnut-')).toBe(true)
    const keys = Array.from({ length: 55 }, (_, i) => `h${i}|connect`)
    dismissHostKeys(keys)
    const stored = JSON.parse(localStorage.getItem(HOST_BANNER_DISMISS_KEY)!) as string[]
    expect(stored).toHaveLength(50)
    expect(stored[0]).toBe('h5|connect')
    expect(getHostDismissed().has('h54|connect')).toBe(true)
  })

  it('dismissing a key again moves it to the newest end', () => {
    expect(addKeys(['a', 'b', 'c'], ['a'])).toEqual(['b', 'c', 'a'])
  })

  it('a readiness key clears on the first frame without that problem', () => {
    const key = 'buildbox|claude_outdated|2.1.280'
    expect(pruneKeys([key], [outdated('2.1.280')], NOW)).toEqual([key])
    const healed = { ...outdated('2.1.280'), readiness: { checkedAt: NOW - 5, problems: [], claude: { version: '2.1.281', minVersion: '2.1.280' } } }
    expect(pruneKeys([key], [healed], NOW)).toEqual([])
    // A new floor is a new key; the old one no longer matches a problem and goes.
    expect(pruneKeys([key], [outdated('2.1.290')], NOW)).toEqual([])
  })

  it('a readiness key is not judged while the host is down or unchecked', () => {
    const key = 'buildbox|claude_outdated|2.1.280'
    const down: HostStatusInput = { host: 'buildbox', connected: false, phase: 'failed', kind: 'timeout', at: NOW }
    expect(pruneKeys([key], [down], NOW)).toEqual([key])
    expect(pruneKeys([key], [], NOW)).toEqual([key])
  })

  it('a connect key clears only after 10 unbroken connected minutes (C81)', () => {
    const at = (ms: number): HostStatusInput => ({ host: 'netbox', connected: true, phase: 'connected', connectedAt: NOW - ms, at: NOW })
    const key = 'netbox|connect'
    expect(pruneKeys([key], [at(5 * 60_000)], NOW)).toEqual([key])
    expect(pruneKeys([key], [at(CONNECT_KEY_CLEAR_MS - 1)], NOW)).toEqual([key])
    expect(pruneKeys([key], [at(CONNECT_KEY_CLEAR_MS)], NOW)).toEqual([])
    const flipping: HostStatusInput = { host: 'netbox', connected: false, phase: 'failed', kind: 'timeout', at: NOW }
    expect(pruneKeys([key], [flipping], NOW)).toEqual([key])
  })

  it('pruneHostDismissed writes the shrunk list back', () => {
    dismissHostKeys(['buildbox|claude_outdated|2.1.280'])
    pruneHostDismissed([outdated('2.1.290')], NOW)
    expect(JSON.parse(localStorage.getItem(HOST_BANNER_DISMISS_KEY)!)).toEqual([])
  })
})

describe('host dismiss keys across tabs', () => {
  const stored = () => JSON.parse(localStorage.getItem(HOST_BANNER_DISMISS_KEY)!) as string[]
  const connectedLong: HostStatusInput = { host: 'netbox', connected: true, phase: 'connected', connectedAt: NOW - CONNECT_KEY_CLEAR_MS, at: NOW }

  it('a prune in this tab starts from storage: a key another tab just added survives it', () => {
    dismissHostKeys(['netbox|connect'])
    expect(getHostDismissed().has('netbox|connect')).toBe(true)
    // Another tab (or the Mac app) dismisses Key box; this tab's cache still says only netbox.
    localStorage.setItem(HOST_BANNER_DISMISS_KEY, JSON.stringify(['netbox|connect', 'keybox|connect']))
    pruneHostDismissed([connectedLong], NOW)
    expect(stored()).toEqual(['keybox|connect'])
    expect(getHostDismissed().has('keybox|connect')).toBe(true)
  })

  it('a dismiss in this tab starts from storage too (the other tab removal is not written back)', () => {
    dismissHostKeys(['netbox|connect', 'keybox|connect'])
    localStorage.setItem(HOST_BANNER_DISMISS_KEY, JSON.stringify(['keybox|connect']))
    dismissHostKeys(['certbox|connect'])
    expect(stored()).toEqual(['keybox|connect', 'certbox|connect'])
  })

  it('a storage event from another tab refreshes every reader at once', () => {
    const handlers: Array<(e: { key: string | null }) => void> = []
    ;(globalThis as { window?: unknown }).window = { addEventListener: (name: string, cb: (e: { key: string | null }) => void) => { if (name === 'storage') handlers.push(cb) } }
    try {
      let notified = 0
      const off = subscribeHostDismissed(() => { notified++ })
      expect(getHostDismissed().size).toBe(0)
      localStorage.setItem(HOST_BANNER_DISMISS_KEY, JSON.stringify(['buildbox|claude_outdated|2.1.280']))
      for (const h of handlers) h({ key: 'unrelated-key' })
      expect(notified).toBe(0)
      for (const h of handlers) h({ key: HOST_BANNER_DISMISS_KEY })
      expect(notified).toBe(1)
      expect(getHostDismissed().has('buildbox|claude_outdated|2.1.280')).toBe(true)
      off()
    } finally {
      delete (globalThis as { window?: unknown }).window
    }
  })
})

describe('local Claude Code notice dismissal (C38)', () => {
  it('keys by kind + version', () => {
    expect(localDismissKey('install', { minVersion: '2.1.280' })).toBe('install:2.1.280')
    expect(localDismissKey('outdated', { minVersion: '2.1.280' })).toBe('outdated:2.1.280')
    expect(localDismissKey('sign-in', { version: '2.1.281' })).toBe('sign-in:2.1.281')
  })

  it('stores a set and never writes the legacy global flag', () => {
    dismissLocal('install:2.1.280')
    dismissLocal('sign-in:2.1.281')
    expect(JSON.parse(localStorage.getItem(LOCAL_DISMISS_KEY)!)).toEqual(['install:2.1.280', 'sign-in:2.1.281'])
    expect(localStorage.getItem(LEGACY_SETUP_DISMISS_KEY)).toBeNull()
    expect(isLocalDismissed('install:2.1.280', 'install')).toBe(true)
    expect(isLocalDismissed('sign-in:2.1.300', 'sign-in')).toBe(false)
  })

  it('reads the old values as dismissed', () => {
    localStorage.setItem(LEGACY_SETUP_DISMISS_KEY, 'true')
    expect(isLocalDismissed('install:2.1.280', 'install')).toBe(true)
    localStorage.setItem(LEGACY_LOCAL_DISMISS_KEY, 'outdated:2.1.280')
    expect(isLocalDismissed('outdated:2.1.280', 'outdated')).toBe(true)
    localStorage.setItem(LEGACY_LOCAL_DISMISS_KEY, 'sign-in')
    expect(isLocalDismissed('sign-in:2.1.281', 'sign-in')).toBe(true)
  })
})

const devbox = (extra: Record<string, unknown>): HostStatusInput =>
  ({ host: 'devbox', label: 'Dev box', connected: false, phase: 'failed', kind: 'unreachable', at: NOW, ...extra }) as HostStatusInput

describe('the pruner: expiry needs no banner mounted (C47)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    fake.statuses = [devbox({})]
    fake.hydration = 'done'
    fake.clock = NOW
    fake.listeners.clear()
  })
  afterEach(() => { vi.useRealTimers() })

  it('is idempotent: a second start returns the same stop and adds no second listener', () => {
    const stop = startHostDismissPruner()
    expect(startHostDismissPruner()).toBe(stop)
    expect(fake.listeners.size).toBe(1)
    stop()
    expect(fake.listeners.size).toBe(0)
    // Stopped: a new start is a real start.
    const again = startHostDismissPruner()
    expect(again).not.toBe(stop)
    again()
  })

  it('a host frame expires a connect key after 10 connected minutes', () => {
    dismissHostKeys(['devbox|connect'])
    startHostDismissPruner()
    expect(getHostDismissed().has('devbox|connect')).toBe(true)
    fake.statuses = [devbox({ connected: true, phase: 'connected', connectedAt: NOW - CONNECT_KEY_CLEAR_MS - 60_000 })]
    frame()
    expect(getHostDismissed().has('devbox|connect')).toBe(false)
    expect(JSON.parse(localStorage.getItem(HOST_BANNER_DISMISS_KEY)!)).toEqual([])
  })

  it('the minute timer expires it with no new frame', () => {
    dismissHostKeys(['devbox|connect'])
    fake.statuses = [devbox({ connected: true, phase: 'connected', connectedAt: NOW - CONNECT_KEY_CLEAR_MS + 30_000 })]
    startHostDismissPruner()
    expect(getHostDismissed().has('devbox|connect')).toBe(true)
    fake.clock = NOW + PRUNE_EVERY_MS
    vi.advanceTimersByTime(PRUNE_EVERY_MS)
    expect(getHostDismissed().has('devbox|connect')).toBe(false)
  })

  it('judges nothing before the store has heard from the server', () => {
    fake.hydration = 'pending'
    dismissHostKeys(['devbox|connect'])
    fake.statuses = [devbox({ connected: true, phase: 'connected', connectedAt: NOW - CONNECT_KEY_CLEAR_MS - 60_000 })]
    startHostDismissPruner()
    frame()
    expect(getHostDismissed().has('devbox|connect')).toBe(true)
  })
})

describe('Undo, Show again and the Settings line (C55)', () => {
  const signIn = (connected = true): HostStatusInput => ({
    host: 'signbox', label: 'Sign box', connected, phase: connected ? 'connected' : 'failed', connectedAt: NOW - 1000, at: NOW,
    readiness: { checkedAt: NOW - 10, problems: [{ kind: 'claude_not_logged_in', message: 'not signed in', commands: [] }], claude: { version: '2.1.280' } },
  })

  it('undismissHostKeys takes out only the keys given', () => {
    dismissHostKeys(['devbox|connect', 'buildbox|connect'])
    undismissHostKeys(['devbox|connect'])
    expect([...getHostDismissed()]).toEqual(['buildbox|connect'])
  })

  it('restoreHost forgets every key of that host and no other', () => {
    dismissHostKeys(['devbox|connect', 'devbox|claude_not_logged_in|2.1.280', 'buildbox|connect'])
    restoreHost('devbox')
    expect([...getHostDismissed()]).toEqual(['buildbox|connect'])
  })

  it('hidden from the banner only while a dismissed key names a problem the host still has', () => {
    const none = new Set<string>()
    expect(hostHiddenFromBanner('devbox', [devbox({})], none)).toBe(false)
    expect(hostHiddenFromBanner('devbox', [devbox({})], new Set(['devbox|connect']))).toBe(true)
    expect(hostHiddenFromBanner('devbox', [devbox({ connected: true, phase: 'connected' })], new Set(['devbox|connect']))).toBe(false)
    expect(hostHiddenFromBanner('devbox', [devbox({})], new Set(['buildbox|connect']))).toBe(false)
    expect(hostHiddenFromBanner('signbox', [signIn()], new Set(['signbox|claude_not_logged_in|2.1.280']))).toBe(true)
    expect(hostHiddenFromBanner('signbox', [signIn()], new Set(['signbox|claude_not_logged_in|2.1.200']))).toBe(false)
    expect(hostHiddenFromBanner('ghost', [], new Set(['ghost|connect']))).toBe(false)
  })
})

describe('the local list store (C12)', () => {
  it('a stable snapshot until the stored value changes; every write notifies', () => {
    let calls = 0
    const off = subscribeLocalDismissed(() => { calls++ })
    const a = getLocalDismissed()
    expect(getLocalDismissed()).toBe(a)
    dismissLocal('sign-in:2.1.280')
    expect(calls).toBe(1)
    const b = getLocalDismissed()
    expect(b).not.toBe(a)
    expect(b).toEqual(['sign-in:2.1.280'])
    undismissLocal('sign-in:2.1.280')
    expect(calls).toBe(2)
    expect(getLocalDismissed()).toEqual([])
    dismissLocal('install:2.1.280')
    clearLocalDismissed()
    expect(calls).toBe(4)
    expect(getLocalDismissed()).toEqual([])
    off()
  })

  it('a write that bypassed the store (ui-prefs sync) still shows on the next read', () => {
    localStorage.setItem(LOCAL_DISMISS_KEY, JSON.stringify(['sign-in:2.1.281']))
    expect(getLocalDismissed()).toEqual(['sign-in:2.1.281'])
  })
})
