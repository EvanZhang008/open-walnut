/**
 * Passkey requests as they cross from a page to the background (passkey-page.ts → passkey-bridge.ts
 * → bg-passkey.ts) and back: plain JSON, every buffer as base64url. Also which requests Walnut
 * takes (the rest go straight back to the browser's own dialog) and the client data the background
 * makes. Pure: no extension API, so the page's world, the background and tests share it.
 */

export const REQUEST_EVENT = 'walnut-passkey-request'
export const ANSWER_EVENT = 'walnut-passkey-answer'
export const CANCEL_EVENT = 'walnut-passkey-cancel'

/** COSE ES256: the only algorithm Walnut makes. */
export const ES256 = -7

export function toB64u(buf: ArrayBuffer | ArrayBufferView): string {
  const bytes = buf instanceof ArrayBuffer ? new Uint8Array(buf) : new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength)
  let s = ''
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i])
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function fromB64u(s: string): Uint8Array<ArrayBuffer> {
  const b = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4))
  const out = new Uint8Array(new ArrayBuffer(b.length))
  for (let i = 0; i < b.length; i++) out[i] = b.charCodeAt(i)
  return out
}

const isBuf = (v: unknown): v is ArrayBuffer | ArrayBufferView => v instanceof ArrayBuffer || ArrayBuffer.isView(v)
const bufB64 = (v: unknown): string | undefined => (isBuf(v) ? toB64u(v) : undefined)

export interface WireDescriptor { id: string; type?: string; transports?: string[] }
export interface WireCreate {
  challenge: string
  rp: { id?: string; name?: string }
  user: { id: string; name?: string; displayName?: string }
  algs: number[]
  exclude: WireDescriptor[]
  attachment?: string
  residentKey?: string
  requireResidentKey?: boolean
  userVerification?: string
  attestation?: string
  extensions: string[]
  /** Extension inputs Walnut answers itself (credProps) or must refuse to fake (largeBlob, prf). */
  largeBlobRequired?: boolean
  hints?: string[]
  mediation?: string
}
export interface WireGet {
  challenge: string
  rpId?: string
  allow: WireDescriptor[]
  userVerification?: string
  extensions: string[]
  mediation?: string
  hints?: string[]
}

function descriptors(list: unknown): WireDescriptor[] {
  if (!Array.isArray(list)) return []
  const out: WireDescriptor[] = []
  for (const d of list.slice(0, 200)) {
    const id = bufB64((d as { id?: unknown })?.id)
    if (id) out.push({ id, ...(typeof d.type === 'string' ? { type: d.type } : {}), ...(Array.isArray(d.transports) ? { transports: d.transports.filter((t: unknown) => typeof t === 'string') } : {}) })
  }
  return out
}

const strOr = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)
const keysOf = (v: unknown): string[] => (v && typeof v === 'object' ? Object.keys(v as object) : [])

/** `publicKey` of a create() call, as JSON. Null when it is not a well-formed request. */
export function encodeCreate(pk: unknown, mediation?: unknown): WireCreate | null {
  if (!pk || typeof pk !== 'object') return null
  const o = pk as Record<string, any>
  const challenge = bufB64(o.challenge)
  const userId = bufB64(o.user?.id)
  if (!challenge || !userId || !o.rp || typeof o.rp !== 'object') return null
  const sel = (o.authenticatorSelection ?? {}) as Record<string, unknown>
  return {
    challenge,
    rp: { ...(strOr(o.rp.id) ? { id: o.rp.id } : {}), ...(strOr(o.rp.name) ? { name: o.rp.name } : {}) },
    user: { id: userId, ...(strOr(o.user.name) ? { name: o.user.name } : {}), ...(strOr(o.user.displayName) ? { displayName: o.user.displayName } : {}) },
    algs: Array.isArray(o.pubKeyCredParams) ? o.pubKeyCredParams.filter((p: any) => p?.type === 'public-key' && typeof p.alg === 'number').map((p: any) => p.alg) : [],
    exclude: descriptors(o.excludeCredentials),
    ...(strOr(sel.authenticatorAttachment) ? { attachment: sel.authenticatorAttachment as string } : {}),
    ...(strOr(sel.residentKey) ? { residentKey: sel.residentKey as string } : {}),
    ...(typeof sel.requireResidentKey === 'boolean' ? { requireResidentKey: sel.requireResidentKey } : {}),
    ...(strOr(sel.userVerification) ? { userVerification: sel.userVerification as string } : {}),
    ...(strOr(o.attestation) ? { attestation: o.attestation } : {}),
    extensions: keysOf(o.extensions),
    ...(o.extensions?.largeBlob?.support === 'required' ? { largeBlobRequired: true } : {}),
    ...(Array.isArray(o.hints) ? { hints: o.hints.filter((x: unknown) => typeof x === 'string') } : {}),
    ...(strOr(mediation) ? { mediation: mediation as string } : {}),
  }
}

/** `publicKey` of a get() call (and its mediation), as JSON. */
export function encodeGet(pk: unknown, mediation?: unknown): WireGet | null {
  if (!pk || typeof pk !== 'object') return null
  const o = pk as Record<string, any>
  const challenge = bufB64(o.challenge)
  if (!challenge) return null
  return {
    challenge,
    ...(strOr(o.rpId) ? { rpId: o.rpId } : {}),
    allow: descriptors(o.allowCredentials),
    ...(strOr(o.userVerification) ? { userVerification: o.userVerification } : {}),
    extensions: keysOf(o.extensions),
    ...(strOr(mediation) ? { mediation: mediation as string } : {}),
    ...(Array.isArray(o.hints) ? { hints: o.hints.filter((x: unknown) => typeof x === 'string') } : {}),
  }
}

/** Extensions Walnut can answer honestly: credProps (it knows the key is discoverable). Others are left unanswered, as the spec allows. */
const ANSWERED = new Set(['credProps'])
/** Extensions whose silent absence would break the site later (a key it encrypts with, a blob it stores): those requests go to the browser. */
const MUST_HONOR = new Set(['prf', 'largeBlob', 'hmacCreateSecret', 'payment'])

/**
 * Why Walnut leaves a create() to the browser, or null when it takes it. It never fakes what it is
 * not: a request for a security key, for an attestation a manufacturer signs, or for an extension
 * it cannot honor goes on to the browser's own dialog untouched.
 */
export function leaveCreate(w: WireCreate): string | null {
  // A conditional create (a passkey offered silently after a password sign-in) has no window by
  // the spec: the browser's own manager decides it, never a Walnut window popping up.
  if (w.mediation === 'conditional') return 'conditional'
  if (!w.algs.includes(ES256) && w.algs.length) return 'algorithm'
  if (w.attachment === 'cross-platform') return 'security-key'
  if (w.hints?.[0] === 'security-key' || w.hints?.[0] === 'hybrid') return 'hint'
  // An enterprise attestation names one device to its company: never faked. "direct" is asked by
  // many sites that accept "none", which every passkey manager (Walnut too) answers with, as the
  // spec lets an authenticator without its own attestation do.
  if (w.attestation === 'enterprise') return 'attestation'
  if (w.largeBlobRequired || w.extensions.some((e) => MUST_HONOR.has(e))) return 'extension'
  return null
}

/** Why Walnut leaves a get() to the browser, or null when it may take it (if it has a passkey for the site). */
export function leaveGet(w: WireGet): string | null {
  // The username-field form (passkeys listed with the saved logins) comes in a later version.
  if (w.mediation === 'conditional') return 'conditional'
  if (w.hints?.[0] === 'security-key' || w.hints?.[0] === 'hybrid') return 'hint'
  if (w.extensions.some((e) => MUST_HONOR.has(e))) return 'extension'
  // Only "public-key" descriptors are passkeys.
  if (w.allow.length && w.allow.every((d) => d.type !== undefined && d.type !== 'public-key')) return 'not-passkey'
  return null
}

export const answeredExtensions = (asked: string[]): Record<string, unknown> =>
  asked.includes('credProps') && ANSWERED.has('credProps') ? { credProps: { rk: true } } : {}

/**
 * The client data the browser would make (WebAuthn §5.8.1 order: type, challenge, origin,
 * crossOrigin). The origin is the one the browser says the asking frame is on, never the page's word.
 */
export function clientDataJSON(type: 'webauthn.create' | 'webauthn.get', challenge: string, origin: string): string {
  return toB64u(new TextEncoder().encode(JSON.stringify({ type, challenge, origin, crossOrigin: false })))
}

/** What the background answers the page. */
export type WireAnswer =
  | { kind: 'leave'; why: string }
  | { kind: 'error'; name: 'NotAllowedError' | 'InvalidStateError' | 'AbortError' | 'SecurityError' | 'NotSupportedError'; message: string }
  | { kind: 'created'; id: string; clientDataJSON: string; attestationObject: string; authenticatorData: string; publicKey: string; publicKeyAlgorithm: number; extensions: Record<string, unknown> }
  | { kind: 'asserted'; id: string; clientDataJSON: string; authenticatorData: string; signature: string; userHandle?: string; extensions: Record<string, unknown> }
