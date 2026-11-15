/** Each explicit host adoption must own a sync pass, even when callers wake together. */
import { afterEach, describe, expect, it, vi } from 'vitest'
const state = vi.hoisted(() => ({ configure: vi.fn(), reconcile: vi.fn(), verify: vi.fn(), connect: vi.fn() }))
vi.mock('../../../src/core/config-manager.js', () => ({ getConfig: async () => ({ net: { enabled: true, relay: 'none' }, hosts: {} }) }))
vi.mock('../../../src/core/config-store.js', () => ({ modifyConfigDoc: async (fn: (doc: Record<string, unknown>) => unknown) => fn({ net: { enabled: true } }) }))
vi.mock('../../../src/core/pairing-targets.js', () => ({ getCloudPairingEndpointAsync: async () => null }))
vi.mock('../../../src/core/hosts/link.js', () => ({ link: async () => ({ hasCapability: () => true, send: async (cmd: string) => {
  if (cmd === 'net.identity') return { ok: true, endpointId: 'a'.repeat(64) }
  if (cmd === 'net.status') return { ok: true, node: { relayMode: 'none' } }
  if (cmd === 'net.configure') return state.configure()
  return { ok: true }
} }) }))
vi.mock('../../../src/core/net/net-rows.js', () => ({
  joinedOf: () => ({}), localMembers: () => [], markRemoving: vi.fn(), netRows: () => [], removalsPending: async () => [], setJoined: vi.fn(), netHostname: (name: string) => name,
  reconcileHosts: (...args: unknown[]) => state.reconcile(...args),
}))
vi.mock('../../../src/core/net/net-local.js', () => ({ clearLeftovers: async () => {}, leftoverJoins: async () => [] }))
vi.mock('../../../src/core/net/net-where.js', () => ({ keepWhere: async () => {}, noteWhere: vi.fn(), withWhere: (members: unknown) => members }))
vi.mock('../../../src/core/net/net-adopt.js', () => ({ verifiedAdoptions: (...args: unknown[]) => state.verify(...args) }))
vi.mock('../../../src/core/hosts/host-connect-action.js', () => ({ connectHostNow: (...args: unknown[]) => state.connect(...args) }))
import { resetNetForTest, syncNet } from '../../../src/core/net/net-mac.js'

afterEach(() => { resetNetForTest(); vi.resetAllMocks(); delete process.env.WALNUT_NET_ACTIVE })

describe('concurrent explicit adoption requests', () => {
  it('runs both requests separately after an existing sync, never returning success for the wrong one', async () => {
    process.env.WALNUT_NET_ACTIVE = '1'
    let release!: () => void
    const blocked = new Promise<void>((resolve) => { release = resolve })
    let first = true
    state.configure.mockImplementation(async () => { if (first) { first = false; await blocked } return { ok: true } })
    state.reconcile.mockResolvedValue({ added: [], removed: [] })
    state.verify.mockImplementation(async (_hosts, _members, requested: string[]) => requested.map((host) => ({ host, joined: `${host}-net`, endpoint: 'b'.repeat(64), hostname: `${host}.example.test`, route: 'route' })))
    const initial = syncNet()
    await vi.waitFor(() => expect(state.configure).toHaveBeenCalledOnce())
    const a = syncNet({ adopt: ['box-a'] })
    const b = syncNet({ enable: true, adopt: ['box-b'] })
    release()
    await Promise.all([initial, a, b])
    expect(state.verify.mock.calls.map((args) => args[2])).toEqual([['box-a'], ['box-b']])
    expect(state.reconcile.mock.calls.map((args) => args[1]?.adopt?.map((entry: { host: string }) => entry.host))).toEqual([[], ['box-a'], ['box-b']])
  })
})
