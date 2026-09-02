/**
 * Persistent file-CONTENT cache: the policy layer, against an in-memory adapter.
 *
 * The bug this pins: clicking a file in the session Files tree blanked the pane
 * and waited for `/api/file-content` to ship the whole file as JSON — for a remote
 * session, over the SSH tunnel, on every open, even when nothing had changed. The
 * tree already painted from cache/dirlist-idb; the file body did not.
 *
 * What matters here is what makes that safe rather than merely fast. A record is
 * only ever PAINTED: the open that paints it also sends `If-None-Match:
 * "<contentHash>"`, so a stale record costs one repaint and never a wrong file.
 * That is why a payload with no `contentHash` (truncated, binary, errored) must
 * never be stored — it has no validator, so it could never be confirmed. The rest:
 * hosts don't bleed into each other; a renamed or deleted DIRECTORY takes its
 * descendants with it and nothing else; an old record is still painted (age drives
 * housekeeping, never a read); a broken storage layer degrades to "no cache"
 * instead of rejecting into a render.
 *
 * There is no fake-indexeddb in devDependencies (adding a dependency for one test
 * is the wrong trade), which is why filecontent-idb.ts takes its store through an
 * injectable adapter.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  getCachedFileContent, setCachedFileContent, deleteCachedFileContent,
  deleteCachedFileContentsUnder, clearCachedFileContents, pruneCachedFileContents,
  setFileContentAdapter, fileContentKey, storable, MAX_CACHED_CONTENT_BYTES,
  type CachedFileContent, type FileContentAdapter,
} from '../../web/src/cache/filecontent-idb';
import type { FileContentResponse } from '../../web/src/api/files';

const DAY = 24 * 60 * 60 * 1000;

/** A complete text read — the only shape that is cacheable. */
function payload(content: string, hash = 'h1', extra: Partial<FileContentResponse> = {}): FileContentResponse {
  return {
    content,
    size: content.length,
    truncated: false,
    binary: false,
    extension: 'ts',
    contentHash: hash,
    ...extra,
  };
}

/** The whole store as a Map — same contract, no IndexedDB. */
class MemoryAdapter implements FileContentAdapter {
  rows = new Map<string, CachedFileContent>();
  calls = { get: 0, put: 0, deleteMany: 0, keysWithPrefix: 0, agesOldestFirst: 0, clear: 0 };

  async get(key: string) { this.calls.get++; return this.rows.get(key) ?? null; }
  async put(key: string, record: CachedFileContent) { this.calls.put++; this.rows.set(key, record); }
  async deleteMany(keys: string[]) {
    this.calls.deleteMany++;
    for (const k of keys) this.rows.delete(k);
  }
  async keysWithPrefix(prefix: string) {
    this.calls.keysWithPrefix++;
    return [...this.rows.keys()].filter((k) => k.startsWith(prefix));
  }
  async agesOldestFirst() {
    this.calls.agesOldestFirst++;
    return [...this.rows.entries()]
      .map(([key, rec]) => ({ key, updatedAt: rec.updatedAt }))
      .sort((a, b) => a.updatedAt - b.updatedAt);
  }
  async clear() { this.calls.clear++; this.rows.clear(); }

  /** Seed a record with a chosen age, bypassing the public write path. */
  seed(host: string | null, p: string, content: string, updatedAt: number, hash = 'seeded'): void {
    this.rows.set(fileContentKey(host, p), {
      host, path: p, content, size: content.length, extension: 'ts', contentHash: hash, updatedAt,
    });
  }
}

/** Every method rejects — private browsing, quota, a corrupt DB. */
class ThrowingAdapter implements FileContentAdapter {
  async get(): Promise<CachedFileContent | null> { throw new Error('idb is gone'); }
  async put(): Promise<void> { throw new Error('idb is gone'); }
  async deleteMany(): Promise<void> { throw new Error('idb is gone'); }
  async keysWithPrefix(): Promise<string[]> { throw new Error('idb is gone'); }
  async agesOldestFirst(): Promise<Array<{ key: string; updatedAt: number }>> { throw new Error('idb is gone'); }
  async clear(): Promise<void> { throw new Error('idb is gone'); }
}

let store: MemoryAdapter;

beforeEach(() => {
  store = new MemoryAdapter();
  setFileContentAdapter(store);
});

describe('file-content cache: roundtrip', () => {
  it('stores the bytes and the validator that will confirm them', async () => {
    await setCachedFileContent(null, '/repo/src/a.ts', payload('export const a = 1\n', 'abc123'));
    const rec = await getCachedFileContent(null, '/repo/src/a.ts');
    expect(rec?.content).toBe('export const a = 1\n');
    expect(rec?.contentHash).toBe('abc123');
    expect(rec?.size).toBe('export const a = 1\n'.length);
    expect(rec?.extension).toBe('ts');
    expect(rec?.path).toBe('/repo/src/a.ts');
    expect(rec?.updatedAt).toBeGreaterThan(0);
  });

  it('a miss is null, not a throw', async () => {
    expect(await getCachedFileContent(null, '/never/opened.ts')).toBeNull();
  });

  it('a second write to the same path replaces the bytes and the validator', async () => {
    await setCachedFileContent(null, '/repo/a.ts', payload('one', 'h1'));
    await setCachedFileContent(null, '/repo/a.ts', payload('two', 'h2'));
    const rec = await getCachedFileContent(null, '/repo/a.ts');
    expect(rec?.content).toBe('two');
    expect(rec?.contentHash).toBe('h2');
    expect(store.rows.size).toBe(1);
  });

  it('the same path on two hosts is two records', async () => {
    await setCachedFileContent(null, '/repo/a.ts', payload('local bytes', 'l1'));
    await setCachedFileContent('devbox', '/repo/a.ts', payload('remote bytes', 'r1'));
    expect((await getCachedFileContent(null, '/repo/a.ts'))?.content).toBe('local bytes');
    expect((await getCachedFileContent('devbox', '/repo/a.ts'))?.content).toBe('remote bytes');
  });
});

describe('file-content cache: only confirmable payloads are stored', () => {
  it('rejects a payload with no contentHash — nothing could ever revalidate it', async () => {
    await setCachedFileContent(null, '/repo/a.ts', { ...payload('x'), contentHash: undefined });
    expect(store.rows.size).toBe(0);
  });

  it('rejects a truncated read: caching half a file would offer it as the whole one', async () => {
    await setCachedFileContent(null, '/repo/big.log', payload('first 512 KB', 'h1', { truncated: true }));
    expect(store.rows.size).toBe(0);
  });

  it('rejects a binary payload and an errored one', async () => {
    await setCachedFileContent(null, '/repo/a.png', { ...payload(''), binary: true, content: null });
    await setCachedFileContent(null, '/repo/gone.ts', { ...payload(''), error: 'File not found', content: null });
    expect(store.rows.size).toBe(0);
  });

  it('rejects content above the size limit, and accepts content exactly at it', async () => {
    await setCachedFileContent(null, '/repo/huge.ts', payload('x'.repeat(MAX_CACHED_CONTENT_BYTES + 1), 'h1'));
    expect(store.rows.size).toBe(0);
    await setCachedFileContent(null, '/repo/edge.ts', payload('x'.repeat(MAX_CACHED_CONTENT_BYTES), 'h2'));
    expect(store.rows.size).toBe(1);
  });

  it('storable() is the single rule both the writer and the caller ask', () => {
    expect(storable(payload('ok'))).toBe(true);
    expect(storable({ ...payload('ok'), truncated: true })).toBe(false);
    expect(storable({ ...payload('ok'), binary: true })).toBe(false);
    expect(storable({ ...payload('ok'), error: 'boom' })).toBe(false);
    expect(storable({ ...payload('ok'), contentHash: undefined })).toBe(false);
    expect(storable({ ...payload(''), content: null })).toBe(false);
  });

  it('an empty file IS cacheable — zero bytes is a real answer', async () => {
    await setCachedFileContent(null, '/repo/empty.ts', payload('', 'h0'));
    expect((await getCachedFileContent(null, '/repo/empty.ts'))?.content).toBe('');
  });
});

describe('file-content cache: a record with no validator is never returned', () => {
  it('ignores a stored row whose contentHash went missing (older schema, corrupt row)', async () => {
    store.rows.set(fileContentKey(null, '/repo/a.ts'), {
      host: null, path: '/repo/a.ts', content: 'x', size: 1, extension: 'ts',
      contentHash: '' as string, updatedAt: Date.now(),
    });
    expect(await getCachedFileContent(null, '/repo/a.ts')).toBeNull();
  });
});

describe('file-content cache: invalidation', () => {
  it('deleteCachedFileContent forgets exactly one file', async () => {
    await setCachedFileContent(null, '/repo/a.ts', payload('a'));
    await setCachedFileContent(null, '/repo/b.ts', payload('b'));
    await deleteCachedFileContent(null, '/repo/a.ts');
    expect(await getCachedFileContent(null, '/repo/a.ts')).toBeNull();
    expect(await getCachedFileContent(null, '/repo/b.ts')).not.toBeNull();
  });

  it('a deleted directory takes its descendants — matched by SEGMENT, not prefix', async () => {
    await setCachedFileContent(null, '/repo/src', payload('the dir itself, somehow'));
    await setCachedFileContent(null, '/repo/src/a.ts', payload('a'));
    await setCachedFileContent(null, '/repo/src/deep/b.ts', payload('b'));
    // The trap: a string-prefix match would also delete this one.
    await setCachedFileContent(null, '/repo/srcc/c.ts', payload('c'));
    await deleteCachedFileContentsUnder(null, '/repo/src');
    expect(await getCachedFileContent(null, '/repo/src')).toBeNull();
    expect(await getCachedFileContent(null, '/repo/src/a.ts')).toBeNull();
    expect(await getCachedFileContent(null, '/repo/src/deep/b.ts')).toBeNull();
    expect((await getCachedFileContent(null, '/repo/srcc/c.ts'))?.content).toBe('c');
  });

  it('a trailing slash on the deleted directory changes nothing', async () => {
    await setCachedFileContent(null, '/repo/src/a.ts', payload('a'));
    await deleteCachedFileContentsUnder(null, '/repo/src/');
    expect(await getCachedFileContent(null, '/repo/src/a.ts')).toBeNull();
  });

  it('deleting under one host leaves the other host alone', async () => {
    await setCachedFileContent(null, '/repo/src/a.ts', payload('local'));
    await setCachedFileContent('devbox', '/repo/src/a.ts', payload('remote'));
    await deleteCachedFileContentsUnder(null, '/repo/src');
    expect(await getCachedFileContent(null, '/repo/src/a.ts')).toBeNull();
    expect((await getCachedFileContent('devbox', '/repo/src/a.ts'))?.content).toBe('remote');
  });

  it('clearCachedFileContents empties the store', async () => {
    await setCachedFileContent(null, '/repo/a.ts', payload('a'));
    await clearCachedFileContents();
    expect(store.rows.size).toBe(0);
  });
});

describe('file-content cache: age drives housekeeping, never a read', () => {
  it('an old record is still painted — hiding it would restore the blank pane', async () => {
    store.seed(null, '/repo/a.ts', 'ancient but paintable', Date.now() - 3 * DAY);
    expect((await getCachedFileContent(null, '/repo/a.ts'))?.content).toBe('ancient but paintable');
  });

  it('housekeeping drops what expired and keeps what did not', async () => {
    store.seed(null, '/repo/old.ts', 'old', Date.now() - 30 * DAY);
    store.seed(null, '/repo/new.ts', 'new', Date.now() - 1 * DAY);
    await pruneCachedFileContents();
    expect(await getCachedFileContent(null, '/repo/old.ts')).toBeNull();
    expect((await getCachedFileContent(null, '/repo/new.ts'))?.content).toBe('new');
  });
});

describe('file-content cache: a broken storage layer is not an error path', () => {
  beforeEach(() => { setFileContentAdapter(new ThrowingAdapter()); });

  it('every operation resolves instead of rejecting into a render', async () => {
    await expect(getCachedFileContent(null, '/repo/a.ts')).resolves.toBeNull();
    await expect(setCachedFileContent(null, '/repo/a.ts', payload('a'))).resolves.toBeUndefined();
    await expect(deleteCachedFileContent(null, '/repo/a.ts')).resolves.toBeUndefined();
    await expect(deleteCachedFileContentsUnder(null, '/repo')).resolves.toBeUndefined();
    await expect(clearCachedFileContents()).resolves.toBeUndefined();
  });
});
