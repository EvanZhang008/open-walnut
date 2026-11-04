/**
 * Walnut's passkeys as a relying party checks them: an attestation object and an assertion
 * are taken apart here with a CBOR reader of the test's own and verified with Node's crypto,
 * the way a site's server does, never with the code under test.
 */
import crypto from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  attestationObject, authData, b64u, credentialIdBytes, fromB64u, mergePasskeys, newKey, nextCounter, publicPasskey,
  readClientData, rpIdFor, sign, storedCredentialId, webOrigin,
} from '../../../src/core/vault/passkey'

// ── a small CBOR reader (major types 0 to 5), independent of the writer ──
function decode(buf: Buffer): unknown {
  let i = 0
  const len = (info: number): number => {
    if (info < 24) return info
    if (info === 24) return buf[i++]
    if (info === 25) { const v = buf.readUInt16BE(i); i += 2; return v }
    if (info === 26) { const v = buf.readUInt32BE(i); i += 4; return v }
    throw new Error(`unsupported length ${info}`)
  }
  const item = (): unknown => {
    const b = buf[i++]
    const major = b >> 5
    const n = len(b & 31)
    if (major === 0) return n
    if (major === 1) return -1 - n
    if (major === 2) { const v = buf.subarray(i, i + n); i += n; return Buffer.from(v) }
    if (major === 3) { const v = buf.subarray(i, i + n).toString('utf8'); i += n; return v }
    if (major === 4) return Array.from({ length: n }, item)
    if (major === 5) { const m = new Map<unknown, unknown>(); for (let k = 0; k < n; k++) m.set(item(), item()); return m }
    throw new Error(`unsupported major ${major}`)
  }
  const v = item()
  expect(i).toBe(buf.length)
  return v
}

function parseAuthData(a: Buffer) {
  const flags = a[32]
  const out: { rpIdHash: Buffer; flags: number; counter: number; credentialId?: Buffer; cose?: Map<number, unknown> } = {
    rpIdHash: a.subarray(0, 32), flags, counter: a.readUInt32BE(33),
  }
  if (flags & 0x40) {
    const idLen = a.readUInt16BE(53)
    out.credentialId = a.subarray(55, 55 + idLen)
    out.cose = decode(a.subarray(55 + idLen)) as Map<number, unknown>
  }
  return out
}

/** The public key a site keeps after registration, from the COSE key in the attestation. */
function siteKeyFromCose(cose: Map<number, unknown>): crypto.KeyObject {
  expect(cose.get(1)).toBe(2) // EC2
  expect(cose.get(3)).toBe(-7) // ES256
  expect(cose.get(-1)).toBe(1) // P-256
  return crypto.createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: b64u(cose.get(-2) as Buffer), y: b64u(cose.get(-3) as Buffer) }, format: 'jwk' })
}

const clientData = (type: string, origin: string, challenge = b64u(crypto.randomBytes(32))) =>
  Buffer.from(JSON.stringify({ type, challenge, origin, crossOrigin: false }))

const sha = (b: Buffer | string) => crypto.createHash('sha256').update(b).digest()

describe('passkey: registration and sign-in as a site verifies them', () => {
  it('a new passkey registers with the "none" attestation and signs a sign-in the site accepts', () => {
    const rpId = 'example.com'
    const key = newKey()
    const id = crypto.randomBytes(16)
    const att = decode(attestationObject(authData(rpId, 0, { credentialId: id, cose: key.cose }))) as Map<string, unknown>
    expect([...att.keys()]).toEqual(['fmt', 'attStmt', 'authData'])
    expect(att.get('fmt')).toBe('none')
    expect((att.get('attStmt') as Map<unknown, unknown>).size).toBe(0)
    const reg = parseAuthData(att.get('authData') as Buffer)
    expect(reg.rpIdHash.equals(sha(rpId))).toBe(true)
    // user present, user verified, backup eligible, backed up, attested credential data
    expect(reg.flags).toBe(0x01 | 0x04 | 0x08 | 0x10 | 0x40)
    expect(reg.counter).toBe(0)
    expect(reg.credentialId!.equals(id)).toBe(true)
    const siteKey = siteKeyFromCose(reg.cose!)
    // The SPKI handed to the page (getPublicKey) is the same key.
    expect((siteKey.export({ format: 'der', type: 'spki' }) as Buffer).equals(key.spki)).toBe(true)

    const pk = { keyValue: b64u(key.privatePkcs8), keyAlgorithm: 'ECDSA', keyCurve: 'P-256', counter: '0' }
    const cd = clientData('webauthn.get', 'https://example.com')
    const auth = authData(rpId, nextCounter(pk))
    const sig = sign(pk, auth, cd)
    const got = parseAuthData(auth)
    expect(got.flags & 0x40).toBe(0)
    expect(got.flags & 0x05).toBe(0x05)
    expect(crypto.verify('sha256', Buffer.concat([auth, sha(cd)]), siteKey, sig)).toBe(true)
    // A changed client data (another challenge) does not verify.
    expect(crypto.verify('sha256', Buffer.concat([auth, sha(clientData('webauthn.get', 'https://example.com'))]), siteKey, sig)).toBe(false)
  })

  it('a passkey imported from Bitwarden (GUID id, base64url PKCS#8) signs as it is', () => {
    const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' })
    const guid = crypto.randomUUID()
    const bw = {
      credentialId: guid, keyType: 'public-key', keyAlgorithm: 'ECDSA', keyCurve: 'P-256',
      keyValue: (privateKey.export({ format: 'der', type: 'pkcs8' }) as Buffer).toString('base64url'),
      rpId: 'github.com', userHandle: b64u(Buffer.from('user-1')), userName: 'octo', counter: '7', discoverable: 'true',
    }
    expect(credentialIdBytes(guid)!.toString('hex')).toBe(guid.replace(/-/g, ''))
    expect(storedCredentialId(credentialIdBytes(guid)!)).toBe(guid)
    const cd = clientData('webauthn.get', 'https://github.com')
    // A passkey that counted goes on counting: one more than its last.
    expect(nextCounter(bw)).toBe(8)
    const auth = authData('github.com', nextCounter(bw))
    expect(parseAuthData(auth).counter).toBe(8)
    expect(crypto.verify('sha256', Buffer.concat([auth, sha(cd)]), publicKey, sign(bw, auth, cd))).toBe(true)
    // Plain base64 (with + / and padding) reads the same.
    const std = { ...bw, keyValue: (privateKey.export({ format: 'der', type: 'pkcs8' }) as Buffer).toString('base64') }
    expect(crypto.verify('sha256', Buffer.concat([auth, sha(cd)]), publicKey, sign(std, auth, cd))).toBe(true)
  })

  it('ids that are not 16 bytes keep the b64. form; unknown forms are no id', () => {
    const long = crypto.randomBytes(32)
    expect(storedCredentialId(long)).toBe(`b64.${b64u(long)}`)
    expect(credentialIdBytes(`b64.${b64u(long)}`)!.equals(long)).toBe(true)
    expect(credentialIdBytes('cred-1')).toBeNull()
    expect(credentialIdBytes('')).toBeNull()
    expect(credentialIdBytes(42)).toBeNull()
  })

  it('a key Walnut cannot sign with is refused, not used', () => {
    const cd = clientData('webauthn.get', 'https://a.com')
    expect(() => sign({ keyAlgorithm: 'EdDSA', keyValue: 'x' }, authData('a.com', 0), cd)).toThrow(/key type/)
    expect(() => sign({ keyCurve: 'P-384', keyValue: 'x' }, authData('a.com', 0), cd)).toThrow(/curve/)
    expect(() => sign({}, authData('a.com', 0), cd)).toThrow(/no key/)
    expect(() => sign({ keyValue: 'bm90IGEga2V5' }, authData('a.com', 0), cd)).toThrow(/cannot be read/)
  })
})

describe('passkey: which site may use which relying party id', () => {
  it.each([
    ['https://example.com', undefined, 'example.com'],
    ['https://login.example.com', 'example.com', 'example.com'],
    ['https://a.b.example.co.uk', 'example.co.uk', 'example.co.uk'],
    ['https://login.example.com', 'login.example.com', 'login.example.com'],
    ['https://example.com', 'EXAMPLE.com', 'example.com'],
    ['http://localhost:4000', 'localhost', 'localhost'],
    ['http://app.localhost:4000', undefined, 'app.localhost'],
    ['https://127.0.0.1:8443', '127.0.0.1', '127.0.0.1'],
  ])('%s may use %s', (origin, rp, want) => {
    expect(rpIdFor(origin, rp)).toBe(want)
  })

  it.each([
    ['https://example.com', 'login.example.com'], // a child of the page
    ['https://example.com', 'other.com'],
    ['https://evil-example.com', 'example.com'], // a suffix that is not a parent
    ['https://a.example.co.uk', 'co.uk'], // a public suffix
    ['https://me.github.io', 'github.io'], // a private public suffix
    ['https://example.com', 'com'],
    ['http://example.com', undefined], // not a secure context
    ['https://10.0.0.1', '0.0.1'],
    ['ftp://example.com', undefined],
    ['https://example.com/path', undefined], // not an origin
    ['https://Example.com', undefined], // not as a browser writes an origin
    ['not a url', undefined],
  ])('%s may not use %s', (origin, rp) => {
    expect(rpIdFor(origin, rp)).toBeNull()
  })

  it('webOrigin accepts https and loopback http only', () => {
    expect(webOrigin('https://a.com')).not.toBeNull()
    expect(webOrigin('http://localhost:3000')).not.toBeNull()
    expect(webOrigin('http://[::1]:3000')).not.toBeNull()
    expect(webOrigin('http://a.com')).toBeNull()
    expect(webOrigin(undefined)).toBeNull()
  })

  it('the client data must be of the right kind and name the request\'s origin', () => {
    const o = 'https://a.com'
    expect(readClientData(b64u(clientData('webauthn.get', o)), 'webauthn.get', o).data.origin).toBe(o)
    expect(() => readClientData(b64u(clientData('webauthn.get', 'https://b.com')), 'webauthn.get', o)).toThrow(/another origin/)
    expect(() => readClientData(b64u(clientData('webauthn.create', o)), 'webauthn.get', o)).toThrow(/must be webauthn.get/)
    expect(() => readClientData(b64u(Buffer.from('{')), 'webauthn.get', o)).toThrow(/not JSON/)
    expect(() => readClientData(b64u(Buffer.from(JSON.stringify({ type: 'webauthn.get', origin: o }))), 'webauthn.get', o)).toThrow(/no challenge/)
    expect(() => readClientData(undefined, 'webauthn.get', o)).toThrow(/required/)
  })
})

describe('passkey: clients never hold a private key', () => {
  it('a client sees a passkey without its key, and an edit keeps the stored key', () => {
    const stored = [
      { credentialId: 'a', keyValue: 'secret-a', rpId: 'a.com', userDisplayName: 'A' },
      { credentialId: 'b', keyValue: 'secret-b', rpId: 'b.com' },
    ]
    const sent = stored.map(publicPasskey)
    expect(sent.every((p) => !('keyValue' in p))).toBe(true)
    // Removing one, renaming the other, and trying to swap in a key of the client's own.
    const merged = mergePasskeys(stored, [{ ...sent[0], userDisplayName: 'A2', keyValue: 'forged', rpId: 'evil.com' }])
    expect(merged).toEqual([{ credentialId: 'a', keyValue: 'secret-a', rpId: 'a.com', userDisplayName: 'A2' }])
    // One the item never had is not added.
    expect(mergePasskeys(stored, [{ credentialId: 'new', keyValue: 'k', rpId: 'x.com' }])).toEqual([])
    expect(fromB64u(b64u(Buffer.from('ok'))).toString()).toBe('ok')
  })
})
