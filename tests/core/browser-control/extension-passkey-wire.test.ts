/**
 * Which passkey requests the extension takes and which it leaves to the browser's own dialog
 * (packages/browser-extension/src/passkey-wire.ts), how a request crosses as JSON, and the client
 * data the background makes. Walnut never fakes what it is not: a security key, an enterprise
 * attestation, an extension it cannot honor (prf, largeBlob) and the username-field form go to the
 * browser untouched. Also: no passkey module logs anything (a private key or a request must never
 * reach a log), checked on every file that touches passkeys.
 */
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import {
  answeredExtensions, clientDataJSON, encodeCreate, encodeGet, fromB64u, leaveCreate, leaveGet, toB64u,
} from '../../../packages/browser-extension/src/passkey-wire'

const bytes = (n: number, v = 7) => new Uint8Array(n).fill(v)
const create = (extra: Record<string, unknown> = {}) => ({
  challenge: bytes(32), rp: { id: 'shop.example', name: 'Shop' }, user: { id: bytes(16, 1), name: 'ada', displayName: 'Ada' },
  pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }], ...extra,
})

describe('passkey requests on the wire', () => {
  it('a create() crosses as JSON with every buffer in base64url', () => {
    const w = encodeCreate(create({ excludeCredentials: [{ type: 'public-key', id: bytes(16, 9).buffer }], authenticatorSelection: { residentKey: 'required', userVerification: 'required' }, extensions: { credProps: true } }))!
    expect(w.challenge).toBe(toB64u(bytes(32)))
    expect(w.user).toEqual({ id: toB64u(bytes(16, 1)), name: 'ada', displayName: 'Ada' })
    expect(w.exclude).toEqual([{ id: toB64u(bytes(16, 9)), type: 'public-key' }])
    expect(w.algs).toEqual([-7, -257])
    expect(w.extensions).toEqual(['credProps'])
    expect(JSON.parse(JSON.stringify(w))).toEqual(w)
    expect(Array.from(fromB64u(w.challenge))).toEqual(Array.from(bytes(32)))
  })

  it('a malformed request is not taken', () => {
    expect(encodeCreate(null)).toBeNull()
    expect(encodeCreate({ ...create(), challenge: 'not bytes' })).toBeNull()
    expect(encodeCreate({ ...create(), user: { name: 'x' } })).toBeNull()
    expect(encodeGet({})).toBeNull()
  })

  it('takes an ordinary passkey registration, "direct" attestation included (answered with none)', () => {
    expect(leaveCreate(encodeCreate(create())!)).toBeNull()
    expect(leaveCreate(encodeCreate(create({ attestation: 'direct' }))!)).toBeNull()
    expect(leaveCreate(encodeCreate(create({ extensions: { credProps: true } }))!)).toBeNull()
  })

  it('leaves to the browser what Walnut would have to fake', () => {
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ pubKeyCredParams: [{ type: 'public-key', alg: -257 }] }, 'algorithm'],
      [{ authenticatorSelection: { authenticatorAttachment: 'cross-platform' } }, 'security-key'],
      [{ hints: ['security-key'] }, 'hint'],
      [{ attestation: 'enterprise' }, 'attestation'],
      [{ extensions: { prf: {} } }, 'extension'],
      [{ extensions: { largeBlob: { support: 'required' } } }, 'extension'],
    ]
    for (const [extra, why] of cases) expect(leaveCreate(encodeCreate(create(extra))!), JSON.stringify(extra)).toBe(why)
    // A conditional create (the silent passkey offer after a password sign-in) never opens a window.
    expect(leaveCreate(encodeCreate(create(), 'conditional')!)).toBe('conditional')
    expect(leaveCreate(encodeCreate(create(), 'required')!)).toBeNull()
  })

  it('a sign-in: taken unless it is the username-field form, a security key, or an extension Walnut cannot honor', () => {
    const get = (extra: Record<string, unknown> = {}, mediation?: string) => encodeGet({ challenge: bytes(32), rpId: 'shop.example', ...extra }, mediation)!
    expect(leaveGet(get())).toBeNull()
    expect(leaveGet(get({ allowCredentials: [{ type: 'public-key', id: bytes(16) }] }))).toBeNull()
    expect(leaveGet(get({}, 'conditional'))).toBe('conditional')
    expect(leaveGet(get({ hints: ['security-key'] }))).toBe('hint')
    expect(leaveGet(get({ extensions: { prf: { eval: { first: bytes(32) } } } }))).toBe('extension')
  })

  it('answers credProps only (Walnut knows its keys are discoverable), nothing it cannot back', () => {
    expect(answeredExtensions(['credProps', 'appid'])).toEqual({ credProps: { rk: true } })
    expect(answeredExtensions(['appid'])).toEqual({})
  })

  it('the client data names the browser\'s origin in the spec\'s key order', () => {
    const cd = JSON.parse(new TextDecoder().decode(fromB64u(clientDataJSON('webauthn.get', 'abc', 'https://shop.example'))))
    expect(Object.keys(cd)).toEqual(['type', 'challenge', 'origin', 'crossOrigin'])
    expect(cd).toEqual({ type: 'webauthn.get', challenge: 'abc', origin: 'https://shop.example', crossOrigin: false })
  })
})

describe('no passkey module logs', () => {
  const ROOT = path.resolve(__dirname, '../../..')
  const files = [
    ...fs.readdirSync(path.join(ROOT, 'src/core/vault')).filter((f) => f.startsWith('passkey')).map((f) => `src/core/vault/${f}`),
    'src/web/routes/vault-passkeys-v1.ts',
    ...fs.readdirSync(path.join(ROOT, 'packages/browser-extension/src')).filter((f) => /passkey/.test(f)).map((f) => `packages/browser-extension/src/${f}`),
  ]
  it('finds them all', () => { expect(files.length).toBeGreaterThanOrEqual(10) })
  for (const f of files) {
    it(`${f} has no log or console call`, () => {
      const src = fs.readFileSync(path.join(ROOT, f), 'utf8')
      expect(src).not.toMatch(/\bconsole\.(log|info|warn|error|debug)\(|\blog\.(info|warn|error|debug)\(/)
    })
  }
})
