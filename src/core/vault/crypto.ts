/**
 * Vault crypto (docs/reference/passwords.md, "Keys"). WebCrypto only, so the same
 * code runs in the server, the web app and the browser extension.
 *
 * Keys:
 *  - the vault key (VK, 32 random bytes) wraps every item key;
 *  - each item key (IK, 32 random bytes) encrypts one item's JSON;
 *  - the account unlock key (AUK) wraps VK. It comes from the master password and
 *    the Secret Key together (1Password's two-secret derivation), so a copy of the
 *    vault file with the password alone does not open it:
 *      pwKey = PBKDF2-HMAC-SHA256(password NFKC, kdf.salt, kdf.iterations, 32 bytes)
 *      AUK   = HKDF-SHA256(ikm = pwKey || secretKeyBytes, salt = aukSalt, info = AUK_INFO)
 *    pwKey is what a client derives and sends, so the master password itself never
 *    crosses the wire;
 *  - the machine key (32 random bytes, kept on this machine only) wraps VK a second
 *    time so the server can serve approved agent requests while the person is away.
 *
 * Every wrap and every item is AES-256-GCM with a fresh 12-byte nonce and an
 * additional-data string naming what it is, so a wrapped key cannot be swapped in
 * as an item (or one item's ciphertext moved under another id).
 */

export const PBKDF2_ITERATIONS = 650_000
export const AUK_INFO = 'walnut-vault-auk-v1'

export interface Sealed {
  /** base64 nonce */
  iv: string
  /** base64 ciphertext with the GCM tag */
  ct: string
}

export interface KdfParams {
  name: 'PBKDF2-SHA256'
  iterations: number
  /** base64 */
  salt: string
}

function subtle(): SubtleCrypto {
  const s = globalThis.crypto?.subtle
  if (!s) throw new Error('WebCrypto is not available here (an insecure context?)')
  return s
}

const enc = new TextEncoder()
const dec = new TextDecoder()

export function randomBytes(n: number): Uint8Array {
  const out = new Uint8Array(n)
  globalThis.crypto.getRandomValues(out)
  return out
}

export function toB64(bytes: Uint8Array): string {
  let s = ''
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i])
  return btoa(s)
}

export function fromB64(b64: string): Uint8Array {
  const s = atob(b64)
  const out = new Uint8Array(s.length)
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i)
  return out
}

/** A Uint8Array backed by its own ArrayBuffer (WebCrypto's BufferSource typing). */
function buf(bytes: Uint8Array): ArrayBuffer {
  return bytes.slice().buffer as ArrayBuffer
}

async function aesKey(raw: Uint8Array): Promise<CryptoKey> {
  if (raw.length !== 32) throw new Error('an AES-256 key is 32 bytes')
  return subtle().importKey('raw', buf(raw), { name: 'AES-GCM' }, false, ['encrypt', 'decrypt'])
}

export async function seal(key: Uint8Array, plain: Uint8Array, aad: string): Promise<Sealed> {
  const iv = randomBytes(12)
  const ct = await subtle().encrypt({ name: 'AES-GCM', iv: buf(iv), additionalData: buf(enc.encode(aad)) }, await aesKey(key), buf(plain))
  return { iv: toB64(iv), ct: toB64(new Uint8Array(ct)) }
}

/** Throws on a wrong key, a changed ciphertext or a different additional-data string. */
export async function open(key: Uint8Array, sealed: Sealed, aad: string): Promise<Uint8Array> {
  const pt = await subtle().decrypt(
    { name: 'AES-GCM', iv: buf(fromB64(sealed.iv)), additionalData: buf(enc.encode(aad)) },
    await aesKey(key), buf(fromB64(sealed.ct)),
  )
  return new Uint8Array(pt)
}

export async function sealJson(key: Uint8Array, value: unknown, aad: string): Promise<Sealed> {
  return seal(key, enc.encode(JSON.stringify(value)), aad)
}

export async function openJson<T>(key: Uint8Array, sealed: Sealed, aad: string): Promise<T> {
  return JSON.parse(dec.decode(await open(key, sealed, aad))) as T
}

/** The client half: master password -> pwKey. Runs wherever the password is typed. */
export async function derivePasswordKey(password: string, kdf: KdfParams): Promise<Uint8Array> {
  if (kdf.name !== 'PBKDF2-SHA256') throw new Error(`unknown kdf ${kdf.name}`)
  const base = await subtle().importKey('raw', buf(enc.encode(password.normalize('NFKC'))), 'PBKDF2', false, ['deriveBits'])
  const bits = await subtle().deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: buf(fromB64(kdf.salt)), iterations: kdf.iterations }, base, 256)
  return new Uint8Array(bits)
}

/** The server half: pwKey + Secret Key -> AUK. */
export async function deriveUnlockKey(pwKey: Uint8Array, secretKey: Uint8Array, aukSalt: Uint8Array): Promise<Uint8Array> {
  if (pwKey.length !== 32) throw new Error('a password key is 32 bytes')
  const ikm = new Uint8Array(pwKey.length + secretKey.length)
  ikm.set(pwKey, 0)
  ikm.set(secretKey, pwKey.length)
  const base = await subtle().importKey('raw', buf(ikm), 'HKDF', false, ['deriveBits'])
  const bits = await subtle().deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: buf(aukSalt), info: buf(enc.encode(AUK_INFO)) }, base, 256)
  return new Uint8Array(bits)
}

export async function sha256Hex(text: string): Promise<string> {
  const d = new Uint8Array(await subtle().digest('SHA-256', buf(enc.encode(text))))
  return Array.from(d, (b) => b.toString(16).padStart(2, '0')).join('')
}

// ── Secret Key: 128 random bits shown as W1-XXXXXX-XXXXX-XXXXX-XXXXX-XXXXX ──

const B32 = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789' // no I, O, 0, 1

export function newSecretKey(): string {
  const bytes = randomBytes(16)
  // 128 bits as 26 base-32 digits (130 bits of room: the top 2 bits are 0).
  let n = 0n
  for (const b of bytes) n = (n << 8n) | BigInt(b)
  let digits = ''
  for (let i = 0; i < 26; i++) { digits = B32[Number(n & 31n)] + digits; n >>= 5n }
  return `W1-${digits.slice(0, 6)}-${digits.slice(6, 11)}-${digits.slice(11, 16)}-${digits.slice(16, 21)}-${digits.slice(21)}`
}

/** The Secret Key's 16 bytes, or null for one that is not well formed. Case and dashes are free. */
export function parseSecretKey(text: string): Uint8Array | null {
  const t = text.toUpperCase().replace(/[\s-]/g, '')
  if (!t.startsWith('W1')) return null
  const digits = t.slice(2)
  if (digits.length !== 26) return null
  let n = 0n
  for (const ch of digits) {
    const v = B32.indexOf(ch)
    if (v < 0) return null
    n = (n << 5n) | BigInt(v)
  }
  if (n >> 128n) return null
  const out = new Uint8Array(16)
  for (let i = 15; i >= 0; i--) { out[i] = Number(n & 255n); n >>= 8n }
  return out
}
