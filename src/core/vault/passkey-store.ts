/**
 * Passkeys on vault items (passkey.ts has the format and the signing): which ones a site may
 * use, making one when a site registers, and signing a sign-in with one. The private key never
 * leaves the server: the browser extension sends the client data, the server answers with the
 * authenticator's part of the response.
 */
import crypto from 'node:crypto'
import { VaultError } from './state.js'
import { allItems, createItems, markUsed, patchItem } from './items.js'
import type { VaultItem } from './types.js'
import { matchItem } from './url-match.js'
import {
  ES256, PasskeyError, attestationObject, authData, b64u, credentialIdBytes, fromB64u, newKey, nextCounter, passkeyFor,
  readClientData, rpIdFor, sign, storedCredentialId, type StoredPasskey,
} from './passkey.js'

export interface PasskeyMatch {
  itemId: string
  title: string
  credentialId: string
  userName?: string
  userDisplayName?: string
  rpId: string
}

function needRp(origin: unknown, rpId: unknown): { origin: string; rpId: string } {
  const o = typeof origin === 'string' ? origin : ''
  const rp = rpIdFor(o, rpId)
  if (!rp) throw new PasskeyError('This page may not use a passkey for that site', 403, 'passkey_rp')
  return { origin: o, rpId: rp }
}

const usable = (pk: StoredPasskey) => typeof pk.keyValue === 'string' && !!pk.keyValue && !!credentialIdBytes(pk.credentialId)
const live = (it: VaultItem) => !it.trashedAt && it.type === 'login'
const str = (v: unknown) => (typeof v === 'string' && v ? v : undefined)

function idsOf(list: unknown): Set<string> {
  const out = new Set<string>()
  if (!Array.isArray(list)) return out
  for (const x of list.slice(0, 200)) if (typeof x === 'string' && x) out.add(b64u(fromB64u(x)))
  return out
}

/** The passkeys a page on `origin` may use for `rpId`, only those named in `allow` when it names any. */
export async function matchPasskeys(p: { origin: unknown; rpId?: unknown; allow?: unknown }): Promise<PasskeyMatch[]> {
  const { rpId } = needRp(p.origin, p.rpId)
  const allow = idsOf(p.allow)
  const out: PasskeyMatch[] = []
  for (const it of await allItems()) {
    if (!live(it)) continue
    for (const pk of it.passkeys ?? []) {
      if (!passkeyFor(pk, rpId) || !usable(pk)) continue
      const id = b64u(credentialIdBytes(pk.credentialId)!)
      if (allow.size && !allow.has(id)) continue
      // A sign-in that names no credential uses a discoverable one only.
      if (!allow.size && pk.discoverable === 'false') continue
      out.push({ itemId: it.id, title: it.title, credentialId: id, rpId, ...(str(pk.userName) ? { userName: str(pk.userName) } : {}), ...(str(pk.userDisplayName) ? { userDisplayName: str(pk.userDisplayName) } : {}) })
    }
  }
  return out.sort((a, b) => (a.userName ?? a.title).localeCompare(b.userName ?? b.title))
}

export interface CreateRequest {
  origin: unknown
  rpId?: unknown
  rpName?: unknown
  user?: { id?: unknown; name?: unknown; displayName?: unknown }
  clientDataJSON: unknown
  /** Credential ids (base64url) the site already has for this account: none of ours may be one. */
  exclude?: unknown
  /** The login to keep it on (else one for this site and user, or a new one). */
  itemId?: unknown
}

export interface Created {
  itemId: string
  credentialId: string
  attestationObject: string
  authenticatorData: string
  publicKey: string
  publicKeyAlgorithm: number
}

/** The login a new passkey goes on: the one named, else this site's login of that user name, else none. */
function homeFor(items: VaultItem[], rpId: string, userName: string | undefined, itemId: unknown): VaultItem | undefined {
  if (typeof itemId === 'string' && itemId) {
    const it = items.find((x) => x.id === itemId && live(x))
    if (!it) throw new VaultError('No such login', 404, 'not_found')
    return it
  }
  if (!userName) return undefined
  const page = `https://${rpId}`
  return items.find((x) => live(x) && x.username === userName && !!matchItem(x.urls, page))
}

export async function createPasskey(r: CreateRequest): Promise<Created> {
  const { origin, rpId } = needRp(r.origin, r.rpId)
  readClientData(r.clientDataJSON, 'webauthn.create', origin)
  const userHandle = typeof r.user?.id === 'string' ? fromB64u(r.user.id) : Buffer.alloc(0)
  if (!userHandle.length || userHandle.length > 64) throw new PasskeyError('user.id must be 1 to 64 bytes', 400, 'bad_passkey_request')
  const userName = str(r.user?.name)?.slice(0, 500)
  const userDisplayName = str(r.user?.displayName)?.slice(0, 500)
  const rpName = str(r.rpName)?.slice(0, 200)
  const items = await allItems()
  const exclude = idsOf(r.exclude)
  if (exclude.size) {
    for (const it of items) {
      if (!live(it)) continue
      for (const pk of it.passkeys ?? []) {
        const id = credentialIdBytes(pk.credentialId)
        if (passkeyFor(pk, rpId) && id && exclude.has(b64u(id))) throw new PasskeyError('Walnut already keeps a passkey for this account on this site', 409, 'passkey_exists')
      }
    }
  }
  const key = newKey()
  const idBytes = crypto.randomBytes(16)
  const stored: StoredPasskey = {
    credentialId: storedCredentialId(idBytes),
    keyType: 'public-key', keyAlgorithm: 'ECDSA', keyCurve: 'P-256',
    keyValue: b64u(key.privatePkcs8),
    rpId, ...(rpName ? { rpName } : {}),
    userHandle: b64u(userHandle),
    ...(userName ? { userName } : {}), ...(userDisplayName ? { userDisplayName } : {}),
    counter: '0', discoverable: 'true', creationDate: new Date().toISOString(),
  }
  // A site registering the same account again replaces the passkey it had for it here.
  const sameUser = (pk: StoredPasskey) => passkeyFor(pk, rpId) && pk.userHandle !== undefined && fromB64u(String(pk.userHandle)).equals(userHandle)
  const home = homeFor(items, rpId, userName, r.itemId)
  let itemId: string
  if (home) {
    const saved = await patchItem(home.id, (it) => ({ ...it, passkeys: [...(it.passkeys ?? []).filter((pk) => !sameUser(pk)), stored], updatedAt: new Date().toISOString() }))
    itemId = saved!.id
  } else {
    const [made] = await createItems([{ type: 'login', title: rpName || rpId, ...(userName ? { username: userName } : {}), urls: [origin], passkeys: [stored] }])
    itemId = made.id
  }
  const auth = authData(rpId, 0, { credentialId: idBytes, cose: key.cose })
  return {
    itemId,
    credentialId: b64u(idBytes),
    attestationObject: b64u(attestationObject(auth)),
    authenticatorData: b64u(auth),
    publicKey: b64u(key.spki),
    publicKeyAlgorithm: ES256,
  }
}

export interface AssertRequest {
  origin: unknown
  rpId?: unknown
  credentialId: unknown
  clientDataJSON: unknown
}

export interface Asserted {
  itemId: string
  credentialId: string
  authenticatorData: string
  signature: string
  userHandle?: string
}

export async function signInWithPasskey(r: AssertRequest): Promise<Asserted> {
  const { origin, rpId } = needRp(r.origin, r.rpId)
  const { json } = readClientData(r.clientDataJSON, 'webauthn.get', origin)
  const want = typeof r.credentialId === 'string' && r.credentialId ? fromB64u(r.credentialId) : null
  if (!want?.length) throw new PasskeyError('credentialId is required', 400, 'bad_passkey_request')
  let found: { item: VaultItem; pk: StoredPasskey } | undefined
  for (const item of await allItems()) {
    if (!live(item)) continue
    const pk = (item.passkeys ?? []).find((x) => passkeyFor(x, rpId) && credentialIdBytes(x.credentialId)?.equals(want))
    if (pk) { found = { item, pk }; break }
  }
  if (!found) throw new PasskeyError('Walnut keeps no such passkey for this site', 404, 'no_passkey')
  const counter = nextCounter(found.pk)
  const auth = authData(rpId, counter)
  const signature = sign(found.pk, auth, json)
  const id = String(found.pk.credentialId)
  if (counter > 0) {
    await patchItem(found.item.id, (it) => ({ ...it, passkeys: (it.passkeys ?? []).map((x) => (x.credentialId === id && passkeyFor(x, rpId) ? { ...x, counter: String(counter) } : x)), usedAt: new Date().toISOString() }))
  } else {
    await markUsed(found.item.id)
  }
  const uh = str(found.pk.userHandle)
  return {
    itemId: found.item.id,
    credentialId: b64u(want),
    authenticatorData: b64u(auth),
    signature: b64u(signature),
    ...(uh ? { userHandle: b64u(fromB64u(uh)) } : {}),
  }
}

