import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {
  diffAgainstManifest,
  findCanonicalSqlite,
  isExcluded,
  scanDataDir,
  SQLITE_SNAPSHOT_PREFIX,
} from '../../../src/core/backup/scan.js';
import type { BackupManifest, ManifestEntry } from '../../../src/core/backup/types.js';

let root: string;

beforeEach(async () => {
  root = path.join(os.tmpdir(), `walnut-backup-scan-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await fsp.mkdir(root, { recursive: true });
});

afterEach(async () => {
  await fsp.rm(root, { recursive: true, force: true }).catch(() => {});
});

const write = async (rel: string, content = 'x'): Promise<void> => {
  const abs = path.join(root, rel);
  await fsp.mkdir(path.dirname(abs), { recursive: true });
  await fsp.writeFile(abs, content);
};

describe('isExcluded', () => {
  it('excludes rebuildable caches and includes canonical data', () => {
    expect(isExcluded('tmp/backup-staging/x')).toBe(true);
    expect(isExcluded('cache/foo.json')).toBe(true);
    expect(isExcluded('stt-debug/a.wav')).toBe(true);
    expect(isExcluded('.smart-env/multi/x')).toBe(true);
    expect(isExcluded('.git/objects/ab')).toBe(true);
    expect(isExcluded('browser/x')).toBe(true);
    expect(isExcluded('notes-search.sqlite')).toBe(true);
    expect(isExcluded('memory-index.sqlite')).toBe(true);
    expect(isExcluded('sessions.sqlite-wal')).toBe(true);
    expect(isExcluded('some.lock')).toBe(true);
    // Raw canonical sqlite is excluded from the raw scan (snapshots ride instead)
    expect(isExcluded('sessions.sqlite')).toBe(true);

    expect(isExcluded('auth.json')).toBe(false);
    expect(isExcluded('config.yaml')).toBe(false);
    expect(isExcluded('tasks/tasks.json')).toBe(false);
    expect(isExcluded('notes/inbox/idea.md')).toBe(false);
    expect(isExcluded('chat-history.json')).toBe(false);
  });

  it('only excludes top-level cache dirs, not same-named nested files', () => {
    expect(isExcluded('notes/tmp')).toBe(false);
    expect(isExcluded('notes/cache-notes.md')).toBe(false);
  });
});

describe('scanDataDir', () => {
  it('walks recursively, applies exclusions, returns sorted entries', async () => {
    await write('config.yaml', 'version: 1');
    await write('auth.json', '{}');
    await write('tasks/tasks.json', '[]');
    await write('notes/inbox/idea.md', 'hello');
    await write('tmp/scratch.txt');
    await write('cache/blob.bin');
    await write('notes-search.sqlite');
    await write('sessions.sqlite');

    const entries = await scanDataDir(root);
    const paths = entries.map((e) => e.path);
    expect(paths).toEqual(['auth.json', 'config.yaml', 'notes/inbox/idea.md', 'tasks/tasks.json']);
    for (const e of entries) {
      expect(e.size).toBeGreaterThan(0);
      expect(e.mtimeMs).toBeGreaterThan(0);
    }
  });
});

describe('findCanonicalSqlite', () => {
  it('finds canonical DBs anywhere, skips search/index DBs and cache dirs', async () => {
    await write('sessions.sqlite');
    await write('tasks/tasks.sqlite');
    await write('usage.sqlite');
    await write('notes-search.sqlite');
    await write('memory-index.sqlite');
    await write('cache/junk.sqlite');
    const found = await findCanonicalSqlite(root);
    expect(found).toEqual(['sessions.sqlite', 'tasks/tasks.sqlite', 'usage.sqlite']);
  });
});

describe('diffAgainstManifest', () => {
  const entry = (p: string, size = 10, mtimeMs = 1000): ManifestEntry => ({ path: p, size, mtimeMs });
  const manifest = (files: ManifestEntry[]): BackupManifest => ({
    version: 1,
    createdAt: '2026-08-13T00:00:00Z',
    hostname: 'test-host',
    walnutVersion: '1.0.0',
    fileCount: files.length,
    totalBytes: files.reduce((n, f) => n + f.size, 0),
    files,
  });

  it('uploads everything on first backup (no previous manifest)', () => {
    const scan = [entry('a.txt'), entry('b/c.txt')];
    const diff = diffAgainstManifest(scan, null);
    expect(diff.upload).toHaveLength(2);
    expect(diff.remove).toHaveLength(0);
    expect(diff.unchanged).toHaveLength(0);
  });

  it('separates changed, unchanged, and deleted files', () => {
    const prev = manifest([entry('same.txt'), entry('changed.txt', 10, 1000), entry('gone.txt')]);
    const scan = [entry('same.txt'), entry('changed.txt', 12, 2000), entry('new.txt')];
    const diff = diffAgainstManifest(scan, prev);
    expect(diff.unchanged.map((e) => e.path)).toEqual(['same.txt']);
    expect(diff.upload.map((e) => e.path).sort()).toEqual(['changed.txt', 'new.txt']);
    expect(diff.remove).toEqual(['gone.txt']);
  });

  it('treats mtime-only change as changed (size same)', () => {
    const prev = manifest([entry('f.txt', 10, 1000)]);
    const diff = diffAgainstManifest([entry('f.txt', 10, 9999)], prev);
    expect(diff.upload.map((e) => e.path)).toEqual(['f.txt']);
  });

  it('sqlite snapshots ride under the snapshot prefix and diff like any file', () => {
    const snap = entry(`${SQLITE_SNAPSHOT_PREFIX}/tasks/tasks.sqlite`, 500, 42);
    const diff = diffAgainstManifest([snap], manifest([snap]));
    expect(diff.unchanged).toHaveLength(1);
  });
});
