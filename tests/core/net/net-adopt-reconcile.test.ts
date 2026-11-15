/** Adoption uses the same atomic host-list writer as every join, preserving concurrent settings. */
import { beforeEach, describe, expect, it, vi } from 'vitest'
const state = vi.hoisted(() => ({ doc: {} as Record<string, unknown>, emit: vi.fn(), drop: vi.fn(), forget: vi.fn() }))
vi.mock('../../../src/core/config-store.js', () => ({ modifyConfigDoc: async (fn: (doc: Record<string, unknown>) => { result: unknown }) => fn(state.doc).result }))
vi.mock('../../../src/core/event-bus.js', () => ({ bus: { emit: state.emit }, EventNames: { CONFIG_CHANGED: 'config:changed' } }))
vi.mock('../../../src/providers/daemon-connection.js', () => ({ dropDaemonConnection: state.drop }))
vi.mock('../../../src/core/hosts/link.js', () => ({ forgetLinkTarget: state.forget }))
import { reconcileHosts, netHostname } from '../../../src/core/net/net-rows.js'
import { adoptionRoute } from '../../../src/core/net/net-adopt.js'

const endpoint = '60d53783dcf0c6e95fe6c2ff390fd3131d42a167eecee7eac15e57e69ed36f5b'
const adoption = { host: 'devbox', joined: 'devbox-net', endpoint, hostname: 'devbox.example.test', route: adoptionRoute({ hostname: 'devbox.example.test' }) }
const members = [{ id: endpoint, name: 'devbox', role: 'host' as const }]
beforeEach(() => {
  vi.clearAllMocks()
  state.doc = { hosts: {
    devbox: { hostname: adoption.hostname, label: 'Existing host', enabled: true, server: { enabled: true } },
    'devbox-net': { hostname: netHostname('devbox-net'), transport: 'net', endpoint, enabled: true },
  }, extra: { keep: true } }
})

describe('host adoption in the join reconcile', () => {
  it('keeps the old alias, drops both old pool targets, and tells existing config consumers', async () => {
    await expect(reconcileHosts(members, { adopt: [adoption] })).resolves.toEqual({ added: [], removed: ['devbox-net'] })
    expect(state.doc).toMatchObject({ hosts: { devbox: { hostname: netHostname('devbox'), transport: 'net', endpoint, label: 'Existing host', server: { enabled: true } } }, extra: { keep: true } })
    expect(state.doc.hosts).not.toHaveProperty('devbox-net')
    expect(state.drop.mock.calls).toEqual([['devbox-net'], ['devbox']])
    expect(state.forget.mock.calls).toEqual([['devbox'], ['devbox-net']])
    expect(state.emit).toHaveBeenCalledOnce()
    // Once adopted, later syncs keep it under its original alias and do not recreate a twin.
    await expect(reconcileHosts(members)).resolves.toEqual({ added: [], removed: [] })
    expect(state.doc.hosts).not.toHaveProperty('devbox-net')
    expect(state.emit).toHaveBeenCalledOnce()
    await expect(reconcileHosts(members, { adopt: [{ ...adoption, joined: 'devbox', hostname: netHostname('devbox') }] })).resolves.toEqual({ added: [], removed: [] })
    expect(state.drop).toHaveBeenCalledTimes(2)
    expect(state.emit).toHaveBeenCalledOnce()
  })

  it('a changed source identity refuses before the writer changes anything or closes a link', async () => {
    const hosts = state.doc.hosts as Record<string, Record<string, unknown>>
    hosts.devbox.hostname = 'other.example.test'
    const before = structuredClone(state.doc)
    await expect(reconcileHosts(members, { adopt: [adoption] })).rejects.toThrow('existing host changed')
    expect(state.doc).toEqual(before)
    expect(state.drop).not.toHaveBeenCalled()
    expect(state.emit).not.toHaveBeenCalled()
  })
})
