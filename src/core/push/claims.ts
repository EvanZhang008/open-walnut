/**
 * Which pairings hold a relayed push row, so the companion can take back a
 * write whose pairing went on the way (web/routes/push.ts) without removing a
 * row another pairing of the same name still holds.
 *
 * A companion registers a phone's token on the primary, and checks the phone's
 * pairing again after that write. When the pairing went meanwhile, the write
 * has to be undone, but the row can no longer simply go: the same phone may
 * have been paired again under its name and registered the same APNs token
 * under the new pairing (one row per token), and that row is not the revoked
 * pairing's to delete.
 *
 * So each relayed write carries a claim, a one-way marker of the pairing that
 * made it, derived from the pairing's token hash (the hash auth.json keeps), so
 * the companion can name the claim of any pairing it holds. The row keeps the
 * claims of the registrations that wrote it. A take-back carries the claims of
 * the name's pairings that still hold right now (read when it runs, also from
 * the queue): the row stays only when one of them is on it, and then keeps only
 * those, so the claim of a revoked pairing never keeps a row again. Otherwise
 * the row goes: also a row with no claims (written before claims, or by an
 * older companion) and a row whose live claim the cap pushed out. A stray row
 * pushes letters to a revoked phone; a missing one comes back when the phone
 * registers again at its next launch.
 *
 * A take-back names the row by the token's sha256, never the token, so a
 * take-back queued on the companion (core/devices/revoke-queue.ts) stores no
 * push token there.
 */

import crypto from 'node:crypto'

/** A claim: 32 hex characters. */
export const CLAIM_RE = /^[0-9a-f]{32}$/

/** A token's sha256: 64 hex characters. */
export const TOKEN_SHA_RE = /^[0-9a-f]{64}$/

/** The most claims a row keeps (the newest ones). */
export const MAX_CLAIMS = 8

/** The most live claims one take-back carries (a name has one pairing, rarely a few). */
export const MAX_LIVE_CLAIMS = 32

const sha256 = (s: string): string => crypto.createHash('sha256').update(s, 'utf-8').digest('hex')

/** A pairing's claim, from its token hash (the sha256 of its bearer, as auth.json keeps it). Not that hash itself. */
export function pushClaimOfPairingHash(tokenHash: string): string {
  return sha256(`walnut push claim\n${tokenHash.toLowerCase()}`).slice(0, 32)
}

/** The claim a registration made with `bearer` puts on its row: its pairing's claim. */
export function pushClaimOf(bearer: string): string {
  return pushClaimOfPairingHash(sha256(bearer))
}

/** How a take-back names a row: the push token's sha256. */
export function pushTokenSha(token: string): string {
  return sha256(token)
}

/** `prior` with `claim` added as the newest, capped at MAX_CLAIMS. */
export function mergeClaims(prior: readonly string[] | undefined, claim: string): string[] {
  return [...(prior ?? []).filter((c) => c !== claim && CLAIM_RE.test(c)), claim].slice(-MAX_CLAIMS)
}
