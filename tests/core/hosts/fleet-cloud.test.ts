/**
 * The fleet view on the cloud companion (CLOUD_MODE): it holds no daemon link of
 * its own, so each host card says only whether that host's bridge is connected,
 * the companion never lists itself as the primary, and nothing dials.
 */
import { describe, expect, it, vi } from 'vitest'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('host-fleet-cloud', { CLOUD_MODE: true }))
vi.mock('../../../src/core/config-manager.js', async (orig) => ({
  ...(await orig<typeof import('../../../src/core/config-manager.js')>()),
  getConfig: async () => ({ hosts: { devbox: { hostname: 'devbox.example.internal', label: 'Dev box' }, spare: { hostname: 'spare.example.internal' } } }),
}))
vi.mock('../../../src/web/ws/bridge-registry.js', () => ({
  bridgeForHost: (host: string) => ({ connected: host === 'devbox' }),
}))

import { getFleetHost, listFleet } from '../../../src/core/hosts/fleet.js'

describe('listFleet on the companion', () => {
  it('lists each host by its bridge, and no primary', async () => {
    const hosts = await listFleet()
    expect(hosts.map((h) => [h.host, h.connection.kind, h.connection.connected])).toEqual([['devbox', 'bridge', true], ['spare', 'bridge', false]])
    expect(hosts[0]).toMatchObject({ now: null, history: null, spend: null, daemon: null })
    expect(await getFleetHost('__local__')).toBeNull()
    expect((await getFleetHost('spare'))?.connection.phaseLabel).toBe('Its bridge is not connected')
  })
})
