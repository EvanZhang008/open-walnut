/**
 * Walnut Connect's phones (src/core/connect/connect-phones.ts): a phone's network id lives on
 * its device record, only a paired app sets its own, one id names one pairing, and the list
 * walnut-net lets in is exactly the phones with an id (a revoke takes it away).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import fs from 'node:fs/promises'
import { createMockConstants } from '../../helpers/mock-constants.js'
import { netKey } from '../../helpers/net-keys.js'

vi.mock('../../../src/constants.js', () => createMockConstants())

import { WALNUT_HOME } from '../../../src/constants.js'
import { createDevice, revokeDevice, _resetDeviceAuthForTesting, listDeviceRecords } from '../../../src/core/device-auth.js'
import {
  ConnectRefused, checkEndpoint, connectEndpointOf, connectPhones, endpointOfKey, mintPhoneKey, registerConnectEndpoint, setConnectEndpointByName,
} from '../../../src/core/connect/connect-phones.js'

beforeEach(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  await fs.mkdir(WALNUT_HOME, { recursive: true })
  _resetDeviceAuthForTesting()
})

const refusal = async (p: Promise<unknown>) => {
  try { await p } catch (err) { return err instanceof ConnectRefused ? { status: err.status, code: err.code } : String(err) }
  return 'resolved'
}

describe('a phone key', () => {
  it('gives the network id iroh gives it (RFC 8032 test vector 1)', () => {
    // native/walnut-connect `walnut-connect id --key <seed>` prints the same id; the phone's
    // test (WalnutConnectTests) checks the all-zero seed below against the library.
    expect(endpointOfKey('0'.repeat(64))).toBe('3b6a27bcceb6a42d62a3a8d02a6f0d73653215771de243a63ac048a18b59da29')
    expect(endpointOfKey('9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60'))
      .toBe('d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a')
  })

  it('is minted fresh with its id, and an id must be a key', () => {
    const a = mintPhoneKey()
    const b = mintPhoneKey()
    expect(a.key).toMatch(/^[0-9a-f]{64}$/)
    expect(a.key).not.toBe(b.key)
    expect(endpointOfKey(a.key)).toBe(a.endpoint)
    expect(checkEndpoint(a.endpoint.toUpperCase())).toBe(a.endpoint)
    for (const bad of ['', 'x'.repeat(64), 'a'.repeat(63), 42, null]) expect(() => checkEndpoint(bad)).toThrow(ConnectRefused)
    // 64 hex characters that are not a point on the curve: walnut-net would leave it out.
    const notAPoint = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, '0').repeat(32)).find((h) => {
      try { checkEndpoint(h); return false } catch { return true }
    })
    expect(notAPoint).toBeDefined()
  })
})

describe('registering a phone', () => {
  it('sets the id on the calling device only, once, and lists it for walnut-net', async () => {
    const phone = await createDevice('iPhone')
    const other = await createDevice('iPad')
    const id = netKey('phone-1')
    expect(await registerConnectEndpoint(phone.token, id)).toEqual({ name: 'iPhone', endpoint: id, changed: true })
    expect(await registerConnectEndpoint(phone.token, id)).toEqual({ name: 'iPhone', endpoint: id, changed: false })
    expect(await connectEndpointOf(phone.token)).toBe(id)
    expect(await connectEndpointOf(other.token)).toBeNull()
    expect(await connectPhones()).toEqual([{ id, name: 'iPhone' }])
    // One id names one pairing.
    expect(await refusal(registerConnectEndpoint(other.token, id))).toEqual({ status: 409, code: 'endpoint_taken' })
    // A phone that makes a new key moves to it.
    const next = netKey('phone-2')
    expect((await registerConnectEndpoint(phone.token, next)).changed).toBe(true)
    expect(await connectPhones()).toEqual([{ id: next, name: 'iPhone' }])
  })

  it('refuses a token that is no paired app, and a bad id', async () => {
    const phone = await createDevice('iPhone')
    const machine = await createDevice('bridge-local', { kind: 'machine' })
    expect(await refusal(registerConnectEndpoint('no-such-token', netKey('x')))).toEqual({ status: 403, code: 'not_a_phone' })
    expect(await refusal(registerConnectEndpoint(machine.token, netKey('x')))).toEqual({ status: 403, code: 'not_a_phone' })
    expect(await refusal(registerConnectEndpoint(phone.token, 'nope'))).toEqual({ status: 400, code: 'bad_endpoint' })
    expect(await connectPhones()).toEqual([])
  })

  it('goes with its pairing: a revoke removes the phone from the list', async () => {
    const phone = await createDevice('iPhone')
    const kept = await createDevice('Other-phone')
    await registerConnectEndpoint(phone.token, netKey('gone'))
    await registerConnectEndpoint(kept.token, netKey('kept'))
    expect((await connectPhones()).map((p) => p.name).sort()).toEqual(['Other-phone', 'iPhone'])
    await revokeDevice('iPhone')
    expect(await connectPhones()).toEqual([{ id: netKey('kept'), name: 'Other-phone' }])
  })

  it('is set by name for a new pairing, taking the id from any other record', async () => {
    await createDevice('iPhone')
    const old = await createDevice('Old')
    const id = netKey('qr')
    await registerConnectEndpoint(old.token, id)
    expect(await setConnectEndpointByName('iPhone', id)).toBe(true)
    expect(await setConnectEndpointByName('nobody', netKey('n'))).toBe(false)
    const records = await listDeviceRecords()
    expect(records.find((d) => d.name === 'iPhone')?.connect?.endpoint).toBe(id)
    expect(records.find((d) => d.name === 'Old')?.connect).toBeUndefined()
    expect(await connectPhones()).toEqual([{ id, name: 'iPhone' }])
  })
})
