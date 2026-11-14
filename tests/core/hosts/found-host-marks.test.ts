/**
 * The writes of `not_offered` (src/core/hosts/found-host-marks.ts):
 *   - a found host waiting for the yes that is a joined machine now is remembered as it, stored
 *     row or one kept only in memory (written whole), and it stays that machine after the machine
 *     moved to another network (joined-twins.ts reads the mark);
 *   - a found host whose probe said another system is marked and off, once;
 *   - a connect that works clears that mark.
 * The data is the shape the reported Mac had (documentation addresses here).
 */
import { describe, expect, it } from 'vitest'
import { clearNotLinux, markFoundTwinsDoc, markNotLinux, type FoundHostMarkDeps } from '../../../src/core/hosts/found-host-marks.js'
import { foundHostsToAsk, notOfferedOf } from '../../../src/core/hosts/found-host-offer.js'
import { foundPickableHosts, joinedTwins } from '../../../src/core/hosts/joined-twins.js'
import { settleFoundHostsDoc } from '../../../src/core/hosts/found-hosts-store.js'
import type { DiscoveredHost } from '../../../src/core/ssh-config-scanner.js'

const NOW = new Date('2026-11-13T10:00:00Z')
const MAC = 'a'.repeat(64)
const scan = (...hosts: DiscoveredHost[]) => new Map(hosts.map((h) => [h.alias, h]))
const joined = { hostname: 'Studio-MacBook.walnut-net.invalid', label: 'Studio-MacBook', transport: 'net', endpoint: MAC, enabled: true }
const netAt = (...self: string[]) => ({ enabled: true, where: { [MAC]: { addrs: self, self } } })

function doc(): Record<string, unknown> {
  return {
    hosts_found: { asking_since: '2026-11-01T00:00:00.000Z' },
    hosts: {
      // Answered Not now on Home; its HostName is an address the joined Mac reports as its own.
      'studio-mac': { hostname: '10.20.30.40', user: 'sam', discovered: true, connect: 'not_now', enabled: false },
      'Studio-MacBook': joined,
      // Said Connect to: a configured host, never marked as a twin.
      'studio-yes': { hostname: 'studio-macbook.local', discovered: true, connect: 'yes', enabled: true },
      devbox: { hostname: 'devbox.example.test', discovered: true, connect: 'ask', enabled: false },
    },
    net: netAt('10.20.30.40:62955', '203.0.113.69:62955'),
  }
}

describe('a found host that is a joined machine is remembered as it', () => {
  it('marks the stored waiting row and the one kept only in memory, never a yes or another machine', () => {
    const d = doc()
    const marked = markFoundTwinsDoc(d, { scanned: scan({ alias: 'studio-lan', hostname: 'Studio-MacBook.lan', user: 'sam' }), now: NOW })
    expect(marked.sort()).toEqual(['studio-lan', 'studio-mac'])
    const hosts = d.hosts as Record<string, Record<string, unknown>>
    expect(hosts['studio-mac']).toMatchObject({ connect: 'not_now', enabled: false, not_offered: { reason: 'same_machine', same_as: 'Studio-MacBook', at: NOW.toISOString() } })
    // Written whole, waiting and off, as answerFoundHost writes a row kept only in memory.
    expect(hosts['studio-lan']).toMatchObject({ hostname: 'Studio-MacBook.lan', user: 'sam', discovered: true, connect: 'ask', enabled: false, scanned: { hostname: 'Studio-MacBook.lan', user: 'sam' } })
    expect(notOfferedOf(hosts['studio-lan'])?.same_as).toBe('Studio-MacBook')
    expect(hosts['studio-yes'].not_offered).toBeUndefined()
    expect(hosts.devbox.not_offered).toBeUndefined()
    // Run again: nothing more to write.
    expect(markFoundTwinsDoc(d, { scanned: new Map(), now: NOW })).toEqual([])
  })

  it('stays that machine after it moved to another network (its addresses no longer match)', () => {
    const d = doc()
    markFoundTwinsDoc(d, { scanned: new Map(), now: NOW })
    const hosts = d.hosts as Record<string, Record<string, unknown>>
    const moved = netAt('192.168.7.20:62955')
    const forgotten = { ...hosts, 'studio-mac': { ...hosts['studio-mac'], not_offered: undefined } }
    expect(joinedTwins(forgotten, moved).map((t) => t.alias)).not.toContain('studio-mac')
    expect(joinedTwins(hosts, moved)).toContainEqual({ alias: 'studio-mac', joined: 'Studio-MacBook' })
    // The new task panel offers it no more (it would without the mark).
    expect(foundPickableHosts(forgotten, moved).map(([a]) => a)).toEqual(['studio-mac', 'devbox'])
    expect(foundPickableHosts(hosts, moved).map(([a]) => a)).toEqual(['devbox'])
    const asked = { ...hosts, 'studio-mac': { ...hosts['studio-mac'], connect: 'ask' } }
    expect(foundHostsToAsk(asked, moved).map((h) => h.host)).toEqual(['devbox'])
  })

  it('the start remembers it in the same write as its found hosts settle', () => {
    const d = doc()
    settleFoundHostsDoc(d, { facts: { sessionHosts: new Set(), taskHosts: new Set(), connectedHosts: new Set(), serverHosts: new Set() }, scanned: new Map(), now: NOW })
    markFoundTwinsDoc(d, { scanned: new Map(), now: NOW })
    expect(notOfferedOf((d.hosts as Record<string, unknown>)['studio-mac'] as never)?.reason).toBe('same_machine')
  })

  it('a config with no host network marks nothing', () => {
    const d = doc()
    delete d.net
    expect(markFoundTwinsDoc(d, { scanned: new Map(), now: NOW })).toEqual([])
  })
})

/** Fake deps over one in-memory config doc. */
function fakeDeps(d: Record<string, unknown>, merged: Record<string, unknown> = {}): FoundHostMarkDeps & { writes: number } {
  const deps = {
    writes: 0,
    scan: async () => new Map<string, DiscoveredHost>(),
    readHosts: async () => ({ ...merged, ...(d.hosts as Record<string, never>) }),
    modify: async (mutate: (doc: Record<string, unknown>) => boolean) => {
      const changed = mutate(d)
      if (changed) deps.writes++
      return changed
    },
    now: () => NOW,
  }
  return deps
}

describe('a found host that is not Linux is marked and off, once', () => {
  it('the first answer writes the mark and the switch; the next says it changed nothing', async () => {
    const d = { hosts: { 'studio-mac': { hostname: '10.20.30.40', user: 'sam', discovered: true, connect: 'yes', enabled: true } } }
    const deps = fakeDeps(d)
    expect(await markNotLinux('studio-mac', 'Darwin', deps)).toBe(true)
    expect(d.hosts['studio-mac']).toMatchObject({ connect: 'yes', enabled: false, not_offered: { reason: 'not_linux', os: 'Darwin' } })
    expect(await markNotLinux('studio-mac', 'Darwin', deps)).toBe(false)
    expect(deps.writes).toBe(1)
    // Turned back on by the person, and still a Mac: marked off again (and told again).
    ;(d.hosts['studio-mac'] as Record<string, unknown>).enabled = true
    expect(await markNotLinux('studio-mac', 'Darwin', deps)).toBe(true)
  })

  it('a found host kept only in memory is written whole; a host added by hand is never marked', async () => {
    const d: Record<string, unknown> = { hosts: { mine: { hostname: 'mine.example.test', enabled: true } } }
    const deps = fakeDeps(d, { 'only-found': { hostname: '10.20.30.41', discovered: true, connect: 'yes', enabled: true, scanned: { hostname: '10.20.30.41' } } })
    expect(await markNotLinux('only-found', undefined, deps)).toBe(true)
    expect((d.hosts as Record<string, unknown>)['only-found']).toMatchObject({ hostname: '10.20.30.41', discovered: true, connect: 'yes', enabled: false, not_offered: { reason: 'not_linux' } })
    expect(await markNotLinux('mine', 'Darwin', deps)).toBe(false)
    expect((d.hosts as Record<string, Record<string, unknown>>).mine.not_offered).toBeUndefined()
  })

  it('a connect that works clears the mark (the alias names another machine now)', async () => {
    const d = { hosts: { box: { hostname: '10.20.30.42', discovered: true, connect: 'yes', enabled: true, not_offered: { reason: 'not_linux', os: 'Darwin', at: 'x' } } } }
    const deps = fakeDeps(d)
    expect(await clearNotLinux('box', deps)).toBe(true)
    expect(d.hosts.box).not.toHaveProperty('not_offered')
    expect(await clearNotLinux('box', deps)).toBe(false)
  })
})
