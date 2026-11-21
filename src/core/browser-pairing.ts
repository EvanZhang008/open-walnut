/**
 * Browser sign-in codes (docs/plan/walnut-servers-everywhere.md, "Signing in a browser").
 *
 * A browser that is not this machine needs a device token. The console mints a
 * short code here; the browser exchanges it once for an ordinary device token,
 * which the device list shows and can revoke. Codes live in memory only: a
 * restart forgets them, which costs one fresh code.
 *
 * Eight characters from an alphabet without look-alikes (no 0/O, 1/I/L), shown as
 * `ABCD-EFGH`, typed in any case, with or without the dash. Ten minutes, one use.
 * Only the hash is kept. At most a few live codes at a time: the oldest goes first.
 */

import crypto from 'node:crypto'

export const CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ'
export const CODE_LENGTH = 8
export const CODE_TTL_MS = 10 * 60_000
export const MAX_LIVE_CODES = 5

interface Pending { hash: string; expiresAt: number }

let pending: Pending[] = []

function hashOf(normalized: string): string {
  return crypto.createHash('sha256').update(`walnut-browser-code\0${normalized}`).digest('hex')
}

/** What the person typed, as the code it means: upper case, letters and digits only. */
export function normalizeCode(input: string): string {
  return input.toUpperCase().replace(/[^0-9A-Z]/g, '')
}

export function formatCode(normalized: string): string {
  return `${normalized.slice(0, 4)}-${normalized.slice(4)}`
}

function prune(now: number): void {
  pending = pending.filter((p) => p.expiresAt > now)
}

export function mintBrowserCode(now = Date.now()): { code: string; expiresAt: number } {
  prune(now)
  let raw = ''
  for (let i = 0; i < CODE_LENGTH; i++) raw += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)]
  const expiresAt = now + CODE_TTL_MS
  pending.push({ hash: hashOf(raw), expiresAt })
  while (pending.length > MAX_LIVE_CODES) pending.shift()
  return { code: formatCode(raw), expiresAt }
}

/** True once for a live code, and the code is gone after that. */
export function consumeBrowserCode(input: string, now = Date.now()): boolean {
  prune(now)
  const normalized = normalizeCode(input)
  if (normalized.length !== CODE_LENGTH) return false
  const hash = hashOf(normalized)
  const at = pending.findIndex((p) => crypto.timingSafeEqual(Buffer.from(p.hash), Buffer.from(hash)))
  if (at < 0) return false
  pending.splice(at, 1)
  return true
}

/** Tests only. */
export function _resetBrowserCodesForTesting(): void {
  pending = []
}
