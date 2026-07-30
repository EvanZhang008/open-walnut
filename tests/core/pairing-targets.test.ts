/**
 * Pairing-target resolution — the QR must never point a phone at loopback.
 * Regression guard for 2026-07-28: a scanned QR carried
 * `server=http://localhost:3456`, which on the phone resolves to the phone
 * itself, so the iOS app could never connect.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import os from 'node:os'

vi.mock('../../src/integrations/git-sync.js', () => ({
  getCloudRemoteCredentials: vi.fn(() => null),
}))

import { detectLanAddress, isLoopbackOrigin, getPairingTargets } from '../../src/core/pairing-targets.js'
import { getCloudRemoteCredentials } from '../../src/integrations/git-sync.js'

type Ifaces = ReturnType<typeof os.networkInterfaces>

function mockIfaces(map: Record<string, Array<{ address: string; family: string; internal: boolean }>>): void {
  vi.spyOn(os, 'networkInterfaces').mockReturnValue(map as unknown as Ifaces)
}

beforeEach(() => {
  vi.mocked(getCloudRemoteCredentials).mockReturnValue(null)
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('isLoopbackOrigin', () => {
  it('flags every loopback spelling and passes real hosts', () => {
    expect(isLoopbackOrigin('http://localhost:3456')).toBe(true)
    expect(isLoopbackOrigin('http://127.0.0.1:3456')).toBe(true)
    expect(isLoopbackOrigin('http://[::1]:3456')).toBe(true)
    expect(isLoopbackOrigin('http://192.168.1.20:3456')).toBe(false)
    expect(isLoopbackOrigin('https://example.invalid')).toBe(false)
    expect(isLoopbackOrigin('not a url')).toBe(false)
  })
})

describe('detectLanAddress', () => {
  it('prefers a physical en* interface over VPN/virtual ones', () => {
    mockIfaces({
      utun1000: [{ address: '11.113.5.186', family: 'IPv4', internal: false }],
      en0: [{ address: '192.168.1.20', family: 'IPv4', internal: false }],
    })
    // 11.x is RFC1918 (10/8 only covers 10.x) — so utun's address here is
    // public and rejected anyway; the point is en0 wins when both qualify.
    expect(detectLanAddress()).toBe('192.168.1.20')
  })

  it('ranks en* ahead of a private VPN address', () => {
    mockIfaces({
      utun0: [{ address: '10.8.0.5', family: 'IPv4', internal: false }],
      en0: [{ address: '192.168.1.20', family: 'IPv4', internal: false }],
    })
    expect(detectLanAddress()).toBe('192.168.1.20')
  })

  it('ignores loopback, IPv6 and non-RFC1918 addresses', () => {
    mockIfaces({
      lo0: [{ address: '127.0.0.1', family: 'IPv4', internal: true }],
      en0: [
        { address: 'fe80::1', family: 'IPv6', internal: false },
        // 192.0.0.2 is NOT private (only 192.168/16 is) — the real address
        // this Mac reported, which is why LAN pairing must degrade to Cloud.
        { address: '192.0.0.2', family: 'IPv4', internal: false },
        { address: '169.254.10.1', family: 'IPv4', internal: false },
        { address: '100.64.0.1', family: 'IPv4', internal: false },
      ],
    })
    expect(detectLanAddress()).toBeNull()
  })

  it('accepts each RFC1918 range', () => {
    for (const addr of ['10.0.0.5', '172.16.3.4', '192.168.0.9']) {
      mockIfaces({ en0: [{ address: addr, family: 'IPv4', internal: false }] })
      expect(detectLanAddress()).toBe(addr)
    }
  })
})

describe('getPairingTargets', () => {
  it('never offers a loopback console origin — substitutes the LAN address', () => {
    mockIfaces({ en0: [{ address: '192.168.1.20', family: 'IPv4', internal: false }] })
    const targets = getPairingTargets('http://localhost:3456', 3456)
    expect(targets).toHaveLength(1)
    expect(targets[0].origin).toBe('http://192.168.1.20:3456')
    expect(targets.every((t) => !isLoopbackOrigin(t.origin))).toBe(true)
  })

  it('keeps a non-loopback console origin as-is (LAN / reverse proxy)', () => {
    mockIfaces({ en0: [{ address: '192.168.1.20', family: 'IPv4', internal: false }] })
    const targets = getPairingTargets('https://walnut.example.invalid', 3456)
    expect(targets[0].origin).toBe('https://walnut.example.invalid')
  })

  it('offers Cloud when a cloud remote exists, and marks it remote-mint', () => {
    mockIfaces({ en0: [{ address: '192.168.1.20', family: 'IPv4', internal: false }] })
    vi.mocked(getCloudRemoteCredentials).mockReturnValue({
      domain: 'cloud.example.invalid', token: 'tok', secure: true,
    })
    const targets = getPairingTargets('http://localhost:3456', 3456)
    expect(targets.map((t) => t.kind)).toEqual(['lan', 'cloud'])
    const cloud = targets.find((t) => t.kind === 'cloud')!
    expect(cloud.origin).toBe('https://cloud.example.invalid')
    // A cloud token must be minted BY the cloud box — auth.json never syncs.
    expect(cloud.remoteMint).toBe(true)
  })

  it('still offers Cloud when this machine has no usable LAN address', () => {
    mockIfaces({ en0: [{ address: '192.0.0.2', family: 'IPv4', internal: false }] })
    vi.mocked(getCloudRemoteCredentials).mockReturnValue({
      domain: 'cloud.example.invalid', token: 'tok', secure: true,
    })
    const targets = getPairingTargets('http://localhost:3456', 3456)
    expect(targets.map((t) => t.kind)).toEqual(['cloud'])
  })

  it('returns nothing rather than a useless loopback QR', () => {
    mockIfaces({ lo0: [{ address: '127.0.0.1', family: 'IPv4', internal: true }] })
    expect(getPairingTargets('http://localhost:3456', 3456)).toEqual([])
  })
})
