/**
 * Prune reads each tree blob once, however many kept backups share it, and finds the same
 * blobs as reading every kept backup's tree whole.
 *
 * 2026-11-25 on the Mac: about 80 kept backups of 55k files each, and every prune parsed
 * about 80 copies of a 12 MB tree within a minute; the server's footprint rose to 5.8 GB.
 *
 * Real: an encrypted repository on a LocalStore in a temp dir, trees cut by treeChunks.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { LocalStore } from '../../../src/core/backup/stores/local-store.js';
import { generateRecoveryKey, parseRecoveryKey } from '../../../src/core/backup/repo/crypto.js';
import { loadLiveIndex } from '../../../src/core/backup/repo/backup-run.js';
import { PackCache, PackWriter, Repository, treeChunks } from '../../../src/core/backup/repo/repository.js';
import { treeDataBlobIds } from '../../../src/core/backup/repo/tree-blobs.js';
import type { Snapshot, TreeEntry } from '../../../src/core/backup/repo/format.js';

const H = { id: 'c'.repeat(32), name: 'h' };
let root: string;
let store: LocalStore;

beforeEach(async () => {
  root = await fsp.mkdtemp(path.join(os.tmpdir(), 'walnut-prune-tree-'));
  store = new LocalStore(path.join(root, 'dest'));
});
afterEach(async () => {
  await fsp.rm(root, { recursive: true, force: true });
});

const fakeId = (s: string): string => createHash('sha256').update(s).digest('hex');

/** A board's worth of files; `gen` changes a few of them, as a backup run a few minutes later would. */
function entries(gen: number): TreeEntry[] {
  const out: TreeEntry[] = [];
  for (let i = 0; i < 12_000; i++) {
    const changed = i % 997 === gen % 997;
    // Multi-byte paths, so a blob edge can fall inside a character.
    out.push({ p: `notes/文件-${i}-été.md`, s: 1000 + i, m: changed ? gen : 0, b: [fakeId(`f${i}-${changed ? gen : 0}`)] });
  }
  // One file with so many chunks that its row is longer than a tree blob can be.
  out.push({ p: 'sessions/huge.jsonl', s: 1, m: 0, b: Array.from({ length: 40_000 }, (_, k) => fakeId(`huge-${k}`)) });
  out.push({ p: 'tasks/empty.json', s: 0, m: 0, b: [] });
  return out.sort((a, b) => a.p.localeCompare(b.p));
}

async function backups(count: number): Promise<{ repo: Repository; snaps: Snapshot[] }> {
  const repo = await Repository.open(store, parseRecoveryKey(generateRecoveryKey()), { create: true, writer: H });
  const known = new Set<string>();
  const snaps: Snapshot[] = [];
  for (let gen = 1; gen <= count; gen++) {
    const tree = new PackWriter(repo, 'tree');
    const ids: string[] = [];
    for (const chunk of treeChunks(entries(gen))) {
      const id = repo.blobId(chunk);
      ids.push(id);
      if (!known.has(id)) {
        known.add(id);
        await tree.add(id, await repo.sealBlob(id, chunk, true), chunk.length);
      }
    }
    await repo.writeIndex(await tree.finish());
    const createdAt = new Date(Date.UTC(2026, 10, 25, 0, gen));
    snaps.push({ version: 1, id: repo.newSnapshotId(createdAt), createdAt: createdAt.toISOString(), hostname: 'h', walnutVersion: 't', fileCount: 12_002, totalBytes: 1, tree: ids });
  }
  return { repo, snaps };
}

describe('the blobs kept backups name', () => {
  it('are the same as reading every kept tree whole, while each tree blob is read once', async () => {
    const { repo, snaps } = await backups(6);
    const { index } = await loadLiveIndex(repo);
    // The trees really cross blob edges: several blobs per tree, one row longer than a blob.
    expect(snaps[0]!.tree.length).toBeGreaterThan(3);

    const expected = new Set<string>();
    for (const s of snaps) for (const e of await repo.readTree(s, index, new PackCache(store))) for (const id of e.b) expected.add(id);

    const read = vi.spyOn(repo, 'readBlob');
    const got = await treeDataBlobIds(repo, snaps, index, new PackCache(store));
    expect([...got].sort()).toEqual([...expected].sort());

    const uniqueTreeBlobs = new Set(snaps.flatMap((s) => s.tree)).size;
    const perSnapshot = snaps.reduce((n, s) => n + s.tree.length, 0);
    expect(read).toHaveBeenCalledTimes(uniqueTreeBlobs);
    expect(uniqueTreeBlobs).toBeLessThan(perSnapshot);
  }, 120_000);

  it('a tree blob no index lists fails the read, as reading the tree did', async () => {
    const { repo, snaps } = await backups(1);
    const { index } = await loadLiveIndex(repo);
    const broken = { ...snaps[0]!, tree: [...snaps[0]!.tree, 'f'.repeat(64)] };
    await expect(treeDataBlobIds(repo, [broken], index, new PackCache(store))).rejects.toThrow(/is in no index/);
  }, 60_000);
});
