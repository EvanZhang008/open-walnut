/** SHA-256 over UTF-16 code units, and the folder that keeps a long token string short with its identity. */

/** Kept as written up to this length; longer becomes head + U+0000 + SHA-256 of the rest. */
const EXACT_MAX = 128;
const HEAD = 64;

// SHA-256 over UTF-16 code units (big-endian), so a lone surrogate is hashed exactly.

const K256 = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

class Utf16Sha256 {
  private readonly h = Uint32Array.of(0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19);
  private readonly unit = new Uint16Array(32);
  private readonly w = new Uint32Array(64);
  private n = 0;
  private units = 0;

  update(s: string, from: number): void {
    const u = this.unit;
    for (let i = from; i < s.length; i++) {
      u[this.n++] = s.charCodeAt(i);
      if (this.n === 32) { this.compress(); this.n = 0; }
    }
    if (s.length > from) this.units += s.length - from;
  }

  hex(): string {
    const bits = this.units * 16;
    const u = this.unit;
    u[this.n++] = 0x8000;
    if (this.n > 28) { u.fill(0, this.n); this.compress(); this.n = 0; }
    u.fill(0, this.n, 28);
    const hi = Math.floor(bits / 0x100000000);
    const lo = bits >>> 0;
    u[28] = hi >>> 16; u[29] = hi & 0xffff; u[30] = lo >>> 16; u[31] = lo & 0xffff;
    this.compress();
    let out = '';
    for (const x of this.h) out += x.toString(16).padStart(8, '0');
    return out;
  }

  private compress(): void {
    const { w, unit: u, h } = this;
    for (let t = 0; t < 16; t++) w[t] = (u[2 * t]! << 16) | u[2 * t + 1]!;
    for (let t = 16; t < 64; t++) {
      const x = w[t - 15]!;
      const y = w[t - 2]!;
      const s0 = ((x >>> 7) | (x << 25)) ^ ((x >>> 18) | (x << 14)) ^ (x >>> 3);
      const s1 = ((y >>> 17) | (y << 15)) ^ ((y >>> 19) | (y << 13)) ^ (y >>> 10);
      w[t] = (w[t - 16]! + s0 + w[t - 7]! + s1) | 0;
    }
    let a = h[0]!, b = h[1]!, c = h[2]!, d = h[3]!, e = h[4]!, f = h[5]!, g = h[6]!, k = h[7]!;
    for (let t = 0; t < 64; t++) {
      const s1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      const t1 = (k + s1 + ((e & f) ^ (~e & g)) + K256[t]! + w[t]!) | 0;
      const s0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      const t2 = (s0 + ((a & b) ^ (a & c) ^ (b & c))) | 0;
      k = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
    }
    h[0] = h[0]! + a; h[1] = h[1]! + b; h[2] = h[2]! + c; h[3] = h[3]! + d;
    h[4] = h[4]! + e; h[5] = h[5]! + f; h[6] = h[6]! + g; h[7] = h[7]! + k;
  }
}

/** SHA-256 of a string's UTF-16BE code units, in hex (exported for tests). */
export function sha256Utf16Hex(s: string): string {
  const hash = new Utf16Sha256();
  hash.update(s, 0);
  return hash.hex();
}

/**
 * Keeps a growing name or value short with its identity intact: up to EXACT_MAX
 * as written, else its first HEAD units, U+0000 (which no parsed name or value
 * contains: the tokenizer turns NUL into U+FFFD) and a SHA-256 of the rest.
 */
export class Folder {
  private hash: Utf16Sha256 | null = null;
  reset(): void { this.hash = null; }
  fold(s: string): string {
    (this.hash ??= new Utf16Sha256()).update(s, HEAD);
    return s.slice(0, HEAD);
  }
  finish(s: string): string {
    if (!this.hash) {
      if (s.length <= EXACT_MAX) return s;
      this.hash = new Utf16Sha256();
    }
    this.hash.update(s, HEAD);
    const out = `${s.slice(0, HEAD)}\u0000${this.hash.hex()}`;
    this.hash = null;
    return out;
  }
}
