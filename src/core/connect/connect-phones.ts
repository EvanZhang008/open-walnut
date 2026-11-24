/**
 * Walnut Connect's phones: which paired devices the Mac's walnut-net lets in on
 * walnut/web/1 (docs/reference/walnut-connect.md).
 *
 * A phone's network id is its iroh public key, kept on its device record in auth.json
 * (`connect.endpoint`), so it lives and dies with the pairing: a revoke removes the record, a
 * re-pairing by anyone but the phone itself makes a new one without it. It is set two ways:
 *  - the pairing QR carries a key made here for the new phone (`mintPhoneKey`), so a phone
 *    paired while away from this Mac's Wi-Fi reaches it at once;
 *  - a phone paired before, or one that made its own key, names it itself
 *    (POST /api/v1/connect/register, with its device token).
 * The key alone opens nothing: walnut-net only lets the phone reach the server's connect door,
 * where every request still needs the device token.
 */

import crypto from 'node:crypto'
import { listDeviceRecords, mutateDeviceRecords } from '../device-auth.js'
import { recordForToken, type DeviceRecord } from '../device-store.js'
import { isEd25519Point } from '../net/ed25519-point.js'

export const ENDPOINT_RE = /^[0-9a-f]{64}$/

/** A phone as walnut-net's config lists it (net-config-core.ts NetPhone). */
export interface ConnectPhone { id: string; name: string }

export class ConnectRefused extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message)
    this.name = 'ConnectRefused'
  }
}

// PKCS#8 header of an Ed25519 private key (RFC 8410): the 32-byte seed follows it.
const PKCS8_ED25519 = Buffer.from('302e020100300506032b657004220420', 'hex')

/** The network id (public key, hex) of a 32-byte Ed25519 seed, as iroh derives it. */
export function endpointOfKey(keyHex: string): string {
  if (!ENDPOINT_RE.test(keyHex)) throw new Error('a phone key is 64 hex characters')
  const priv = crypto.createPrivateKey({ key: Buffer.concat([PKCS8_ED25519, Buffer.from(keyHex, 'hex')]), format: 'der', type: 'pkcs8' })
  // An OKP key's JWK carries its public half as `x` (RFC 8037).
  const { x } = priv.export({ format: 'jwk' }) as { x?: string }
  if (!x) throw new Error('no public key')
  return Buffer.from(x, 'base64url').toString('hex')
}

/** A new key for a phone the pairing QR carries, and the id it gives. */
export function mintPhoneKey(): { key: string; endpoint: string } {
  const key = crypto.randomBytes(32).toString('hex')
  return { key, endpoint: endpointOfKey(key) }
}

export function checkEndpoint(raw: unknown): string {
  const endpoint = typeof raw === 'string' ? raw.trim().toLowerCase() : ''
  if (!ENDPOINT_RE.test(endpoint) || !isEd25519Point(endpoint)) {
    throw new ConnectRefused(400, 'bad_endpoint', 'endpoint must be a network id: 64 hex characters of an Ed25519 public key')
  }
  return endpoint
}

/** A paired app: never a machine credential, a browser's sign-in or the browser extension. */
const isPhoneRecord = (d: DeviceRecord) => d.kind !== 'machine' && !d.browserSignIn && !/^extension-/i.test(d.name)

/**
 * Set the network id of the device whose token this is (the phone naming its own). One id
 * names one pairing: another device's is refused. Returns whether anything changed.
 */
export async function registerConnectEndpoint(token: string, raw: unknown, reserved: ReadonlySet<string> = new Set()): Promise<{ name: string; endpoint: string; changed: boolean }> {
  const endpoint = checkEndpoint(raw)
  // A machine's id on the host network (or this Mac's) is never a phone's.
  if (reserved.has(endpoint)) throw new ConnectRefused(409, 'endpoint_taken', 'That network id belongs to a machine on your host network.')
  return mutateDeviceRecords<{ name: string; endpoint: string; changed: boolean }>((devices) => {
    const me = recordForToken(devices, token)
    if (!me || !isPhoneRecord(me)) throw new ConnectRefused(403, 'not_a_phone', 'Only a paired app registers for Walnut Connect.')
    if (devices.some((d) => d !== me && d.connect?.endpoint === endpoint)) {
      throw new ConnectRefused(409, 'endpoint_taken', 'That network id belongs to another paired device.')
    }
    if (me.connect?.endpoint === endpoint) return { result: { name: me.name, endpoint, changed: false } }
    const next = devices.map((d) => (d === me ? { ...d, connect: { endpoint, at: new Date().toISOString() } } : d))
    return { devices: next, result: { name: me.name, endpoint, changed: true } }
  })
}

/** Set the network id of a device by name, right after the pairing made it (the QR carries its key). */
export async function setConnectEndpointByName(name: string, endpoint: string): Promise<boolean> {
  return mutateDeviceRecords((devices) => {
    const me = devices.find((d) => d.name === name)
    if (!me || !isPhoneRecord(me)) return { result: false }
    const next = devices.map((d) => {
      if (d === me) return { ...d, connect: { endpoint, at: new Date().toISOString() } }
      // A key made for this pairing is new: nothing else holds it, but never two records with one id.
      if (d.connect?.endpoint === endpoint) { const { connect: _gone, ...rest } = d; return rest }
      return d
    })
    return { devices: next, result: true }
  })
}

/** The network id the device of this token registered, or null. */
export async function connectEndpointOf(token: string): Promise<string | null> {
  return recordForToken(await listDeviceRecords(), token)?.connect?.endpoint ?? null
}

/** Every paired phone with a network id: the list the Mac's walnut-net lets in. */
export async function connectPhones(): Promise<ConnectPhone[]> {
  const seen = new Set<string>()
  const out: ConnectPhone[] = []
  for (const d of await listDeviceRecords()) {
    const id = d.connect?.endpoint
    if (!id || !isPhoneRecord(d) || !ENDPOINT_RE.test(id) || seen.has(id)) continue
    seen.add(id)
    out.push({ id, name: (d.info?.deviceName ?? d.name).slice(0, 80) })
  }
  return out
}
