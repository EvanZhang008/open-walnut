/**
 * Challenge-response proofs with a shared key: one side issues a fresh nonce, the other answers
 * with an HMAC-SHA256 over a text that names the nonce and what it vouches for, and the check is
 * constant time. No reusable secret ever crosses the wire: a proof is good for one nonce only.
 *
 * One module for every such proof, so there is one piece of this crypto in the repo:
 *   - the leader switch's witnesses (core/leader/switch/witness-door.ts, witness-direct.ts): a caller
 *     proves the witness's own key over the request and the witness's nonce, and the witness proves
 *     the same key over its reply;
 *   - the host-dialed door of host sessions ("5a", core/session-channel/door-wire.ts) builds its
 *     hello/welcome/auth proofs from the same helpers (its key S, its nonces, its texts).
 *
 * A proof text is lines joined by "\n", the first a domain tag of its own (so a proof made for one
 * purpose is never a proof for another); no line may hold a line break.
 */
import crypto from 'node:crypto'

/** A key or a nonce: 32 random bytes, hex. A proof has the same shape (an HMAC-SHA256 digest). */
export const PROOF_SECRET_RE = /^[0-9a-f]{64}$/

/** A fresh key or nonce: 32 random bytes, hex. */
export function proofSecret(): string {
  return crypto.randomBytes(32).toString('hex')
}

/** The text a proof is the HMAC of: `parts` one per line. Throws on a part with a line break (two texts could then read alike). */
export function proofText(parts: readonly string[]): string {
  for (const p of parts) if (p.includes('\n') || p.includes('\r')) throw new Error('a proof text part holds a line break')
  return parts.join('\n')
}

/** HMAC-SHA256 of `text` (utf8) under `keyHex` (hex bytes), hex. */
export function hmacProof(keyHex: string, text: string): string {
  return crypto.createHmac('sha256', Buffer.from(keyHex, 'hex')).update(text, 'utf8').digest('hex')
}

/** Does `given` equal `expected` (both 32-byte hex)? Constant time; anything not of that shape is not equal. */
export function proofsEqual(expected: string, given: unknown): boolean {
  if (typeof given !== 'string' || !PROOF_SECRET_RE.test(given) || !PROOF_SECRET_RE.test(expected)) return false
  return crypto.timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(given, 'hex'))
}

/** The id of a key a proof may name: the first 8 hex of sha256(key bytes). Not secret. */
export function proofKeyId(keyHex: string): string {
  return crypto.createHash('sha256').update(Buffer.from(keyHex, 'hex')).digest('hex').slice(0, 8)
}

/** sha256 of `text` (utf8), hex: how a proof names a body it vouches for. */
export function sha256Hex(text: string): string {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex')
}
