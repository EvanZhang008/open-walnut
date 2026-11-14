/**
 * The writes of `not_offered` (src/core/hosts/found-host-marks.ts):
 *   - a found host whose probe said another system is marked and off, once, on the target it was
 *     dialled at;
 *   - a connect that works clears that mark;
 *   - a replica writes nothing (its config is the Mac's copy).
 * A found host that is a machine already joined with a link is matched live on the machine's
 * current addresses (joined-twins.ts) and never written down: an address match can be an accident.
 * The data is the shape the reported Mac had (documentation addresses here).
 */
import { afterEach, describe, expect, it } from 'vitest'
import * as marks from '../../../src/core/hosts/found-host-marks.js'
import { clearNotLinux, markNotLinux, type FoundHostMarkDeps } from '../../../src/core/hosts/found-host-marks.js'
import { foundHostsToAsk, notOfferedOf } from '../../../src/core/hosts/found-host-offer.js'
import { foundPickableHosts, joinedTwins } from '../../../src/core/hosts/joined-twins.js'
import { settleFoundHostsDoc } from '../../../src/core/hosts/found-hosts-store.js'

const NOW = new Date('2026-11-13T10:00:00Z')
const MAC = 'a'.repeat(64)
const joined = { hostname: 'Studio-MacBook.walnut-net.invalid', label: 'Studio-MacBook', transport: 'net', endpoint: MAC, enabled: true }
const netAt = (...self: string[]) => ({ enabled: true, where: { [MAC]: { addrs: self, self } } })

function doc(): Record<string, unknown> {
  return {
    hosts_found: { asking_since: '2026-11-01T00:00:00.000Z' },
    hosts: {
      // Waiting for the yes; its HostName is an address the joined Mac reports as its own.
      'studio-mac': { hostname: '10.20.30.40', user: 'sam', discovered: true, connect: 'ask', enabled: false },
      'Studio-MacBook': joined,
      devbox: { hostname: 'devbox.example.test', discovered: true, connect: 'ask', enabled: false },
    },
    net: netAt('10.20.30.40:62955', '203.0.113.69:62955'),
  }
}

describe('a found host that is a joined machine is matched live, never written down', () => {
  it('is left out while the machine reports that address, and offered again once it does not', () => {
    const d = doc()
    const hosts = d.hosts as Record<string, Record<string, unknown>>
    expect(joinedTwins(hosts, d.net)).toEqual([{ alias: 'studio-mac', joined: 'Studio-MacBook' }])
    expect(foundPickableHosts(hosts, d.net).map(([a]) => a)).toEqual(['devbox'])
    // The Mac moved to another network: the found row may be another machine now, so it is offered.
    const moved = netAt('192.168.7.20:62955')
    expect(joinedTwins(hosts, moved)).toEqual([])
    expect(foundPickableHosts(hosts, moved).map(([a]) => a)).toEqual(['studio-mac', 'devbox'])
    expect(foundHostsToAsk(hosts).map((h) => h.host)).toEqual(['studio-mac', 'devbox'])
  })

  it('the start writes no mark for it, and an entry an earlier build wrote is ignored', () => {
    const d = doc()
    settleFoundHostsDoc(d, { facts: { sessionHosts: new Set(), taskHosts: new Set(), connectedHosts: new Set(), serverHosts: new Set() }, scanned: new Map(), now: NOW })
    for (const row of Object.values(d.hosts as Record<string, Record<string, unknown>>)) expect(row.not_offered).toBeUndefined()
    const hosts = { ...(d.hosts as Record<string, Record<string, unknown>>) }
    hosts['studio-mac'] = { ...hosts['studio-mac'], not_offered: { reason: 'same_machine', same_as: 'Studio-MacBook', at: NOW.toISOString() } }
    const moved = netAt('192.168.7.20:62955')
    expect(notOfferedOf(hosts['studio-mac'])).toBeUndefined()
    expect(foundPickableHosts(hosts, moved).map(([a]) => a)).toEqual(['studio-mac', 'devbox'])
    expect(foundHostsToAsk(hosts).map((h) => h.host)).toEqual(['studio-mac', 'devbox'])
  })

  it('no writer of a same machine mark is left (only not Linux is written)', () => {
    expect(Object.keys(marks).filter((k) => typeof (marks as Record<string, unknown>)[k] === 'function').sort()).toEqual(['clearNotLinux', 'markNotLinux'])
  })
})

/** Fake deps over one in-memory config doc. */
function fakeDeps(d: Record<string, unknown>, merged: Record<string, unknown> = {}): FoundHostMarkDeps & { writes: number; told: number } {
  const deps = {
    writes: 0,
    told: 0,
    readHosts: async () => ({ ...(d.hosts as Record<string, never>), ...merged }) as never,
    modify: async (mutate: (doc: Record<string, unknown>) => boolean) => {
      const changed = mutate(d)
      if (changed) deps.writes++
      return changed
    },
    now: () => NOW,
    announce: async () => { deps.told++ },
  }
  return deps
}

describe('a found host that is not Linux is marked and off, once, on the target it was dialled at', () => {
  it('the first answer writes the mark, its target and the switch; the next says it changed nothing', async () => {
    const d = { hosts: { 'studio-mac': { hostname: '10.20.30.40', user: 'sam', discovered: true, connect: 'yes', enabled: true } } }
    const deps = fakeDeps(d)
    expect(await markNotLinux('studio-mac', 'Darwin', deps)).toBe(true)
    expect(d.hosts['studio-mac']).toMatchObject({
      connect: 'yes', enabled: false,
      not_offered: { reason: 'not_linux', os: 'Darwin', target: { hostname: '10.20.30.40', user: 'sam' }, at: NOW.toISOString() },
    })
    expect(await markNotLinux('studio-mac', 'Darwin', deps)).toBe(false)
    expect([deps.writes, deps.told]).toEqual([1, 1])
    // Turned back on by the person, and still a Mac: marked off again (and told again).
    ;(d.hosts['studio-mac'] as Record<string, unknown>).enabled = true
    expect(await markNotLinux('studio-mac', 'Darwin', deps)).toBe(true)
  })

  it('the target is the one the read named (it follows ~/.ssh/config), and the stored row keeps its own values', async () => {
    const stored = { hostname: '10.20.30.40', user: 'sam', discovered: true, connect: 'yes', enabled: true, scanned: { hostname: '10.20.30.40', user: 'sam' } }
    const d = { hosts: { 'studio-mac': stored } }
    // The merged read already follows a new HostName in ~/.ssh/config.
    const deps = fakeDeps(d, { 'studio-mac': { ...stored, hostname: '10.20.30.50', scanned: { hostname: '10.20.30.50', user: 'sam' } } })
    expect(await markNotLinux('studio-mac', 'Darwin', deps)).toBe(true)
    expect(d.hosts['studio-mac']).toMatchObject({ hostname: '10.20.30.40', scanned: { hostname: '10.20.30.40' }, not_offered: { target: { hostname: '10.20.30.50', user: 'sam' } } })
    // A mark on another target is written again for the one dialled now.
    const later = fakeDeps(d, { 'studio-mac': { ...stored, hostname: '10.20.30.60' } })
    expect(await markNotLinux('studio-mac', 'Darwin', later)).toBe(true)
    expect(notOfferedOf(d.hosts['studio-mac'])?.target).toEqual({ hostname: '10.20.30.60', user: 'sam' })
  })

  it('a found host kept only in memory is written whole; a host added by hand is never marked', async () => {
    const d: Record<string, unknown> = { hosts: { mine: { hostname: 'mine.example.test', enabled: true } } }
    const deps = fakeDeps(d, { 'only-found': { hostname: '10.20.30.41', discovered: true, connect: 'yes', enabled: true, scanned: { hostname: '10.20.30.41' } } })
    expect(await markNotLinux('only-found', undefined, deps)).toBe(true)
    expect((d.hosts as Record<string, unknown>)['only-found']).toMatchObject({
      hostname: '10.20.30.41', discovered: true, connect: 'yes', enabled: false, not_offered: { reason: 'not_linux', target: { hostname: '10.20.30.41' } },
    })
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

describe('a replica writes no mark', () => {
  const was = process.env.WALNUT_ROLE
  afterEach(() => { if (was === undefined) delete process.env.WALNUT_ROLE; else process.env.WALNUT_ROLE = was })

  it('markNotLinux and clearNotLinux do nothing on a follower', async () => {
    process.env.WALNUT_ROLE = 'replica'
    expect(await markNotLinux('studio-mac', 'Darwin')).toBe(false)
    expect(await clearNotLinux('studio-mac')).toBe(false)
  })
})
