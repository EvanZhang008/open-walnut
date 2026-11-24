/**
 * Walnut Connect in walnut-net's config: the daemon takes phones and the door only as walnut-net
 * reads them (native/walnut-net/src/config.rs), writes nothing new for a Walnut that lists no
 * phone, and the leader adds them only while Walnut Connect runs and the daemon passes them on.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { netKey } from '../../helpers/net-keys.js'
import { netConfigFileText, parseNetConfig } from '../../../src/providers/net-config-core.js'

const PHONE = netKey('cfg-phone')
const HOST = netKey('cfg-host')
const DOOR = '/home/u/.open-walnut/local/connect/door.sock'

describe('the daemon\'s config parser', () => {
  it('takes phones and the door together, and writes neither without both', () => {
    const both = parseNetConfig({ relayMode: 'public', phones: [{ id: PHONE.toUpperCase(), name: 'iPhone' }], webSocket: DOOR })
    expect(both).toMatchObject({ phones: [{ id: PHONE, name: 'iPhone' }], webSocket: DOOR })
    const text = JSON.parse(netConfigFileText(both, { self: netKey('self'), keyFile: '/k', portFile: '/p', control: '/c' }))
    expect(text.phones).toEqual([{ id: PHONE, name: 'iPhone' }])
    expect(text.webSocket).toBe(DOOR)
    // A Walnut that lists no phone writes the file it always wrote.
    for (const req of [{}, { phones: [] }, { phones: [], webSocket: DOOR }, { phones: [{ id: PHONE }] }]) {
      const parsed = parseNetConfig({ relayMode: 'public', ...req })
      expect(parsed).not.toHaveProperty('phones')
      expect(parsed).not.toHaveProperty('webSocket')
    }
  })

  it('refuses what walnut-net could not use', () => {
    expect(() => parseNetConfig({ phones: [{ id: 'nothex' }], webSocket: DOOR })).toThrow(/bad phone id/)
    expect(() => parseNetConfig({ phones: 'x', webSocket: DOOR })).toThrow(/a list/)
    expect(() => parseNetConfig({ phones: Array.from({ length: 65 }, (_, i) => ({ id: netKey(`p${i}`) })), webSocket: DOOR })).toThrow(/at most 64/)
    for (const bad of ['relative/door.sock', 42, '/x\0y', `/${'a'.repeat(250)}`]) {
      expect(() => parseNetConfig({ phones: [{ id: PHONE }], webSocket: bad })).toThrow(/webSocket/)
    }
    expect(parseNetConfig({ members: [{ id: HOST, accept: true }], phones: [{ id: PHONE }], webSocket: DOOR }).members).toEqual([{ id: HOST, name: '', accept: true }])
  })

  it('leaves out a phone listed twice or whose id is a member, and never stops the config for it', () => {
    // A phone is never a member (it would reach the daemon): such a record is dropped, the
    // rest of the host network's config goes on (one bad device record wedged every sync).
    const parsed = parseNetConfig({
      members: [{ id: HOST, accept: true }],
      phones: [{ id: PHONE, name: 'a' }, { id: PHONE, name: 'again' }, { id: HOST, name: 'a machine' }],
      webSocket: DOOR,
    })
    expect(parsed.phones).toEqual([{ id: PHONE, name: 'a' }])
    expect(parsed.members).toHaveLength(1)
    // Nor is this host itself one of its phones.
    const self = netKey('self')
    const text = JSON.parse(netConfigFileText(parseNetConfig({ phones: [{ id: self }, { id: PHONE }], webSocket: DOOR }), { self, keyFile: '/k', portFile: '/p', control: '/c' }))
    expect(text.phones).toEqual([{ id: PHONE, name: '' }])
  })
})

vi.mock('../../../src/core/connect/connect-phones.js', async (orig) => ({
  ...(await orig<typeof import('../../../src/core/connect/connect-phones.js')>()),
  connectPhones: vi.fn(async () => [{ id: PHONE, name: 'iPhone' }]),
}))
let flagOn = true
vi.mock('../../../src/core/config-manager.js', () => ({ getConfig: vi.fn(async () => ({ experimental: { walnut_connect: flagOn } })) }))

import { connectNetFields, dialableAddrs, resetConnectForTest, setConnectDoor, uniqueRelays } from '../../../src/core/connect/connect-net.js'

describe('what the leader tells its walnut-net', () => {
  beforeEach(() => { resetConnectForTest(); flagOn = true })
  const daemon = (caps: string[]) => ({ hasCapability: (c: string) => caps.includes(c), send: vi.fn() })

  it('lists the phones and the door only while it runs and the daemon passes them on', async () => {
    expect(await connectNetFields(daemon(['net-v1', 'net-web-v1']))).toEqual({})
    setConnectDoor(DOOR)
    expect(await connectNetFields(daemon(['net-v1', 'net-web-v1']))).toEqual({ phones: [{ id: PHONE, name: 'iPhone' }], webSocket: DOOR })
    // A machine's id (or this Mac's) is never sent as a phone's.
    expect(await connectNetFields(daemon(['net-v1', 'net-web-v1']), [PHONE.toUpperCase()])).toEqual({})
    // An older daemon would drop them: nothing is sent.
    expect(await connectNetFields(daemon(['net-v1', 'net-join-v1']))).toEqual({})
    flagOn = false
    expect(await connectNetFields(daemon(['net-v1', 'net-web-v1']))).toEqual({})
    resetConnectForTest()
  })

  it('hands a phone only addresses another device can dial', () => {
    expect(dialableAddrs(['127.0.0.1:5', '[::1]:5', '[fe80::1]:5', '169.254.1.2:5', '10.0.0.2:5', '76.104.1.2:5', '[2601::1]:5', 7, 'x'.repeat(80)]))
      .toEqual(['10.0.0.2:5', '76.104.1.2:5', '[2601::1]:5'])
    expect(dialableAddrs(Array.from({ length: 20 }, (_, i) => `10.0.0.${i}:5`))).toHaveLength(8)
    expect(dialableAddrs(null)).toEqual([])
  })
})

describe('uniqueRelays', () => {
  it('lists a relay once when the config and walnut-net write it with and without the final slash', () => {
    expect(uniqueRelays(['https://relay.example.net', 'https://relay.example.net/', 'https://other.example.net/'])).toEqual(['https://relay.example.net', 'https://other.example.net/'])
    expect(uniqueRelays(['', ' '])).toEqual([])
  })
})
