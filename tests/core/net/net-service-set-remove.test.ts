/**
 * The leader's host network and a service set of this Walnut's own on a machine (review round 2,
 * N1 to N3): Settings > Remove leaves the set and clears its pairing and relay registration; a host
 * record store that cannot be read never lets a sync give the set's endpoint a host row; a record
 * whose host is gone is forgotten by the next sync; the set's endpoint is dialled where it was last
 * seen, as a host row's is.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const MAC = 'c'.repeat(64)
const BOX = 'b'.repeat(64)
const SET_EP = 'a'.repeat(64)
const SET = '0123456789abcdef'
const h = vi.hoisted(() => ({
  hosts: {} as Record<string, unknown>,
  where: {} as Record<string, unknown>,
  macConfigs: [] as Array<Record<string, unknown>>,
  hostSends: [] as Array<{ cmd: string; body: Record<string, unknown> }>,
  fetches: [] as string[],
  deleted: new Set<string>(),
  deleteStatus: 200,
  order: [] as string[],
  conn: 'up' as 'up' | 'none',
  leave: null as null | ((boundMs: number) => Promise<unknown>),
  seen: [] as unknown[][],
  kept: [] as string[][],
  /** More fields of the link (its hello's set, its record of served Walnuts). */
  connExtra: {} as Record<string, unknown>,
}))

vi.mock('../../../src/core/config-manager.js', () => ({
  getConfig: async () => ({ net: { enabled: true, where: h.where }, hosts: h.hosts }),
  isFallbackConfig: () => false,
}))
vi.mock('../../../src/core/config-store.js', () => ({ modifyConfigDoc: async (fn: (doc: Record<string, unknown>) => unknown) => fn({ net: { enabled: true } }) }))
vi.mock('../../../src/core/pairing-targets.js', () => ({ getCloudPairingEndpointAsync: async () => ({ origin: 'https://companion.example.invalid', token: 't' }) }))
vi.mock('../../../src/integrations/cloud-bridge-config.js', () => ({ machineProofHeaders: async () => ({}) }))
vi.mock('../../../src/core/hosts/link.js', () => ({ link: async () => ({ hasCapability: () => true, send: async (cmd: string, body: Record<string, unknown>) => {
  if (cmd === 'net.identity') return { ok: true, endpointId: MAC }
  if (cmd === 'net.configure') { h.macConfigs.push(body); return { ok: true } }
  return { ok: true }
} }) }))
vi.mock('../../../src/providers/daemon-connection.js', () => ({
  peekDaemonConnection: () => (h.conn === 'none' ? null : {
    connected: true,
    hasCapability: () => true,
    send: async (cmd: string, body: Record<string, unknown>) => { h.hostSends.push({ cmd, body }); return { ok: true } },
    netEndpointNow: async () => SET_EP,
    ...(h.leave ? { leaveServiceSet: (boundMs: number) => h.leave!(boundMs) } : {}),
    ...h.connExtra,
  }),
  dropDaemonConnection: () => { h.order.push('drop-connection'); return true },
}))
vi.mock('../../../src/core/net/net-seen.js', () => ({
  machineLinks: async () => ({}), runningChoice: async () => 'own', waitForModes: async () => true,
  noteSeen: async (...args: unknown[]) => { h.seen.push(args.slice(2)) },
}))
vi.mock('../../../src/core/net/net-rows.js', () => ({
  joinedOf: () => ({}), localMembers: () => [], markRemoving: async () => {}, netRows: () => [], removalsPending: async () => [], setJoined: async () => {}, netHostname: (name: string) => name,
  reconcileHosts: async (_m: unknown, o?: { drop?: string }) => { h.order.push(o?.drop ? `drop-row:${o.drop.slice(0, 4)}` : 'reconcile'); return { added: [], removed: [] } },
}))
vi.mock('../../../src/core/net/net-local.js', () => ({ clearLeftovers: async () => {}, leftoverJoins: async () => [] }))
vi.mock('../../../src/core/net/net-where.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../src/core/net/net-where.js')>()
  return { ...real, keepWhere: async (keep: Set<string>) => { h.kept.push([...keep]) }, noteWhere: async () => false }
})

import { removeMachine, resetNetForTest, syncNet } from '../../../src/core/net/net-mac.js'
import { hostServiceSets } from '../../../src/providers/service-set-leader.js'
import { walnutKeyOf } from '../../../src/providers/daemon-shared.js'
import { WALNUT_HOME } from '../../../src/constants.js'

// The companion's list: this Mac, the machine, and the set's endpoint it registered (until a DELETE took one off).
const members = () => [{ id: MAC, name: 'Mac', role: 'mac' }, { id: BOX, name: 'box', role: 'host' }, { id: SET_EP, name: 'box-set', role: 'host' }].filter((m) => !h.deleted.has(m.id))

let dir = ''
const saved: Record<string, string | undefined> = {}
beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'net-set-remove-'))
  for (const k of ['WALNUT_SERVICE_SET_FILE', 'WALNUT_SERVICE_SET_MOVE_FILE', 'WALNUT_NET_ACTIVE', 'WALNUT_HOST_SERVICE_SETS']) saved[k] = process.env[k]
  process.env.WALNUT_SERVICE_SET_FILE = path.join(dir, 'sets.json')
  process.env.WALNUT_SERVICE_SET_MOVE_FILE = path.join(dir, 'moves.json')
  process.env.WALNUT_NET_ACTIVE = '1'
  h.hosts = { box: { hostname: 'box', transport: 'net', endpoint: BOX, enabled: true } }
  h.where = {}
  vi.stubGlobal('fetch', async (url: string, init: { method: string }) => {
    const p = new URL(url).pathname.replace('/api/v1', '')
    h.fetches.push(`${init.method} ${p}`)
    if (init.method === 'DELETE') {
      if (h.deleteStatus === 200) h.deleted.add(p.split('/').pop()!)
      return new Response('{}', { status: h.deleteStatus })
    }
    return new Response(JSON.stringify({ members: members(), relays: ['https://relay.example.invalid'], relayRoots: [] }), { status: 200 })
  })
  await hostServiceSets.write('net:box', { at: Date.now(), set: SET, movedAt: Date.now(), netEndpoint: SET_EP, netAddrs: ['10.0.0.5:41641'], netShared: BOX, netSharedLeftAt: Date.now() })
})
afterEach(() => {
  resetNetForTest(); vi.unstubAllGlobals()
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v }
  fs.rmSync(dir, { recursive: true, force: true })
  Object.assign(h, { macConfigs: [], hostSends: [], fetches: [], deleted: new Set(), deleteStatus: 200, order: [], conn: 'up', leave: null, seen: [], kept: [], connExtra: {} })
})

const dialled = () => ((h.macConfigs.at(-1)?.members ?? []) as Array<{ id: string; addrs?: string[] }>)

describe('N1: Remove of a machine where this Walnut has its own service set', () => {
  it('the set leaves first, while the link still reaches it, and the machine\'s walnut-net (another Walnut\'s) is never turned off', async () => {
    h.leave = async () => { h.order.push('leave'); return { ok: true, why: 'this Walnut\'s own service set was removed from the host' } }
    // Round 3, L-N2: Remove's answer says what came of the set.
    expect(await removeMachine('box')).toEqual({ removed: 'box', serviceSet: 'this Walnut\'s own service set was removed from the host' })
    expect(h.order.indexOf('leave')).toBeGreaterThanOrEqual(0)
    expect(h.order.indexOf('leave')).toBeLessThan(h.order.indexOf(`drop-row:${BOX.slice(0, 4)}`))
    expect(h.order.indexOf('leave')).toBeLessThan(h.order.indexOf('drop-connection'))
    expect(h.hostSends.some((s) => s.cmd === 'net.configure' && s.body.enabled === false)).toBe(false)
  })

  it('a machine away: the companion forgets the set\'s endpoint, its record goes, and this Mac dials it no more', async () => {
    h.conn = 'none'
    await removeMachine('box')
    expect(h.fetches).toContain(`DELETE /net/members/${SET_EP}`)
    expect(await hostServiceSets.read('net:box')).toBe(null)
    h.hosts = {}
    await syncNet()
    expect(dialled().some((m) => m.id === SET_EP)).toBe(false)
  })
})

describe('N2: a sync never gives the set\'s endpoint a host row', () => {
  it('(c) the host record store cannot be read: the sync fails, and no host row is added', async () => {
    fs.rmSync(process.env.WALNUT_SERVICE_SET_FILE!)
    fs.mkdirSync(process.env.WALNUT_SERVICE_SET_FILE!)
    const s = await syncNet()
    expect(s.error).toBeTruthy()
    expect(h.order).not.toContain('reconcile')
  })

  it('(b) a record whose host is gone is forgotten by the next sync, and one the companion kept stays until it forgets', async () => {
    h.hosts = {}
    h.deleteStatus = 502
    await syncNet()
    expect(h.fetches).toContain(`DELETE /net/members/${SET_EP}`)
    expect((await hostServiceSets.read('net:box'))?.netEndpoint).toBe(SET_EP)
    // Never dialled meanwhile.
    expect(dialled().some((m) => m.id === SET_EP)).toBe(false)
    h.deleteStatus = 200
    await syncNet()
    expect(await hostServiceSets.read('net:box')).toBe(null)
  })
})

describe('N3: the set\'s endpoint is dialled where it was last seen', () => {
  it('its addresses come from the address book like a host row\'s, the book keeps it, and a sighting is noted under it', async () => {
    h.where = { [SET_EP]: { addrs: ['192.168.7.7:5000'] } }
    await syncNet()
    const set = dialled().find((m) => m.id === SET_EP)
    expect(set?.addrs?.[0]).toBe('192.168.7.7:5000')
    expect(set?.addrs).toContain('10.0.0.5:41641')
    expect(h.kept.at(-1)).toContain(SET_EP)
    await vi.waitFor(() => expect(h.seen.length).toBeGreaterThan(0))
    // name, the endpoint dialled now, the relays, and the host it is noted for.
    expect(h.seen[0]![0]).toBe('box')
    expect(h.seen[0]![1]).toBe(SET_EP)
    expect(h.seen[0]![3]).toEqual({ via: 'box' })
  })
})

describe('review round 3, L-N1: a Remove never turns off a walnut-net another Walnut runs', () => {
  const turnedOff = () => h.hostSends.some((x) => x.cmd === 'net.configure' && x.body.enabled === false)
  const servedBy = (other: boolean) => ({ serviceSet: '', daemonServes: { version: 'v', twin: null, capabilities: [], walnuts: { [walnutKeyOf(WALNUT_HOME)]: Date.now(), ...(other ? { '/home/other/.open-walnut': Date.now() - 60_000 } : {}) } } })

  it('flag on, no set record yet, another Walnut on the machine\'s daemon just now: the machine is not told to stop its walnut-net', async () => {
    process.env.WALNUT_HOST_SERVICE_SETS = '1'
    await hostServiceSets.write('net:box', null)
    h.connExtra = servedBy(true)
    await removeMachine('box')
    expect(turnedOff()).toBe(false)
  })

  it('this Walnut alone there: told to stop, as before', async () => {
    process.env.WALNUT_HOST_SERVICE_SETS = '1'
    await hostServiceSets.write('net:box', null)
    h.connExtra = servedBy(false)
    await removeMachine('box')
    expect(turnedOff()).toBe(true)
  })
})
