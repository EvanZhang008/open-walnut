/**
 * `walnut.hosts.list()` / `get()` carry a host's hub status (src/core/plugins/plugin-hosts.ts,
 * core/hosts/hub-ports.ts) only for a host `net.hub_ports` names; `get` asks only for its own
 * host, and `run` never waits on any hub status.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../src/core/config-manager.js', () => ({
  getConfig: vi.fn(async () => ({
    hosts: { 'home-pc': { hostname: 'home-pc.walnut-net.invalid' }, lab: { hostname: 'lab.example.test' } },
    net: { hub_ports: [{ port: 18403, hosts: ['home-pc'] }] },
  })),
}))
const asked = vi.hoisted(() => [] as string[])
vi.mock('../../src/core/hosts/hub-ports.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../src/core/hosts/hub-ports.js')>()
  return {
    ...original,
    hubPortStatus: vi.fn(async (host: string) => {
      asked.push(host)
      return [{ port: 18403, linked: true, forward: { localPort: 18403, listening: true, error: null, waiting: null }, needsUpdate: false, up: true, active: 0, opened: 3, refused: 0, lastConnectedAt: 1, lastRefusedAt: null, lastError: null }]
    }),
  }
})
vi.mock('../../src/core/hosts/host-script.js', () => ({ runScriptOnHost: vi.fn(async () => ({ code: 0, stdout: 'ok', stderr: '', timedOut: false, truncated: false })) }))

import { getPluginHost, listPluginHosts, runOnPluginHost } from '../../src/core/plugins/plugin-hosts.js'

beforeEach(() => { asked.length = 0 })

describe('hub status in walnut.hosts', () => {
  it('list carries hub on the named host only', async () => {
    const rows = await listPluginHosts()
    expect(rows.find((r) => r.alias === 'home-pc')?.hub).toEqual([expect.objectContaining({ port: 18403, up: true, opened: 3 })])
    expect(rows.find((r) => r.alias === 'lab')?.hub).toBeUndefined()
    expect(rows.find((r) => r.alias === '__local__')?.hub).toBeUndefined()
    expect(asked).toEqual(['home-pc'])
  })

  it('get asks only for its own host', async () => {
    expect((await getPluginHost('lab'))?.hub).toBeUndefined()
    expect(asked).toEqual([])
    expect((await getPluginHost('home-pc'))?.hub?.[0].up).toBe(true)
    expect(asked).toEqual(['home-pc'])
  })

  it('run never waits on a hub status', async () => {
    expect((await runOnPluginHost('home-pc', { script: 'true' })).stdout).toBe('ok')
    expect(asked).toEqual([])
  })
})
