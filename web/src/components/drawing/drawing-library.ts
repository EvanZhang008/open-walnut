/**
 * The drawing library (the editor's Library panel), kept on the server so every drawing, surface
 * and device shows the same items:
 *   GET  /api/drawings/library                  -> { revision, libraryItems }
 *   PUT  /api/drawings/library {revision, libraryItems} -> the same; 409 { current } on a stale revision
 *   GET  /api/drawings/library/catalog          -> { items: CatalogItem[] } (the public catalog, proxied)
 *   GET  /api/drawings/library/fetch?source=    -> one library file of that catalog, proxied
 * The server says `drawings:library-updated {revision}` when it changed.
 *
 * One LibraryStore per tab (`tabLibrary`) holds what the editors show; each editor applies its
 * items and hands back what the person did (added a selection, removed an item). A change is
 * saved compare-and-set on the revision it started from; a 409 merges by item id (an item one side
 * added stays, an item one side removed goes), and is saved again on the newer revision.
 *
 * Pure apart from the API object, so tests/web/drawing-library.test.ts drives it with a fake.
 */
import { apiGet, apiPut, ApiError } from '@/api/client';
import { log } from '@/utils/log';

export interface LibraryItem {
  id: string;
  status: 'published' | 'unpublished';
  elements: Array<Record<string, unknown>>;
  created: number;
  name?: string;
  [key: string]: unknown;
}

export interface LibraryState {
  revision: string;
  libraryItems: LibraryItem[];
}

export interface CatalogItem {
  id: string;
  name: string;
  description: string;
  authors: string[];
  /** The library file's path in the catalog: what `fetch` takes. */
  source: string;
  /** A preview image, served through Walnut's server. */
  preview: string;
  updated: string;
  itemNames: string[];
}

/** The library changed on the server since the revision this change started from. */
export class LibraryConflictError extends Error {
  constructor(public current: LibraryState) {
    super('The library was changed somewhere else.');
    this.name = 'LibraryConflictError';
  }
}

export interface DrawingLibraryApi {
  get(): Promise<LibraryState>;
  put(revision: string, libraryItems: LibraryItem[]): Promise<LibraryState>;
  /** `stale`: the site was not reached, and this is the server's last copy. */
  catalog(): Promise<{ items: CatalogItem[]; stale: boolean }>;
  /** The library file for a catalog `source`, as JSON. */
  fetch(source: string): Promise<unknown>;
}

/** The server takes a library up to this size. */
export const LIBRARY_MAX_BYTES = 5 * 1024 * 1024;

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

function asItem(value: unknown, fallbackId: string): LibraryItem | null {
  if (!isRecord(value) || !Array.isArray(value.elements)) return null;
  const elements = value.elements.filter(isRecord);
  if (!elements.length) return null;
  return {
    ...value,
    id: typeof value.id === 'string' && value.id ? value.id : fallbackId,
    status: value.status === 'unpublished' ? 'unpublished' : 'published',
    elements,
    created: typeof value.created === 'number' ? value.created : 0,
    ...(typeof value.name === 'string' && value.name ? { name: value.name } : {}),
  };
}

/** The valid items of a list (a server answer, the editor's report). */
export function parseLibraryItems(value: unknown): LibraryItem[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((v, i) => { const item = asItem(v, `item-${i}`); return item ? [item] : []; });
}

function asState(value: unknown): LibraryState {
  const v = isRecord(value) ? (isRecord(value.current) ? value.current : value) : {};
  return { revision: typeof v.revision === 'string' || typeof v.revision === 'number' ? String(v.revision) : '', libraryItems: parseLibraryItems(v.libraryItems) };
}

/**
 * The items of a library file (`.excalidrawlib`): version 2 lists `libraryItems`, version 1 lists
 * `library` (one array of elements per item). Ids of version 1 items come from `source`, so adding
 * the same file twice gives the same items.
 */
export function itemsFromLibraryFile(file: unknown, source = 'library'): LibraryItem[] {
  if (!isRecord(file)) return [];
  if (Array.isArray(file.libraryItems)) return parseLibraryItems(file.libraryItems);
  if (Array.isArray(file.library)) {
    return file.library.flatMap((elements, i) => {
      const item = asItem({ elements, status: 'published', created: 0 }, `${source}#${i}`);
      return item ? [item] : [];
    });
  }
  return [];
}

/**
 * Equal for the same items in the same order. The editor's library never edits an item's shapes
 * (it adds, removes and names whole items), and it restores what it is given with its own
 * defaults, so the shapes count by number, not by every field.
 */
export function libraryFingerprint(items: readonly LibraryItem[]): string {
  return items.map((i) => `${i.id}:${i.status}:${i.name ?? ''}:${i.elements.length}`).join('|');
}

/**
 * Both sides' changes since `base`, by item id: an item either side added is kept, an item either
 * side removed goes, an item both have is mine. Mine keep their order; their new items go first,
 * where the editor puts what was just added.
 */
export function mergeLibraries(base: readonly LibraryItem[], mine: readonly LibraryItem[], theirs: readonly LibraryItem[]): LibraryItem[] {
  const inBase = new Set(base.map((i) => i.id));
  const inMine = new Set(mine.map((i) => i.id));
  const inTheirs = new Set(theirs.map((i) => i.id));
  const added = theirs.filter((i) => !inMine.has(i.id) && !inBase.has(i.id));
  const kept = mine.filter((i) => inTheirs.has(i.id) || !inBase.has(i.id));
  return [...added, ...kept];
}

/** `add` first, then what was there; an item already there by id is not added twice. */
export function withAddedItems(current: readonly LibraryItem[], add: readonly LibraryItem[]): LibraryItem[] {
  const have = new Set(current.map((i) => i.id));
  const fresh = add.filter((i, n) => !have.has(i.id) && add.findIndex((j) => j.id === i.id) === n);
  return [...fresh, ...current];
}

const CATALOG_HOST = 'libraries.excalidraw.com';

/**
 * A library the public catalog sent back in the address (`#addLibrary=<url>`, the editor's own
 * way back from the catalog site). Null when the address has no `addLibrary` key; otherwise the
 * address to keep (without the catalog's `addLibrary` and `token` keys, so the key is read once
 * and a bad one never comes back on reload) and the catalog source, which is null when the value
 * names another site or does not decode. Only the catalog's own `/libraries/<source>` is taken.
 */
export function takeAddLibrary(hash: string): { source: string | null; rest: string } | null {
  const params = new URLSearchParams(hash.replace(/^#/, ''));
  const raw = params.get('addLibrary');
  if (raw === null) return null;
  params.delete('addLibrary');
  params.delete('token');
  const kept = params.toString();
  return { source: catalogSource(raw), rest: kept ? `#${kept}` : '' };
}

function catalogSource(raw: string): string | null {
  try {
    const url = new URL(decodeURIComponent(raw));
    if (url.protocol !== 'https:' || url.hostname !== CATALOG_HOST || !url.pathname.startsWith('/libraries/')) return null;
    const source = decodeURIComponent(url.pathname.slice('/libraries/'.length));
    return source && !source.split('/').includes('..') ? source : null;
  } catch {
    return null; // a crafted value that does not decode is ignored
  }
}

function parseCatalog(value: unknown): CatalogItem[] {
  const rows = isRecord(value) && Array.isArray(value.items) ? value.items : [];
  return rows.flatMap((row): CatalogItem[] => {
    if (!isRecord(row) || typeof row.source !== 'string' || !row.source) return [];
    const authors = Array.isArray(row.authors)
      ? row.authors.flatMap((a) => (typeof a === 'string' ? [a] : isRecord(a) && typeof a.name === 'string' ? [a.name] : []))
      : [];
    return [{
      id: typeof row.id === 'string' && row.id ? row.id : row.source,
      name: typeof row.name === 'string' && row.name.trim() ? row.name : row.source,
      description: typeof row.description === 'string' ? row.description : '',
      authors,
      source: row.source,
      preview: typeof row.preview === 'string' ? row.preview : '',
      updated: typeof row.updated === 'string' ? row.updated : typeof row.created === 'string' ? row.created : '',
      itemNames: Array.isArray(row.itemNames) ? row.itemNames.filter((n): n is string => typeof n === 'string') : [],
    }];
  });
}

/** The catalog items whose name, description, authors or item names hold every word typed. */
export function searchCatalog(items: readonly CatalogItem[], query: string): CatalogItem[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [...items];
  return items.filter((item) => {
    const text = [item.name, item.description, ...item.authors, ...item.itemNames].join(' ').toLowerCase();
    return words.every((w) => text.includes(w));
  });
}

export const drawingLibraryApi: DrawingLibraryApi = {
  async get() {
    return asState(await apiGet<unknown>('/api/drawings/library'));
  },
  async put(revision, libraryItems) {
    try {
      return asState(await apiPut<unknown>('/api/drawings/library', { revision, libraryItems }));
    } catch (err) {
      if (err instanceof ApiError && err.status === 409 && isRecord(err.body) && isRecord(err.body.current)) throw new LibraryConflictError(asState(err.body.current));
      throw err;
    }
  },
  async catalog() {
    const value = await apiGet<unknown>('/api/drawings/library/catalog', undefined, { timeoutMs: 20_000 });
    return { items: parseCatalog(value), stale: isRecord(value) && value.stale === true };
  },
  async fetch(source) {
    return apiGet<unknown>('/api/drawings/library/fetch', { source }, { timeoutMs: 20_000 });
  },
};

const RETRY_MS = [2_000, 5_000, 15_000, 30_000];
/** Answers saving again cannot change. */
const REFUSED = new Set([400, 403, 413, 422]);

export interface LibraryStoreOptions {
  /** How long after a change it is saved (a few quick removals go as one). */
  delayMs?: number;
}

/** What the editors of one tab show, and its way to the server. */
export class LibraryStore {
  private revision: string | null = null;
  /** What the server holds at `revision`. */
  private server: LibraryItem[] = [];
  /** What the editors show: the server's, with the changes not saved yet. */
  private current: LibraryItem[] = [];
  private currentFp = '';
  private pending = false;
  private loading: Promise<void> | null = null;
  private pushing: Promise<void> | null = null;
  private pushAgain = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private retries = 0;
  private readonly listeners = new Set<(items: LibraryItem[]) => void>();
  /** Why the last save did not go through (shown in the library dialog); null when saved. */
  error: string | null = null;

  constructor(private readonly api: DrawingLibraryApi, private readonly opts: LibraryStoreOptions = {}) {}

  items(): LibraryItem[] { return this.current; }
  isLoaded(): boolean { return this.revision !== null; }
  isSaved(): boolean { return !this.pending; }

  subscribe(fn: (items: LibraryItem[]) => void): () => void {
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  }

  private show(items: LibraryItem[]): void {
    const fp = libraryFingerprint(items);
    this.current = items;
    if (fp === this.currentFp) return;
    this.currentFp = fp;
    for (const fn of [...this.listeners]) {
      try { fn(items); } catch (err) { log.warn('drawing', 'a library listener failed', { error: String(err) }); }
    }
  }

  /** Read the server's library (once; `force` reads again). Changes made before it arrived are kept. */
  load(force = false): Promise<void> {
    if (this.loading) return this.loading;
    if (this.isLoaded() && !force) return Promise.resolve();
    const run = (async () => {
      try {
        const state = await this.api.get();
        const base = this.server;
        this.server = state.libraryItems;
        this.revision = state.revision;
        if (this.pending) {
          this.show(mergeLibraries(base, this.current, state.libraryItems));
          this.schedule(0);
        } else {
          this.show(state.libraryItems);
        }
      } catch (err) {
        log.warn('drawing', 'the drawing library could not be read', { error: String(err) });
        this.error = 'The library could not be read. It is tried again when a drawing opens.';
      } finally {
        this.loading = null;
      }
    })();
    this.loading = run;
    return run;
  }

  /** An editor's library changed (the person added or removed items). */
  edited(items: LibraryItem[]): void {
    if (libraryFingerprint(items) === this.currentFp) return;
    // Before the server answered, an editor's empty start is not a removal of everything.
    if (!this.isLoaded() && !items.length) return;
    this.pending = true;
    this.show(items);
    this.schedule();
  }

  /** Items from the catalog (or a library sent back in the address), first in the list. */
  add(items: LibraryItem[]): number {
    const next = withAddedItems(this.current, items);
    const added = next.length - this.current.length;
    if (!added) return 0;
    this.pending = true;
    this.show(next);
    this.schedule(0);
    return added;
  }

  /** The server says the library changed: read it, unless a change here is on its way (its save merges). */
  remoteUpdated(revision: unknown): void {
    if (typeof revision === 'string' && revision === this.revision) return;
    if (this.pending || this.pushing) return;
    void this.load(true);
  }

  private schedule(delay = this.opts.delayMs ?? 400): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => { this.timer = undefined; void this.push(); }, delay);
  }

  /** Save now; resolves when what is shown is on the server or the save stopped. */
  push(): Promise<void> {
    if (this.pushing) { this.pushAgain = true; return this.pushing; }
    const run = this.pushLoop().finally(() => {
      this.pushing = null;
      if (this.pushAgain) { this.pushAgain = false; void this.push(); }
    });
    this.pushing = run;
    return run;
  }

  private async pushLoop(): Promise<void> {
    clearTimeout(this.timer);
    this.timer = undefined;
    if (!this.isLoaded()) await this.load();
    if (!this.isLoaded()) { this.retryLater(); return; }
    // A few rounds at most: each 409 merges once and saves on the newer revision.
    for (let round = 0; round < 4 && this.pending; round++) {
      const sent = this.current;
      const sentFp = this.currentFp;
      if (JSON.stringify(sent).length > LIBRARY_MAX_BYTES) {
        this.error = 'The library is larger than 5 MB, so this change is not saved. Remove an item to save it.';
        return;
      }
      try {
        const state = await this.api.put(this.revision!, sent);
        this.server = state.libraryItems;
        this.revision = state.revision;
        this.retries = 0;
        this.error = null;
        if (this.currentFp === sentFp) {
          this.pending = false;
          this.show(state.libraryItems);
        }
      } catch (err) {
        if (err instanceof LibraryConflictError) {
          const base = this.server;
          this.server = err.current.libraryItems;
          this.revision = err.current.revision;
          this.show(mergeLibraries(base, this.current, err.current.libraryItems));
          continue;
        }
        if (err instanceof ApiError && REFUSED.has(err.status)) {
          this.error = `The library change was not saved: ${err.message}`;
          return;
        }
        this.error = 'The library change is not saved yet. Retrying.';
        this.retryLater();
        return;
      }
    }
    if (this.pending) this.retryLater();
  }

  private retryLater(): void {
    const delay = RETRY_MS[Math.min(this.retries, RETRY_MS.length - 1)];
    this.retries++;
    this.schedule(delay);
  }
}

/** The library of this tab, shared by every editor in it. */
export const tabLibrary = new LibraryStore(drawingLibraryApi);

/**
 * Add one catalog library to the tab's library (saved to the server from there). Resolves with
 * how many items were new; throws when the file could not be fetched or held no items.
 */
export async function addCatalogLibrary(source: string, store: LibraryStore = tabLibrary, api: DrawingLibraryApi = drawingLibraryApi): Promise<number> {
  const file = await api.fetch(source);
  const items = itemsFromLibraryFile(file, source);
  if (!items.length) throw new Error('That library has no items this editor can read.');
  await store.load();
  return store.add(items);
}
