/**
 * Host-level last-known model catalog store: per-host persistence (local key
 * normalization), write-through + atomic file shape, survives a reload
 * (fresh in-memory cache reads the same file), and empty-model guard.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import fsp from 'node:fs/promises';
import { createMockConstants } from '../helpers/mock-constants.js';

vi.mock('../../src/constants.js', () => createMockConstants('host-catalog-test'));

import {
  saveHostModelCatalog,
  getHostModelCatalog,
  listHostModelCatalogs,
  hostCatalogKey,
  _resetHostModelCatalogCache,
  LOCAL_HOST_KEY,
} from '../../src/core/host-model-catalog.js';
import { HOST_MODEL_CATALOG_FILE } from '../../src/constants.js';

const MODELS = [
  { value: 'default', displayName: 'Default' },
  {
    value: 'global.anthropic.claude-fable-5[1m]', resolvedModel: 'global.anthropic.claude-fable-5[1m]',
    displayName: 'Fable', description: 'Fast & capable', supportsEffort: true,
  },
];

// Flush the store's internal write chain by waiting for the file to appear.
async function waitForFile(): Promise<void> {
  for (let i = 0; i < 50; i++) {
    try { await fsp.access(HOST_MODEL_CATALOG_FILE); return; } catch { /* not yet */ }
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('catalog file never appeared');
}

beforeEach(() => {
  _resetHostModelCatalogCache();
});

describe('hostCatalogKey', () => {
  it('normalizes empty/null/undefined to the local key', () => {
    expect(hostCatalogKey(null)).toBe(LOCAL_HOST_KEY);
    expect(hostCatalogKey(undefined)).toBe(LOCAL_HOST_KEY);
    expect(hostCatalogKey('')).toBe(LOCAL_HOST_KEY);
    expect(hostCatalogKey('  ')).toBe(LOCAL_HOST_KEY);
    expect(hostCatalogKey('devbox')).toBe('devbox');
  });
});

describe('saveHostModelCatalog / getHostModelCatalog', () => {
  it('stores per host, local key normalized, cwd recorded', async () => {
    await saveHostModelCatalog(null, MODELS, '/Users/me/repo');
    await saveHostModelCatalog('devbox', MODELS.slice(1), '/home/me/proj');

    const local = await getHostModelCatalog(undefined);
    expect(local?.models.map((m) => m.value)).toEqual(['default', 'global.anthropic.claude-fable-5[1m]']);
    expect(local?.cwd).toBe('/Users/me/repo');
    expect(local?.fetchedAt).toBeTruthy();

    const remote = await getHostModelCatalog('devbox');
    expect(remote?.models).toHaveLength(1);

    const all = await listHostModelCatalogs();
    expect(Object.keys(all).sort()).toEqual([LOCAL_HOST_KEY, 'devbox'].sort());
  });

  it('ignores empty model arrays (a failed fetch must not clobber a good catalog)', async () => {
    await saveHostModelCatalog('devbox', MODELS);
    await saveHostModelCatalog('devbox', []);
    const cat = await getHostModelCatalog('devbox');
    expect(cat?.models).toHaveLength(2);
  });

  it('rejects a catalog whose source transport became stale during async load', async () => {
    await saveHostModelCatalog('devbox', MODELS);
    await waitForFile();
    _resetHostModelCatalogCache();
    const replacement = [{ value: 'stale-only', displayName: 'Stale' }];

    const accepted = await saveHostModelCatalog(
      'devbox',
      replacement,
      '/old/process',
      undefined,
      () => false,
    );

    expect(accepted).toBe(false);
    expect((await getHostModelCatalog('devbox'))?.models).toEqual(MODELS);
  });

  it('persists to disk and survives a cache reset (server-restart shape)', async () => {
    await saveHostModelCatalog('devbox', MODELS, '/w');
    await waitForFile();

    _resetHostModelCatalogCache(); // simulate a fresh process re-reading the file
    const cat = await getHostModelCatalog('devbox');
    expect(cat?.models.map((m) => m.value)).toEqual(['default', 'global.anthropic.claude-fable-5[1m]']);

    // File is valid JSON with the expected key (atomic-write sanity).
    const raw = JSON.parse(await fsp.readFile(HOST_MODEL_CATALOG_FILE, 'utf-8'));
    expect(raw.devbox.models).toHaveLength(2);
  });

  it('returns null for a host that never produced a catalog', async () => {
    expect(await getHostModelCatalog('nowhere')).toBeNull();
  });

  it('tolerates a corrupt file (cache, not source of truth)', async () => {
    await fsp.mkdir(HOST_MODEL_CATALOG_FILE.slice(0, HOST_MODEL_CATALOG_FILE.lastIndexOf('/')), { recursive: true });
    await fsp.writeFile(HOST_MODEL_CATALOG_FILE, 'not-json{', 'utf-8');
    _resetHostModelCatalogCache();
    expect(await getHostModelCatalog('devbox')).toBeNull();
    await saveHostModelCatalog('devbox', MODELS); // recovers by overwriting
    expect((await getHostModelCatalog('devbox'))?.models).toHaveLength(2);
  });
});
