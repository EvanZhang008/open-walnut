/** A matching name is not enough to migrate a host: its old live daemon proves its key. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { adoptionRoute, verifiedAdoptions } from '../../../src/core/net/net-adopt.js'
import { netHostname } from '../../../src/core/net/net-rows.js'

const { peek, targets } = vi.hoisted(() => ({ peek: vi.fn(), targets: vi.fn(() => true) }))
vi.mock('../../../src/providers/daemon-connection.js', () => ({ peekDaemonConnection: peek, pooledConnectionTargets: targets }))
const endpoint = '60d53783dcf0c6e95fe6c2ff390fd3131d42a167eecee7eac15e57e69ed36f5b'
const rows = {
  devbox: { hostname: 'devbox.example.test', enabled: true },
  'devbox-net': { hostname: netHostname('devbox-net'), transport: 'net', endpoint },
}
const members = [{ id: endpoint, name: 'devbox', role: 'host' }]
afterEach(() => { vi.resetAllMocks(); targets.mockReturnValue(true) })

describe('network adoption identity proof', () => {
  it('uses only the existing live link, with a short deadline', async () => {
    const send = vi.fn().mockResolvedValue({ ok: true, endpointId: endpoint })
    peek.mockReturnValue({ connected: true, hasCapability: () => true, send })
    await expect(verifiedAdoptions(rows, members, ['devbox'])).resolves.toEqual([{ host: 'devbox', joined: 'devbox-net', endpoint, hostname: 'devbox.example.test', route: adoptionRoute(rows.devbox) }])
    expect(send).toHaveBeenCalledWith('net.identity', {}, 5_000)
  })

  it('refuses an old pooled link that no longer matches the configured machine', async () => {
    const send = vi.fn().mockResolvedValue({ ok: true, endpointId: endpoint })
    peek.mockReturnValue({ connected: true, hasCapability: () => true, send })
    targets.mockReturnValue(false)
    await expect(verifiedAdoptions(rows, members, ['devbox'])).resolves.toEqual([])
    expect(send).not.toHaveBeenCalled()
  })

  it('repeating an adopted request needs no old SSH link or another identity call', async () => {
    const adopted = { devbox: { hostname: netHostname('devbox'), transport: 'net', endpoint } }
    await expect(verifiedAdoptions(adopted, members, ['devbox'])).resolves.toMatchObject([{ host: 'devbox', joined: 'devbox', endpoint }])
    expect(peek).not.toHaveBeenCalled()
  })

  it('does not change default join behavior without an explicit request', async () => {
    await expect(verifiedAdoptions(rows, members, [])).resolves.toEqual([])
    expect(peek).not.toHaveBeenCalled()
  })

  it.each([
    ['offline', { connected: false }],
    ['older daemon', { connected: true, hasCapability: () => false }],
    ['different key', { connected: true, hasCapability: () => true, send: vi.fn().mockResolvedValue({ ok: true, endpointId: 'a'.repeat(64) }) }],
    ['refused', { connected: true, hasCapability: () => true, send: vi.fn().mockResolvedValue({ ok: false, endpointId: endpoint }) }],
    ['timeout', { connected: true, hasCapability: () => true, send: vi.fn().mockRejectedValue(new Error('timeout')) }],
  ])('leaves %s unchanged, without starting any SSH dial', async (_label, connection) => {
    peek.mockReturnValue(connection)
    await expect(verifiedAdoptions(rows, members, ['devbox'])).resolves.toEqual([])
  })
})
