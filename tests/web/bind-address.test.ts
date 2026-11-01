/**
 * serverBindAddress (src/web/bind-address.ts): where the web server listens. A host replica
 * is loopback only; the caller's choice wins; WALNUT_BIND_ADDRESS (the cloud companion's
 * unit sets 127.0.0.1) comes next; anything but an IP literal there falls back to loopback,
 * never to every interface.
 */
import { describe, expect, it } from 'vitest'
import { serverBindAddress } from '../../src/web/bind-address.js'

describe('serverBindAddress', () => {
  it('a host replica stays on loopback whatever is asked', () => {
    expect(serverBindAddress({ replica: true, requested: '0.0.0.0', env: { WALNUT_BIND_ADDRESS: '0.0.0.0' } })).toBe('127.0.0.1')
  })
  it('unset means every interface, as before', () => {
    expect(serverBindAddress({ replica: false, env: {} })).toBeUndefined()
    expect(serverBindAddress({ replica: false, env: { WALNUT_BIND_ADDRESS: '  ' } })).toBeUndefined()
  })
  it('the caller wins, then the env', () => {
    expect(serverBindAddress({ replica: false, requested: '::1', env: { WALNUT_BIND_ADDRESS: '127.0.0.1' } })).toBe('::1')
    expect(serverBindAddress({ replica: false, env: { WALNUT_BIND_ADDRESS: ' 127.0.0.1 ' } })).toBe('127.0.0.1')
    expect(serverBindAddress({ replica: false, env: { WALNUT_BIND_ADDRESS: '::1' } })).toBe('::1')
  })
  it('a name or a typo never opens it wider: loopback', () => {
    for (const v of ['localhost', '127.0.0.l', 'example.com', '0.0.0.0.0']) {
      expect(serverBindAddress({ replica: false, env: { WALNUT_BIND_ADDRESS: v } })).toBe('127.0.0.1')
    }
  })
})
