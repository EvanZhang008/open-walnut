/**
 * Runs in a page's own world (registered only while "Save and use passkeys" is on: bg-passkey.ts),
 * top frames only, before the page's scripts. It wraps navigator.credentials.create and .get:
 * a passkey request Walnut can take goes to the extension (passkey-bridge.ts, then the background,
 * which asks the person in a Walnut window); everything else, and anything the person sends on with
 * "Use the browser instead", goes to the browser's own function untouched, with the page's own options.
 *
 * What the page learns is only what a passkey manager gives it anyway: the credential, or an error.
 * The page can fire the request event itself; that asks for nothing more than calling
 * navigator.credentials would, for its own origin, which the background takes from the browser.
 */
import {
  ANSWER_EVENT, CANCEL_EVENT, REQUEST_EVENT, encodeCreate, encodeGet, fromB64u, leaveCreate, leaveGet, toB64u,
  type WireAnswer,
} from './passkey-wire'

const MARK = Symbol.for('walnut.passkeys')
const w = window as unknown as Window & Record<symbol, unknown>

function buf(b64: string): ArrayBuffer {
  const u = fromB64u(b64)
  return u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength) as ArrayBuffer
}

/** No answer from the bridge this soon: the extension is gone (reloaded, removed), the browser decides. */
const ACK_MS = 1500
let seq = 0

function ask(op: 'create' | 'get', wire: unknown, signal: AbortSignal | undefined): Promise<WireAnswer> {
  const id = `${Date.now().toString(36)}.${++seq}.${Math.random().toString(36).slice(2)}`
  return new Promise((resolve) => {
    let acked = false
    let reason: unknown
    const done = (a: WireAnswer) => {
      document.removeEventListener(ANSWER_EVENT, onAnswer)
      signal?.removeEventListener('abort', onAbort)
      clearTimeout(timer)
      // An abort rejects with the signal's own reason, as the browser's function does.
      resolve(reason !== undefined && a.kind === 'error' && a.name === 'AbortError' ? { ...a, reason } as WireAnswer : a)
    }
    const onAnswer = (e: Event) => {
      let d: { id?: string; ack?: boolean; answer?: WireAnswer }
      try { d = JSON.parse(String((e as CustomEvent).detail)) } catch { return }
      if (d.id !== id) return
      if (d.ack) { acked = true; return }
      if (d.answer) done(d.answer)
    }
    const onAbort = () => {
      document.dispatchEvent(new CustomEvent(CANCEL_EVENT, { detail: JSON.stringify({ id }) }))
      reason = signal?.reason
      done({ kind: 'error', name: 'AbortError', message: 'The operation was aborted.' })
    }
    const timer = setTimeout(() => { if (!acked) done({ kind: 'leave', why: 'no-extension' }) }, ACK_MS)
    document.addEventListener(ANSWER_EVENT, onAnswer)
    signal?.addEventListener('abort', onAbort)
    document.dispatchEvent(new CustomEvent(REQUEST_EVENT, { detail: JSON.stringify({ id, op, wire }) }))
  })
}

function credentialOf(a: Extract<WireAnswer, { kind: 'created' | 'asserted' }>): PublicKeyCredential {
  const rawId = buf(a.id)
  const clientDataJSON = buf(a.clientDataJSON)
  const authenticatorData = buf(a.authenticatorData)
  let response: Record<string, unknown>
  let json: Record<string, unknown>
  if (a.kind === 'created') {
    const attestationObject = buf(a.attestationObject)
    const publicKey = buf(a.publicKey)
    response = {
      clientDataJSON, attestationObject,
      getAuthenticatorData: () => authenticatorData,
      getPublicKey: () => publicKey,
      getPublicKeyAlgorithm: () => a.publicKeyAlgorithm,
      getTransports: () => ['hybrid', 'internal'],
    }
    json = { clientDataJSON: a.clientDataJSON, attestationObject: a.attestationObject, authenticatorData: a.authenticatorData, publicKey: a.publicKey, publicKeyAlgorithm: a.publicKeyAlgorithm, transports: ['hybrid', 'internal'] }
    if (typeof AuthenticatorAttestationResponse !== 'undefined') Object.setPrototypeOf(response, AuthenticatorAttestationResponse.prototype)
  } else {
    const signature = buf(a.signature)
    const userHandle = a.userHandle ? buf(a.userHandle) : null
    response = { clientDataJSON, authenticatorData, signature, userHandle }
    json = { clientDataJSON: a.clientDataJSON, authenticatorData: a.authenticatorData, signature: a.signature, ...(a.userHandle ? { userHandle: a.userHandle } : {}) }
    if (typeof AuthenticatorAssertionResponse !== 'undefined') Object.setPrototypeOf(response, AuthenticatorAssertionResponse.prototype)
  }
  const ext = a.extensions ?? {}
  const cred: Record<string, unknown> = {
    id: a.id, rawId, type: 'public-key', authenticatorAttachment: 'platform', response,
    getClientExtensionResults: () => ext,
    toJSON: () => ({ id: a.id, rawId: a.id, type: 'public-key', authenticatorAttachment: 'platform', response: json, clientExtensionResults: ext }),
  }
  if (typeof PublicKeyCredential !== 'undefined') Object.setPrototypeOf(cred, PublicKeyCredential.prototype)
  return cred as unknown as PublicKeyCredential
}

/** The browser takes a passkey request only from a focused page: after Walnut's window closes, wait for the focus to come back (at most a second). */
function focused(): Promise<void> {
  if (document.hasFocus()) return Promise.resolve()
  return new Promise((resolve) => {
    const t = setTimeout(() => { window.removeEventListener('focus', go); resolve() }, 1000)
    const go = () => { clearTimeout(t); window.removeEventListener('focus', go); resolve() }
    window.addEventListener('focus', go)
  })
}

function fail(a: Extract<WireAnswer, { kind: 'error' }>): never {
  const reason = (a as { reason?: unknown }).reason
  if (reason !== undefined) throw reason
  throw new DOMException(a.message, a.name)
}

/** Looks like the browser's own function to a page that prints it. */
function native<T extends (...args: any[]) => unknown>(name: string, f: T): T {
  Object.defineProperty(f, 'name', { value: name })
  Object.defineProperty(f, 'toString', { value: () => `function ${name}() { [native code] }`, enumerable: false })
  return f
}

const cc = navigator.credentials as CredentialsContainer | undefined
if (cc && !w[MARK] && window.top === window && typeof cc.create === 'function' && typeof cc.get === 'function') {
  w[MARK] = true
  const browserCreate = cc.create.bind(cc)
  const browserGet = cc.get.bind(cc)

  const create = native('create', async function create(options?: CredentialCreationOptions): Promise<Credential | null> {
    const pk = options?.publicKey
    const wire = pk && !options?.signal?.aborted ? encodeCreate(pk, (options as { mediation?: unknown } | undefined)?.mediation) : null
    if (!wire || leaveCreate(wire)) return browserCreate(options)
    const a = await ask('create', wire, options?.signal)
    if (a.kind === 'leave') { await focused(); return browserCreate(options) }
    if (a.kind === 'error') fail(a)
    if (a.kind !== 'created') return browserCreate(options)
    return credentialOf(a)
  })

  const get = native('get', async function get(options?: CredentialRequestOptions): Promise<Credential | null> {
    const pk = options?.publicKey
    const wire = pk && !options?.signal?.aborted ? encodeGet(pk, options?.mediation) : null
    if (!wire || leaveGet(wire)) return browserGet(options)
    const a = await ask('get', wire, options?.signal)
    if (a.kind === 'leave') { await focused(); return browserGet(options) }
    if (a.kind === 'error') fail(a)
    if (a.kind !== 'asserted') return browserGet(options)
    return credentialOf(a)
  })

  try {
    Object.defineProperty(cc, 'create', { value: create, configurable: true, writable: true })
    Object.defineProperty(cc, 'get', { value: get, configurable: true, writable: true })
  } catch { /* a page that froze navigator.credentials keeps the browser's own */ }
}

export const _forTest = { credentialOf, toB64u }
