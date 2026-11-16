/**
 * copyPack's direct route (src/core/transfer/workspace.ts): the target host's daemon copies the
 * pack from the source over its own SSH (`ssh <source> true`, then scp). A source with no SSH
 * door (a machine on the host network, hostname `<alias>.walnut-net.invalid`; the cloud box)
 * is never tried that way: the copy is relayed through the links at once, and no failed reach
 * is written into the target's profile (which would skip the direct route for a day).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../../src/core/config-manager.js', () => ({
  getConfig: vi.fn(async () => ({
    hosts: {
      clouddev: { hostname: 'clouddev.walnut-net.invalid', transport: 'net', endpoint: 'cd'.repeat(32) },
      cloudbox: { hostname: 'box.example.test', cloud_box: true },
      devbox: { hostname: 'devbox.example.test', user: 'me', port: 2222 },
      laptop: { hostname: 'laptop.example.test' },
    },
  })),
}))
const reachHost = vi.fn(async () => ({ reachable: true, ms: 1 }))
const fetchFromHost = vi.fn(async () => ({ ok: true, results: [] }))
const relayFile = vi.fn(async () => undefined)
vi.mock('../../../src/core/transfer/daemon-transfer-client.js', () => ({ reachHost, fetchFromHost, relayFile }))
const recordReach = vi.fn(async () => undefined)
vi.mock('../../../src/core/hosts/host-profile.js', () => ({
  readHostProfile: vi.fn(async () => null), recordReach, repoKey: (_u: unknown, f: string) => f,
}))

const { copyPack } = await import('../../../src/core/transfer/workspace.js')

const pack = { outDir: '/tmp/p', meta: null, files: [{ name: 'changes.patch', size: 3, sha256: 'a'.repeat(64) }] } as never

beforeEach(() => { reachHost.mockClear(); fetchFromHost.mockClear(); relayFile.mockClear(); recordReach.mockClear() })

describe('copyPack route', () => {
  it.each(['clouddev', 'cloudbox'])('relays a pack from %s, which has no SSH door, without asking the target to ssh there', async (source) => {
    const moved = await copyPack(pack, { sourceHost: source, targetHost: 'laptop', bundleDir: '/b' })
    expect(moved.route).toBe('relay')
    expect(reachHost).not.toHaveBeenCalled()
    expect(fetchFromHost).not.toHaveBeenCalled()
    expect(recordReach).not.toHaveBeenCalled()
    expect(relayFile).toHaveBeenCalledTimes(1)
  })

  it('still copies host to host from an SSH source', async () => {
    const moved = await copyPack(pack, { sourceHost: 'devbox', targetHost: 'laptop', bundleDir: '/b' })
    expect(moved.route).toBe('direct')
    expect(reachHost).toHaveBeenCalledWith('laptop', { host: 'devbox.example.test', user: 'me', port: 2222 })
  })
})
