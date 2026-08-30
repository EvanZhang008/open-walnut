/**
 * Engine catalog — the browser's model of "which coding agents exist, what can
 * they do, is one usable right now".
 *
 * Contract under test:
 *   - The COMPILED-IN default is exactly the two engines that shipped before the
 *     catalog existed, both installed. That is what makes a cold page paint the
 *     same engine toggle it always did (and an old server with no /api/engines
 *     keep it forever).
 *   - Storage shape is untouched: the default engine persists as `undefined`,
 *     every other engine explicitly.
 *   - resolveEngineForHost is the ONE local-only rule; three surfaces call it
 *     instead of re-deriving `engine === '<vendor>' && !remoteHost`.
 *   - An engine the catalog cannot describe degrades to the conservative ACP
 *     shape (no preassigned session id, no pre-launch model list).
 *   - Hydration replaces the catalog; an empty/garbage/failed answer keeps the
 *     default rather than emptying the toggle.
 *   - A PENDING availability answer (the probe outran its deadline, or threw) is
 *     retryable, not a verdict: it paints, but it never starts the TTL clock and
 *     never reaches localStorage.
 *
 * Node env: localStorage is stubbed with the surface the store touches (same
 * harness as launcher-last-path.test.ts).
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { SESSION_ENGINE_IDS } from '../../src/core/types';

class FakeStorage {
  private store = new Map<string, string>();
  get length() { return this.store.size; }
  key(i: number) { return [...this.store.keys()][i] ?? null; }
  getItem(k: string) { return this.store.get(k) ?? null; }
  setItem(k: string, v: string) { this.store.set(k, v); }
  removeItem(k: string) { this.store.delete(k); }
  clear() { this.store.clear(); }
}
const localStorage = new FakeStorage();
Object.defineProperty(globalThis, 'localStorage', { value: localStorage, writable: true, configurable: true });

const apiGet = vi.fn();
vi.mock('../../web/src/api/client', () => ({
  apiGet: (...args: unknown[]) => apiGet(...args),
  apiPost: async () => ({}),
  apiPatch: async () => ({}),
  ApiError: class ApiError extends Error {},
}));
vi.mock('../../web/src/utils/log', () => ({
  log: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
}));

import {
  DEFAULT_ENGINE,
  DEFAULT_ENGINE_CATALOG,
  engineDisplayName,
  engineEntry,
  engineLockReason,
  engineTitle,
  isSessionEngine,
  launchEngineForHost,
  normalizeEngine,
  resolveEngine,
  resolveEngineForHost,
  type EngineCatalog,
  type EngineCatalogEntry,
} from '../../web/src/utils/engines';
import {
  _resetEngineCatalogStore,
  getEngineCatalog,
  refreshEngineCatalog,
} from '../../web/src/hooks/useEngineCatalog';

function serverEntry(
  id: string,
  over: Partial<EngineCatalogEntry> & { availability?: Partial<EngineCatalogEntry['availability']> } = {},
): Record<string, unknown> {
  return {
    id,
    displayName: over.displayName ?? id,
    runtimeKind: over.runtimeKind ?? 'acp',
    isDefault: over.isDefault ?? false,
    localOnly: over.localOnly ?? true,
    capabilities: over.capabilities ?? {
      rewind: false,
      fork: false,
      modelCatalog: 'provider-advertised',
      modeControl: 'config-options',
      idProvisioning: 'provider-issued',
    },
    availability: { installed: true, version: null, reason: null, ...(over.availability ?? {}) },
  };
}

describe('compiled-in default catalog', () => {
  it('is exactly the pre-catalog engines, both installed', () => {
    expect(DEFAULT_ENGINE_CATALOG.map((e) => e.id)).toEqual(['claude', 'codex']);
    expect(DEFAULT_ENGINE_CATALOG.every((e) => e.availability.installed)).toBe(true);
    const claude = engineEntry(DEFAULT_ENGINE_CATALOG, 'claude');
    expect(claude.isDefault).toBe(true);
    expect(claude.localOnly).toBe(false);
    expect(claude.capabilities).toMatchObject({
      rewind: true, fork: true, modelCatalog: 'static',
      modeControl: 'claude-modes', idProvisioning: 'preassigned',
    });
    const codex = engineEntry(DEFAULT_ENGINE_CATALOG, 'codex');
    expect(codex.isDefault).toBe(false);
    expect(codex.localOnly).toBe(true);
    expect(codex.capabilities).toMatchObject({
      rewind: false, fork: false, modelCatalog: 'provider-advertised',
      modeControl: 'config-options', idProvisioning: 'provider-issued',
    });
  });

  it('keeps the two hand-written toggle tooltips', () => {
    expect(engineTitle(engineEntry(DEFAULT_ENGINE_CATALOG, 'claude'))).toBe('Claude Code (native)');
    expect(engineTitle(engineEntry(DEFAULT_ENGINE_CATALOG, 'codex'))).toBe('Codex (via ACP)');
  });
});

describe('engine value normalization', () => {
  it('accepts every registered engine and nothing else', () => {
    for (const id of SESSION_ENGINE_IDS) expect(isSessionEngine(id)).toBe(true);
    for (const bad of ['', 'CLAUDE', 'gpt', null, undefined, 7, {}]) {
      expect(isSessionEngine(bad)).toBe(false);
    }
  });

  it('resolves unknown values to the default engine instead of throwing', () => {
    expect(resolveEngine(undefined)).toBe(DEFAULT_ENGINE);
    expect(resolveEngine('engine-from-a-newer-build')).toBe(DEFAULT_ENGINE);
    for (const id of SESSION_ENGINE_IDS) expect(resolveEngine(id)).toBe(id);
  });

  it('keeps the storage shape: default engine is undefined, others explicit', () => {
    expect(normalizeEngine('claude')).toBeUndefined();
    expect(normalizeEngine(undefined)).toBeUndefined();
    expect(normalizeEngine('nope')).toBeUndefined();
    for (const id of SESSION_ENGINE_IDS.filter((i) => i !== DEFAULT_ENGINE)) {
      expect(normalizeEngine(id)).toBe(id);
    }
  });
});

describe('resolveEngineForHost (the one local-only rule)', () => {
  const catalog: EngineCatalog = DEFAULT_ENGINE_CATALOG;

  it('downgrades a local-only engine on a remote host tab', () => {
    expect(resolveEngineForHost('codex', 'clouddev', catalog)).toBe('claude');
    expect(launchEngineForHost('codex', 'clouddev', catalog)).toBeUndefined();
    expect(engineLockReason(engineEntry(catalog, 'codex'), 'clouddev'))
      .toBe('Codex sessions are local-only for now');
  });

  it('keeps it on the local machine, however local is spelled', () => {
    for (const host of [null, undefined, '', '__local__']) {
      expect(resolveEngineForHost('codex', host, catalog)).toBe('codex');
      expect(launchEngineForHost('codex', host, catalog)).toBe('codex');
      expect(engineLockReason(engineEntry(catalog, 'codex'), host)).toBeNull();
    }
  });

  it('never locks the default engine, on any host', () => {
    expect(resolveEngineForHost(undefined, 'clouddev', catalog)).toBe('claude');
    expect(engineLockReason(engineEntry(catalog, 'claude'), 'clouddev')).toBeNull();
  });

  it('reports an uninstalled engine as the lock reason, ahead of the host rule', () => {
    const missing: EngineCatalog = [{
      ...engineEntry(DEFAULT_ENGINE_CATALOG, 'codex'),
      id: 'goose',
      displayName: 'Goose',
      availability: { installed: false, version: null, reason: 'goose not found on PATH' },
    }];
    expect(engineLockReason(engineEntry(missing, 'goose'), null)).toBe('goose not found on PATH');
    expect(engineLockReason(engineEntry(missing, 'goose'), 'clouddev')).toBe('goose not found on PATH');
  });
});

describe('engines the catalog cannot describe', () => {
  it('degrades a non-default engine to the conservative ACP shape', () => {
    const entry = engineEntry(DEFAULT_ENGINE_CATALOG, 'gemini');
    expect(entry.capabilities.idProvisioning).toBe('provider-issued');
    expect(entry.capabilities.modelCatalog).toBe('provider-advertised');
    expect(entry.availability.installed).toBe(false);
    expect(entry.displayName).toBe('Gemini');
    expect(engineLockReason(entry, null)).toContain('gemini');
  });

  it('still answers the default engine from the compiled-in rows', () => {
    expect(engineEntry([], undefined).id).toBe('claude');
    expect(engineEntry([], undefined).capabilities.idProvisioning).toBe('preassigned');
    expect(engineDisplayName([], 'claude')).toBe('Claude');
  });
});

describe('catalog store hydration', () => {
  beforeEach(() => {
    apiGet.mockReset();
    localStorage.clear();
    _resetEngineCatalogStore();
  });

  it('starts on the compiled-in default before any fetch', () => {
    expect(getEngineCatalog().map((e) => e.id)).toEqual(['claude', 'codex']);
  });

  async function hydrateWith(engines: unknown): Promise<void> {
    apiGet.mockResolvedValue({ engines });
    refreshEngineCatalog();
    // One microtask flush per await link in the hydrate chain.
    for (let i = 0; i < 5; i++) await Promise.resolve();
  }

  it('replaces the catalog from GET /api/engines and persists it', async () => {
    await hydrateWith([
      serverEntry('claude', {
        displayName: 'Claude', runtimeKind: 'native', isDefault: true, localOnly: false,
        capabilities: {
          rewind: true, fork: true, modelCatalog: 'static',
          modeControl: 'claude-modes', idProvisioning: 'preassigned',
        },
      }),
      serverEntry('gemini', { displayName: 'Gemini' }),
      serverEntry('custom', {
        displayName: 'Custom (ACP)',
        availability: { installed: false, reason: 'configure engines.custom.adapter_cmd' },
      }),
    ]);

    expect(apiGet).toHaveBeenCalledWith('/api/engines');
    expect(getEngineCatalog().map((e) => e.id)).toEqual(['claude', 'gemini', 'custom']);
    expect(engineLockReason(engineEntry(getEngineCatalog(), 'custom'), null))
      .toBe('configure engines.custom.adapter_cmd');
    expect(localStorage.getItem('walnut.engineCatalog.v1')).toContain('gemini');
  });

  it('drops malformed rows but keeps the default when nothing survives', async () => {
    await hydrateWith([{ id: 'not-an-engine' }, 'nonsense', null]);
    expect(getEngineCatalog().map((e) => e.id)).toEqual(['claude', 'codex']);
  });

  it('keeps the default catalog when the endpoint is missing or fails', async () => {
    apiGet.mockRejectedValue(new Error('404 not found'));
    refreshEngineCatalog();
    for (let i = 0; i < 5; i++) await Promise.resolve();
    expect(getEngineCatalog().map((e) => e.id)).toEqual(['claude', 'codex']);
  });

  it('seeds from localStorage on module load, before any fetch', async () => {
    localStorage.setItem('walnut.engineCatalog.v1', JSON.stringify([
      serverEntry('claude', { displayName: 'Claude', runtimeKind: 'native', isDefault: true, localOnly: false }),
      serverEntry('goose', { displayName: 'Goose' }),
    ]));
    vi.resetModules();
    const fresh = await import('../../web/src/hooks/useEngineCatalog');
    expect(fresh.getEngineCatalog().map((e) => e.id)).toEqual(['claude', 'goose']);
    expect(apiGet).not.toHaveBeenCalled();
  });
});

/**
 * The two retryable reasons, verbatim from the two places that mint them:
 * engine-probe's deadline degradation and the route's probe-threw fallback.
 * Both arrive as installed:false, which is why they need naming — a real
 * missing binary looks identical on the wire.
 */
describe('pending availability is retryable, not a verdict', () => {
  const KEY = 'walnut.engineCatalog.v1';
  const PENDING_REASONS = ['still checking availability', 'availability check unavailable'];
  const claudeRow = () => serverEntry('claude', {
    displayName: 'Claude', runtimeKind: 'native', isDefault: true, localOnly: false,
  });
  const gooseRow = (reason: string | null, installed = false) =>
    serverEntry('goose', { displayName: 'Goose', availability: { installed, reason } });

  beforeEach(() => {
    apiGet.mockReset();
    localStorage.clear();
    _resetEngineCatalogStore();
  });
  // The last pending test leaves a live re-pull timer otherwise.
  afterEach(() => { _resetEngineCatalogStore(); });

  async function flush(): Promise<void> {
    for (let i = 0; i < 5; i++) await Promise.resolve();
  }

  for (const reason of PENDING_REASONS) {
    it(`applies "${reason}" to the live store but never persists it`, async () => {
      apiGet.mockResolvedValue({ engines: [claudeRow(), gooseRow(reason)] });
      refreshEngineCatalog();
      await flush();
      // In memory: this paint must show what the server just said.
      expect(getEngineCatalog().map((e) => e.id)).toEqual(['claude', 'goose']);
      expect(engineEntry(getEngineCatalog(), 'goose').availability.reason).toBe(reason);
      // On disk: nothing, so the next page load starts from the default again
      // instead of painting a usable engine as unavailable.
      expect(localStorage.getItem(KEY)).toBeNull();
    });
  }

  it('a settled row alongside a pending one still keeps the whole answer off disk', async () => {
    apiGet.mockResolvedValue({
      engines: [claudeRow(), gooseRow('goose not found on PATH'), serverEntry('gemini', {
        displayName: 'Gemini', availability: { installed: false, reason: PENDING_REASONS[0] },
      })],
    });
    refreshEngineCatalog();
    await flush();
    expect(getEngineCatalog().map((e) => e.id)).toEqual(['claude', 'goose', 'gemini']);
    expect(localStorage.getItem(KEY)).toBeNull();
  });

  it('re-pulls once ~3s later and persists the settled answer', async () => {
    vi.useFakeTimers();
    try {
      apiGet
        .mockResolvedValueOnce({ engines: [claudeRow(), gooseRow(PENDING_REASONS[0])] })
        .mockResolvedValueOnce({ engines: [claudeRow(), gooseRow(null, true)] });
      refreshEngineCatalog();
      await flush();
      expect(apiGet).toHaveBeenCalledTimes(1);
      expect(localStorage.getItem(KEY)).toBeNull();

      // The re-pull actually fetching also proves lastHydrateAt was NOT stamped:
      // hydrate() short-circuits inside the 60s TTL, so a stamped pending answer
      // would have pinned the row for the whole minute.
      await vi.advanceTimersByTimeAsync(3_000);
      expect(apiGet).toHaveBeenCalledTimes(2);
      expect(engineEntry(getEngineCatalog(), 'goose').availability.installed).toBe(true);
      expect(localStorage.getItem(KEY)).toContain('goose');
    } finally {
      vi.useRealTimers();
    }
  });

  it('never chains timers: a still-pending re-pull schedules no third fetch', async () => {
    vi.useFakeTimers();
    try {
      apiGet.mockResolvedValue({ engines: [claudeRow(), gooseRow(PENDING_REASONS[1])] });
      refreshEngineCatalog();
      await flush();
      await vi.advanceTimersByTimeAsync(3_000);
      expect(apiGet).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(apiGet).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('ignores a pending catalog an older build already wrote to localStorage', async () => {
    localStorage.setItem(KEY, JSON.stringify([claudeRow(), gooseRow(PENDING_REASONS[0])]));
    vi.resetModules();
    const fresh = await import('../../web/src/hooks/useEngineCatalog');
    expect(fresh.getEngineCatalog().map((e) => e.id)).toEqual(['claude', 'codex']);
  });
});
