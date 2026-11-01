/**
 * Real host network ids for tests: the Ed25519 public key of a fixed seed, so the
 * same name gives the same id every run. The companion refuses an id that is not a
 * point on the curve (src/core/net/ed25519-point.ts), so `'a'.repeat(64)` will not do.
 */
import crypto from 'node:crypto'

const PKCS8_ED25519 = Buffer.from('302e020100300506032b657004220420', 'hex')

export function netKey(name: string): string {
  const seed = crypto.createHash('sha256').update(`walnut-net-test:${name}`).digest()
  const priv = crypto.createPrivateKey({ key: Buffer.concat([PKCS8_ED25519, seed]), format: 'der', type: 'pkcs8' })
  const jwk = crypto.createPublicKey(priv).export({ format: 'jwk' }) as { x: string }
  return Buffer.from(jwk.x, 'base64url').toString('hex')
}
