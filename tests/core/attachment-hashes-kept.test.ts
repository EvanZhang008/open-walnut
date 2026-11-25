/**
 * The attachments copy keeps its file hashes across restarts (src/core/attachment-replica.ts):
 * held in memory only, the first walk after every restart hashed the whole vault again (1.5 GB
 * measured) on the event loop, and the Mac restarts for every land (2026-11-25: 4.3 s of 395 s of
 * the live server's loop CPU in its stall profiles). A walk after a restart hashes only files
 * whose stat moved (size, mtime, ctime or inode).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createMockConstants } from '../helpers/mock-constants.js';

const counts = vi.hoisted(() => ({ sha256: 0 }));
vi.mock('../../src/constants.js', () => createMockConstants('walnut-attachment-hashes'));
vi.mock('node:crypto', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:crypto')>();
  const createHash = ((alg: string, ...rest: unknown[]) => {
    if (alg === 'sha256') counts.sha256++;
    return (real.createHash as (...a: unknown[]) => ReturnType<typeof real.createHash>)(alg, ...rest);
  }) as typeof real.createHash;
  return { ...real, createHash, default: { ...real, createHash } };
});

import { NOTES_DIR, WALNUT_HOME } from '../../src/constants.js';
import { attachmentEntries, _resetAttachmentReplicaForTesting } from '../../src/core/attachment-replica.js';

const pic = (name: string) => path.join(NOTES_DIR, 'pics', name);

beforeEach(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true });
  await fs.mkdir(path.join(NOTES_DIR, 'pics'), { recursive: true });
  for (const n of ['a.png', 'b.jpg', 'c.pdf']) await fs.writeFile(pic(n), `bytes of ${n}`);
  _resetAttachmentReplicaForTesting();
});

describe('attachment hashes across a restart', () => {
  it('a walk after a restart hashes no unchanged file, and a changed one again', async () => {
    counts.sha256 = 0;
    const first = await attachmentEntries([]);
    expect(first.map((e) => e.k)).toEqual(['pics/a.png', 'pics/b.jpg', 'pics/c.pdf']);
    expect(counts.sha256).toBe(3);

    _resetAttachmentReplicaForTesting(); // what a restart leaves: nothing in memory
    counts.sha256 = 0;
    expect(await attachmentEntries([])).toEqual(first);
    expect(counts.sha256).toBe(0);

    await fs.writeFile(pic('b.jpg'), 'new bytes of b');
    _resetAttachmentReplicaForTesting();
    counts.sha256 = 0;
    const third = await attachmentEntries([]);
    expect(counts.sha256).toBe(1);
    expect(third.find((e) => e.k === 'pics/b.jpg')?.h).not.toBe(first.find((e) => e.k === 'pics/b.jpg')?.h);
  });

  it('a file swapped in with the same size and mtime (cp -p, rsync -t, a restore) is hashed again', async () => {
    // A whole second: utimes takes a Date, which holds milliseconds only.
    const pinned = new Date(Math.floor(Date.now() / 1000) * 1000 - 60_000);
    await fs.utimes(pic('a.png'), pinned, pinned);
    const first = await attachmentEntries([]);
    const before = await fs.stat(pic('a.png'));
    // Same length, other bytes, put in place by a rename, the old mtime kept.
    const swap = path.join(NOTES_DIR, 'pics', 'a.png.swap');
    await fs.writeFile(swap, 'BYTES OF a.png');
    await fs.utimes(swap, pinned, pinned);
    await fs.rename(swap, pic('a.png'));
    const after = await fs.stat(pic('a.png'));
    expect([after.size, after.mtimeMs]).toEqual([before.size, before.mtimeMs]);
    _resetAttachmentReplicaForTesting();
    counts.sha256 = 0;
    const again = await attachmentEntries([]);
    expect(counts.sha256).toBe(1);
    expect(again.find((e) => e.k === 'pics/a.png')?.h).not.toBe(first.find((e) => e.k === 'pics/a.png')?.h);
  });

  it('a kept file of the first format (size and mtime alone) is not trusted', async () => {
    const st = await fs.stat(pic('a.png'));
    await fs.mkdir(path.join(WALNUT_HOME, 'cache'), { recursive: true });
    await fs.writeFile(path.join(WALNUT_HOME, 'cache', 'attachment-hashes.json'),
      JSON.stringify({ v: 1, files: { [pic('a.png')]: [st.mtimeMs, st.size, '0'.repeat(64)] } }));
    counts.sha256 = 0;
    const entries = await attachmentEntries([]);
    expect(counts.sha256).toBe(3);
    expect(entries.find((e) => e.k === 'pics/a.png')?.h).not.toBe('0'.repeat(64));
  });

  it('an unreadable kept file is ignored, and a removed picture leaves it', async () => {
    await fs.mkdir(path.join(WALNUT_HOME, 'cache'), { recursive: true });
    await fs.writeFile(path.join(WALNUT_HOME, 'cache', 'attachment-hashes.json'), '{not json');
    expect(await attachmentEntries([])).toHaveLength(3);
    await fs.rm(pic('c.pdf'));
    await attachmentEntries([]);
    const kept = JSON.parse(await fs.readFile(path.join(WALNUT_HOME, 'cache', 'attachment-hashes.json'), 'utf8'));
    expect(Object.keys(kept.files).map((k) => path.basename(k)).sort()).toEqual(['a.png', 'b.jpg']);
  });
});
