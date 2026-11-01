/**
 * The companion's check that a member id is a key (src/core/net/ed25519-point.ts),
 * the same one walnut-net applies (config.rs member_map): every real key passes, and
 * the shapes Rust refuses are refused here too.
 */
import { describe, expect, it } from 'vitest'
import crypto from 'node:crypto'
import { isEd25519Point } from '../../../src/core/net/ed25519-point.js'
import { netKey } from '../../helpers/net-keys.js'

function freshKey(): string {
  const { publicKey } = crypto.generateKeyPairSync('ed25519')
  return Buffer.from((publicKey.export({ format: 'jwk' }) as { x: string }).x, 'base64url').toString('hex')
}

describe('isEd25519Point', () => {
  it('accepts every real public key', () => {
    for (let i = 0; i < 300; i++) expect(isEd25519Point(freshKey())).toBe(true)
    expect(isEd25519Point(netKey('mac'))).toBe(true)
  })

  it('refuses 64 hex characters that are not a point (walnut-net left 02.. out)', () => {
    expect(isEd25519Point('02'.repeat(32))).toBe(false)
  })

  it('refuses a y at or above the field prime, and anything not 64 lowercase hex', () => {
    // y = 2^255 - 19 (the prime itself), little-endian, sign bit clear.
    expect(isEd25519Point('ed' + 'ff'.repeat(30) + '7f')).toBe(false)
    expect(isEd25519Point('A'.repeat(64))).toBe(false)
    expect(isEd25519Point('ab')).toBe(false)
  })

  it('the identity point with the sign bit set is not a key', () => {
    // y = 1 gives x = 0; with the sign bit it is the non-canonical form RFC 8032 refuses.
    expect(isEd25519Point('01' + '00'.repeat(30) + '00')).toBe(true)
    expect(isEd25519Point('01' + '00'.repeat(30) + '80')).toBe(false)
  })
})
