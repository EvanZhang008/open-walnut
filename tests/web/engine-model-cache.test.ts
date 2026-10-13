import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EngineModelCatalog } from '../../web/src/api/engine-model-cache';

class FakeStorage {
  private values = new Map<string, string>();
  getItem(key: string): string | null { return this.values.get(key) ?? null; }
  setItem(key: string, value: string): void { this.values.set(key, value); }
  removeItem(key: string): void { this.values.delete(key); }
}

function catalog(engine = 'codex', modelId = 'model-a'): EngineModelCatalog {
  return {
    engine,
    source: 'probe',
    models: [{ modelId, name: 'Model A', description: 'Primary model', groupId: 'provider', groupName: 'Provider' }],
    currentModelId: modelId,
  };
}

type CacheModule = typeof import('../../web/src/api/engine-model-cache');
let cache: CacheModule;
let storage: FakeStorage;
const NOW = 1_800_000_000_000;

beforeEach(async () => {
  vi.resetModules();
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  storage = new FakeStorage();
  vi.stubGlobal('localStorage', storage);
  cache = await import('../../web/src/api/engine-model-cache');
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function persistedEntries(): Array<{ cwd?: string; catalog: EngineModelCatalog; fetchedAt: number }> {
  return JSON.parse(storage.getItem(cache.ENGINE_MODEL_CACHE_STORAGE_KEY)!).entries;
}

function seedPersistence(entries: unknown[]): void {
  storage.setItem(cache.ENGINE_MODEL_CACHE_STORAGE_KEY, JSON.stringify({ version: 1, entries }));
}

describe('engine model catalog cache', () => {
  it('is cold until an authoritative catalog is recorded', () => {
    expect(cache.getCachedEngineModelCatalog('codex', '/workspace/alpha')).toBeNull();
    expect(cache.getFreshEngineModelCatalog('codex', '/workspace/alpha')).toBeNull();
    cache.recordEngineModelCatalog('codex', '/workspace/alpha', catalog());
    expect(cache.getCachedEngineModelCatalog('codex', '/workspace/alpha')).toEqual(catalog());
    expect(persistedEntries()).toEqual([{ cwd: '/workspace/alpha', catalog: catalog(), fetchedAt: NOW }]);
  });

  it('isolates exact engines and working directories without normalizing them', () => {
    cache.recordEngineModelCatalog('codex', '/workspace/alpha', catalog());
    cache.recordEngineModelCatalog('opencode', '/workspace/alpha', catalog('opencode', 'model-b'));
    cache.recordEngineModelCatalog('codex', '/workspace/beta', catalog('codex', 'model-c'));
    expect(cache.getCachedEngineModelCatalog('codex', '/workspace/alpha')?.currentModelId).toBe('model-a');
    expect(cache.getCachedEngineModelCatalog('opencode', '/workspace/alpha')?.currentModelId).toBe('model-b');
    expect(cache.getCachedEngineModelCatalog('codex', '/workspace/beta')?.currentModelId).toBe('model-c');
    for (const cwd of [undefined, '', '/workspace/alpha/', ' /workspace/alpha']) {
      expect(cache.getCachedEngineModelCatalog('codex', cwd)).toBeNull();
    }
    expect(cache.getCachedEngineModelCatalog('Codex', '/workspace/alpha')).toBeNull();
  });

  it('keeps omitted and empty working directories distinct across reloads', async () => {
    cache.recordEngineModelCatalog('codex', undefined, catalog());
    cache.recordEngineModelCatalog('codex', '', catalog('codex', 'model-b'));
    vi.resetModules();
    const reloaded = await import('../../web/src/api/engine-model-cache');
    expect(reloaded.getCachedEngineModelCatalog('codex')?.currentModelId).toBe('model-a');
    expect(reloaded.getCachedEngineModelCatalog('codex', '')?.currentModelId).toBe('model-b');
  });

  it('reuses a catalog for less than thirty seconds but keeps stale rows readable', () => {
    cache.recordEngineModelCatalog('codex', '/workspace/alpha', catalog());
    vi.setSystemTime(NOW + 29_999);
    expect(cache.getFreshEngineModelCatalog('codex', '/workspace/alpha')).toEqual(catalog());
    vi.setSystemTime(NOW + 30_000);
    expect(cache.getFreshEngineModelCatalog('codex', '/workspace/alpha')).toBeNull();
    expect(cache.getCachedEngineModelCatalog('codex', '/workspace/alpha')).toEqual(catalog());
    vi.setSystemTime(NOW + 86_400_000);
    expect(cache.getCachedEngineModelCatalog('codex', '/workspace/alpha')).toEqual(catalog());
  });

  it('restores the original freshness deadline from persistence', async () => {
    cache.recordEngineModelCatalog('codex', '/workspace/alpha', catalog());
    vi.setSystemTime(NOW + 20_000);
    vi.resetModules();
    const reloaded = await import('../../web/src/api/engine-model-cache');
    expect(reloaded.getFreshEngineModelCatalog('codex', '/workspace/alpha')).toEqual(catalog());
    vi.setSystemTime(NOW + 30_000);
    expect(reloaded.getFreshEngineModelCatalog('codex', '/workspace/alpha')).toBeNull();
    expect(reloaded.getCachedEngineModelCatalog('codex', '/workspace/alpha')).toEqual(catalog());
  });

  it('does not treat a future timestamp as fresh after the clock moves backwards', () => {
    cache.recordEngineModelCatalog('codex', '/workspace/alpha', catalog());
    vi.setSystemTime(NOW - 1);
    expect(cache.getFreshEngineModelCatalog('codex', '/workspace/alpha')).toBeNull();
    expect(cache.getCachedEngineModelCatalog('codex', '/workspace/alpha')).toEqual(catalog());
  });

  it.each([
    null,
    {},
    { ...catalog(), engine: 'opencode' },
    { ...catalog(), models: [] },
    { ...catalog(), models: [{ modelId: 'model-a' }] },
    { ...catalog(), models: [{ modelId: ' ', name: 'Model A' }] },
    { ...catalog(), models: [{ modelId: 'model-a', name: '' }] },
    { ...catalog(), models: [{ modelId: 'model-a', name: 'Model A', groupId: 1 }] },
    { ...catalog(), models: [...catalog().models, null] },
    { ...catalog(), currentModelId: 1 },
    { ...catalog(), source: 'mock' },
    { ...catalog(), source: 'acp' },
  ])('rejects invalid or non-probe responses without overwriting a good catalog: %j', (invalid) => {
    cache.recordEngineModelCatalog('codex', '/workspace/alpha', catalog());
    const before = storage.getItem(cache.ENGINE_MODEL_CACHE_STORAGE_KEY);
    vi.setSystemTime(NOW + 30_000);
    cache.recordEngineModelCatalog('codex', '/workspace/alpha', invalid);
    expect(cache.getCachedEngineModelCatalog('codex', '/workspace/alpha')).toEqual(catalog());
    expect(cache.getFreshEngineModelCatalog('codex', '/workspace/alpha')).toBeNull();
    expect(storage.getItem(cache.ENGINE_MODEL_CACHE_STORAGE_KEY)).toBe(before);
  });

  it('preserves the last good rows and deadline when a request fails', async () => {
    cache.recordEngineModelCatalog('codex', '/workspace/alpha', catalog());
    vi.setSystemTime(NOW + 30_000);
    const before = storage.getItem(cache.ENGINE_MODEL_CACHE_STORAGE_KEY);
    const failed = Promise.reject(new Error('Catalog request timed out'))
      .then((value) => cache.recordEngineModelCatalog('codex', '/workspace/alpha', value));
    await expect(failed).rejects.toThrow('Catalog request timed out');
    expect(cache.getCachedEngineModelCatalog('codex', '/workspace/alpha')).toEqual(catalog());
    expect(cache.getFreshEngineModelCatalog('codex', '/workspace/alpha')).toBeNull();
    expect(storage.getItem(cache.ENGINE_MODEL_CACHE_STORAGE_KEY)).toBe(before);
    cache.recordEngineModelCatalog('codex', '/workspace/alpha', catalog('codex', 'model-b'));
    expect(cache.getFreshEngineModelCatalog('codex', '/workspace/alpha')?.currentModelId).toBe('model-b');
  });

  it.each([
    'not json',
    'null',
    '{}',
    '[]',
    JSON.stringify({ version: 2, entries: [] }),
    JSON.stringify({ version: 1, entries: {} }),
  ])('ignores malformed persistence: %s', (text) => {
    storage.setItem(cache.ENGINE_MODEL_CACHE_STORAGE_KEY, text);
    expect(cache.getCachedEngineModelCatalog('codex', '/workspace/alpha')).toBeNull();
  });

  it('rejects empty, malformed, non-probe and future persisted entries', () => {
    const entry = { cwd: '/workspace/alpha', catalog: catalog(), fetchedAt: NOW };
    seedPersistence([
      null,
      { ...entry, cwd: 1 },
      { ...entry, fetchedAt: 'today' },
      { ...entry, fetchedAt: -1 },
      { ...entry, fetchedAt: NOW + 1 },
      { ...entry, catalog: { ...catalog(), models: [] } },
      { ...entry, catalog: { ...catalog(), models: [{ modelId: 'model-a', name: 1 }] } },
      { ...entry, catalog: { ...catalog(), source: 'mock' } },
      { ...entry, catalog: { ...catalog(), source: 'acp' } },
    ]);
    expect(cache.getCachedEngineModelCatalog('codex', '/workspace/alpha')).toBeNull();
    expect(cache.getFreshEngineModelCatalog('codex', '/workspace/alpha')).toBeNull();
  });

  it('loads valid persisted entries beside rejected ones', () => {
    seedPersistence([
      { cwd: '/workspace/alpha', catalog: catalog(), fetchedAt: NOW - 30_000 },
      { cwd: '/workspace/beta', catalog: { ...catalog(), models: [] }, fetchedAt: NOW },
    ]);
    expect(cache.getCachedEngineModelCatalog('codex', '/workspace/alpha')).toEqual(catalog());
    expect(cache.getFreshEngineModelCatalog('codex', '/workspace/alpha')).toBeNull();
    expect(cache.getCachedEngineModelCatalog('codex', '/workspace/beta')).toBeNull();
  });

  it('evicts the oldest recorded entry at thirty-two and moves refreshed entries to the end', () => {
    for (let index = 0; index < 32; index++) {
      cache.recordEngineModelCatalog('codex', `/workspace/project-${index}`, catalog());
    }
    cache.recordEngineModelCatalog('codex', '/workspace/project-0', catalog('codex', 'model-b'));
    cache.recordEngineModelCatalog('codex', '/workspace/project-32', catalog());
    expect(cache.getCachedEngineModelCatalog('codex', '/workspace/project-1')).toBeNull();
    expect(cache.getCachedEngineModelCatalog('codex', '/workspace/project-0')?.currentModelId).toBe('model-b');
    expect(cache.getCachedEngineModelCatalog('codex', '/workspace/project-32')).toEqual(catalog());
    expect(persistedEntries()).toHaveLength(32);
    expect(persistedEntries().map((entry) => entry.cwd)).not.toContain('/workspace/project-1');
  });

  it('bounds persisted catalogs to the thirty-two newest timestamps', () => {
    seedPersistence(Array.from({ length: 35 }, (_, index) => ({
      cwd: `/workspace/project-${index}`,
      catalog: catalog(),
      fetchedAt: NOW - index,
    })));
    expect(cache.getCachedEngineModelCatalog('codex', '/workspace/project-0')).toEqual(catalog());
    expect(cache.getCachedEngineModelCatalog('codex', '/workspace/project-31')).toEqual(catalog());
    expect(cache.getCachedEngineModelCatalog('codex', '/workspace/project-32')).toBeNull();
    cache.recordEngineModelCatalog('opencode', '/workspace/alpha', catalog('opencode'));
    expect(persistedEntries()).toHaveLength(32);
    expect(cache.getCachedEngineModelCatalog('codex', '/workspace/project-31')).toBeNull();
  });

  it('clears persistent rows and refuses requests started before invalidation', async () => {
    cache.recordEngineModelCatalog('codex', '/workspace/alpha', catalog());
    const oldGeneration = cache.getEngineModelCacheGeneration();
    cache.clearEngineModelCatalogCache();
    expect(storage.getItem(cache.ENGINE_MODEL_CACHE_STORAGE_KEY)).toBeNull();
    expect(cache.getCachedEngineModelCatalog('codex', '/workspace/alpha')).toBeNull();
    cache.recordEngineModelCatalog('codex', '/workspace/alpha', catalog(), oldGeneration);
    expect(cache.getCachedEngineModelCatalog('codex', '/workspace/alpha')).toBeNull();
    vi.resetModules();
    const reloaded = await import('../../web/src/api/engine-model-cache');
    expect(reloaded.getCachedEngineModelCatalog('codex', '/workspace/alpha')).toBeNull();
    cache.recordEngineModelCatalog('codex', '/workspace/alpha', catalog('codex', 'model-b'));
    expect(cache.getFreshEngineModelCatalog('codex', '/workspace/alpha')?.currentModelId).toBe('model-b');
  });

  it.each(['ui', 'focus_bar', 'ordering', 'favorites', 'focus_tiers'])('ignores changes to the unrelated config key %s', (key) => {
    cache.recordEngineModelCatalog('codex', '/workspace/alpha', catalog());
    expect(cache.shouldInvalidateEngineCatalog({ key })).toBe(false);
    expect(cache.shouldInvalidateEngineCatalog({ key, config: { engines: { codex: { enabled: false } } } })).toBe(false);
    expect(cache.getFreshEngineModelCatalog('codex', '/workspace/alpha')).toEqual(catalog());
  });

  it('compares only engines across full config events', () => {
    const engines = { codex: { enabled: true, env: { MODEL_PROFILE: 'primary' } } };
    expect(cache.shouldInvalidateEngineCatalog({ config: { engines, ui: { session_panels: 2 } } })).toBe(true);
    expect(cache.shouldInvalidateEngineCatalog({ config: { engines: structuredClone(engines), ui: { session_panels: 4 } } })).toBe(false);
    expect(cache.shouldInvalidateEngineCatalog({ config: { engines, ordering: ['alpha', 'beta'] } })).toBe(false);
    expect(cache.shouldInvalidateEngineCatalog({ config: { engines: { codex: { enabled: false } } } })).toBe(true);
    expect(cache.shouldInvalidateEngineCatalog({ config: { engines: { codex: { enabled: false } }, ui: {} } })).toBe(false);
  });

  it('detects engine removal and handles full configs without explicit engines', () => {
    expect(cache.shouldInvalidateEngineCatalog({ config: { ui: {} } })).toBe(true);
    expect(cache.shouldInvalidateEngineCatalog({ config: { ui: { session_panels: 4 } } })).toBe(false);
    expect(cache.shouldInvalidateEngineCatalog({ config: { engines: { codex: { enabled: true } } } })).toBe(true);
    expect(cache.shouldInvalidateEngineCatalog({ config: { ui: {} } })).toBe(true);
    expect(cache.shouldInvalidateEngineCatalog({ config: { ui: {} } })).toBe(false);
  });

  it('invalidates explicit engine edits and compares subsequent full events again', () => {
    const engines = { codex: { enabled: true } };
    expect(cache.shouldInvalidateEngineCatalog({ config: { engines } })).toBe(true);
    expect(cache.shouldInvalidateEngineCatalog({ config: { engines } })).toBe(false);
    expect(cache.shouldInvalidateEngineCatalog({ key: 'engines' })).toBe(true);
    expect(cache.shouldInvalidateEngineCatalog({ config: { engines } })).toBe(true);
    expect(cache.shouldInvalidateEngineCatalog({ config: { engines } })).toBe(false);
  });

  it.each([null, undefined, {}, { config: null }, { config: 'invalid' }])('ignores config events without a key or config: %j', (event) => {
    expect(cache.shouldInvalidateEngineCatalog(event)).toBe(false);
  });

  it('never persists engine configuration signatures', () => {
    const engines = { codex: { env: { API_TOKEN: 'fixture-token' } } };
    expect(cache.shouldInvalidateEngineCatalog({ config: { engines } })).toBe(true);
    cache.recordEngineModelCatalog('codex', '/workspace/alpha', catalog());
    const persisted = storage.getItem(cache.ENGINE_MODEL_CACHE_STORAGE_KEY)!;
    expect(persisted).not.toContain('fixture-token');
    expect(persisted).not.toContain('API_TOKEN');
    expect(cache.shouldInvalidateEngineCatalog({ config: { engines } })).toBe(false);
  });

  it('notifies once after a config invalidation, with the new generation and cleared rows', () => {
    cache.recordEngineModelCatalog('codex', '/workspace/alpha', catalog());
    const generation = cache.getEngineModelCacheGeneration();
    const listener = vi.fn(() => ({
      generation: cache.getEngineModelCacheGeneration(),
      catalog: cache.getCachedEngineModelCatalog('codex', '/workspace/alpha'),
      persisted: storage.getItem(cache.ENGINE_MODEL_CACHE_STORAGE_KEY),
    }));
    cache.subscribeEngineModelCache(listener);
    const engines = { codex: { enabled: true } };
    if (cache.shouldInvalidateEngineCatalog({ config: { engines } })) cache.clearEngineModelCatalogCache();
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener.mock.results[0].value).toEqual({ generation: generation + 1, catalog: null, persisted: null });
    if (cache.shouldInvalidateEngineCatalog({ config: { engines } })) cache.clearEngineModelCatalogCache();
    expect(listener).toHaveBeenCalledTimes(1);
    cache.recordEngineModelCatalog('codex', '/workspace/alpha', catalog());
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('unsubscribes cache invalidation listeners without disturbing others', () => {
    const removed = vi.fn();
    const active = vi.fn();
    const unsubscribe = cache.subscribeEngineModelCache(removed);
    cache.subscribeEngineModelCache(active);
    unsubscribe();
    cache.clearEngineModelCatalogCache();
    cache.clearEngineModelCatalogCache();
    expect(removed).not.toHaveBeenCalled();
    expect(active).toHaveBeenCalledTimes(2);
  });

  it('keeps in-memory catalogs usable when localStorage is blocked', () => {
    vi.spyOn(storage, 'getItem').mockImplementation(() => { throw new Error('Storage blocked'); });
    vi.spyOn(storage, 'setItem').mockImplementation(() => { throw new Error('Storage blocked'); });
    vi.spyOn(storage, 'removeItem').mockImplementation(() => { throw new Error('Storage blocked'); });
    cache.recordEngineModelCatalog('codex', '/workspace/alpha', catalog());
    expect(cache.getFreshEngineModelCatalog('codex', '/workspace/alpha')).toEqual(catalog());
    cache.clearEngineModelCatalogCache();
    expect(cache.getCachedEngineModelCatalog('codex', '/workspace/alpha')).toBeNull();
  });
});
