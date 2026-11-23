/**
 * Drill N2 (round 2, S5): with host_service_sets on, a host whose daemon another Walnut shares runs
 * that Walnut's walnut-net. This leader's connect push (`net.configure` with only its own member
 * list) replaced that walnut-net's whole list and dropped the other Walnut's members before any move.
 * Now: flag on and a shared daemon, no list is pushed there (net.status says nothing of the list
 * there, so it cannot be merged; this leader got on it by joining); flag off, the push is the very
 * one sent before; this Walnut's own set's daemon (after a move) still gets it.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const MAC = 'c'.repeat(64)
const BOX = 'b'.repeat(64)
const SET = '0123456789abcdef'
const h = vi.hoisted(() => ({
  hostSends: [] as Array<Record<string, unknown>>,
  conn: {} as Record<string, unknown>,
  /** The relay choice this machine's walnut-net runs on (a different one is a relay move). */
  running: 'own' as string,
}))

vi.mock('../../../src/core/config-manager.js', () => ({
  getConfig: async () => ({ net: { enabled: true }, hosts: { box: { hostname: 'box', transport: 'net', endpoint: 'b'.repeat(64), enabled: true } } }),
  isFallbackConfig: () => false,
}))
vi.mock('../../../src/core/config-store.js', () => ({ modifyConfigDoc: async (fn: (doc: Record<string, unknown>) => unknown) => fn({ net: { enabled: true } }) }))
vi.mock('../../../src/core/pairing-targets.js', () => ({ getCloudPairingEndpointAsync: async () => ({ origin: 'https://companion.example.invalid', token: 't' }) }))
vi.mock('../../../src/integrations/cloud-bridge-config.js', () => ({ machineProofHeaders: async () => ({}) }))
vi.mock('../../../src/core/hosts/link.js', () => ({ link: async () => ({ hasCapability: () => true, send: async (cmd: string) => (cmd === 'net.identity' ? { ok: true, endpointId: 'c'.repeat(64) } : { ok: true }) }) }))
vi.mock('../../../src/providers/daemon-connection.js', () => ({
  peekDaemonConnection: () => ({
    connected: true,
    hasCapability: () => true,
    send: async (cmd: string, body: Record<string, unknown>) => { if (cmd === 'net.configure') h.hostSends.push(body); return { ok: true } },
    ...h.conn,
  }),
  dropDaemonConnection: () => true,
}))
vi.mock('../../../src/core/net/net-seen.js', () => ({ machineLinks: async () => ({}), runningChoice: async () => h.running, waitForModes: async () => true, noteSeen: async () => {} }))
vi.mock('../../../src/core/net/net-rows.js', () => ({
  joinedOf: () => ({}), localMembers: () => [], markRemoving: async () => {}, netRows: () => [], removalsPending: async () => [], setJoined: async () => {}, netHostname: (name: string) => name,
  reconcileHosts: async () => ({ added: [], removed: [] }),
}))
vi.mock('../../../src/core/net/net-local.js', () => ({ clearLeftovers: async () => {}, leftoverJoins: async () => [] }))
vi.mock('../../../src/core/net/net-where.js', async (importOriginal) => ({ ...(await importOriginal<object>()), keepWhere: async () => {}, noteWhere: async () => false }))

import { resetNetForTest, syncNet } from '../../../src/core/net/net-mac.js'
import { hostServiceSets } from '../../../src/providers/service-set-leader.js'
import { walnutKeyOf } from '../../../src/providers/daemon-shared.js'
import { WALNUT_HOME } from '../../../src/constants.js'

const RELAY = 'https://relay.example.invalid'
let dir = ''
const saved: Record<string, string | undefined> = {}
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'net-shared-push-'))
  for (const k of ['WALNUT_SERVICE_SET_FILE', 'WALNUT_HOST_SERVICE_SETS', 'WALNUT_NET_ACTIVE']) saved[k] = process.env[k]
  process.env.WALNUT_SERVICE_SET_FILE = path.join(dir, 'sets.json')
  process.env.WALNUT_NET_ACTIVE = '1'
  vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ members: [{ id: MAC, name: 'Mac', role: 'mac' }, { id: BOX, name: 'box', role: 'host' }], relays: [RELAY], relayRoots: [] }), { status: 200 }))
})
afterEach(() => {
  resetNetForTest(); vi.unstubAllGlobals()
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v }
  fs.rmSync(dir, { recursive: true, force: true })
  h.hostSends = []; h.conn = {}; h.running = 'own'
})

/** A daemon another Walnut used `agoMs` ago (ten minutes: it is pairing now), as its record of served Walnuts says. */
const sharedServes = (agoMs = 10 * 60_000) => ({ version: 'v', twin: null, capabilities: [], walnuts: { [walnutKeyOf(WALNUT_HOME)]: Date.now(), '/home/other/.open-walnut': Date.now() - agoMs } })
const pushed = async () => { await syncNet(); await new Promise((r) => setTimeout(r, 50)); return h.hostSends }

describe('drill N2: the connect push never replaces another Walnut\'s walnut-net list', () => {
  it('flag off: the push is the one sent before, byte for byte, shared daemon or not', async () => {
    process.env.WALNUT_HOST_SERVICE_SETS = '0'
    h.conn = { serviceSet: '', daemonServes: sharedServes() }
    expect(await pushed()).toEqual([{ relays: [RELAY], relayRoots: [], members: [{ id: MAC, name: 'Mac', accept: true }] }])
  })

  it('flag on and a daemon another Walnut shares: no list is pushed there', async () => {
    process.env.WALNUT_HOST_SERVICE_SETS = '1'
    h.conn = { serviceSet: '', daemonServes: sharedServes() }
    expect(await pushed()).toEqual([])
  })

  it('flag on and a host whose record names this Walnut\'s own set while the link reaches another daemon: none either (after a move too)', async () => {
    process.env.WALNUT_HOST_SERVICE_SETS = '1'
    await hostServiceSets.write('net:box', { at: Date.now(), set: SET, movedAt: Date.now() })
    h.conn = { serviceSet: '', daemonServes: null }
    expect(await pushed()).toEqual([])
  })

  it('flag on: this Walnut\'s own set\'s daemon (the link after a move), or a daemon only this Walnut uses, still gets its list', async () => {
    process.env.WALNUT_HOST_SERVICE_SETS = '1'
    await hostServiceSets.write('net:box', { at: Date.now(), set: SET, movedAt: Date.now() })
    h.conn = { serviceSet: SET, daemonServes: { version: 'v', twin: null, capabilities: [], walnuts: { [walnutKeyOf(WALNUT_HOME)]: Date.now() } } }
    expect(await pushed()).toHaveLength(1)
    await hostServiceSets.write('net:box', null)
    h.hostSends = []
    h.conn = { serviceSet: '', daemonServes: { version: 'v', twin: null, capabilities: [], walnuts: { [walnutKeyOf(WALNUT_HOME)]: Date.now() } } }
    expect(await pushed()).toHaveLength(1)
  })
})

describe('review round 3, S4: this Walnut\'s own default walnut-net is never taken for another Walnut\'s', () => {
  beforeEach(() => { process.env.WALNUT_HOST_SERVICE_SETS = '1' })

  it('the host gave this Walnut the default set (record set \'\'): its list goes, whoever else was seen there just now', async () => {
    await hostServiceSets.write('net:box', { at: Date.now(), set: '' })
    h.conn = { serviceSet: '', daemonServes: sharedServes(60_000) }
    expect(await pushed()).toHaveLength(1)
  })

  it('no record: another Walnut seen there over half an hour ago is no reason to push nothing', async () => {
    h.conn = { serviceSet: '', daemonServes: sharedServes(3600_000) }
    expect(await pushed()).toHaveLength(1)
  })

  it('a relay move always pushes, even while another Walnut was seen there just now and no record says whose it is', async () => {
    h.running = 'public'
    h.conn = { serviceSet: '', daemonServes: sharedServes(60_000) }
    expect(await pushed()).toHaveLength(1)
  })
})
