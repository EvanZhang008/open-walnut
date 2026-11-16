/**
 * The drawing library (web/src/components/drawing/drawing-library.ts): one store per tab that the
 * editors show and the server keeps. Pinned: a change is saved compare-and-set; a 409 merges by
 * item id and saves again on the newer revision; an editor's empty start before the server answered
 * removes nothing; a catalog library adds its items once; only the catalog's own address is taken
 * back from `#addLibrary=`.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ApiError } from '../../web/src/api/client';
import {
  LibraryConflictError, LibraryStore, addCatalogLibrary, itemsFromLibraryFile,
  libraryFingerprint, mergeLibraries, searchCatalog, takeAddLibrary, type CatalogItem, type DrawingLibraryApi, type LibraryItem,
} from '../../web/src/components/drawing/drawing-library';

vi.mock('@/utils/log', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

const item = (id: string, shapes = 1): LibraryItem => ({
  id, status: 'published', created: 1, elements: Array.from({ length: shapes }, (_, i) => ({ id: `${id}-${i}`, type: 'rectangle' })),
});
const ids = (items: readonly LibraryItem[]) => items.map((i) => i.id);
const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v));

class FakeLibrary implements DrawingLibraryApi {
  revision = 1;
  items: LibraryItem[] = [];
  puts: Array<{ revision: string; ids: string[] }> = [];
  failPut: unknown[] = [];
  files = new Map<string, unknown>();
  async get() { return { revision: `v${this.revision}`, libraryItems: clone(this.items) }; }
  async put(revision: string, libraryItems: LibraryItem[]) {
    this.puts.push({ revision, ids: ids(libraryItems) });
    const failure = this.failPut.shift();
    if (failure) throw failure;
    if (revision !== `v${this.revision}`) throw new LibraryConflictError({ revision: `v${this.revision}`, libraryItems: clone(this.items) });
    this.items = clone(libraryItems);
    this.revision++;
    return { revision: `v${this.revision}`, libraryItems: clone(this.items) };
  }
  /** Another device saved. */
  elsewhere(items: LibraryItem[]) { this.items = clone(items); this.revision++; }
  async catalog() { return { items: [] as CatalogItem[], stale: false }; }
  async fetch(source: string) {
    if (!this.files.has(source)) throw new ApiError(404, 'Not found');
    return clone(this.files.get(source));
  }
}

async function settle() { for (let i = 0; i < 20; i++) await Promise.resolve(); }
async function tick(ms: number) { await vi.advanceTimersByTimeAsync(ms); await settle(); }

let api: FakeLibrary;
let store: LibraryStore;
beforeEach(() => {
  vi.useFakeTimers();
  api = new FakeLibrary();
  store = new LibraryStore(api, { delayMs: 100 });
});
afterEach(() => { vi.useRealTimers(); });

describe('mergeLibraries', () => {
  it('keeps what either side added and drops what either side removed', () => {
    const base = [item('a'), item('b'), item('c')];
    const mine = [item('m'), item('a'), item('b')];        // added m, removed c
    const theirs = [item('t'), item('a'), item('c')];      // added t, removed b
    expect(ids(mergeLibraries(base, mine, theirs))).toEqual(['t', 'm', 'a']);
  });
});

describe('the tab library', () => {
  it('loads once, and an editor handing back what it was shown saves nothing', async () => {
    api.items = [item('a')];
    await store.load();
    await store.load();
    expect(ids(store.items())).toEqual(['a']);
    store.edited(clone(store.items()));
    await tick(500);
    expect(api.puts).toHaveLength(0);
  });

  it('saves a change compare-and-set on the revision it started from, and tells the editors', async () => {
    api.items = [item('a')];
    await store.load();
    const shown: string[][] = [];
    store.subscribe((items) => shown.push(ids(items)));
    store.edited([item('new'), item('a')]);
    await tick(200);
    expect(api.puts).toEqual([{ revision: 'v1', ids: ['new', 'a'] }]);
    expect(store.isSaved()).toBe(true);
    expect(shown).toEqual([['new', 'a']]);
  });

  it('a 409 merges both sides by id and saves again on the newer revision', async () => {
    api.items = [item('a'), item('b')];
    await store.load();
    api.elsewhere([item('theirs'), item('a'), item('b')]);
    store.edited([item('mine'), item('a')]); // added mine, removed b
    await tick(200);
    expect(api.puts.map((p) => p.revision)).toEqual(['v1', 'v2']);
    expect(ids(api.items)).toEqual(['theirs', 'mine', 'a']);
    expect(ids(store.items())).toEqual(['theirs', 'mine', 'a']);
  });

  it("an editor's empty start before the server answered removes nothing; an add made then is kept", async () => {
    api.items = [item('a'), item('b')];
    store.edited([]);
    store.edited([item('early')]);
    await tick(200);
    expect(ids(api.items).sort()).toEqual(['a', 'b', 'early']);
  });

  it('a network failure keeps the change and saves it later; a refused one says why', async () => {
    await store.load();
    api.failPut = [new TypeError('Failed to fetch')];
    store.edited([item('x')]);
    await tick(200);
    expect(store.isSaved()).toBe(false);
    expect(store.error).toMatch(/Retrying/);
    await tick(2_100);
    expect(ids(api.items)).toEqual(['x']);
    expect(store.error).toBeNull();

    api.failPut = [new ApiError(413, 'Too large')];
    store.edited([item('y'), item('x')]);
    await tick(200);
    expect(store.error).toMatch(/not saved: Too large/);
  });

  it('reads again when the server says it changed, unless a change here is on its way', async () => {
    await store.load();
    api.elsewhere([item('remote')]);
    store.remoteUpdated('v2');
    await tick(10);
    expect(ids(store.items())).toEqual(['remote']);
    store.remoteUpdated('v2');
    await tick(10);
    expect(api.puts).toHaveLength(0);
  });
});

describe('catalog libraries', () => {
  it('reads both library file versions, with stable ids for version 1', () => {
    expect(ids(itemsFromLibraryFile({ type: 'excalidrawlib', version: 2, libraryItems: [item('v2a'), { id: 'bad' }] }))).toEqual(['v2a']);
    const v1 = itemsFromLibraryFile({ type: 'excalidrawlib', version: 1, library: [[{ id: 'e', type: 'rectangle' }], []] }, 'ann/boxes.excalidrawlib');
    expect(ids(v1)).toEqual(['ann/boxes.excalidrawlib#0']);
  });

  it('adds a library once, saved on the server', async () => {
    api.files.set('ann/boxes.excalidrawlib', { type: 'excalidrawlib', version: 2, libraryItems: [item('b1'), item('b2')] });
    expect(await addCatalogLibrary('ann/boxes.excalidrawlib', store, api)).toBe(2);
    expect(await addCatalogLibrary('ann/boxes.excalidrawlib', store, api)).toBe(0);
    await tick(200);
    expect(ids(api.items)).toEqual(['b1', 'b2']);
    await expect(addCatalogLibrary('missing.excalidrawlib', store, api)).rejects.toThrow();
  });

  it('takes back only the catalog site’s own library address, and clears it from the address', () => {
    const url = encodeURIComponent('https://libraries.excalidraw.com/libraries/ann/boxes.excalidrawlib');
    expect(takeAddLibrary(`#addLibrary=${url}&token=abc`)).toEqual({ source: 'ann/boxes.excalidrawlib', rest: '' });
    expect(takeAddLibrary(`#addLibrary=${encodeURIComponent('https://evil.example/libraries/x.excalidrawlib')}`)?.source).toBeNull();
    expect(takeAddLibrary(`#addLibrary=${encodeURIComponent('http://libraries.excalidraw.com/libraries/x.excalidrawlib')}`)?.source).toBeNull();
    expect(takeAddLibrary('#open-link=x')).toBeNull();
    expect(takeAddLibrary(`#addLibrary=${url}&token=abc&keep=1`)?.rest).toBe('#keep=1');
  });

  it('ignores a crafted catalog address that does not decode, and still clears it from the address', () => {
    // The catalog path holds a broken escape: the second decode would throw URIError on every reload.
    const crafted = encodeURIComponent(encodeURIComponent('https://libraries.excalidraw.com/libraries/%E0%A4%A'));
    expect(() => takeAddLibrary(`#addLibrary=${crafted}&keep=1`)).not.toThrow();
    expect(takeAddLibrary(`#addLibrary=${crafted}&keep=1`)).toEqual({ source: null, rest: '#keep=1' });
    // A value that is not even one decode deep is dropped the same way.
    expect(takeAddLibrary('#addLibrary=%25E0%25A4%25A')).toEqual({ source: null, rest: '' });
  });

  it('finds catalog entries by every word typed, across name, authors and item names', () => {
    const entry = (name: string, extra: Partial<CatalogItem> = {}): CatalogItem => ({ id: name, name, description: '', authors: [], source: name, preview: '', updated: '', itemNames: [], ...extra });
    const all = [entry('System design', { authors: ['Ann'], itemNames: ['load balancer'] }), entry('Icons'), entry('Cloud', { description: 'servers and databases' })];
    expect(searchCatalog(all, 'balancer ann').map((i) => i.name)).toEqual(['System design']);
    expect(searchCatalog(all, 'DATABASES').map((i) => i.name)).toEqual(['Cloud']);
    expect(searchCatalog(all, '  ')).toHaveLength(3);
  });

  it('a fingerprint ignores the editor’s restored fields but not the items', () => {
    const a = [item('a', 2)];
    const restored = [{ ...a[0], elements: a[0].elements.map((e) => ({ ...e, version: 1, seed: 7 })) }];
    expect(libraryFingerprint(restored)).toBe(libraryFingerprint(a));
    expect(libraryFingerprint([item('a', 3)])).not.toBe(libraryFingerprint(a));
  });
});
