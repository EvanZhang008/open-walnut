/**
 * The host network's sync under the leader switch's permit (src/core/net/net-mac.ts runSync,
 * pushToHost, readCompanionList, retellNet), wired as the server runs it with only the edges faked:
 * the daemons (this machine's and each host's link), the permit's record, the companion's API.
 *
 *   - a record that names neither this machine nor a handover from it: the sync fails with 409
 *     not_permit_holder, this machine's walnut-net and every host are told nothing, and a host that
 *     connects afterwards is handed no list either;
 *   - this machine leads from a machine that has a host row (a switch moved the leader there): that
 *     row is never pushed to, the others are, each answer reported (told, missed with why);
 *   - with a companion, a leader already on its list as a host never puts itself in the Mac's place
 *     (no PUT /net/self), and with no permit it does, as before;
 *   - retellNet says whether the new holder of a handover is let in: by its hello, by an endpoint
 *     the caller names, or not at all (reported, never only warned).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { netKey } from '../../helpers/net-keys.js'

const MAC = netKey('sync-mac')
const DEV = netKey('sync-dev')
const OLD = netKey('sync-old')

const w = vi.hoisted(() => ({
  self: '' as string,
  hosts: {} as Record<string, { transport: string; endpoint: string }>,
  members: [] as Array<Record<string, unknown>>,
  permit: null as null | { machine: string; record: { holder: string; kind: string; from?: string; number: number } | null },
  hello: {} as Record<string, string>,
  conns: {} as Record<string, { connected: boolean; sent: Array<[string, unknown]>; answer?: () => unknown }>,
  localSent: [] as Array<[string, unknown]>,
  pairing: null as null | { origin: string; token: string },
  companion: { members: [] as Array<Record<string, unknown>>, puts: 0 },
  onConnected: null as null | ((host: string) => void),
}))

vi.mock('../../../src/core/config-manager.js', () => ({ getConfig: async () => ({ net: { enabled: true, relay: w.pairing ? undefined : 'none' }, hosts: w.hosts }) }))
vi.mock('../../../src/core/config-store.js', () => ({ modifyConfigDoc: async (fn: (doc: Record<string, unknown>) => unknown) => fn({ net: { enabled: true } }) }))
vi.mock('../../../src/core/pairing-targets.js', () => ({ getCloudPairingEndpointAsync: async () => w.pairing }))
vi.mock('../../../src/integrations/cloud-bridge-config.js', () => ({ machineProofHeaders: async () => ({}) }))
vi.mock('../../../src/core/hosts/link.js', () => ({ link: async () => ({ hasCapability: () => true, send: async (cmd: string, payload: unknown) => {
  w.localSent.push([cmd, payload])
  if (cmd === 'net.identity') return { ok: true, endpointId: w.self }
  if (cmd === 'net.status') return { ok: true, node: { relayMode: w.pairing ? 'own' : 'none' } }
  return { ok: true }
} }) }))
vi.mock('../../../src/providers/daemon-connection.js', () => ({
  peekDaemonConnection: (name: string) => {
    const c = w.conns[name]
    return c ? { connected: c.connected, hasCapability: () => true, send: async (cmd: string, payload: unknown) => { c.sent.push([cmd, payload]); return c.answer ? c.answer() : { ok: true } } } : null
  },
  pooledMachineIdOf: (name: string) => w.hello[name] ?? null,
  addOnDaemonHostConnected: (fn: (host: string) => void) => { w.onConnected = fn; return () => { w.onConnected = null } },
}))
vi.mock('../../../src/core/host-server/index.js', () => ({ hostServerLink: () => null }))
vi.mock('../../../src/core/session-channel/leader-permit.js', () => ({
  runningLeaderPermit: () => (w.permit ? { machine: w.permit.machine, runtime: { status: () => ({ record: w.permit!.record }) } } : null),
}))
vi.mock('../../../src/core/net/net-rows.js', () => ({
  joinedOf: () => ({}), localMembers: () => w.members, markRemoving: vi.fn(), netRows: () => [], removalsPending: async () => [], setJoined: vi.fn(), netHostname: (name: string) => name,
  reconcileHosts: async () => ({ added: [], removed: [] }),
}))
vi.mock('../../../src/core/net/net-local.js', () => ({ clearLeftovers: async () => {}, leftoverJoins: async () => [] }))
vi.mock('../../../src/core/net/net-where.js', () => ({ keepWhere: async () => {}, noteWhere: vi.fn(), withWhere: (members: unknown) => members }))
vi.mock('../../../src/core/net/net-seen.js', () => ({ machineLinks: async () => [], noteSeen: async () => {}, runningChoice: async () => null, waitForModes: async () => true }))
vi.mock('../../../src/core/net/net-adopt.js', () => ({ verifiedAdoptions: async () => [] }))

import { resetNetForTest, retellNet, startNet, syncNet } from '../../../src/core/net/net-mac.js'

const conn = (connected = true) => ({ connected, sent: [] as Array<[string, unknown]> })
const configures = (name: string) => w.conns[name]!.sent.filter(([cmd]) => cmd === 'net.configure').map(([, p]) => p as { members: Array<{ id: string }> })

beforeEach(() => {
  process.env.WALNUT_NET_ACTIVE = '1'
  Object.assign(w, {
    self: MAC, hello: {}, localSent: [], pairing: null, permit: null, onConnected: null,
    hosts: { clouddev: { transport: 'net', endpoint: DEV }, olddev: { transport: 'net', endpoint: OLD } },
    members: [
      { id: MAC, name: 'mac', role: 'mac' },
      { id: DEV, name: 'clouddev', role: 'host' },
      { id: OLD, name: 'olddev', role: 'host' },
    ],
    conns: { clouddev: conn(), olddev: conn() },
    companion: { members: [], puts: 0 },
  })
})
afterEach(() => { resetNetForTest(); vi.unstubAllGlobals(); delete process.env.WALNUT_NET_ACTIVE })

describe('a record that does not name this machine', () => {
  it('fails the sync with not_permit_holder and tells nobody; a host that connects afterwards gets no list either', async () => {
    // First a sync this machine leads (the Mac holds the permit): every host is told.
    w.permit = { machine: 'm-mac', record: { holder: 'm-mac', kind: 'renew', number: 3 } }
    await startNet()
    const first = await retellNet()
    expect(first.state.error).toBeNull()
    expect(first.told.sort()).toEqual(['clouddev', 'olddev'])
    // Then the record names another machine (it was handed over and committed elsewhere).
    w.permit = { machine: 'm-mac', record: { holder: 'm-dev', kind: 'renew', number: 7 } }
    for (const c of Object.values(w.conns)) c.sent.length = 0
    w.localSent.length = 0
    const r = await retellNet()
    expect(r.state.error).toMatch(/does not hold the leader's write permission/)
    await expect(syncNet({ enable: true })).rejects.toMatchObject({ status: 409, code: 'not_permit_holder' })
    expect(w.localSent.filter(([cmd]) => cmd === 'net.configure')).toEqual([])
    // A host reached again is handed the list on connect, but not while no record names this machine.
    w.onConnected!('olddev')
    // Negative: the connect push reads the rows and returns at the refusal, all on the next turns.
    for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r))
    expect(configures('clouddev')).toEqual([])
    expect(configures('olddev')).toEqual([])
  })
})

describe('under a running permit', () => {
  it('a leader on a machine with a host row never pushes to that row; each other host\'s answer is reported', async () => {
    // A switch moved the leader to clouddev: this machine's own id is DEV, and its host row stays.
    w.self = DEV
    w.permit = { machine: 'm-dev', record: { holder: 'm-dev', kind: 'renew', number: 8 } }
    w.conns.olddev!.answer = () => ({ ok: false, error: 'walnut-net is stopping' })
    w.hosts = { ...w.hosts, gone: { transport: 'net', endpoint: netKey('sync-gone') } }
    w.conns.gone = conn(false)
    const r = await retellNet()
    expect(configures('clouddev')).toEqual([])
    expect(r.told).toEqual([])
    expect(r.missed.sort((a, b) => a.host.localeCompare(b.host))).toEqual([
      { host: 'gone', why: 'not connected' },
      { host: 'olddev', why: 'walnut-net is stopping' },
    ])
    // The list the host was handed lets in the holder only, and never names the host itself.
    expect(configures('olddev')[0]!.members.map((m) => m.id)).toEqual([DEV])
    // Nobody else holds the record: there is no new leader to let in.
    expect(r.newLeaderLetIn).toBeNull()
  })

  it('during a handover: the new holder is let in when its hello says its machine, or when the caller names its endpoint; else it is reported, not only warned', async () => {
    w.permit = { machine: 'm-mac', record: { holder: 'm-dev', kind: 'handover', from: 'm-mac', number: 6 } }
    // No hello from clouddev yet (reached over ssh, or not connected over the network).
    const blind = await retellNet()
    expect(blind.newLeaderLetIn).toBe(false)
    expect(blind.unknownMachines).toEqual(['m-dev'])
    expect(configures('olddev').at(-1)!.members.map((m) => m.id)).toEqual([MAC])
    // The caller (the switch) knows the new leader's network id: it is let in everywhere.
    const named = await retellNet({ endpoints: { 'm-dev': DEV } })
    expect(named.newLeaderLetIn).toBe(true)
    expect(configures('olddev').at(-1)!.members.map((m) => m.id)).toEqual([MAC, DEV])
    // The endpoint named is for that sync only; the hello finds it too.
    w.hello = { clouddev: 'm-dev' }
    const hello = await retellNet()
    expect(hello.newLeaderLetIn).toBe(true)
    expect(hello.told.sort()).toEqual(['clouddev', 'olddev'])
    // clouddev itself is told to let in the Mac (the old holder), never itself.
    expect(configures('clouddev').at(-1)!.members.map((m) => m.id)).toEqual([MAC])
  })
})

describe('with a companion', () => {
  function companion(): void {
    w.pairing = { origin: 'https://companion.example.invalid', token: 't' }
    vi.stubGlobal('fetch', async (url: string, init: { method: string }) => {
      const p = new URL(url).pathname
      if (p.endsWith('/net/self') && init.method === 'PUT') { w.companion.puts++; return new Response(JSON.stringify({ ok: true }), { status: 200 }) }
      if (p.endsWith('/net/info')) return new Response(JSON.stringify({ members: w.companion.members, relays: ['https://relay.example.invalid/'], relayRoots: ['root-1'] }), { status: 200 })
      return new Response(JSON.stringify({ error: { code: 'not_found' } }), { status: 404 })
    })
  }

  it('a leader already on the companion\'s list as a host leads from there: it never takes the Mac\'s place', async () => {
    companion()
    w.self = DEV
    w.companion.members = [{ id: MAC, name: 'mac', role: 'mac' }, { id: DEV, name: 'clouddev', role: 'host' }, { id: OLD, name: 'olddev', role: 'host' }]
    w.permit = { machine: 'm-dev', record: { holder: 'm-dev', kind: 'renew', number: 8 } }
    const r = await retellNet()
    expect(r.state.error).toBeNull()
    expect(w.companion.puts).toBe(0)
  })

  it('with no permit running, a Mac not on the list as the mac puts itself there, as before', async () => {
    companion()
    w.companion.members = [{ id: DEV, name: 'clouddev', role: 'host' }]
    const r = await retellNet()
    expect(r.state.error).toBeNull()
    expect(w.companion.puts).toBe(1)
  })
})
