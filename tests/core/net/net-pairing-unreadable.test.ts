/**
 * A pairing this Mac cannot read right now is never "no companion" (2026-11-22).
 *
 * At load 400 the data repo's `git remote` read failed, the read answered null, the sync took
 * that as "unpaired", picked the public relay and handed it to every machine first. clouddev and
 * olddev moved to the public relay while this Mac stayed on the companion's, and the Mac could
 * not reach them for 33 minutes until a later sync moved them back.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

const MAC = 'a'.repeat(64)
const BOX = 'b'.repeat(64)
const COMPANION_RELAY = 'https://relay.example.invalid'
const h = vi.hoisted(() => ({
  pairing: 'paired' as 'paired' | 'unreadable',
  pairingCalls: [] as Array<unknown>,
  macConfigs: [] as Array<Record<string, unknown>>,
  hostConfigs: [] as Array<Record<string, unknown>>,
  netEnabled: true,
}))

vi.mock('../../../src/core/config-manager.js', () => ({
  getConfig: async () => ({
    net: { enabled: h.netEnabled },
    hosts: { box: { hostname: 'box.walnut-net.invalid', transport: 'net', endpoint: 'b'.repeat(64), enabled: true } },
  }),
}))
vi.mock('../../../src/core/config-store.js', () => ({ modifyConfigDoc: async (fn: (doc: Record<string, unknown>) => unknown) => fn({ net: { enabled: true } }) }))
vi.mock('../../../src/core/pairing-targets.js', () => ({
  getCloudPairingEndpointAsync: async (options?: unknown) => {
    h.pairingCalls.push(options)
    // As the real read does: a failed git answers null, unless the caller asked for strict.
    if (h.pairing === 'unreadable') {
      if ((options as { strict?: boolean } | undefined)?.strict) throw new Error('Command failed: git remote (timed out)')
      return null
    }
    return { origin: 'https://companion.example.invalid', token: 't' }
  },
}))
vi.mock('../../../src/integrations/cloud-bridge-config.js', () => ({ machineProofHeaders: async () => ({}) }))
vi.mock('../../../src/core/hosts/link.js', () => ({ link: async () => ({ hasCapability: () => true, send: async (cmd: string, body: Record<string, unknown>) => {
  if (cmd === 'net.identity') return { ok: true, endpointId: 'a'.repeat(64) }
  if (cmd === 'net.configure') { h.macConfigs.push(body); return { ok: true } }
  return { ok: true }
} }) }))
vi.mock('../../../src/providers/daemon-connection.js', () => ({
  peekDaemonConnection: () => ({
    connected: true,
    hasCapability: () => true,
    send: async (cmd: string, body: Record<string, unknown>) => { if (cmd === 'net.configure') h.hostConfigs.push(body); return { ok: true } },
  }),
}))
vi.mock('../../../src/core/net/net-seen.js', () => ({
  machineLinks: async () => ({}), noteSeen: async () => {}, runningChoice: async () => 'own', waitForModes: async () => true,
}))
vi.mock('../../../src/core/net/net-rows.js', () => ({
  joinedOf: () => ({}), localMembers: () => [], markRemoving: vi.fn(), netRows: () => [], removalsPending: async () => [], setJoined: vi.fn(), netHostname: (name: string) => name,
  reconcileHosts: async () => ({ added: [], removed: [] }),
}))
vi.mock('../../../src/core/net/net-local.js', () => ({ clearLeftovers: async () => {}, leftoverJoins: async () => [] }))
vi.mock('../../../src/core/net/net-where.js', () => ({ keepWhere: async () => {}, noteWhere: vi.fn(), withWhere: (members: unknown) => members }))

import { netState, removeMachine, resetNetForTest, syncNet } from '../../../src/core/net/net-mac.js'
import { markRemoving } from '../../../src/core/net/net-rows.js'

const members = [
  { id: MAC, name: 'Mac', role: 'mac' },
  { id: BOX, name: 'box', role: 'host' },
]

afterEach(() => {
  resetNetForTest(); vi.unstubAllGlobals(); delete process.env.WALNUT_NET_ACTIVE
  h.pairing = 'paired'; h.pairingCalls = []; h.macConfigs = []; h.hostConfigs = []; h.netEnabled = true
})

describe('a pairing that cannot be read is not "no companion"', () => {
  it('fails the sync and hands no machine another relay; the next readable sync goes on as before', async () => {
    process.env.WALNUT_NET_ACTIVE = '1'
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ members, relays: [COMPANION_RELAY], relayRoots: [] }), { status: 200 }))
    // Paired and readable: the companion's relay everywhere.
    await syncNet()
    await vi.waitFor(() => expect(h.hostConfigs.length).toBeGreaterThan(0))
    expect(h.macConfigs.at(-1)).toMatchObject({ relays: [COMPANION_RELAY] })
    expect(h.hostConfigs.every((c) => c.relayMode === undefined)).toBe(true)
    const before = { mac: h.macConfigs.length, hosts: h.hostConfigs.length }

    // The read fails (git timed out under load): nothing is configured anywhere.
    h.pairing = 'unreadable'
    const s = await syncNet()
    expect(s.error).toMatch(/git remote/)
    expect(h.macConfigs.length).toBe(before.mac)
    expect(h.hostConfigs.length).toBe(before.hosts)
    expect(netState().relay).not.toBe('public')
    // Every read of the pairing the sync makes is strict (a throw, never a null).
    expect(h.pairingCalls.length).toBeGreaterThan(0)
    expect(h.pairingCalls.every((o) => (o as { strict?: boolean } | undefined)?.strict === true)).toBe(true)

    // Readable again: the companion's relay, never a move.
    h.pairing = 'paired'
    await syncNet()
    await vi.waitFor(() => expect(h.hostConfigs.length).toBeGreaterThan(before.hosts))
    expect([...h.macConfigs, ...h.hostConfigs].some((c) => c.relayMode === 'public')).toBe(false)
  })

  it('Remove fails with nothing marked when the pairing cannot be read (a later sync would finish half of it)', async () => {
    process.env.WALNUT_NET_ACTIVE = '1'
    h.pairing = 'unreadable'
    await expect(removeMachine('box')).rejects.toMatchObject({ code: 'pairing_unreadable', status: 503 })
    expect(markRemoving).not.toHaveBeenCalled()
    expect(h.hostConfigs).toEqual([])
  })

  it('a read that fails while the network is off is no error', async () => {
    h.netEnabled = false
    h.pairing = 'unreadable'
    const s = await syncNet()
    expect(s.error).toBeNull()
    expect(s.enabled).toBe(false)
    expect(h.macConfigs).toEqual([])
  })
})
