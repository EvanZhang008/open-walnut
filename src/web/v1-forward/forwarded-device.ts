/**
 * Which paired iPhone a call the cloud companion carried here came from.
 *
 * A forwarded call reaches this server's routes as a loopback request with no credential (the
 * phone's token stays on the companion: target.ts, stream-door.ts), so a route keyed on the device
 * saw none, and the iPhone app adding its signing key through the companion read as a stranger
 * (2026-11-18: a "Let iPhone sign your approvals" card for the phone the person had just paired).
 * The companion checks the token's pairing is the iPhone app (approvals/phone-app.ts) and names it
 * (proxy.ts: the call's `phone`, or COMPANION_PHONE_HEADER on a stream). The runner here passes the
 * name on with a proof only this process holds, so a request from anything else on this Mac that
 * sends the same headers names nothing. A phone's own copy of a header never crosses
 * (policy.ts forwardRequestHeaders keeps only its list). Read by routes/approvals-v1.ts only.
 */

import crypto from 'node:crypto'
import type { Request } from 'express'

/** Companion to Mac, on a stream: the paired iPhone app the call came from. */
export const COMPANION_PHONE_HEADER = 'x-walnut-companion-phone'
export const FORWARDED_PHONE_HEADER = 'x-walnut-forwarded-phone'
export const FORWARDED_PHONE_PROOF_HEADER = 'x-walnut-forwarded-phone-proof'

/** Made once per process, never written anywhere and never sent off this machine. */
const proof = crypto.randomBytes(32).toString('hex')

/** A device name as a header can carry it: printable ASCII, short. Pure. */
export function cleanDeviceName(name: unknown): string | null {
  if (typeof name !== 'string') return null
  const t = name.trim()
  return t && t.length <= 128 && /^[\x20-\x7e]+$/.test(t) ? t : null
}

/**
 * The one call a phone is named on: the iPhone app adding its signing key. Every other forwarded
 * call goes as before, with no name and no proof, so no other route on the Mac reads either.
 */
export function namesPhone(method: unknown, url: unknown): boolean {
  return typeof method === 'string' && method.toUpperCase() === 'POST'
    && typeof url === 'string' && url.split('?')[0] === '/api/v1/approvals/keys'
}

/** Companion side: the name of the paired iPhone app whose token this request carries, else undefined. */
export async function companionPhoneOf(req: Request): Promise<string | undefined> {
  if (!namesPhone(req.method, req.originalUrl)) return undefined
  const name = cleanDeviceName((req as Request & { deviceName?: string }).deviceName)
  if (!name) return undefined
  const { isPairedPhoneApp } = await import('../../core/approvals/phone-app.js')
  return (await isPairedPhoneApp(name).catch(() => false)) ? name : undefined
}

/** Mac side: the headers the forward runner adds for a call the companion says came from that phone. */
export function forwardedPhoneHeaders(phone: unknown, method: unknown, url: unknown): Record<string, string> {
  const name = namesPhone(method, url) ? cleanDeviceName(phone) : null
  return name ? { [FORWARDED_PHONE_HEADER]: name, [FORWARDED_PHONE_PROOF_HEADER]: proof } : {}
}

/** The phone the companion named, when this process's forward runner sent the request; else null. */
export function forwardedPhoneOf(req: Pick<Request, 'headers'>): string | null {
  const given = req.headers[FORWARDED_PHONE_PROOF_HEADER]
  if (typeof given !== 'string') return null
  const a = Buffer.from(given)
  const b = Buffer.from(proof)
  if (a.byteLength !== b.byteLength || !crypto.timingSafeEqual(a, b)) return null
  return cleanDeviceName(req.headers[FORWARDED_PHONE_HEADER])
}
