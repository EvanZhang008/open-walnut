/**
 * Passkeys end to end on a real server (vault-v1.ts /vault/passkeys/* over passkey-store.ts):
 * the browser extension's three calls, checked the way a site's server checks the answers
 * (the signature against the key the registration gave, with Node's crypto). Who may call them,
 * which page may use which site, a private key that never reaches a client, an edit that keeps
 * it, and a passkey imported from Bitwarden. Fake data only; the vault lives in the test's own
 * data home.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import crypto from 'node:crypto'
import fsp from 'node:fs/promises'
import type { AddressInfo } from 'node:net'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-vault-passkeys-e2e'))

import { WALNUT_HOME } from '../../src/constants.js'
import { startServer, stopServer } from '../../src/web/server.js'
import { derivePasswordKey, randomBytes, toB64, type KdfParams } from '../../src/core/vault/crypto.js'
import { resetVaultForTest } from '../../src/core/vault/store.js'
import { resetSessionsForTest } from '../../src/core/vault/sessions.js'

let base = ''
let session = ''
const kdf: KdfParams = { name: 'PBKDF2-SHA256', iterations: 600_000, salt: toB64(randomBytes(16)) }

async function http(method: string, p: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(`${base}/api/v1${p}`, {
    method,
    headers: { 'content-type': 'application/json', ...(session ? { 'x-walnut-vault-session': session } : {}), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  return { status: res.status, body: await res.json().catch(() => ({})) as Record<string, any> }
}

const b64u = (b: Buffer | string) => Buffer.from(b).toString('base64url')
const sha = (b: Buffer | string) => crypto.createHash('sha256').update(b).digest()
const clientData = (type: string, origin: string) => b64u(JSON.stringify({ type, challenge: b64u(crypto.randomBytes(32)), origin, crossOrigin: false }))

/** What a site's server does with a sign-in: verify the signature with the key it kept. */
function verifies(spkiB64u: string, r: { authenticatorData: string; signature: string }, cd: string): boolean {
  const key = crypto.createPublicKey({ key: Buffer.from(spkiB64u, 'base64url'), format: 'der', type: 'spki' })
  const auth = Buffer.from(r.authenticatorData, 'base64url')
  return crypto.verify('sha256', Buffer.concat([auth, sha(Buffer.from(cd, 'base64url'))]), key, Buffer.from(r.signature, 'base64url'))
}

const ORIGIN = 'https://login.shop.example.com'
const RP = 'shop.example.com'
const user = { id: b64u('user-42'), name: 'alice@shop.example.com', displayName: 'Alice' }

beforeAll(async () => {
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true })
  resetVaultForTest(null)
  resetSessionsForTest()
  const server = await startServer({ port: 0, dev: true })
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const pwKey = toB64(await derivePasswordKey('passkey test horses battery', kdf))
  const r = await http('POST', '/vault/setup', { passwordKey: pwKey, kdf, agentsWhileAway: false, client: 'test' })
  expect(r.status).toBe(200)
  session = r.body.session.token
}, 120_000)

afterAll(async () => {
  await stopServer()
})

describe('passkeys through the vault routes', () => {
  let made: Record<string, any>

  it('only a person with the vault unlocked may use them', async () => {
    for (const p of ['/vault/passkeys/match', '/vault/passkeys/create', '/vault/passkeys/assert']) {
      const agent = await http('POST', p, { origin: ORIGIN }, { 'x-walnut-caller-sid': 's1' })
      expect(agent.status).toBe(403)
      expect(agent.body.code).toBe('human_only')
      const held = session
      session = ''
      try {
        expect((await http('POST', p, { origin: ORIGIN })).body.code).toBe('vault_session_needed')
      } finally { session = held }
    }
  })

  it('a site registers one: a new login holds it, and no client ever gets its private key', async () => {
    const r = await http('POST', '/vault/passkeys/create', { origin: ORIGIN, rpId: RP, rpName: 'Shop', user, clientDataJSON: clientData('webauthn.create', ORIGIN) })
    expect(r.status).toBe(200)
    made = r.body
    expect(made.publicKeyAlgorithm).toBe(-7)
    expect(Buffer.from(made.credentialId, 'base64url')).toHaveLength(16)
    const auth = Buffer.from(made.authenticatorData, 'base64url')
    expect(auth.subarray(0, 32).equals(sha(RP))).toBe(true)
    expect(auth[32] & 0x40).toBe(0x40)
    const item = (await http('GET', `/vault/items/${made.itemId}`)).body.item
    expect(item).toMatchObject({ type: 'login', title: 'Shop', username: user.name, urls: [ORIGIN] })
    expect(item.passkeys).toHaveLength(1)
    expect(item.passkeys[0]).toMatchObject({ rpId: RP, userName: user.name, userDisplayName: 'Alice', keyAlgorithm: 'ECDSA', discoverable: 'true' })
    expect(item.passkeys[0]).not.toHaveProperty('keyValue')
    const summary = (await http('GET', '/vault/items')).body.items.find((i: { id: string }) => i.id === made.itemId)
    expect(summary.passkeyCount).toBe(1)
    expect(JSON.stringify(summary)).not.toMatch(/keyValue/)
  })

  it('the site\'s pages find it and sign in; the site verifies the signature with the key it kept', async () => {
    for (const origin of [ORIGIN, 'https://shop.example.com']) {
      const m = await http('POST', '/vault/passkeys/match', { origin, rpId: RP })
      expect(m.body.passkeys).toEqual([expect.objectContaining({ itemId: made.itemId, credentialId: made.credentialId, userName: user.name, rpId: RP })])
    }
    // Named in the site's allow list, or another credential named: then none.
    expect((await http('POST', '/vault/passkeys/match', { origin: ORIGIN, rpId: RP, allow: [made.credentialId] })).body.passkeys).toHaveLength(1)
    expect((await http('POST', '/vault/passkeys/match', { origin: ORIGIN, rpId: RP, allow: [b64u(crypto.randomBytes(16))] })).body.passkeys).toEqual([])
    const cd = clientData('webauthn.get', ORIGIN)
    const a = await http('POST', '/vault/passkeys/assert', { origin: ORIGIN, rpId: RP, credentialId: made.credentialId, clientDataJSON: cd })
    expect(a.status).toBe(200)
    expect(a.body.userHandle).toBe(user.id)
    expect(verifies(made.publicKey, a.body, cd)).toBe(true)
    // A passkey made here never counts (a synced passkey): the counter stays 0.
    expect(Buffer.from(a.body.authenticatorData, 'base64url').readUInt32BE(33)).toBe(0)
  })

  it('another site, or client data for another origin, gets nothing', async () => {
    for (const origin of ['https://evil.test', 'https://shop.example.com.evil.test', 'http://shop.example.com']) {
      const m = await http('POST', '/vault/passkeys/match', { origin, rpId: RP })
      expect(m.status).toBe(403)
      expect(m.body.code).toBe('passkey_rp')
      const a = await http('POST', '/vault/passkeys/assert', { origin, rpId: RP, credentialId: made.credentialId, clientDataJSON: clientData('webauthn.get', origin) })
      expect(a.body.code).toBe('passkey_rp')
    }
    const a = await http('POST', '/vault/passkeys/assert', { origin: ORIGIN, rpId: RP, credentialId: made.credentialId, clientDataJSON: clientData('webauthn.get', 'https://evil.test') })
    expect(a.status).toBe(403)
    expect(a.body.code).toBe('passkey_origin')
    const c = await http('POST', '/vault/passkeys/assert', { origin: ORIGIN, rpId: RP, credentialId: made.credentialId, clientDataJSON: clientData('webauthn.create', ORIGIN) })
    expect(c.body.code).toBe('bad_passkey_request')
    // Its own subdomain's id is not the parent's: a passkey for the parent stays with the parent.
    expect((await http('POST', '/vault/passkeys/match', { origin: ORIGIN, rpId: 'login.shop.example.com' })).body.passkeys).toEqual([])
  })

  it('a site that already has this passkey for the account is told so; registering the account again replaces it', async () => {
    const ex = await http('POST', '/vault/passkeys/create', { origin: ORIGIN, rpId: RP, user, exclude: [made.credentialId], clientDataJSON: clientData('webauthn.create', ORIGIN) })
    expect(ex.status).toBe(409)
    expect(ex.body.code).toBe('passkey_exists')
    const again = await http('POST', '/vault/passkeys/create', { origin: ORIGIN, rpId: RP, user, clientDataJSON: clientData('webauthn.create', ORIGIN) })
    expect(again.status).toBe(200)
    // The same login (its user name on this site), one passkey: the new one.
    expect(again.body.itemId).toBe(made.itemId)
    const item = (await http('GET', `/vault/items/${made.itemId}`)).body.item
    expect(item.passkeys.map((p: { credentialId: string }) => Buffer.from(p.credentialId.replace(/-/g, ''), 'hex').toString('base64url'))).toEqual([again.body.credentialId])
    expect((await http('POST', '/vault/passkeys/assert', { origin: ORIGIN, rpId: RP, credentialId: made.credentialId, clientDataJSON: clientData('webauthn.get', ORIGIN) })).body.code).toBe('no_passkey')
    made = again.body
  })

  it('an edit from a client (which never had the key) keeps the key; removing it in an edit removes it', async () => {
    const item = (await http('GET', `/vault/items/${made.itemId}`)).body.item
    const u = await http('PUT', `/vault/items/${made.itemId}`, { item: { ...item, password: 'Changed-pass-1!' } })
    expect(u.status).toBe(200)
    expect(u.body.item.passkeys[0]).not.toHaveProperty('keyValue')
    const cd = clientData('webauthn.get', ORIGIN)
    const a = await http('POST', '/vault/passkeys/assert', { origin: ORIGIN, rpId: RP, credentialId: made.credentialId, clientDataJSON: cd })
    expect(verifies(made.publicKey, a.body, cd)).toBe(true)
    // A client cannot put in a key of its own.
    const forged = await http('PUT', `/vault/items/${made.itemId}`, { item: { ...u.body.item, passkeys: [{ ...u.body.item.passkeys[0], keyValue: b64u(crypto.randomBytes(40)) }] } })
    const cd2 = clientData('webauthn.get', ORIGIN)
    expect(verifies(made.publicKey, (await http('POST', '/vault/passkeys/assert', { origin: ORIGIN, rpId: RP, credentialId: made.credentialId, clientDataJSON: cd2 })).body, cd2)).toBe(true)
    const removed = await http('PUT', `/vault/items/${made.itemId}`, { item: { ...forged.body.item, passkeys: [] } })
    expect(removed.body.item.passkeys).toBeUndefined()
    expect((await http('POST', '/vault/passkeys/match', { origin: ORIGIN, rpId: RP })).body.passkeys).toEqual([])
  })

  it('a passkey on a login in the trash is not offered', async () => {
    const r = await http('POST', '/vault/passkeys/create', { origin: ORIGIN, rpId: RP, user: { ...user, id: b64u('user-43'), name: 'bob@shop.example.com' }, clientDataJSON: clientData('webauthn.create', ORIGIN) })
    expect(r.body.itemId).not.toBe(made.itemId)
    expect((await http('POST', '/vault/passkeys/match', { origin: ORIGIN, rpId: RP })).body.passkeys).toHaveLength(1)
    await http('POST', `/vault/items/${r.body.itemId}/trash`)
    expect((await http('POST', '/vault/passkeys/match', { origin: ORIGIN, rpId: RP })).body.passkeys).toEqual([])
    expect((await http('POST', '/vault/passkeys/assert', { origin: ORIGIN, rpId: RP, credentialId: r.body.credentialId, clientDataJSON: clientData('webauthn.get', ORIGIN) })).body.code).toBe('no_passkey')
  })

  it('one imported from Bitwarden signs in as it is, and its counter goes on from where it was', async () => {
    const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' })
    const guid = crypto.randomUUID()
    const json = JSON.stringify({
      encrypted: false,
      items: [{ type: 1, name: 'Code host', login: {
        username: 'octo', uris: [{ uri: 'https://code.example.org' }],
        fido2Credentials: [{
          credentialId: guid, keyType: 'public-key', keyAlgorithm: 'ECDSA', keyCurve: 'P-256',
          keyValue: (privateKey.export({ format: 'der', type: 'pkcs8' }) as Buffer).toString('base64url'),
          rpId: 'code.example.org', userHandle: b64u('octo-1'), userName: 'octo', counter: '7', rpName: 'Code', userDisplayName: 'Octo',
          discoverable: 'true', creationDate: '2025-01-02T03:04:05.000Z',
        }],
      } }],
    })
    const imp = await http('POST', '/vault/import', { text: json, fileName: 'bitwarden.json', dryRun: false })
    expect(imp.status).toBe(200)
    const origin = 'https://code.example.org'
    const [m] = (await http('POST', '/vault/passkeys/match', { origin })).body.passkeys
    expect(m).toMatchObject({ userName: 'octo', credentialId: Buffer.from(guid.replace(/-/g, ''), 'hex').toString('base64url') })
    const spki = b64u(publicKey.export({ format: 'der', type: 'spki' }) as Buffer)
    for (const want of [8, 9]) {
      const cd = clientData('webauthn.get', origin)
      const a = await http('POST', '/vault/passkeys/assert', { origin, credentialId: m.credentialId, clientDataJSON: cd })
      expect(a.status).toBe(200)
      expect(verifies(spki, a.body, cd)).toBe(true)
      expect(Buffer.from(a.body.authenticatorData, 'base64url').readUInt32BE(33)).toBe(want)
      expect(a.body.userHandle).toBe(b64u('octo-1'))
    }
    const item = (await http('GET', `/vault/items/${m.itemId}`)).body.item
    expect(item.passkeys[0].counter).toBe('9')
    expect(item.usedAt).toBeTruthy()
  })
})
