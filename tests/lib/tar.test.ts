/**
 * The shared tar reader and writer (src/lib/tar.ts): what every downloaded part
 * of Walnut is unpacked with, and what the component build packs with.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { extractTarGz, packTar, readTar, tarGzDigest, type TarEntry } from '../../src/lib/tar.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-tar-'));

const UNICODE = 'node_modules/a/\u00e9t\u00e9-\u4f60\u597d.txt';
const LONG = `node_modules/@scope/${'deep/'.repeat(30)}file-with-a-long-name.js`;
const entries: TarEntry[] = [
  { path: 'node_modules/a/package.json', type: 'file', data: Buffer.from('{"name":"a"}') },
  { path: 'node_modules/a/bin/run', type: 'file', mode: 0o755, data: Buffer.from('#!/bin/sh\necho hi\n') },
  { path: 'node_modules/a/empty.txt', type: 'file', data: Buffer.alloc(0) },
  { path: 'node_modules/a/lib/libx.so.1.2', type: 'file', data: Buffer.alloc(70_000, 7) },
  { path: 'node_modules/a/lib/libx.so.1', type: 'symlink', link: 'libx.so.1.2' },
  { path: LONG, type: 'file', data: Buffer.from('long') },
  // A non-ASCII name (accented Latin and CJK), as test data.
  { path: UNICODE, type: 'file', data: Buffer.from('u') },
];

function writeTgz(tar: Buffer): string {
  const file = path.join(tmp(), 'a.tar.gz');
  fs.writeFileSync(file, gzipSync(tar));
  return file;
}

describe('packTar', () => {
  it('gives the same bytes for the same entries, whenever and wherever', () => {
    const a = packTar(entries);
    const b = packTar(entries.map((e) => ({ ...e })));
    expect(a.equals(b)).toBe(true);
    expect(a.length % 512).toBe(0);
  });

  it('round-trips through the streaming reader: modes, links, empty files, long and non-ASCII names', async () => {
    const out = tmp();
    const res = await extractTarGz(writeTgz(packTar(entries)), out);
    expect(res.files).toBe(6);
    expect(fs.readFileSync(path.join(out, 'node_modules/a/package.json'), 'utf8')).toBe('{"name":"a"}');
    expect(fs.statSync(path.join(out, 'node_modules/a/bin/run')).mode & 0o777).toBe(0o755);
    expect(fs.statSync(path.join(out, 'node_modules/a/package.json')).mode & 0o777).toBe(0o644);
    expect(fs.readFileSync(path.join(out, 'node_modules/a/empty.txt')).length).toBe(0);
    expect(fs.readlinkSync(path.join(out, 'node_modules/a/lib/libx.so.1'))).toBe('libx.so.1.2');
    expect(fs.readFileSync(path.join(out, 'node_modules/a/lib/libx.so.1')).equals(Buffer.alloc(70_000, 7))).toBe(true);
    expect(fs.readFileSync(path.join(out, LONG), 'utf8')).toBe('long');
    expect(fs.readFileSync(path.join(out, UNICODE), 'utf8')).toBe('u');
  });

  it('is a tar the system tar reads', () => {
    const listed = execFileSync('tar', ['-tzf', writeTgz(packTar(entries))], { encoding: 'utf8' }).trim().split('\n');
    expect(listed).toContain(LONG);
    expect(listed).toContain('node_modules/a/lib/libx.so.1');
  });

  it('reads back in memory (the build reads npm tarballs this way)', () => {
    const got = [...readTar(packTar(entries))];
    expect(got.map((e) => e.path)).toEqual(entries.map((e) => e.path));
    expect(got.find((e) => e.path === LONG)?.data.toString()).toBe('long');
  });
});

describe('extractTarGz bounds', () => {
  it('streams a file bigger than any one chunk', async () => {
    const big = Buffer.alloc(3 * 1024 * 1024 + 123);
    for (let i = 0; i < big.length; i++) big[i] = i % 253;
    const out = tmp();
    await extractTarGz(writeTgz(packTar([{ path: 'big.bin', type: 'file', data: big }])), out);
    expect(createHash('sha256').update(fs.readFileSync(path.join(out, 'big.bin'))).digest('hex'))
      .toBe(createHash('sha256').update(big).digest('hex'));
  });

  it('refuses an archive that unpacks past its bound', async () => {
    const out = tmp();
    const tgz = writeTgz(packTar([{ path: 'a', type: 'file', data: Buffer.alloc(5000) }, { path: 'b', type: 'file', data: Buffer.alloc(5000) }]));
    await expect(extractTarGz(tgz, out, { maxBytes: 8000 })).rejects.toThrow(/more than 8000 bytes/);
  });

  it('refuses a truncated archive instead of leaving half a file as if whole', async () => {
    const tar = packTar([{ path: 'a.bin', type: 'file', data: Buffer.alloc(100_000, 1) }]);
    await expect(extractTarGz(writeTgz(tar.subarray(0, 40_000)), tmp())).rejects.toThrow(/truncated/);
  });

  it('refuses a corrupt header', async () => {
    const tar = packTar([{ path: 'a.txt', type: 'file', data: Buffer.from('x') }]);
    tar[10] ^= 0xff;
    await expect(extractTarGz(writeTgz(tar), tmp())).rejects.toThrow(/checksum/);
  });

  it('digests the tar inside, bounded', async () => {
    const tar = packTar(entries);
    const file = writeTgz(tar);
    expect(await tarGzDigest(file)).toEqual({ sha256: createHash('sha256').update(tar).digest('hex'), bytes: tar.length });
    await expect(tarGzDigest(file, 1024)).rejects.toThrow(/more than/);
  });
});

/** Rewrite the header at `at` and give it a valid checksum again, so only the patched field is wrong. */
function patchHeader(tar: Buffer, at: number, patch: (h: Buffer) => void): Buffer {
  const out = Buffer.from(tar);
  const h = out.subarray(at, at + 512);
  patch(h);
  h.fill(0x20, 148, 156);
  let sum = 0;
  for (const b of h) sum += b;
  h.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 'latin1');
  return out;
}

describe('extractTarGz refuses what it cannot unpack faithfully', () => {
  const two = () => packTar([
    { path: 'a.txt', type: 'file', data: Buffer.alloc(100, 1) },
    { path: 'b.txt', type: 'file', data: Buffer.alloc(100, 2) },
  ]);

  it('hashes the tar as it reads it, and stops past the length it was told', async () => {
    const tar = two();
    const res = await extractTarGz(writeTgz(tar), tmp());
    expect(res).toMatchObject({ files: 2, tarBytes: tar.length, tarSha256: createHash('sha256').update(tar).digest('hex') });
    await expect(extractTarGz(writeTgz(tar), tmp(), { maxTarBytes: tar.length - 1 })).rejects.toThrow(/longer than/);
  });

  it('an archive cut at an entry boundary is truncated, not complete', async () => {
    // a.txt is one header and one padded block: the cut leaves a stream that parses.
    await expect(extractTarGz(writeTgz(two().subarray(0, 1024)), tmp())).rejects.toThrow(/end block: truncated/);
  });

  it('a tail shorter than one block is truncated, not ignored', async () => {
    await expect(extractTarGz(writeTgz(two().subarray(0, 1024 + 100)), tmp())).rejects.toThrow(/truncated/);
  });

  it('refuses a hard link (its file would be missing without a word)', async () => {
    const tar = patchHeader(packTar([{ path: 'x', type: 'symlink', link: 'y' }]), 0, (h) => { h[156] = '1'.charCodeAt(0); });
    await expect(extractTarGz(writeTgz(tar), tmp())).rejects.toThrow(/type 1/);
  });

  it('a file after a symlink of the same name replaces the link and never writes through it', async () => {
    const out = tmp();
    await extractTarGz(writeTgz(packTar([
      { path: 'lib/target.txt', type: 'file', data: Buffer.from('original') },
      { path: 'lib/a', type: 'symlink', link: 'target.txt' },
      { path: 'lib/a', type: 'file', data: Buffer.from('replaced') },
    ])), out);
    expect(fs.lstatSync(path.join(out, 'lib/a')).isSymbolicLink()).toBe(false);
    expect(fs.readFileSync(path.join(out, 'lib/a'), 'utf8')).toBe('replaced');
    expect(fs.readFileSync(path.join(out, 'lib/target.txt'), 'utf8')).toBe('original');
  });

  it('refuses a link that leaves its own directory', async () => {
    await expect(extractTarGz(writeTgz(packTar([{ path: 'lib/a', type: 'symlink', link: '../../etc/passwd' }])), tmp()))
      .rejects.toThrow(/leaves the destination/);
  });

  const badSizes: Array<[string, (h: Buffer) => void]> = [
    ['-1', (h) => { h.fill(0, 124, 136); h.write('-1', 124, 'latin1'); }],
    ['GNU base-256', (h) => { h.fill(0, 124, 136); h[124] = 0x80; h[135] = 0x10; }],
    ['not a number', (h) => { h.fill(0, 124, 136); h.write('zzzzzzzzzzz', 124, 'latin1'); }],
  ];
  for (const [what, patch] of badSizes) {
    it(`refuses an entry size of ${what} at once, in the stream and in memory`, async () => {
      const tar = patchHeader(packTar([{ path: 'a.txt', type: 'file', data: Buffer.alloc(10, 1) }]), 0, patch);
      const t0 = Date.now();
      await expect(extractTarGz(writeTgz(tar), tmp())).rejects.toThrow(/invalid size/);
      expect(Date.now() - t0).toBeLessThan(2_000);
      expect(() => [...readTar(tar)]).toThrow(/invalid size/);
    });
  }
});
