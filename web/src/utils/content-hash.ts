/**
 * The server's content hash, computed in the browser.
 *
 * `computeContentHash` on the server is `sha256(utf8(content)).hex.slice(0, 12)`
 * (src/utils/file-ops.ts). This is the same function, and the equivalence is
 * pinned by tests/web/content-hash.test.ts against the server's own
 * implementation.
 *
 * WHY the editor needs to compute a hash itself, rather than quoting the one the
 * server sent: an optimistic lock only protects a file while the token and the
 * bytes describe the SAME state. Quoting a token out of a mutable ref lets the two
 * drift, and a write then carries a token the server cannot refuse for text nobody
 * is looking at. That is the 2026-09-05 incident, and it happened AGAIN on
 * 2026-09-08 through a different drift (the pane's buffer generation advanced with
 * the lock while the editor still held cached bytes, so a generation check could
 * not see it). A hash DERIVED FROM THE BYTES the write is based on cannot drift:
 * if the bytes are stale, the token is stale, and the server refuses.
 *
 * Deliberately NOT `crypto.subtle.digest`: that is unavailable outside a secure
 * context, so the console served over a LAN address (http://<ip>:3456) would lose
 * the guarantee exactly where it is hardest to notice. This is ~60 lines,
 * synchronous, and works everywhere.
 */

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function rotr(x: number, n: number): number {
  return (x >>> n) | (x << (32 - n));
}

/** Full SHA-256 of a byte array, as 64 lowercase hex characters. */
function sha256Hex(bytes: Uint8Array): string {
  const h = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  // Pad: 0x80, then zeros, then the bit length as a 64-bit big-endian integer.
  const bitLen = bytes.length * 8;
  const withPad = new Uint8Array(((bytes.length + 9 + 63) >> 6) << 6);
  withPad.set(bytes);
  withPad[bytes.length] = 0x80;
  // Length fits in 53 bits for any realistic file, so the high word is derived by
  // division rather than by 64-bit arithmetic JS does not have.
  const hi = Math.floor(bitLen / 0x100000000);
  const lo = bitLen >>> 0;
  const lenAt = withPad.length - 8;
  withPad[lenAt] = (hi >>> 24) & 0xff;
  withPad[lenAt + 1] = (hi >>> 16) & 0xff;
  withPad[lenAt + 2] = (hi >>> 8) & 0xff;
  withPad[lenAt + 3] = hi & 0xff;
  withPad[lenAt + 4] = (lo >>> 24) & 0xff;
  withPad[lenAt + 5] = (lo >>> 16) & 0xff;
  withPad[lenAt + 6] = (lo >>> 8) & 0xff;
  withPad[lenAt + 7] = lo & 0xff;

  const w = new Uint32Array(64);
  for (let off = 0; off < withPad.length; off += 64) {
    for (let i = 0; i < 16; i++) {
      w[i] = (withPad[off + i * 4] << 24) | (withPad[off + i * 4 + 1] << 16)
        | (withPad[off + i * 4 + 2] << 8) | withPad[off + i * 4 + 3];
    }
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, hh] = h;
    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (hh + S1 + ch + K[i] + w[i]) >>> 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) >>> 0;
      hh = g; g = f; f = e;
      e = (d + t1) >>> 0;
      d = c; c = b; b = a;
      a = (t1 + t2) >>> 0;
    }
    h[0] = (h[0] + a) >>> 0; h[1] = (h[1] + b) >>> 0; h[2] = (h[2] + c) >>> 0; h[3] = (h[3] + d) >>> 0;
    h[4] = (h[4] + e) >>> 0; h[5] = (h[5] + f) >>> 0; h[6] = (h[6] + g) >>> 0; h[7] = (h[7] + hh) >>> 0;
  }
  let out = '';
  for (let i = 0; i < 8; i++) out += h[i].toString(16).padStart(8, '0');
  return out;
}

/**
 * One-entry memo, because this runs synchronously on the UI thread.
 *
 * The editor's ceiling is 512 KB and hashing that much pure-JS costs ~75 ms here,
 * which is a visible stall to someone typing. Every write in a typing burst is
 * based on the SAME bytes (the base only moves when a write lands or a read is
 * folded in), so remembering the last argument collapses a burst to one hash. One
 * entry rather than a map: the base is a whole file, and the only string worth
 * keeping is the one the next call will almost certainly repeat.
 */
let memoInput: string | null = null;
let memoOutput = '';

/**
 * The token the server compares against the bytes on disk. Same value as the
 * server's `computeContentHash` for the same string.
 */
export function computeContentHashClient(content: string): string {
  if (content === memoInput) return memoOutput;
  const hash = sha256Hex(new TextEncoder().encode(content)).slice(0, 12);
  memoInput = content;
  memoOutput = hash;
  return hash;
}
