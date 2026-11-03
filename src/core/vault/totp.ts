/**
 * TOTP codes (RFC 6238 over RFC 4226), from an otpauth:// URI or a bare base32 seed.
 * WebCrypto HMAC, so it runs in the server and in a secure-context client.
 */

export interface TotpParams {
  secret: Uint8Array
  digits: number
  period: number
  algorithm: 'SHA-1' | 'SHA-256' | 'SHA-512'
  issuer?: string
  account?: string
}

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

export function base32Decode(text: string): Uint8Array | null {
  const t = text.toUpperCase().replace(/[\s=-]/g, '')
  if (!t) return null
  let bits = 0, value = 0
  const out: number[] = []
  for (const ch of t) {
    const v = B32.indexOf(ch)
    if (v < 0) return null
    value = (value << 5) | v
    bits += 5
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8 }
  }
  return new Uint8Array(out)
}

/** The parameters of a saved TOTP value, or null for one that is not usable. */
export function parseTotp(raw: string): TotpParams | null {
  const t = (raw ?? '').trim()
  if (!t) return null
  if (!/^otpauth:\/\//i.test(t)) {
    const secret = base32Decode(t)
    return secret && secret.length >= 10 ? { secret, digits: 6, period: 30, algorithm: 'SHA-1' } : null
  }
  let u: URL
  try { u = new URL(t) } catch { return null }
  if (u.host.toLowerCase() !== 'totp') return null
  const secret = base32Decode(u.searchParams.get('secret') ?? '')
  if (!secret || secret.length < 10) return null
  const digits = Number(u.searchParams.get('digits') ?? 6)
  const period = Number(u.searchParams.get('period') ?? 30)
  const alg = (u.searchParams.get('algorithm') ?? 'SHA1').toUpperCase().replace('-', '')
  const algorithm = alg === 'SHA256' ? 'SHA-256' : alg === 'SHA512' ? 'SHA-512' : alg === 'SHA1' ? 'SHA-1' : null
  if (!algorithm || ![6, 7, 8].includes(digits) || !(period >= 10 && period <= 300)) return null
  const label = decodeURIComponent(u.pathname.replace(/^\//, ''))
  const [labelIssuer, account] = label.includes(':') ? label.split(/:(.*)/s, 2) : [undefined, label]
  const issuer = u.searchParams.get('issuer') ?? labelIssuer
  return { secret, digits, period, algorithm, ...(issuer ? { issuer } : {}), ...(account ? { account: account.trim() } : {}) }
}

export interface TotpCode {
  code: string
  period: number
  /** Seconds this code is still good for. */
  remaining: number
}

export async function totpAt(p: TotpParams, nowMs: number): Promise<TotpCode> {
  const counter = Math.floor(nowMs / 1000 / p.period)
  const msg = new Uint8Array(8)
  let c = counter
  for (let i = 7; i >= 0; i--) { msg[i] = c & 255; c = Math.floor(c / 256) }
  const key = await globalThis.crypto.subtle.importKey('raw', p.secret.slice().buffer as ArrayBuffer, { name: 'HMAC', hash: p.algorithm }, false, ['sign'])
  const mac = new Uint8Array(await globalThis.crypto.subtle.sign('HMAC', key, msg.buffer as ArrayBuffer))
  const off = mac[mac.length - 1] & 15
  const bin = ((mac[off] & 127) << 24) | (mac[off + 1] << 16) | (mac[off + 2] << 8) | mac[off + 3]
  const code = String(bin % 10 ** p.digits).padStart(p.digits, '0')
  const remaining = p.period - (Math.floor(nowMs / 1000) % p.period)
  return { code, period: p.period, remaining }
}
