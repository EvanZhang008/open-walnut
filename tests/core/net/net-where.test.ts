import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import yaml from 'js-yaml'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-net-where'))

import { CONFIG_FILE, WALNUT_HOME } from '../../../src/constants.js'
import { _configRepairIdleForTest, _resetWriteLockForTest, onConfigWritten } from '../../../src/core/config-manager.js'
import { _setBeforeConfigCommitForTest } from '../../../src/core/config-store.js'
import { mergeAddrs, noteWhere, whereOf, type Where } from '../../../src/core/net/net-where.js'
import { noteSeen } from '../../../src/core/net/net-seen.js'

const HOST = 'a'.repeat(64)
const OTHER = 'b'.repeat(64)
const RELAY = 'https://relay.example.invalid/'
// The real eight-address shape: a LAN address, public IPv4 and rotating IPv6 addresses.
const ADDRS = [
  '[2001:db8:1:2::f901]:50088', '10.0.0.56:50088', '203.0.113.69:50088',
  '[2001:db8:1:2:44d:b765:d556:f0d2]:50088', '[2001:db8:1:2:3967:9277:1c52:ddc2]:50088',
  '[2001:db8:1:2:bd6a:6a83:3a33:c583]:50088', '[2001:db8:1:2:66:374a:457d:6280]:50088',
  '[2001:db8:1:2:1:2:3:4]:50088',
]
let writes = 0
let off: () => void

async function seed(where: Where = { addrs: ADDRS, self: ADDRS }): Promise<void> {
  await fs.writeFile(CONFIG_FILE, yaml.dump({
    version: 1,
    hosts: {
      box: { transport: 'net', endpoint: HOST, enabled: true },
      other: { transport: 'net', endpoint: OTHER, enabled: true },
    },
    net: { enabled: true, where: { [HOST]: where } },
    unrelated: { keep: 'user setting' },
  }))
}
async function stored() {
  return yaml.load(await fs.readFile(CONFIG_FILE, 'utf8')) as Record<string, unknown>
}
async function snapshot() {
  await _configRepairIdleForTest()
  const stat = await fs.stat(CONFIG_FILE)
  return {
    content: await fs.readFile(CONFIG_FILE, 'utf8'),
    ino: stat.ino, mtime: stat.mtimeMs,
    files: (await fs.readdir(WALNUT_HOME)).sort(),
    history: (await fs.readdir(`${CONFIG_FILE}.history`).catch(() => [])).sort(),
  }
}
function daemon(status: Record<string, unknown>) {
  return { send: async () => ({ node: status }) } as never
}

beforeEach(async () => {
  _resetWriteLockForTest()
  await fs.mkdir(WALNUT_HOME, { recursive: true })
  await seed()
  writes = 0
  off = onConfigWritten(() => { writes++ })
})
afterEach(async () => {
  _setBeforeConfigCommitForTest(null)
  off()
  await _configRepairIdleForTest()
  vi.restoreAllMocks()
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
})

describe('host sightings write only when the normalized address set changes', () => {
  it('an identical sighting writes nothing, including backup, history and write notifications', async () => {
    const before = await snapshot()
    expect(await noteWhere(HOST, { addrs: ADDRS, self: ADDRS })).toBe(false)
    expect(await snapshot()).toEqual(before)
    expect(writes).toBe(0)
  })

  it('repeated reordered and duplicate sightings keep the stored order and write nothing', async () => {
    const before = await snapshot()
    for (let i = 0; i < 12; i++) {
      const rotated = [...ADDRS.slice(i % 8), ...ADDRS.slice(0, i % 8)]
      expect(await noteWhere(HOST, { addrs: [...rotated, ...rotated], self: [...rotated, ...rotated] })).toBe(false)
    }
    expect(await snapshot()).toEqual(before)
    expect(writes).toBe(0)
  })

  it('IPv6 case, expansion and leading zeroes in ports identify the same socket', async () => {
    await seed({ addrs: ['[2001:db8::a]:5', '192.0.2.1:5'], self: ['[2001:db8::a]:5'] })
    const before = await snapshot()
    expect(await noteWhere(HOST, { addrs: ['192.0.2.1:00005', '[2001:0DB8:0:0:0:0:0:A]:00005'], self: ['[2001:DB8::A]:5'] })).toBe(false)
    expect(await snapshot()).toEqual(before)
    expect(writes).toBe(0)
  })

  it('normalization deduplicates before the eight-address limit without admitting invalid sockets', () => {
    expect(mergeAddrs(['[2001:DB8::A]:5', '[2001:db8:0:0:0:0:0:a]:00005', 'bad', '[fe80::1%en0]:5'], ADDRS))
      .toEqual(['[2001:DB8::A]:5', ...ADDRS.slice(0, 7)])
  })

  it('the real noteSeen entry tolerates a different direct path on each reconnect', async () => {
    const before = await snapshot()
    for (const at of ADDRS.slice(0, 4)) {
      await noteSeen(daemon({ peers: [{ id: HOST, link: { path: 'direct', paths: [{ kind: 'direct', addr: `Ip(${at})`, selected: true }] } }] }),
        daemon({ addrs: [...ADDRS].reverse(), homeRelay: null }), 'box', HOST, [])
    }
    expect(await snapshot()).toEqual(before)
    expect(writes).toBe(0)
  })

  it('more than eight reported sockets keep the same bounded subset across reordered reports and direct paths', async () => {
    const own = Array.from({ length: 16 }, (_, i) => `192.0.2.${i + 1}:50088`)
    await seed({ addrs: own.slice(0, 8), self: own.slice(0, 8) })
    const report = async (at: string, addrs: string[]) => noteSeen(
      daemon({ peers: [{ id: HOST, link: { paths: [{ kind: 'direct', addr: `Ip(${at})`, selected: true }] } }] }),
      daemon({ addrs, homeRelay: null }), 'box', HOST, [],
    )
    await report(own[15], own)
    const before = await snapshot()
    const count = writes
    for (const at of [own[0], own[8], own[15], own[7]]) {
      await report(at, [...own].reverse())
      await report(at, own)
    }
    expect(await snapshot()).toEqual(before)
    expect(writes).toBe(count)
    expect(whereOf((await stored()).net)[HOST].addrs).toHaveLength(8)
    expect(whereOf((await stored()).net)[HOST].self).toHaveLength(8)
  })

  it('overflow keeps LAN and public IPv4 sockets alongside IPv6, including the observed NAT port', async () => {
    const own = ['10.0.0.56:50088', '203.0.113.69:50088',
      ...Array.from({ length: 8 }, (_, i) => `[2001:db8:1:2::${i + 1}]:50088`)]
    const at = '203.0.113.69:61234'
    const local = daemon({ peers: [{ id: HOST, link: { paths: [{ kind: 'direct', addr: `Ip(${at})`, selected: true }] } }] })
    await noteSeen(local, daemon({ addrs: own, homeRelay: null }), 'box', HOST, [])
    const w = whereOf((await stored()).net)[HOST]
    expect(w.addrs).toEqual(expect.arrayContaining([at, ...own.slice(0, 2)]))
    expect(w.self).toEqual(expect.arrayContaining(own.slice(0, 2)))
    expect(w.addrs).toHaveLength(8)
    expect(w.self).toHaveLength(8)
    const before = await snapshot()
    const count = writes
    await noteSeen(local, daemon({ addrs: [...own].reverse(), homeRelay: null }), 'box', HOST, [])
    expect(await snapshot()).toEqual(before)
    expect(writes).toBe(count)
  })

  it('a new address is saved once, bounded, and its repeated reordered report writes nothing', async () => {
    const fresh = '192.0.2.99:50088'
    expect(await noteWhere(HOST, { addrs: [fresh], self: [fresh, ...ADDRS.slice(0, 7)] })).toBe(true)
    expect(whereOf((await stored()).net)[HOST]).toEqual({ addrs: [fresh, ...ADDRS.slice(0, 7)], self: [fresh, ...ADDRS.slice(0, 7)] })
    expect((await stored()).unrelated).toEqual({ keep: 'user setting' })
    const before = await snapshot()
    expect(await noteWhere(HOST, { addrs: [fresh, ...ADDRS.slice(0, 7)].reverse(), self: [fresh, ...ADDRS.slice(0, 7)].reverse() })).toBe(false)
    expect(await snapshot()).toEqual(before)
    expect(writes).toBe(1)
  })

  it('a removed self address is saved while the address book retains previously reached sockets', async () => {
    expect(await noteWhere(HOST, { addrs: ADDRS.slice(1), self: ADDRS.slice(1) })).toBe(true)
    expect(whereOf((await stored()).net)[HOST].self).toEqual(ADDRS.slice(1))
    expect(whereOf((await stored()).net)[HOST].addrs).toEqual(ADDRS)
  })

  it('an empty self report clears it once; absent self and empty address book input keep existing data', async () => {
    expect(await noteWhere(HOST, { addrs: [], self: [] })).toBe(true)
    expect(whereOf((await stored()).net)[HOST]).toEqual({ addrs: ADDRS })
    const before = await snapshot()
    expect(await noteWhere(HOST, { addrs: [], self: [] })).toBe(false)
    expect(await noteWhere(HOST, { addrs: [] })).toBe(false)
    expect(await snapshot()).toEqual(before)
    expect(writes).toBe(1)
  })

  it('a relay change and daily renewal still save, without reordering unchanged addresses', async () => {
    expect(await noteWhere(HOST, { addrs: [...ADDRS].reverse(), home: RELAY, ours: [RELAY] })).toBe(true)
    let w = whereOf((await stored()).net)[HOST]
    expect(w.addrs).toEqual(ADDRS)
    expect(w.relay).toBe(RELAY)
    const before = await snapshot()
    expect(await noteWhere(HOST, { addrs: ADDRS, home: RELAY, ours: [RELAY] })).toBe(false)
    expect(await snapshot()).toEqual(before)
    await seed({ ...w, relayAt: Date.now() - 25 * 60 * 60_000 })
    expect(await noteWhere(HOST, { addrs: ADDRS, home: RELAY, ours: [RELAY] })).toBe(true)
    w = whereOf((await stored()).net)[HOST]
    expect(Date.now() - w.relayAt!).toBeLessThan(10_000)
  })

  it('concurrent reordered reports and a second host preserve both records with one write', async () => {
    const results = await Promise.all([
      noteWhere(HOST, { addrs: [...ADDRS].reverse(), self: [...ADDRS].reverse() }),
      noteWhere(OTHER, { addrs: ['192.0.2.2:5'], self: ['192.0.2.2:5'] }),
      noteWhere(HOST, { addrs: ADDRS, self: ADDRS }),
    ])
    expect(results).toEqual([false, true, false])
    expect(whereOf((await stored()).net)[HOST]).toEqual({ addrs: ADDRS, self: ADDRS })
    expect(whereOf((await stored()).net)[OTHER]).toEqual({ addrs: ['192.0.2.2:5'], self: ['192.0.2.2:5'] })
    expect(writes).toBe(1)
  })

  it('a host removed while a write is in flight is not restored', async () => {
    _setBeforeConfigCommitForTest(async () => {
      _setBeforeConfigCommitForTest(null)
      const doc = await stored()
      delete (doc.hosts as Record<string, unknown>).box
      await fs.writeFile(CONFIG_FILE, yaml.dump(doc))
    })
    expect(await noteWhere(HOST, { addrs: ['192.0.2.99:5'] })).toBe(false)
    expect((await stored()).hosts).not.toHaveProperty('box')
    expect(whereOf((await stored()).net)[HOST].addrs).toEqual(ADDRS)
    expect(writes).toBe(0)
  })

  it('a failed commit reports failure, leaves the file intact and can be retried', async () => {
    const before = await snapshot()
    _setBeforeConfigCommitForTest(async () => { throw new Error('injected commit failure') })
    await expect(noteWhere(HOST, { addrs: ['192.0.2.99:5'] })).rejects.toThrow('injected commit failure')
    expect(await snapshot()).toEqual(before)
    expect(writes).toBe(0)
    _setBeforeConfigCommitForTest(null)
    expect(await noteWhere(HOST, { addrs: ['192.0.2.99:5'] })).toBe(true)
    expect(writes).toBe(1)
  })
})
