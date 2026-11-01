/**
 * Is this 32-byte hex string an Ed25519 public key (a point on the curve)? A host
 * network id is the machine's public key, and walnut-net parses each member's id as
 * one (native/walnut-net/src/config.rs): 64 hex characters that are not a point pass
 * a format check and are then left out there. The companion refuses them at the door
 * instead (net-store.ts). RFC 8032 section 5.1.3, the decompression check.
 */
const P = (1n << 255n) - 19n
const D = mod(-121665n * inv(121666n))
const SQRT_M1 = pow(2n, (P - 1n) / 4n)

function mod(a: bigint): bigint {
  const r = a % P
  return r < 0n ? r + P : r
}

function pow(b: bigint, e: bigint): bigint {
  let r = 1n
  let x = mod(b)
  let n = e
  while (n > 0n) {
    if (n & 1n) r = (r * x) % P
    x = (x * x) % P
    n >>= 1n
  }
  return r
}

function inv(a: bigint): bigint {
  return pow(a, P - 2n)
}

export function isEd25519Point(hex: string): boolean {
  if (!/^[0-9a-f]{64}$/.test(hex)) return false
  // Little-endian: the last byte holds the top bits, and its high bit is the sign of x.
  let y = 0n
  for (let i = 31; i >= 0; i--) y = (y << 8n) | BigInt(parseInt(hex.slice(i * 2, i * 2 + 2), 16))
  const sign = y >> 255n
  y &= (1n << 255n) - 1n
  if (y >= P) return false
  const yy = (y * y) % P
  const u = mod(yy - 1n)
  const v = mod(D * yy + 1n)
  const v3 = (v * v % P) * v % P
  let x = (u * v3 % P) * pow(u * (v3 * v3 % P) % P * v % P, (P - 5n) / 8n) % P
  const vxx = v * (x * x % P) % P
  if (vxx !== u) {
    if (vxx !== mod(-u)) return false
    x = x * SQRT_M1 % P
  }
  return !(x === 0n && sign === 1n)
}
