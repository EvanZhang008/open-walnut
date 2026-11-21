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
  createdAt?: string
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
      out.push({
        itemId: it.id, title: it.title, credentialId: id, rpId,
        ...(str(pk.userName) ? { userName: str(pk.userName) } : {}),
        ...(str(pk.userDisplayName) ? { userDisplayName: str(pk.userDisplayName) } : {}),
        ...(str(pk.creationDate) ? { createdAt: str(pk.creationDate) } : {}),
      })
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

/** What the person is asked to approve (passkey-approval.ts): the site, the account, the login it goes on. */
export interface RequestSummary {
  rpId: string
  origin: string
  userName?: string
  userDisplayName?: string
  rpName?: string
  /** The login it goes on (create), or the one it signs in as (get). */
  itemId?: string
  itemTitle?: string
  credentialId?: string
}

interface CheckedCreate { origin: string; rpId: string; userHandle: Buffer; userName?: string; userDisplayName?: string; rpName?: string; items: VaultItem[]; home?: VaultItem }

async function checkedCreate(r: CreateRequest): Promise<CheckedCreate> {
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
  return { origin, rpId, userHandle, userName, userDisplayName, rpName, items, home: homeFor(items, rpId, userName, r.itemId) }
}

/** A registration checked as createPasskey checks it, nothing written: what the person is asked. */
export async function checkCreate(r: CreateRequest): Promise<RequestSummary> {
  const c = await checkedCreate(r)
  return {
    rpId: c.rpId, origin: c.origin,
    ...(c.userName ? { userName: c.userName } : {}), ...(c.userDisplayName ? { userDisplayName: c.userDisplayName } : {}),
    ...(c.rpName ? { rpName: c.rpName } : {}),
    ...(c.home ? { itemId: c.home.id, itemTitle: c.home.title } : {}),
  }
}

/** Only the fields a request may carry, as plain data (kept by passkey-approval.ts until the yes). */
export function cleanRequest(op: 'create' | 'get', raw: unknown): CreateRequest | AssertRequest {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const s = (v: unknown) => (typeof v === 'string' ? v.slice(0, 20_000) : undefined)
  const list = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').slice(0, 200) : undefined)
  if (op === 'get') return { origin: s(r.origin), rpId: s(r.rpId), credentialId: s(r.credentialId), clientDataJSON: s(r.clientDataJSON) }
  const u = (r.user && typeof r.user === 'object' ? r.user : {}) as Record<string, unknown>
  return {
    origin: s(r.origin), rpId: s(r.rpId), rpName: s(r.rpName), clientDataJSON: s(r.clientDataJSON),
    user: { id: s(u.id), name: s(u.name), displayName: s(u.displayName) },
    exclude: list(r.exclude), itemId: s(r.itemId),
  }
}

/**
 * Make a passkey. Only passkey-approval.ts calls it, after the person's yes for this very request.
 * A site registering the same account again gets a new passkey beside the old one: Walnut cannot
 * see whether the site took the new one, so dropping the old here could leave none that works.
 */
export async function createPasskey(r: CreateRequest): Promise<Created> {
  const { origin, rpId, userHandle, userName, userDisplayName, rpName, home } = await checkedCreate(r)
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
    // Bitwarden never has it, so a sync from Bitwarden keeps it (sources/bitwarden/sync.ts).
    madeBy: 'walnut',
  }
  let itemId: string
  if (home) {
    const saved = await patchItem(home.id, (it) => ({ ...it, passkeys: [...(it.passkeys ?? []), stored], updatedAt: new Date().toISOString() }))
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

async function checkedAssert(r: AssertRequest): Promise<{ origin: string; rpId: string; json: Buffer; want: Buffer; found: { item: VaultItem; pk: StoredPasskey } }> {
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
  if (!found || !usable(found.pk)) throw new PasskeyError('Walnut keeps no such passkey for this site', 404, 'no_passkey')
  return { origin, rpId, json, want, found }
}

/** A sign-in checked as signInWithPasskey checks it, nothing signed: what the person is asked. */
export async function checkAssert(r: AssertRequest): Promise<RequestSummary> {
  const { origin, rpId, want, found } = await checkedAssert(r)
  return {
    rpId, origin, itemId: found.item.id, itemTitle: found.item.title, credentialId: b64u(want),
    ...(str(found.pk.userName) ? { userName: str(found.pk.userName) } : {}),
    ...(str(found.pk.userDisplayName) ? { userDisplayName: str(found.pk.userDisplayName) } : {}),
    ...(str(found.pk.rpName) ? { rpName: str(found.pk.rpName) } : {}),
  }
}

/** Sign a sign-in. Only passkey-approval.ts calls it, after the person's yes for this very request. */
export async function signInWithPasskey(r: AssertRequest): Promise<Asserted> {
  const { rpId, json, want, found } = await checkedAssert(r)
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

