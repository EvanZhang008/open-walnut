/**
 * Persistent directory-listing cache: the policy layer, against an in-memory adapter.
 *
 * The bug this pins: every listing in the session Files tree is a fresh
 * `/api/files/list` round trip (for a remote session, over the SSH tunnel), and
 * the tree rendered nothing until the first one landed — so reopening a panel you
 * had open two minutes ago showed a bare `Loading…` pane. This store is what
 * makes the previously expanded tree paint from disk first.
 *
 * So what matters here is: a listing survives; MANY listings come back in ONE
 * transaction (the reopen path asks for up to ~64 dirs and must not pay 64 round
 * trips); hosts don't bleed into each other; a renamed or deleted DIRECTORY takes
 * its descendants' records with it and nothing else; an old record is still
 * painted (age drives housekeeping, never a read); and a broken storage layer
 * degrades to "no cache" instead of rejecting into a render.
 *
 * There is no fake-indexeddb in devDependencies (and adding a dependency for one
 * test is the wrong trade), which is exactly why dirlist-idb.ts takes its store
 * through an injectable adapter.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  getCachedDirList, getCachedDirListsBulk, setCachedDirList,
  deleteCachedDirList, deleteCachedDirListsUnder, clearCachedDirLists,
  pruneCachedDirLists, settleDirListHousekeeping,
  setDirListAdapter, dirListKey,
  type CachedDirList, type DirListAdapter,
} from '../../web/src/cache/dirlist-idb';
import type { DirListResponse } from '../../web/src/api/files';

const DAY = 24 * 60 * 60 * 1000;

function listing(names: string[], extra: Partial<DirListResponse> = {}): DirListResponse {
  return {
    path: '/ignored',
    entries: names.map((name) => ({ name, type: 'file' as const })),
    ...extra,
  };
}

/** The whole store as a Map — same contract, no IndexedDB. Counts calls so the
 *  "one transaction" promise of the bulk API is provable, not just asserted. */
class MemoryAdapter implements DirListAdapter {
  rows = new Map<string, CachedDirList>();
  calls = { get: 0, getMany: 0, put: 0, deleteMany: 0, keysWithPrefix: 0, agesOldestFirst: 0, clear: 0 };

  async get(key: string) { this.calls.get++; return this.rows.get(key) ?? null; }
  async getMany(keys: string[]) {
    this.calls.getMany++;
    return keys.map((k) => this.rows.get(k) ?? null);
  }
  async put(key: string, record: CachedDirList) { this.calls.put++; this.rows.set(key, record); }
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
  seed(host: string | null, dirPath: string, names: string[], updatedAt: number): void {
    this.rows.set(dirListKey(host, dirPath), {
      host, path: dirPath, entries: names.map((name) => ({ name, type: 'file' as const })), updatedAt,
    });
  }
}

/** Every method rejects — private browsing, quota, a corrupt DB. */
class ThrowingAdapter implements DirListAdapter {
  async get(): Promise<CachedDirList | null> { throw new Error('idb is gone'); }
  async getMany(): Promise<Array<CachedDirList | null>> { throw new Error('idb is gone'); }
  async put(): Promise<void> { throw new Error('idb is gone'); }
  async deleteMany(): Promise<void> { throw new Error('idb is gone'); }
  async keysWithPrefix(): Promise<string[]> { throw new Error('idb is gone'); }
  async agesOldestFirst(): Promise<Array<{ key: string; updatedAt: number }>> { throw new Error('idb is gone'); }
  async clear(): Promise<void> { throw new Error('idb is gone'); }
}

let store: MemoryAdapter;

beforeEach(() => {
  store = new MemoryAdapter();
  setDirListAdapter(store);
});

describe('dirlist cache: roundtrip', () => {
  it('stores and returns a listing, plus what the response said about the path', async () => {
    await setCachedDirList(null, '/repo/src', listing(['a.ts', 'b.ts'], {
      selectedFile: 'a.ts', requestedPath: '/repo/srcc', resolvedVia: 'git',
    }));
    const rec = await getCachedDirList(null, '/repo/src');
    expect(rec?.entries.map((e) => e.name)).toEqual(['a.ts', 'b.ts']);
    expect(rec?.path).toBe('/repo/src');
    expect(rec?.selectedFile).toBe('a.ts');
    expect(rec?.requestedPath).toBe('/repo/srcc');
    expect(rec?.resolvedVia).toBe('git');
    expect(rec?.updatedAt).toBeGreaterThan(0);
  });

  it('a miss is null, not a throw', async () => {
    expect(await getCachedDirList(null, '/never/listed')).toBeNull();
  });

  it('deleteCachedDirList forgets exactly one listing', async () => {
    await setCachedDirList(null, '/repo/src', listing(['a.ts']));
    await setCachedDirList(null, '/repo/lib', listing(['b.ts']));
    await deleteCachedDirList(null, '/repo/src');
    expect(await getCachedDirList(null, '/repo/src')).toBeNull();
    expect(await getCachedDirList(null, '/repo/lib')).not.toBeNull();
  });

  it('clearCachedDirLists empties the store', async () => {
    await setCachedDirList(null, '/repo/src', listing(['a.ts']));
    await clearCachedDirLists();
    expect(store.rows.size).toBe(0);
  });
});

describe('dirlist cache: bulk read', () => {
  it('returns only the asked-for paths', async () => {
    await setCachedDirList(null, '/repo', listing(['src']));
    await setCachedDirList(null, '/repo/src', listing(['a.ts']));
    await setCachedDirList(null, '/repo/lib', listing(['b.ts']));

    const got = await getCachedDirListsBulk(null, ['/repo', '/repo/src', '/repo/nope']);
    expect([...got.keys()].sort()).toEqual(['/repo', '/repo/src']);
    expect(got.get('/repo/src')!.entries.map((e) => e.name)).toEqual(['a.ts']);
    // Asked for none of it, got none of it: /repo/lib is cached but not requested.
    expect(got.has('/repo/lib')).toBe(false);
  });

  it('costs ONE adapter round trip however many paths are asked for', async () => {
    const paths: string[] = [];
    for (let i = 0; i < 64; i++) {
      paths.push(`/repo/pkg${i}`);
      await setCachedDirList(null, `/repo/pkg${i}`, listing([`f${i}.ts`]));
    }
    store.calls.get = 0;
    store.calls.getMany = 0;

    const got = await getCachedDirListsBulk(null, paths);

    expect(got.size).toBe(64);
    // The whole reason this API exists: 64 dirs, one transaction, zero per-key gets.
    expect(store.calls.getMany).toBe(1);
    expect(store.calls.get).toBe(0);
  });

  it('de-duplicates repeated paths instead of asking twice', async () => {
    await setCachedDirList(null, '/repo', listing(['src']));
    store.calls.getMany = 0;
    const got = await getCachedDirListsBulk(null, ['/repo', '/repo', '/repo']);
    expect(got.size).toBe(1);
    expect(store.calls.getMany).toBe(1);
  });

  it('an empty ask touches the store not at all', async () => {
    store.calls.getMany = 0;
    expect((await getCachedDirListsBulk(null, [])).size).toBe(0);
    expect(store.calls.getMany).toBe(0);
  });
});

describe('dirlist cache: host isolation', () => {
  it('the same path on two hosts is two listings', async () => {
    await setCachedDirList(null, '/srv/app', listing(['local-only.ts']));
    await setCachedDirList('marina', '/srv/app', listing(['remote-only.ts']));

    expect((await getCachedDirList(null, '/srv/app'))!.entries[0]!.name).toBe('local-only.ts');
    expect((await getCachedDirList('marina', '/srv/app'))!.entries[0]!.name).toBe('remote-only.ts');
    expect(await getCachedDirList('acme', '/srv/app')).toBeNull();
    expect((await getCachedDirListsBulk('marina', ['/srv/app'])).get('/srv/app')!.entries[0]!.name)
      .toBe('remote-only.ts');
  });

  it('an undefined host means this machine, same as null', async () => {
    await setCachedDirList(undefined, '/srv/app', listing(['x.ts']));
    expect(await getCachedDirList(null, '/srv/app')).not.toBeNull();
  });

  it('invalidating a subtree on one host leaves the other host alone', async () => {
    await setCachedDirList(null, '/srv/app', listing(['x.ts']));
    await setCachedDirList('marina', '/srv/app', listing(['x.ts']));
    await deleteCachedDirListsUnder('marina', '/srv/app');
    expect(await getCachedDirList('marina', '/srv/app')).toBeNull();
    expect(await getCachedDirList(null, '/srv/app')).not.toBeNull();
  });
});

describe('dirlist cache: subtree invalidation', () => {
  beforeEach(async () => {
    for (const p of ['/a', '/a/b', '/a/b/c', '/a/b/c/d', '/a/bc', '/a/bc/x', '/a/b2', '/ab']) {
      await setCachedDirList(null, p, listing([`in-${p}`]));
    }
  });

  it('removes the directory and every descendant', async () => {
    await deleteCachedDirListsUnder(null, '/a/b');
    expect(await getCachedDirList(null, '/a/b')).toBeNull();
    expect(await getCachedDirList(null, '/a/b/c')).toBeNull();
    expect(await getCachedDirList(null, '/a/b/c/d')).toBeNull();
  });

  it('matches on the path SEPARATOR, not on a string prefix', async () => {
    await deleteCachedDirListsUnder(null, '/a/b');
    // Each of these merely STARTS WITH "/a/b" — a substring rule would have
    // wiped a sibling tree the user never touched.
    expect(await getCachedDirList(null, '/a/bc')).not.toBeNull();
    expect(await getCachedDirList(null, '/a/bc/x')).not.toBeNull();
    expect(await getCachedDirList(null, '/a/b2')).not.toBeNull();
    // …and it never climbs upward either.
    expect(await getCachedDirList(null, '/a')).not.toBeNull();
    expect(await getCachedDirList(null, '/ab')).not.toBeNull();
  });

  it('a trailing slash on the doomed path changes nothing', async () => {
    await deleteCachedDirListsUnder(null, '/a/b/');
    expect(await getCachedDirList(null, '/a/b')).toBeNull();
    expect(await getCachedDirList(null, '/a/b/c')).toBeNull();
    expect(await getCachedDirList(null, '/a/bc')).not.toBeNull();
  });

  it('the filesystem root takes everything on that host', async () => {
    await deleteCachedDirListsUnder(null, '/');
    expect(store.rows.size).toBe(0);
  });

  it('a leaf with no cached descendants is still forgotten', async () => {
    await deleteCachedDirListsUnder(null, '/a/b/c/d');
    expect(await getCachedDirList(null, '/a/b/c/d')).toBeNull();
    expect(await getCachedDirList(null, '/a/b/c')).not.toBeNull();
  });
});

describe('dirlist cache: housekeeping', () => {
  it('drops records older than 14 days and keeps the rest', async () => {
    const now = Date.now();
    store.seed(null, '/fresh', ['a.ts'], now - 1000);
    store.seed(null, '/yesterday', ['b.ts'], now - 1 * DAY);
    store.seed(null, '/thirteen-days', ['c.ts'], now - 13 * DAY);
    store.seed(null, '/fifteen-days', ['d.ts'], now - 15 * DAY);
    store.seed(null, '/ancient', ['e.ts'], now - 400 * DAY);

    await pruneCachedDirLists();

    expect([...store.rows.values()].map((r) => r.path).sort())
      .toEqual(['/fresh', '/thirteen-days', '/yesterday']);
  });

  it('evicts oldest-first down to the 4000-record cap', async () => {
    const now = Date.now();
    // 4003 live records, each one second older than the next.
    for (let i = 0; i < 4003; i++) store.seed(null, `/d${i}`, ['x.ts'], now - (4003 - i) * 1000);
    expect(store.rows.size).toBe(4003);

    await pruneCachedDirLists();

    expect(store.rows.size).toBe(4000);
    // The three oldest went; the newest stayed.
    for (const gone of ['/d0', '/d1', '/d2']) {
      expect(await getCachedDirList(null, gone)).toBeNull();
    }
    expect(await getCachedDirList(null, '/d3')).not.toBeNull();
    expect(await getCachedDirList(null, '/d4002')).not.toBeNull();
  });

  it('never deletes when the store is inside both limits', async () => {
    store.seed(null, '/a', ['x.ts'], Date.now());
    store.calls.deleteMany = 0;
    await pruneCachedDirLists();
    expect(store.calls.deleteMany).toBe(0);
    expect(store.rows.size).toBe(1);
  });

  it('paints an ancient listing FIRST and only sweeps it afterwards', async () => {
    // The load-bearing rule: there is no read-time TTL. A 100-day-old listing is
    // still the fastest honest answer, and the fetch running alongside it is what
    // corrects the rows — hiding it would restore the empty pane.
    store.seed(null, '/repo/src', ['a.ts'], Date.now() - 100 * DAY);

    const rec = await getCachedDirList(null, '/repo/src');
    expect(rec?.entries.map((e) => e.name)).toEqual(['a.ts']);

    // The same read kicked housekeeping, which does eventually reclaim it —
    // after answering, never before.
    await settleDirListHousekeeping();
    expect(store.rows.has(dirListKey(null, '/repo/src'))).toBe(false);
  });
});

describe('dirlist cache: what is not worth storing', () => {
  it('skips a directory with more entries than the clone budget', async () => {
    const huge = Array.from({ length: 5001 }, (_, i) => `f${i}.ts`);
    await setCachedDirList(null, '/node_modules/.bin', listing(huge));
    expect(await getCachedDirList(null, '/node_modules/.bin')).toBeNull();
  });

  it('a malformed response is ignored rather than persisted', async () => {
    await setCachedDirList(null, '/repo', { path: '/repo' } as unknown as DirListResponse);
    expect(store.rows.size).toBe(0);
  });
});

describe('dirlist cache: a broken storage layer', () => {
  beforeEach(() => setDirListAdapter(new ThrowingAdapter()));

  it('reads degrade to a miss instead of rejecting into a render', async () => {
    await expect(getCachedDirList(null, '/repo')).resolves.toBeNull();
    await expect(getCachedDirListsBulk(null, ['/repo', '/repo/src'])).resolves.toEqual(new Map());
  });

  it('writes and invalidations are no-ops instead of rejecting', async () => {
    await expect(setCachedDirList(null, '/repo', listing(['a.ts']))).resolves.toBeUndefined();
    await expect(deleteCachedDirList(null, '/repo')).resolves.toBeUndefined();
    await expect(deleteCachedDirListsUnder(null, '/repo')).resolves.toBeUndefined();
    await expect(clearCachedDirLists()).resolves.toBeUndefined();
    await expect(pruneCachedDirLists()).resolves.toBeUndefined();
  });
});

/**
 * The `showHidden` decision, pinned in the only place it can be:
 *
 * The cache key is `host + path` and has NO hidden dimension, so one listing per
 * directory is all the store can hold. That is deliberate — `showHidden` is
 * per-mount state that always starts false, so the instant-paint path never runs
 * in hidden mode and a second key scope would buy nothing while doubling every
 * invalidation. The price is that the CALLER must not read or write the cache
 * while hidden files are on, or a hidden-files listing would paint into a
 * hidden-files-off tree (rows for files the user asked not to see). These are the
 * four guards in SessionFileExplorer that hold that up.
 */
describe('dirlist cache: showHidden is a caller-side skip, not a key', () => {
  const src = fs.readFileSync(
    path.resolve(import.meta.dirname, '../../web/src/components/sessions/SessionFileExplorer.tsx'),
    'utf8',
  );

  it('the key is a pure function of host and path', () => {
    expect(dirListKey(null, '/repo/src')).toBe('local /repo/src');
    expect(dirListKey('marina', '/repo/src')).toBe('marina /repo/src');
  });

  it('the per-dir cached paint is gated on !showHidden', () => {
    expect(src).toMatch(/!noCache && !showHidden && !childrenMapRef\.current\.has\(dirPath\)/);
  });

  it('the write-through is gated on !showHidden', () => {
    expect(src).toMatch(/if \(!showHidden\) void setCachedDirList\(/);
  });

  it('the reopen bulk prime is gated on !showHidden', () => {
    expect(src).toMatch(/if \(!showHidden\) \{\s*\n\s*const wanted = \[initialRoot/);
  });

  it('the network fetch is NOT gated on the cache read', () => {
    // The cached paint must never delay or replace the fetch: the cache read is
    // kicked with `void` (no await) and fetchDirList is reached on the same
    // synchronous run. An `await getCachedDirList` above it would be the bug.
    expect(src).toMatch(/void cacheRead\?\.then\(/);
    expect(src).not.toMatch(/await getCachedDirList\(/);
    expect(src).not.toMatch(/await getCachedDirListsBulk\(/);
    // The reopen prime is fire-and-forget too, and the root load runs regardless.
    expect(src).toMatch(/void getCachedDirListsBulk\(host, wanted\)\.then\(/);
  });
});
