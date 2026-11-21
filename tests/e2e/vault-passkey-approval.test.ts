/**
 * The person's yes for every passkey Walnut makes or signs with (routes/vault-passkeys-v1.ts over
 * core/vault/passkey-approval.ts and passkey-confirm-keys.ts), on a real server:
 *   - an unlocked vault session alone makes and signs nothing: begin keeps the request, and only
 *     approve with proof runs it, once, as it was kept;
 *   - proof is the master password again (slowed like every password check), or the person's
 *     confirm key: a WebAuthn credential of the extension itself, added with the master password,
 *     whose user-verified signature over the challenge Walnut checks (here a software key stands in
 *     for the browser's platform authenticator);
 *   - another session cannot approve, an approved request cannot run twice, a cancel ends it.
 * Fake data only; the vault lives in the test's own data home.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import crypto from 'node:crypto'
import fsp from 'node:fs/promises'
import type { AddressInfo } from 'node:net'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-vault-passkey-approval-e2e'))

import { WALNUT_HOME } from '../../src/constants.js'
import { startServer, stopServer } from '../../src/web/server.js'
import { derivePasswordKey, randomBytes, toB64, type KdfParams } from '../../src/core/vault/crypto.js'
import { resetVaultForTest } from '../../src/core/vault/store.js'
import { resetSessionsForTest } from '../../src/core/vault/sessions.js'

let base = ''
let pwKey = ''
let sessionA = ''
let sessionB = ''
const kdf: KdfParams = { name: 'PBKDF2-SHA256', iterations: 600_000, salt: toB64(randomBytes(16)) }

async function http(method: string, p: string, body: unknown, session: string, headers: Record<string, string> = {}) {
  const res = await fetch(`${base}/api/v1${p}`, {
    method,
    headers: { 'content-type': 'application/json', ...(session ? { 'x-walnut-vault-session': session } : {}), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  return { status: res.status, body: await res.json().catch(() => ({})) as Record<string, any> }
}

const b64u = (b: Buffer | string) => Buffer.from(b).toString('base64url')
const sha = (b: Buffer | string) => crypto.createHash('sha256').update(b).digest()
const ORIGIN = 'https://app.example.net'
const clientData = (type: string, origin: string, challenge = b64u(crypto.randomBytes(32))) => b64u(JSON.stringify({ type, challenge, origin, crossOrigin: false }))
const createReq = () => ({ origin: ORIGIN, rpId: 'app.example.net', rpName: 'App', user: { id: b64u(crypto.randomBytes(8)), name: 'carol@example.net' }, clientDataJSON: clientData('webauthn.create', ORIGIN) })

/** A software stand-in for the browser's platform authenticator, for the extension's own rp id. */
const EXT_ORIGIN = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop'
const EXT_RP = 'abcdefghijklmnopabcdefghijklmnop'
function authenticator() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' })
  const id = crypto.randomBytes(16)
  const ad = (flags: number) => Buffer.concat([sha(EXT_RP), Buffer.from([flags]), Buffer.alloc(4)])
  return {
    id: b64u(id),
    enroll: (challenge: string, flags = 0x45) => ({
      credentialId: b64u(id),
      publicKey: b64u(publicKey.export({ format: 'der', type: 'spki' }) as Buffer),
      clientDataJSON: b64u(JSON.stringify({ type: 'webauthn.create', challenge, origin: EXT_ORIGIN })),
      authenticatorData: b64u(ad(flags)),
    }),
    sign: (challenge: string, opts: { flags?: number; origin?: string; type?: string } = {}) => {
      const cd = Buffer.from(JSON.stringify({ type: opts.type ?? 'webauthn.get', challenge, origin: opts.origin ?? EXT_ORIGIN }))
      const auth = ad(opts.flags ?? 0x05)
      return {
        credentialId: b64u(id), clientDataJSON: b64u(cd), authenticatorData: b64u(auth),
        signature: b64u(crypto.sign('sha256', Buffer.concat([auth, sha(cd)]), privateKey)),
      }
    },
  }
}

beforeAll(async () => {
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true })
  resetVaultForTest(null)
  resetSessionsForTest()
  const server = await startServer({ port: 0, dev: true })
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  pwKey = toB64(await derivePasswordKey('approval test lantern river', kdf))
  const r = await http('POST', '/vault/setup', { passwordKey: pwKey, kdf, agentsWhileAway: false, client: 'test' }, '')
  expect(r.status).toBe(200)
  sessionA = r.body.session.token
  const u = await http('POST', '/vault/unlock', { passwordKey: pwKey, kdfSalt: kdf.salt, client: 'other' }, '')
  expect(u.status).toBe(200)
  sessionB = u.body.session.token
}, 120_000)

afterAll(async () => {
  await stopServer()
})

describe('a passkey needs the person\'s yes for that one request', () => {
  it('the old one-step routes are gone: nothing makes or signs a passkey with a session alone', async () => {
    for (const p of ['/vault/passkeys/create', '/vault/passkeys/assert']) {
      expect((await http('POST', p, createReq(), sessionA)).status).toBe(404)
    }
  })

  it('begin keeps the request and writes nothing; it says what the person is asked', async () => {
    const before = (await http('GET', '/vault/items', undefined, sessionA)).body.items.length
    const b = await http('POST', '/vault/passkeys/begin', { op: 'create', request: createReq() }, sessionA)
    expect(b.status).toBe(200)
    expect(b.body.summary).toMatchObject({ rpId: 'app.example.net', origin: ORIGIN, userName: 'carol@example.net', rpName: 'App' })
    expect(Buffer.from(b.body.challenge, 'base64url')).toHaveLength(32)
    expect((await http('GET', '/vault/items', undefined, sessionA)).body.items.length).toBe(before)
  })

  it('a bad request is refused at begin, before anyone is asked', async () => {
    const r = await http('POST', '/vault/passkeys/begin', { op: 'create', request: { ...createReq(), origin: 'http://app.example.net' } }, sessionA)
    expect(r.body.code).toBe('passkey_rp')
    const o = await http('POST', '/vault/passkeys/begin', { op: 'sign', request: createReq() }, sessionA)
    expect(o.body.code).toBe('bad_passkey_request')
  })

  it('a wrong master password does not approve, and the request stays open for the right one', async () => {
    const b = await http('POST', '/vault/passkeys/begin', { op: 'create', request: createReq() }, sessionA)
    const wrong = toB64(await derivePasswordKey('not the password', kdf))
    const w = await http('POST', '/vault/passkeys/approve', { id: b.body.id, passwordKey: wrong }, sessionA)
    expect(w.status).toBe(401)
    const ok = await http('POST', '/vault/passkeys/approve', { id: b.body.id, passwordKey: pwKey }, sessionA)
    expect(ok.status).toBe(200)
    expect(ok.body.op).toBe('create')
    expect(ok.body.publicKeyAlgorithm).toBe(-7)
  })

  it('another session cannot approve it, and an approved request never runs twice', async () => {
    const b = await http('POST', '/vault/passkeys/begin', { op: 'create', request: createReq() }, sessionA)
    expect((await http('POST', '/vault/passkeys/approve', { id: b.body.id, passwordKey: pwKey }, sessionB)).body.code).toBe('passkey_approval_gone')
    expect((await http('POST', '/vault/passkeys/approve', { id: b.body.id, passwordKey: pwKey }, sessionA)).status).toBe(200)
    expect((await http('POST', '/vault/passkeys/approve', { id: b.body.id, passwordKey: pwKey }, sessionA)).body.code).toBe('passkey_approval_gone')
  })

  it('a cancel ends it', async () => {
    const b = await http('POST', '/vault/passkeys/begin', { op: 'create', request: createReq() }, sessionA)
    expect((await http('POST', '/vault/passkeys/cancel', { id: b.body.id }, sessionA)).body.ok).toBe(true)
    expect((await http('POST', '/vault/passkeys/approve', { id: b.body.id, passwordKey: pwKey }, sessionA)).body.code).toBe('passkey_approval_gone')
  })

  describe('a confirm key (Touch ID through the browser)', () => {
    const auth = authenticator()

    it('is added only with the master password, made in the extension, with the user verified', async () => {
      const start = async () => (await http('POST', '/vault/passkeys/confirm-keys/begin', {}, sessionA)).body
      let e = await start()
      const noPw = await http('POST', '/vault/passkeys/confirm-keys', { enrollId: e.id, ...auth.enroll(e.challenge) }, sessionA)
      expect(noPw.status).toBe(400)
      e = await start()
      const fromSite = auth.enroll(e.challenge)
      fromSite.clientDataJSON = b64u(JSON.stringify({ type: 'webauthn.create', challenge: e.challenge, origin: 'https://evil.test' }))
      expect((await http('POST', '/vault/passkeys/confirm-keys', { enrollId: e.id, ...fromSite, passwordKey: pwKey }, sessionA)).body.code).toBe('bad_confirm_key')
      e = await start()
      expect((await http('POST', '/vault/passkeys/confirm-keys', { enrollId: e.id, ...auth.enroll(e.challenge, 0x41), passwordKey: pwKey }, sessionA)).body.code).toBe('confirm_not_verified')
      e = await start()
      const stale = auth.enroll('b2xkLWNoYWxsZW5nZQ')
      expect((await http('POST', '/vault/passkeys/confirm-keys', { enrollId: e.id, ...stale, passwordKey: pwKey }, sessionA)).body.code).toBe('bad_confirm_key')
      e = await start()
      const ok = await http('POST', '/vault/passkeys/confirm-keys', { enrollId: e.id, ...auth.enroll(e.challenge), passwordKey: pwKey, name: 'Chrome on this Mac' }, sessionA)
      expect(ok.status).toBe(200)
      expect(ok.body.key).toMatchObject({ id: auth.id, name: 'Chrome on this Mac' })
      const list = (await http('GET', '/vault/passkeys/confirm-keys', undefined, sessionA)).body.keys
      expect(list).toEqual([expect.objectContaining({ id: auth.id })])
      expect(JSON.stringify(list)).not.toMatch(/spki/)
    })

    it('its user-verified signature over the challenge approves; any other signature does not', async () => {
      const b = await http('POST', '/vault/passkeys/begin', { op: 'create', request: createReq() }, sessionA)
      const ch = b.body.challenge
      const refused = [
        auth.sign('b3RoZXItY2hhbGxlbmdl'),
        auth.sign(ch, { flags: 0x01 }),
        auth.sign(ch, { origin: 'chrome-extension://zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz' }),
        auth.sign(ch, { type: 'webauthn.create' }),
        { ...auth.sign(ch), signature: authenticator().sign(ch).signature },
        { ...authenticator().sign(ch) },
      ]
      for (const assertion of refused) {
        const r = await http('POST', '/vault/passkeys/approve', { id: b.body.id, assertion }, sessionA)
        expect(r.status).toBe(403)
        expect(r.body.code).toBe('confirm_refused')
      }
      const ok = await http('POST', '/vault/passkeys/approve', { id: b.body.id, assertion: auth.sign(ch) }, sessionA)
      expect(ok.status).toBe(200)
      // The same yes again: the request is spent.
      expect((await http('POST', '/vault/passkeys/approve', { id: b.body.id, assertion: auth.sign(ch) }, sessionA)).body.code).toBe('passkey_approval_gone')
      // And a sign-in with the new passkey, approved the same way, verifies as a site would check it.
      const cd = clientData('webauthn.get', ORIGIN)
      const g = await http('POST', '/vault/passkeys/begin', { op: 'get', request: { origin: ORIGIN, credentialId: ok.body.credentialId, clientDataJSON: cd } }, sessionA)
      expect(g.body.summary).toMatchObject({ userName: 'carol@example.net', credentialId: ok.body.credentialId })
      const a = await http('POST', '/vault/passkeys/approve', { id: g.body.id, assertion: auth.sign(g.body.challenge) }, sessionA)
      expect(a.status).toBe(200)
      const key = crypto.createPublicKey({ key: Buffer.from(ok.body.publicKey, 'base64url'), format: 'der', type: 'spki' })
      const authData = Buffer.from(a.body.authenticatorData, 'base64url')
      expect(crypto.verify('sha256', Buffer.concat([authData, sha(Buffer.from(cd, 'base64url'))]), key, Buffer.from(a.body.signature, 'base64url'))).toBe(true)
      // User present and verified, because the person said yes this time.
      expect(authData[32] & 0x05).toBe(0x05)
    })

    it('removed, it approves nothing', async () => {
      expect((await http('DELETE', `/vault/passkeys/confirm-keys/${auth.id}`, undefined, sessionA)).body.ok).toBe(true)
      const b = await http('POST', '/vault/passkeys/begin', { op: 'create', request: createReq() }, sessionA)
      expect((await http('POST', '/vault/passkeys/approve', { id: b.body.id, assertion: auth.sign(b.body.challenge) }, sessionA)).body.code).toBe('confirm_refused')
    })
  })
})
