/**
 * Passkeys kept in the vault, used by Walnut as the authenticator (WebAuthn, the "none"
 * attestation, ES256 only). Pure: key making, the authenticator data, the attestation object
 * and the assertion signature. passkey-store.ts keeps them on items.
 *
 * A passkey is stored the way Bitwarden exports one (`fido2Credentials`), so one imported from
 * Bitwarden signs in as it is, and one made here exports the same way:
 *   credentialId     a GUID, or "b64." + the base64url bytes of an id that is not 16 bytes
 *   keyType "public-key", keyAlgorithm "ECDSA", keyCurve "P-256"
 *   keyValue         the private key, base64url PKCS#8 DER (never leaves the server: clients
 *                    get items without it, publicPasskey below)
 *   rpId, rpName, userHandle (base64url user.id), userName, userDisplayName
 *   counter          a decimal string; "0" for a passkey that never counts (synced passkeys)
 *   discoverable     "true" | "false"
 *   creationDate     ISO time
 *
 * Who may sign for which site is checked here too, not only in the browser: the request's
 * origin must be https (or a loopback name), the relying party id must be that origin's host or
 * a parent of it that is not a public suffix, and the client data must name that origin.
 */
import crypto from 'node:crypto'
import { parse } from 'tldts'

export type StoredPasskey = Record<string, unknown>

/** COSE algorithm ES256 (ECDSA P-256 with SHA-256): the only one Walnut makes or uses. */
export const ES256 = -7

export class PasskeyError extends Error {
  constructor(message: string, readonly status: number, readonly code: string) { super(message) }
}

// ── base64url ──

export function b64u(bytes: Uint8Array | Buffer): string {
  return Buffer.from(bytes).toString('base64url')
}

/** base64url or base64, with or without padding (Bitwarden exports have used both). */
export function fromB64u(s: string): Buffer {
  return Buffer.from(String(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''), 'base64url')
}

// ── credential ids ──

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** The raw id bytes of a stored credentialId (a GUID, or "b64." + base64url). */
export function credentialIdBytes(stored: unknown): Buffer | null {
  if (typeof stored !== 'string' || !stored) return null
  if (GUID.test(stored)) return Buffer.from(stored.replace(/-/g, ''), 'hex')
  if (stored.startsWith('b64.')) {
    const b = fromB64u(stored.slice(4))
    return b.length ? b : null
  }
  return null
}

/** The stored form of raw id bytes: a GUID for 16 bytes (as Bitwarden makes them). */
export function storedCredentialId(bytes: Buffer): string {
  if (bytes.length !== 16) return `b64.${b64u(bytes)}`
  const h = bytes.toString('hex')
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`
}

// ── who may use which relying party id ──

const LOOPBACK = /^(localhost|.+\.localhost|127\.\d+\.\d+\.\d+|\[::1\])$/i

/** An origin WebAuthn runs on (a secure context): https, or http on a loopback name. */
export function webOrigin(raw: unknown): URL | null {
  if (typeof raw !== 'string') return null
  let u: URL
  try { u = new URL(raw) } catch { return null }
  if (u.origin !== raw.replace(/\/$/, '')) return null
  if (u.protocol === 'https:') return u
  if (u.protocol === 'http:' && LOOPBACK.test(u.hostname)) return u
  return null
}

/**
 * The relying party id a page may use (WebAuthn's rule): its own host, or a parent domain of
 * it that is not a public suffix. An IP address may only name itself. Null when it may not.
 */
export function rpIdFor(origin: string, requested?: unknown): string | null {
  const u = webOrigin(origin)
  if (!u) return null
  const host = u.hostname.toLowerCase()
  const rp = typeof requested === 'string' && requested ? requested.toLowerCase() : host
  if (rp === host) return rp
  const p = parse(host, { allowPrivateDomains: true })
  if (p.isIp) return null
  if (!host.endsWith(`.${rp}`)) return null
  // A public suffix (com, co.uk, github.io) is never a relying party: it must hold the registrable domain.
  const reg = p.domain
  if (!reg || !(rp === reg || rp.endsWith(`.${reg}`))) return null
  return rp
}

/** The passkey belongs to this relying party id. */
export function passkeyFor(pk: StoredPasskey, rpId: string): boolean {
  return typeof pk.rpId === 'string' && pk.rpId.toLowerCase() === rpId
}

// ── client data ──

export interface ClientData { type: string; challenge: string; origin: string; crossOrigin?: boolean }

/** The client data the browser side made, checked against the origin it claims to be for. */
export function readClientData(b64: unknown, type: 'webauthn.create' | 'webauthn.get', origin: string): { json: Buffer; data: ClientData } {
  if (typeof b64 !== 'string' || !b64) throw new PasskeyError('clientDataJSON is required', 400, 'bad_passkey_request')
  const json = fromB64u(b64)
  let data: ClientData
  try { data = JSON.parse(json.toString('utf8')) as ClientData } catch { throw new PasskeyError('clientDataJSON is not JSON', 400, 'bad_passkey_request') }
  if (data.type !== type) throw new PasskeyError(`clientDataJSON must be ${type}`, 400, 'bad_passkey_request')
  if (data.origin !== origin) throw new PasskeyError('clientDataJSON names another origin', 403, 'passkey_origin')
  if (typeof data.challenge !== 'string' || !data.challenge) throw new PasskeyError('clientDataJSON has no challenge', 400, 'bad_passkey_request')
  return { json, data }
}

// ── CBOR (only what attestation objects and COSE keys use) ──

function head(major: number, n: number): Buffer {
  if (n < 24) return Buffer.from([(major << 5) | n])
  if (n < 0x100) return Buffer.from([(major << 5) | 24, n])
  if (n < 0x10000) { const b = Buffer.alloc(3); b[0] = (major << 5) | 25; b.writeUInt16BE(n, 1); return b }
  const b = Buffer.alloc(5); b[0] = (major << 5) | 26; b.writeUInt32BE(n, 1); return b
}

export type Cbor = number | string | Buffer | Map<number | string, Cbor>

export function cbor(v: Cbor): Buffer {
  if (typeof v === 'number') {
    if (!Number.isInteger(v)) throw new Error('cbor: integers only')
    return v >= 0 ? head(0, v) : head(1, -1 - v)
  }
  if (typeof v === 'string') { const s = Buffer.from(v, 'utf8'); return Buffer.concat([head(3, s.length), s]) }
  if (Buffer.isBuffer(v)) return Buffer.concat([head(2, v.length), v])
  // Map keys are written in the order given: callers give the canonical CTAP2 order.
  const parts: Buffer[] = [head(5, v.size)]
  for (const [k, x] of v) parts.push(cbor(k), cbor(x))
  return Buffer.concat(parts)
}

// ── keys ──

export interface NewKey { privatePkcs8: Buffer; cose: Buffer; spki: Buffer }

function coseOf(key: crypto.KeyObject): Buffer {
  const jwk = key.export({ format: 'jwk' }) as { x?: string; y?: string }
  if (!jwk.x || !jwk.y) throw new Error('not an EC key')
  // kty EC2, alg ES256, crv P-256, x, y (CTAP2 canonical order: 1, 3, -1, -2, -3)
  return cbor(new Map<number, Cbor>([[1, 2], [3, ES256], [-1, 1], [-2, fromB64u(jwk.x)], [-3, fromB64u(jwk.y)]]))
}

export function newKey(): NewKey {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' })
  return {
    privatePkcs8: privateKey.export({ format: 'der', type: 'pkcs8' }) as Buffer,
    cose: coseOf(publicKey),
    spki: publicKey.export({ format: 'der', type: 'spki' }) as Buffer,
  }
}

function privateKeyOf(pk: StoredPasskey): crypto.KeyObject {
  if (pk.keyAlgorithm !== undefined && pk.keyAlgorithm !== 'ECDSA') throw new PasskeyError('This passkey uses a key type Walnut cannot sign with yet', 422, 'passkey_key_type')
  if (pk.keyCurve !== undefined && pk.keyCurve !== 'P-256') throw new PasskeyError('This passkey uses a curve Walnut cannot sign with yet', 422, 'passkey_key_type')
  if (typeof pk.keyValue !== 'string' || !pk.keyValue) throw new PasskeyError('This passkey has no key', 422, 'passkey_no_key')
  try {
    return crypto.createPrivateKey({ key: fromB64u(pk.keyValue), format: 'der', type: 'pkcs8' })
  } catch {
    throw new PasskeyError('This passkey\'s key cannot be read', 422, 'passkey_no_key')
  }
}

// ── authenticator data ──

const FLAG_UP = 0x01
const FLAG_UV = 0x04
const FLAG_BE = 0x08
const FLAG_BS = 0x10
const FLAG_AT = 0x40
/** Walnut's passkeys live in the vault every device of the person opens: backup eligible and backed up. */
const BASE_FLAGS = FLAG_UP | FLAG_UV | FLAG_BE | FLAG_BS
/** No attestation, so no model to name: all zeros, as most synced passkey managers send. */
const AAGUID = Buffer.alloc(16)

export function authData(rpId: string, counter: number, attested?: { credentialId: Buffer; cose: Buffer }): Buffer {
  const parts: Buffer[] = [crypto.createHash('sha256').update(rpId, 'utf8').digest()]
  parts.push(Buffer.from([BASE_FLAGS | (attested ? FLAG_AT : 0)]))
  const c = Buffer.alloc(4); c.writeUInt32BE(counter >>> 0, 0); parts.push(c)
  if (attested) {
    const len = Buffer.alloc(2); len.writeUInt16BE(attested.credentialId.length, 0)
    parts.push(AAGUID, len, attested.credentialId, attested.cose)
  }
  return Buffer.concat(parts)
}

export function attestationObject(auth: Buffer): Buffer {
  return cbor(new Map<string, Cbor>([['fmt', 'none'], ['attStmt', new Map()], ['authData', auth]]))
}

/** The counter this use sends: none for one that never counted, else one more than the last. */
export function nextCounter(pk: StoredPasskey): number {
  const n = Number(pk.counter ?? 0)
  return Number.isFinite(n) && n > 0 ? Math.min(n + 1, 0xffffffff) : 0
}

/** ECDSA over the authenticator data and the hash of the client data (DER, as WebAuthn wants). */
export function sign(pk: StoredPasskey, auth: Buffer, clientDataJSON: Buffer): Buffer {
  const hash = crypto.createHash('sha256').update(clientDataJSON).digest()
  return crypto.sign('sha256', Buffer.concat([auth, hash]), privateKeyOf(pk))
}

// ── what a client may see ──

/** A passkey as a client sees it: everything but the private key. */
export function publicPasskey(pk: StoredPasskey): StoredPasskey {
  const { keyValue: _k, ...rest } = pk
  return rest
}

/**
 * The passkeys a client sends back with an edit, with the private key of each taken again from
 * the stored one (clients never had it). One the item never had, or without a key, is dropped:
 * a client can remove a passkey, never add or change a key.
 */
export function mergePasskeys(prev: StoredPasskey[] | undefined, incoming: StoredPasskey[]): StoredPasskey[] {
  const byId = new Map((prev ?? []).map((p) => [String(p.credentialId ?? ''), p]))
  const out: StoredPasskey[] = []
  for (const p of incoming) {
    if (!p || typeof p !== 'object') continue
    const old = byId.get(String(p.credentialId ?? ''))
    if (!old) continue
    // Only what the person may edit changes; the key and the ids stay the stored ones.
    out.push({ ...old, ...(typeof p.userDisplayName === 'string' ? { userDisplayName: p.userDisplayName } : {}) })
  }
  return out
}
