/**
 * A machine on the host network is written by the network, never by the Remote Hosts
 * editor (src/core/net/net-hosts.ts, used by PUT /api/config): an editor save that
 * leaves one out, or an older editor that drops its transport and endpoint, keeps it
 * as it was; the editor may switch it on or off and label it; and an editor cannot make
 * a new `net` row of its own.
 */
import { describe, expect, it } from 'vitest'
import { keepNetHosts, NetHostAliasTaken } from '../../../src/core/net/net-hosts.js'

const E = 'e'.repeat(64)
const current = {
  devbox: { hostname: 'devbox.example', user: 'me', enabled: true },
  'gpu-box': { hostname: 'gpu-box.walnut-net.invalid', label: 'gpu-box', transport: 'net', endpoint: E, enabled: true, capabilities: ['gpu'] },
}

describe('keepNetHosts', () => {
  it('keeps a net machine the editor left out', () => {
    const out = keepNetHosts({ devbox: { hostname: 'devbox.example', enabled: true } }, current)
    expect(out['gpu-box']).toEqual(current['gpu-box'])
    expect(out.devbox).toEqual({ hostname: 'devbox.example', enabled: true })
  })

  it('an older editor that drops transport and endpoint cannot turn it into an SSH host', () => {
    const out = keepNetHosts({ 'gpu-box': { hostname: 'gpu-box.walnut-net.invalid', enabled: false, label: 'GPU' } }, current)
    expect(out['gpu-box']).toEqual({ ...current['gpu-box'], enabled: false, label: 'GPU' })
  })

  it('a net row the editor invents is only an SSH row', () => {
    const out = keepNetHosts({ x: { hostname: 'x', transport: 'net', endpoint: 'f'.repeat(64) } }, current)
    expect(out.x).toEqual({ hostname: 'x' })
  })

  it('an SSH host saved under the name of a net machine is refused, not swallowed', () => {
    expect(() => keepNetHosts({ 'gpu-box': { hostname: 'gpu.example', user: 'me' } }, current)).toThrow(NetHostAliasTaken)
    // The same name with no hostname (only a switch or a label) is not a new host.
    expect(keepNetHosts({ 'gpu-box': { enabled: false } }, current)['gpu-box']).toMatchObject({ enabled: false, transport: 'net' })
  })

  it('removing an SSH host still works', () => {
    const out = keepNetHosts({}, current)
    expect(out.devbox).toBeUndefined()
    expect(out['gpu-box']).toBeDefined()
  })
})
