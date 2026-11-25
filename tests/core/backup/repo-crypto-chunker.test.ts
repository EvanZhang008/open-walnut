import { describe, it, expect, vi } from 'vitest';
import { Readable } from 'node:stream';
import { randomBytes } from 'node:crypto';
import {
  blobId, deriveKeys, formatRecoveryKey, generateRecoveryKey, open, parseRecoveryKey, seal,
} from '../../../src/core/backup/repo/crypto.js';
import { chunkBuffer, chunkStream, MAX_CHUNK, MIN_CHUNK } from '../../../src/core/backup/repo/chunker.js';

describe('recovery key', () => {
  it('round-trips through its printed form', () => {
    for (let i = 0; i < 50; i++) {
      const raw = randomBytes(32);
      const printed = formatRecoveryKey(raw);
      expect(printed).toMatch(/^WB1(-[0-9A-HJKMNP-TV-Z]{1,5}){11}$/);
      expect(parseRecoveryKey(printed).equals(raw)).toBe(true);
    }
  });

  it('forgives case, spaces, missing dashes and look-alike letters', () => {
    const key = generateRecoveryKey();
    const raw = parseRecoveryKey(key);
    const sloppy = `  ${key.toLowerCase().replace(/-/g, ' ')}  `;
    expect(parseRecoveryKey(sloppy).equals(raw)).toBe(true);
    const lookalikes = key.replace(/0/g, 'O').replace(/1/g, 'l');
    expect(parseRecoveryKey(lookalikes).equals(raw)).toBe(true);
  });

  it('catches a typo with its check character and refuses junk', () => {
    const key = generateRecoveryKey();
    const body = key.replace(/-/g, '');
    // Change one character in the middle.
    const i = 10;
    const swapped = body[i] === 'A' ? 'B' : 'A';
    expect(() => parseRecoveryKey(body.slice(0, i) + swapped + body.slice(i + 1))).toThrow(/typo/);
    expect(() => parseRecoveryKey('hello')).toThrow(/not a Walnut recovery key/);
    expect(() => parseRecoveryKey('')).toThrow();
  });
});

describe('sealing', () => {
  const keys = deriveKeys(randomBytes(32));

  it('opens what it sealed, and nothing else', () => {
    const data = Buffer.from('private notes 你好');
    const sealed = seal(keys, data, 'blob:x');
    expect(sealed.includes(data)).toBe(false);
    expect(open(keys, sealed, 'blob:x').equals(data)).toBe(true);
    // Another name, another key, a flipped bit: all refused.
    expect(() => open(keys, sealed, 'blob:y')).toThrow(/wrong recovery key or damaged/);
    expect(() => open(deriveKeys(randomBytes(32)), sealed, 'blob:x')).toThrow();
    const flipped = Buffer.from(sealed);
    flipped[20] ^= 1;
    expect(() => open(keys, flipped, 'blob:x')).toThrow();
  });

  it('gives content ids that depend on the key', () => {
    const data = Buffer.from('same bytes');
    expect(blobId(keys, data)).toBe(blobId(keys, data));
    expect(blobId(keys, data)).not.toBe(blobId(deriveKeys(randomBytes(32)), data));
  });
});

describe('content-defined chunking', () => {
  const big = randomBytes(9 * 1024 * 1024);

  it('keeps chunk sizes in bounds and the bytes intact', () => {
    const chunks = chunkBuffer(big);
    expect(Buffer.concat(chunks).equals(big)).toBe(true);
    for (const c of chunks.slice(0, -1)) {
      expect(c.length).toBeGreaterThanOrEqual(MIN_CHUNK);
      expect(c.length).toBeLessThanOrEqual(MAX_CHUNK);
    }
  });

  it('cuts a stream exactly where it cuts the whole buffer', async () => {
    const pieces: Buffer[] = [];
    for (let off = 0; off < big.length; off += 65_537) pieces.push(big.subarray(off, off + 65_537));
    const streamed: Buffer[] = [];
    for await (const c of chunkStream(Readable.from(pieces))) streamed.push(c);
    expect(streamed.map((c) => c.length)).toEqual(chunkBuffer(big).map((c) => c.length));
  });

  it('cuts the same bytes whatever the reads look like: tiny, empty, larger than a chunk', async () => {
    const sizes = [1, 0, 7, 65_536, 3 * 1024 * 1024, 0, 12_345, MAX_CHUNK, 1];
    const pieces: Buffer[] = [];
    let off = 0;
    for (let i = 0; off < big.length; i++) {
      const n = sizes[i % sizes.length]!;
      pieces.push(big.subarray(off, off + n));
      off += n;
    }
    const streamed: Buffer[] = [];
    for await (const c of chunkStream(Readable.from(pieces))) streamed.push(c);
    const whole = chunkBuffer(big);
    expect(streamed.length).toBe(whole.length);
    streamed.forEach((c, i) => expect(c.equals(whole[i]!)).toBe(true));
  });

  // 2026-11-25: every 64 KiB read was joined onto what was pending, copying up to 2 MiB a read
  // (about 16 times the file in buffers); a backup run's ~300 MB of changed files took the Mac's
  // server from 2 to 5.6 GB. The reads are joined about once per chunk now.
  it('joins the reads about once per chunk, never once per read', async () => {
    const pieces: Buffer[] = [];
    for (let off = 0; off < big.length; off += 65_536) pieces.push(big.subarray(off, off + 65_536));
    const concat = vi.spyOn(Buffer, 'concat');
    let joined = 0;
    try {
      for await (const _ of chunkStream(Readable.from(pieces))) { /* drain */ }
      for (const [list, total] of concat.mock.calls) joined += total ?? (list as Buffer[]).reduce((n, b) => n + b.length, 0);
    } finally { concat.mockRestore(); }
    expect(joined).toBeLessThan(2 * big.length);
  });

  it('moves only the chunks near an insertion', () => {
    const keys = deriveKeys(randomBytes(32));
    const ids = (b: Buffer) => new Set(chunkBuffer(b).map((c) => blobId(keys, c)));
    const before = ids(big);
    const edited = Buffer.concat([big.subarray(0, 3_000_000), Buffer.from('inserted line\n'), big.subarray(3_000_000)]);
    const after = ids(edited);
    const fresh = [...after].filter((id) => !before.has(id));
    // One or two chunks around the edit change; the rest dedupe.
    expect(fresh.length).toBeLessThanOrEqual(3);
    expect(after.size - fresh.length).toBeGreaterThan(before.size - 4);
  });
});
