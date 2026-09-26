/**
 * C51: a wake (clock gap > 30s) or a network change redials each failed host
 * once, at once; a host at most once a minute; and only addresses that name a
 * network count as a change (link-local and rotating IPv6 ids do not).
 */
import { describe, it, expect, afterEach } from 'vitest'
import {
  HOST_REDIAL_MIN_INTERVAL_MS, networkAddressSet, networkKeyOf, startHostWakeSignal, WAKE_GAP_MS,
} from '../../../src/core/hosts/host-wake-signal.js'
import { lastHostSignalAt, resetHostSignalForTest } from '../../../src/providers/daemon-reconnect-cause.js'

function harness(hosts: string[]) {
  let t = 1_000_000
  let addrs = ['en0|IPv4|10.0.0.5']
  const redials: Array<[string, string]> = []
  const sig = startHostWakeSignal({
    now: () => t, addresses: () => addrs, hostsToRedial: () => hosts, redial: (h, k) => redials.push([h, k]),
    setInterval: () => ({ unref: () => {} }), clearInterval: () => {},
  })
  return { sig, redials, advance: (ms: number) => { t += ms }, setAddrs: (a: string[]) => { addrs = a }, now: () => t }
}

describe('host wake signal', () => {
  afterEach(() => resetHostSignalForTest())

  it('a tick gap over 30s is a wake: each failed host redials exactly once, and the signal is stamped', () => {
    const h = harness(['netbox', 'netbox', 'keybox'])
    h.advance(5_000); h.sig.tick()
    expect(h.redials).toEqual([])
    h.advance(WAKE_GAP_MS + 1); h.sig.tick()
    expect(h.redials).toEqual([['netbox', 'wake'], ['keybox', 'wake']])
    expect(lastHostSignalAt()).toBe(h.now())
    // The next normal tick is not another wake.
    h.advance(5_000); h.sig.tick()
    expect(h.redials).toHaveLength(2)
  })

  it('a changed address set is a network signal; an unchanged one is not', () => {
    const h = harness(['netbox'])
    h.sig.poll()
    expect(h.redials).toEqual([])
    h.setAddrs(['en0|IPv4|10.0.0.9'])
    h.sig.poll()
    h.sig.poll()
    expect(h.redials).toEqual([['netbox', 'network']])
  })

  it('a flapping interface redials a host at most once a minute; a host that just joined the list is not held back', () => {
    const hosts = ['netbox']
    const h = harness(hosts)
    for (const [i, a] of ['10.0.0.9', '10.0.0.5', '10.0.0.9'].entries()) {
      h.advance(10_000); h.setAddrs([`en0|IPv4|${a}`]); h.sig.poll()
      if (i === 1) hosts.push('keybox')
    }
    expect(h.redials).toEqual([['netbox', 'network'], ['keybox', 'network']])
    h.advance(HOST_REDIAL_MIN_INTERVAL_MS); h.setAddrs(['en0|IPv4|10.0.0.7']); h.sig.poll()
    expect(h.redials.slice(2)).toEqual([['netbox', 'network'], ['keybox', 'network']])
  })
})

describe('networkAddressSet', () => {
  const v4 = (address: string, internal = false) => ({ address, family: 'IPv4', internal })
  const v6 = (address: string, internal = false) => ({ address, family: 'IPv6', internal })

  it('ignores loopback, link-local (169.254/16, fe80::/10) and the interfaces that only carry them', () => {
    expect(networkAddressSet({
      lo0: [v4('127.0.0.1', true), v6('::1', true)],
      awdl0: [v6('fe80::1c2b:3aff:fe4d:5e6f%awdl0')],
      llw0: [v6('fe80::aa:bbff:fecc:ddee%llw0')],
      en5: [v4('169.254.12.34')],
      en0: [v4('192.168.1.20'), v6('fe80::1%en0'), v6('2001:db8:1:2:a1b2:c3d4:e5f6:1234')],
    })).toEqual(['en0|IPv4|192.168.1.20', 'en0|IPv6|2001:db8:1:2::/64'])
  })

  it('an IPv6 privacy address rotating inside the same /64 is not a network change; a new prefix is', () => {
    const before = networkAddressSet({ en0: [v6('2001:db8:1:2:1111:2222:3333:4444')] })
    expect(networkAddressSet({ en0: [v6('2001:db8:1:2:9999:8888:7777:6666'), v6('2001:db8:1:2:1111:2222:3333:4444')] })).toEqual(before)
    expect(networkAddressSet({ en0: [v6('2001:db8:5:6:1111:2222:3333:4444')] })).not.toEqual(before)
  })

  it('reads a numeric family (older node) and a compressed IPv6 prefix the same way', () => {
    expect(networkKeyOf('en0', { address: '10.1.2.3', family: 4, internal: false })).toBe('en0|IPv4|10.1.2.3')
    expect(networkKeyOf('en0', { address: '2001:db8::1', family: 6, internal: false })).toBe('en0|IPv6|2001:db8:0:0::/64')
    expect(networkKeyOf('en0', { address: 'FE80::1', family: 6, internal: false })).toBeNull()
  })
})
