import { afterEach, describe, expect, it, vi } from 'vitest'

const stores = vi.hoisted(() => ({
  projects: {} as Record<string, { metadata?: Record<string, unknown> }>,
  open: [] as Array<{ id: string; last_start?: { host?: string } }>,
  sessions: {} as Record<string, number>,
}))
vi.mock('../../../src/core/task-manager.js', () => ({
  getStoreProjects: async () => stores.projects,
  // The real one keeps the newest `max` rows.
  listOpenTaskViews: async (max: number) => stores.open.slice(0, max),
}))
vi.mock('../../../src/core/session-tracker.js', () => ({
  countOpenSessionsByHost: async () => stores.sessions,
}))

import {
  _setHostsUsedForSessions, hostUsedForSessions, readHostsUsedForSessions, refreshHostSessionUse, setHostSessionUseOverride,
  wireHostSessionUse,
} from '../../../src/core/hosts/host-session-use.js'

afterEach(() => {
  _setHostsUsedForSessions(null)
  setHostSessionUseOverride(null)
  stores.projects = {}; stores.open = []; stores.sessions = {}
})

describe('which hosts Walnut work uses for sessions', () => {
  it('a project that starts there, an open task that last started there, or an open session there', async () => {
    stores.projects = {
      Walnut: { metadata: { default_host: 'clouddev' } },
      Home: { metadata: { default_host: '__local__' } },
      Inbox: {},
    }
    stores.open = [{ id: 't1', last_start: { host: 'olddev' } }, { id: 't2', last_start: { host: '' } }, { id: 't3' }]
    stores.sessions = { local: 3, gpu: 1, idlebox: 0 }
    expect([...await readHostsUsedForSessions()].sort()).toEqual(['clouddev', 'gpu', 'olddev'])
  })

  it('reads every open task: the oldest of 5001 still makes its host used', async () => {
    stores.open = [...Array.from({ length: 5000 }, (_, i) => ({ id: `n${i}`, last_start: { host: 'active-box' } })), { id: 'old', last_start: { host: 'older-box' } }]
    expect([...await readHostsUsedForSessions()].sort()).toEqual(['active-box', 'older-box'])
  })

  it('is unknown before the first read, then answers per host', async () => {
    expect(hostUsedForSessions('clouddev')).toBeUndefined()
    expect(await refreshHostSessionUse(async () => new Set(['clouddev']))).toBe('all')
    expect(hostUsedForSessions('clouddev')).toBe(true)
    expect(hostUsedForSessions('fleet-mac')).toBe(false)
  })

  it('the host fixture answers for its own hosts, and only those', async () => {
    await refreshHostSessionUse(async () => new Set(['real']))
    setHostSessionUseOverride((h) => (h === 'fixture-spare' ? false : h === 'fixture-used' ? true : undefined))
    expect([hostUsedForSessions('fixture-spare'), hostUsedForSessions('fixture-used'), hostUsedForSessions('real'), hostUsedForSessions('other')])
      .toEqual([false, true, true, false])
  })

  it('names exactly the hosts whose answer flipped', async () => {
    await refreshHostSessionUse(async () => new Set(['a', 'b']))
    expect((await refreshHostSessionUse(async () => new Set(['b', 'c']))) as string[]).toEqual(expect.arrayContaining(['a', 'c']))
    expect(await refreshHostSessionUse(async () => new Set(['b', 'c']))).toEqual([])
  })

  it('the wiring pushes every stored host on the first read, then only the flips, and keeps the old answer when a read fails', async () => {
    vi.useFakeTimers()
    try {
      let next: Set<string> | Error = new Set(['a'])
      const pushed: string[] = []
      const off = wireHostSessionUse((h) => pushed.push(h), {
        hosts: () => ['a', 'spare'], everyMs: 1000,
        read: async () => { if (next instanceof Error) throw next; return next },
      })
      await vi.advanceTimersByTimeAsync(0)
      expect(pushed.sort()).toEqual(['a', 'spare'])
      pushed.length = 0
      next = new Set(['a', 'spare'])
      await vi.advanceTimersByTimeAsync(1000)
      expect(pushed).toEqual(['spare'])
      pushed.length = 0
      next = new Error('the store is busy')
      await vi.advanceTimersByTimeAsync(1000)
      expect(pushed).toEqual([])
      expect(hostUsedForSessions('spare')).toBe(true)
      off()
      next = new Set()
      await vi.advanceTimersByTimeAsync(5000)
      expect(pushed).toEqual([])
    } finally {
      vi.useRealTimers()
    }
  })
})
