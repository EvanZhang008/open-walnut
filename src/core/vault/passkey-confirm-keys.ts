/**
 * Confirm keys: how the person says yes to a passkey request with Touch ID (passkey-approval.ts).
 *
 * The browser extension asks the browser's own WebAuthn, in an extension page, for a credential of
 * the extension itself (its rp id is the extension's own, never a site's: Chrome 122+, Firefox
 * 150+). The browser keeps that key in its platform authenticator (on a Mac, behind Touch ID); the
 * extension never holds it. Walnut keeps only the public key, added with the master password, and
 * takes a yes only as that key's signature over the approval's challenge with the user-verified
 * flag set. What the server can prove is exactly that: the enrolled key signed this challenge after
 * the authenticator verified the user. Which way it verified (Touch ID, the Mac password) is the
 * authenticator's, not Walnut's.
 *
 * `passkey-confirm-keys.json` is a side file (state.ts) sealed with the vault key, so a process that
 * cannot open the vault cannot plant a key of its own there.
 */
import crypto from 'node:crypto'
import { openSide, updateSide } from './state.js'
import { PasskeyError, b64u, fromB64u } from './passkey.js'

const FILE = 'passkey-confirm-keys.json' as const
const MAX_KEYS = 10
const ENROLL_MS = 180_000
const FLAG_UP = 0x01
const FLAG_UV = 0x04

export interface ConfirmKey {
  /** The credential id, base64url. */
  id: string
  /** The public key, base64url SPKI DER (P-256). */
  spki: string
  /** The extension origin the key was made in (clientDataJSON.origin at enrollment). */
  origin: string
  /** sha256 of the rp id the key was made for, hex (from the enrollment's authenticator data). */
  rpIdHash: string
  name: string
  createdAt: string
  usedAt?: string
}
interface KeysFile { version: 1; keys: ConfirmKey[] }

/** What a person sees of a key: never anything secret (there is none), but no need for the key bytes either. */
export interface ConfirmKeyView { id: string; name: string; createdAt: string; usedAt?: string }

const view = (k: ConfirmKey): ConfirmKeyView => ({ id: k.id, name: k.name, createdAt: k.createdAt, ...(k.usedAt ? { usedAt: k.usedAt } : {}) })

async function readKeys(): Promise<ConfirmKey[]> {
  const f = await openSide<KeysFile>(FILE)
  return Array.isArray(f?.keys) ? f!.keys : []
}

export async function listConfirmKeys(): Promise<ConfirmKeyView[]> {
  return (await readKeys()).map(view)
}

/** An extension page's origin: the only place a confirm key may be made and used. */
export function extensionOrigin(o: unknown): o is string {
  return typeof o === 'string' && /^(chrome-extension|moz-extension|extension):\/\/[a-z0-9-]{1,128}$/i.test(o)
}

// ── enrollment: a challenge first, so a replayed old registration is refused ──

const enrolling = new Map<string, { challenge: string; expiresAt: number }>()

export function beginEnroll(now = Date.now()): { id: string; challenge: string; userId: string } {
  for (const [id, e] of enrolling) if (e.expiresAt <= now) enrolling.delete(id)
  if (enrolling.size > 20) enrolling.delete(enrolling.keys().next().value!)
  const id = `pke-${crypto.randomBytes(12).toString('hex')}`
  const challenge = b64u(crypto.randomBytes(32))
  enrolling.set(id, { challenge, expiresAt: now + ENROLL_MS })
  return { id, challenge, userId: b64u(crypto.randomBytes(16)) }
}

export interface EnrollRequest {
  enrollId: unknown
  credentialId: unknown
  /** response.getPublicKey(): SPKI DER, base64url. */
  publicKey: unknown
  clientDataJSON: unknown
  /** response.getAuthenticatorData(), base64url. */
  authenticatorData: unknown
  name?: unknown
}

function publicKeyOf(spki: Buffer): crypto.KeyObject {
  let key: crypto.KeyObject
  try { key = crypto.createPublicKey({ key: spki, format: 'der', type: 'spki' }) } catch { throw new PasskeyError('The confirm key is not a public key', 400, 'bad_confirm_key') }
  const d = key.asymmetricKeyDetails
  if (key.asymmetricKeyType !== 'ec' || d?.namedCurve !== 'prime256v1') throw new PasskeyError('The confirm key must be P-256 (ES256)', 400, 'bad_confirm_key')
  return key
}

/** Add a confirm key. The caller has checked the master password already (the route does, as for an export). */
export async function enrollConfirmKey(r: EnrollRequest, now = Date.now()): Promise<ConfirmKeyView> {
  const e = typeof r.enrollId === 'string' ? enrolling.get(r.enrollId) : undefined
  if (!e || e.expiresAt <= now) throw new PasskeyError('This setup has ended: start again', 410, 'confirm_enroll_gone')
  enrolling.delete(r.enrollId as string)
  if (typeof r.credentialId !== 'string' || !fromB64u(r.credentialId).length) throw new PasskeyError('credentialId is required', 400, 'bad_confirm_key')
  if (typeof r.publicKey !== 'string') throw new PasskeyError('publicKey is required', 400, 'bad_confirm_key')
  const spki = fromB64u(r.publicKey)
  publicKeyOf(spki)
  const cd = clientData(r.clientDataJSON)
  if (cd.type !== 'webauthn.create' || cd.challenge !== e.challenge) throw new PasskeyError('This is not the setup Walnut asked for', 400, 'bad_confirm_key')
  if (!extensionOrigin(cd.origin)) throw new PasskeyError('A confirm key is made only in the Walnut extension', 403, 'bad_confirm_key')
  const ad = typeof r.authenticatorData === 'string' ? fromB64u(r.authenticatorData) : Buffer.alloc(0)
  if (ad.length < 37) throw new PasskeyError('authenticatorData is required', 400, 'bad_confirm_key')
  if ((ad[32] & FLAG_UV) === 0) throw new PasskeyError('The browser did not verify you (no Touch ID or device password): this key cannot confirm', 400, 'confirm_not_verified')
  const key: ConfirmKey = {
    id: b64u(fromB64u(r.credentialId)),
    spki: b64u(spki),
    origin: cd.origin,
    rpIdHash: ad.subarray(0, 32).toString('hex'),
    name: (typeof r.name === 'string' && r.name.trim() ? r.name.trim() : 'This browser').slice(0, 80),
    createdAt: new Date(now).toISOString(),
  }
  await updateSide<KeysFile>(FILE, (cur) => {
    const keys = (Array.isArray(cur?.keys) ? cur!.keys : []).filter((k) => k.id !== key.id)
    return { version: 1, keys: [key, ...keys].slice(0, MAX_KEYS) }
  })
  return view(key)
}

export async function removeConfirmKey(id: unknown): Promise<boolean> {
  let removed = false
  await updateSide<KeysFile>(FILE, (cur) => {
    const keys = Array.isArray(cur?.keys) ? cur!.keys : []
    const next = keys.filter((k) => k.id !== id)
    removed = next.length !== keys.length
    return { version: 1, keys: next }
  })
  return removed
}

// ── a yes ──

export interface ConfirmAssertion { credentialId: unknown; clientDataJSON: unknown; authenticatorData: unknown; signature: unknown }

function clientData(b64: unknown): { type?: string; challenge?: string; origin?: string } {
  if (typeof b64 !== 'string' || !b64) throw new PasskeyError('clientDataJSON is required', 400, 'bad_confirm_proof')
  try { return JSON.parse(fromB64u(b64).toString('utf8')) } catch { throw new PasskeyError('clientDataJSON is not JSON', 400, 'bad_confirm_proof') }
}

/** The enrolled key signed `challenge`, in the extension it was made in, with the user verified. Throws otherwise. */
export async function verifyConfirmAssertion(a: ConfirmAssertion, challenge: string): Promise<void> {
  const refuse = (why: string) => new PasskeyError(why, 403, 'confirm_refused')
  const id = typeof a?.credentialId === 'string' ? b64u(fromB64u(a.credentialId)) : ''
  const key = (await readKeys()).find((k) => k.id === id)
  if (!key) throw refuse('This confirm key is not set up in Walnut')
  const cdJson = typeof a.clientDataJSON === 'string' ? fromB64u(a.clientDataJSON) : Buffer.alloc(0)
  const cd = clientData(a.clientDataJSON)
  if (cd.type !== 'webauthn.get' || cd.challenge !== challenge) throw refuse('The confirmation is for another request')
  if (cd.origin !== key.origin) throw refuse('The confirmation came from somewhere else')
  const ad = typeof a.authenticatorData === 'string' ? fromB64u(a.authenticatorData) : Buffer.alloc(0)
  if (ad.length < 37 || ad.subarray(0, 32).toString('hex') !== key.rpIdHash) throw refuse('The confirmation is for another key')
  if ((ad[32] & FLAG_UP) === 0 || (ad[32] & FLAG_UV) === 0) throw refuse('The browser did not verify you')
  const sig = typeof a.signature === 'string' ? fromB64u(a.signature) : Buffer.alloc(0)
  const signed = Buffer.concat([ad, crypto.createHash('sha256').update(cdJson).digest()])
  let ok = false
  try { ok = crypto.verify('sha256', signed, publicKeyOf(fromB64u(key.spki)), sig) } catch { ok = false }
  if (!ok) throw refuse('The confirmation signature does not check out')
  await updateSide<KeysFile>(FILE, (cur) => ({ version: 1, keys: (cur?.keys ?? []).map((k) => (k.id === key.id ? { ...k, usedAt: new Date().toISOString() } : k)) })).catch(() => undefined)
}

export function resetConfirmEnrollForTest(): void { enrolling.clear() }
