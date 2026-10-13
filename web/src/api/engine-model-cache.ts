import type { CodexModelInfo } from './sessions';

export interface EngineModelCatalog {
  engine: string;
  models: CodexModelInfo[];
  currentModelId?: string;
  source: 'probe' | 'mock';
}

interface CacheEntry {
  cwd?: string;
  catalog: EngineModelCatalog;
  fetchedAt: number;
}

export const ENGINE_MODEL_CACHE_STORAGE_KEY = 'walnut:engine-model-catalogs:v1';
const FETCH_TTL_MS = 30_000;
const MAX_ENTRIES = 32;
const entries = new Map<string, CacheEntry>();
let loaded = false;
let generation = 0;
let engineConfigSignature: string | undefined;
const invalidationListeners = new Set<() => void>();

export function subscribeEngineModelCache(listener: () => void): () => void {
  invalidationListeners.add(listener);
  return () => { invalidationListeners.delete(listener); };
}

export function shouldInvalidateEngineCatalog(event: unknown): boolean {
  if (!event || typeof event !== 'object') return false;
  const raw = event as { key?: unknown; config?: unknown };
  if (typeof raw.key === 'string') {
    if (raw.key !== 'engines') return false;
    engineConfigSignature = undefined;
    return true;
  }
  if (!raw.config || typeof raw.config !== 'object') return false;
  const engines = (raw.config as { engines?: unknown }).engines;
  const signature = JSON.stringify(engines ?? null);
  const changed = signature !== engineConfigSignature;
  engineConfigSignature = signature;
  return changed;
}

function cacheKey(engine: string, cwd?: string): string {
  return JSON.stringify([engine, cwd ?? null]);
}

function parseCatalog(value: unknown, engine: string): EngineModelCatalog | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  if (raw.engine !== engine || raw.source !== 'probe'
    || !Array.isArray(raw.models) || raw.models.length === 0
    || (raw.currentModelId !== undefined && typeof raw.currentModelId !== 'string')) return null;
  const models: CodexModelInfo[] = [];
  for (const value of raw.models) {
    if (!value || typeof value !== 'object') return null;
    const row = value as Record<string, unknown>;
    if (typeof row.modelId !== 'string' || !row.modelId.trim()
      || typeof row.name !== 'string' || !row.name.trim()) return null;
    const model: CodexModelInfo = { modelId: row.modelId, name: row.name };
    for (const field of ['description', 'groupId', 'groupName'] as const) {
      const text = row[field];
      if (text !== undefined) {
        if (typeof text !== 'string') return null;
        model[field] = text;
      }
    }
    models.push(model);
  }
  return {
    engine,
    models,
    source: 'probe',
    ...(raw.currentModelId !== undefined ? { currentModelId: raw.currentModelId as string } : {}),
  };
}

function trimEntries(): void {
  while (entries.size > MAX_ENTRIES) entries.delete(entries.keys().next().value!);
}

function loadEntries(): void {
  if (loaded) return;
  loaded = true;
  try {
    const text = localStorage.getItem(ENGINE_MODEL_CACHE_STORAGE_KEY);
    const stored = text ? JSON.parse(text) : null;
    if (stored?.version !== 1 || !Array.isArray(stored.entries)) return;
    const valid: CacheEntry[] = [];
    for (const value of stored.entries) {
      if (!value || typeof value !== 'object') continue;
      const raw = value as Record<string, unknown>;
      if (raw.cwd !== undefined && typeof raw.cwd !== 'string') continue;
      if (typeof raw.fetchedAt !== 'number' || !Number.isFinite(raw.fetchedAt)
        || raw.fetchedAt < 0 || raw.fetchedAt > Date.now()) continue;
      const engine = (raw.catalog as { engine?: unknown } | null)?.engine;
      if (typeof engine !== 'string' || !engine) continue;
      const catalog = parseCatalog(raw.catalog, engine);
      if (catalog) valid.push({ cwd: raw.cwd as string | undefined, catalog, fetchedAt: raw.fetchedAt });
    }
    valid.sort((a, b) => a.fetchedAt - b.fetchedAt);
    for (const entry of valid) {
      const key = cacheKey(entry.catalog.engine, entry.cwd);
      entries.delete(key);
      entries.set(key, entry);
      trimEntries();
    }
  } catch { /* Storage is optional. */ }
}

function persistEntries(): void {
  try {
    localStorage.setItem(ENGINE_MODEL_CACHE_STORAGE_KEY, JSON.stringify({
      version: 1,
      entries: [...entries.values()],
    }));
  } catch { /* Keep the in-memory cache when storage is unavailable. */ }
}

/** Last successful engine/cwd catalog, including stale rows for an instant first paint. */
export function getCachedEngineModelCatalog(engine: string, cwd?: string): EngineModelCatalog | null {
  loadEntries();
  return entries.get(cacheKey(engine, cwd))?.catalog ?? null;
}

export function getFreshEngineModelCatalog(engine: string, cwd?: string): EngineModelCatalog | null {
  loadEntries();
  const entry = entries.get(cacheKey(engine, cwd));
  if (!entry) return null;
  const age = Date.now() - entry.fetchedAt;
  return age >= 0 && age < FETCH_TTL_MS ? entry.catalog : null;
}

export function getEngineModelCacheGeneration(): number { return generation; }

export function recordEngineModelCatalog(
  engine: string,
  cwd: string | undefined,
  value: unknown,
  requestGeneration = generation,
): void {
  if (!engine || requestGeneration !== generation) return;
  const catalog = parseCatalog(value, engine);
  if (!catalog) return;
  loadEntries();
  const key = cacheKey(engine, cwd);
  entries.delete(key);
  entries.set(key, { cwd, catalog, fetchedAt: Date.now() });
  trimEntries();
  persistEntries();
}

export function clearEngineModelCatalogCache(): void {
  generation++;
  loaded = true;
  entries.clear();
  try { localStorage.removeItem(ENGINE_MODEL_CACHE_STORAGE_KEY); } catch { /* Storage is optional. */ }
  for (const listener of invalidationListeners) listener();
}
