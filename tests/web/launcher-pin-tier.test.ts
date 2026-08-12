/**
 * Session-launcher pin-tier default + stickiness.
 *
 * Contract under test (the user-visible behavior):
 *   - A brand-new browser opens the launcher on SATELLITE (was Focus — every
 *     session ever started piled into the Focus tier).
 *   - Whatever tier the user last picked becomes the next launch's default,
 *     including an explicit "unpinned" (clicking the active tier to toggle off).
 *   - The key is `open-walnut-`-prefixed so ui-prefs-sync mirrors it to the
 *     server — the choice follows the user to another browser. Guarded here
 *     because a rename to a non-syncable prefix would silently make the memory
 *     device-local again.
 *   - Corrupt / unknown stored values fall back to the default instead of
 *     seeding an invalid tier that the quick-start route would 400 on.
 *
 * Node env: localStorage is stubbed with the minimal surface the module touches
 * (same style as crash-report.test.ts).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

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

// ui-prefs-sync pulls in the API client + device token at import time; stub them
// so the test can import the real `syncable` predicate (the thing that actually
// decides whether this pref reaches the server) without a browser fetch stack.
vi.mock('../../web/src/api/client', () => ({
  apiGet: async () => ({ prefs: {} }),
  apiPut: async () => ({}),
}));
vi.mock('../../web/src/api/device-token', () => ({ getDeviceToken: () => null }));

const {
  DEFAULT_META,
  LAUNCHER_PIN_TIER_KEY,
  readLastPinTier,
  rememberPinTier,
  freshLauncherMeta,
} = await import('../../web/src/components/sessions/task-meta-constants');
const { syncable } = await import('../../web/src/utils/ui-prefs-sync');

beforeEach(() => {
  localStorage.clear();
});

describe('session launcher pin tier', () => {
  it('defaults a first-ever launch to satellite', () => {
    expect(DEFAULT_META.pinTier).toBe('satellite');
    expect(readLastPinTier()).toBe('satellite');
    expect(freshLauncherMeta().pinTier).toBe('satellite');
  });

  it('keeps the rest of the launcher defaults intact', () => {
    const meta = freshLauncherMeta();
    expect(meta.starred).toBe(true);
    expect(meta.needs_attention).toBe(false);
    expect(meta.priority).toBe('none');
    expect(meta.model).toBeUndefined();
    expect(meta.engine).toBeUndefined();
  });

  it('remembers the last picked tier as the next default', () => {
    rememberPinTier('focus');
    expect(readLastPinTier()).toBe('focus');
    expect(freshLauncherMeta().pinTier).toBe('focus');

    rememberPinTier('wait');
    expect(freshLauncherMeta().pinTier).toBe('wait');

    rememberPinTier('backlog');
    expect(freshLauncherMeta().pinTier).toBe('backlog');
  });

  it('remembers an explicit unpin instead of snapping back to the default', () => {
    rememberPinTier(undefined);
    expect(readLastPinTier()).toBeUndefined();
    expect(freshLauncherMeta().pinTier).toBeUndefined();
  });

  it('syncs across browsers: the key passes ui-prefs-sync\'s own allowlist', () => {
    // Asserted against the REAL predicate, not a hardcoded prefix: if the
    // allowlist were ever narrowed, this cross-device guarantee would quietly
    // become device-local, and a prefix-string assertion would still pass.
    expect(syncable(LAUNCHER_PIN_TIER_KEY)).toBe(true);
    rememberPinTier('wait');
    expect(localStorage.getItem(LAUNCHER_PIN_TIER_KEY)).toBe('wait');
  });

  it('does NOT sync keys whose name embeds an absolute path', () => {
    // Same predicate, opposite direction (2026-08 config/share move): ui-prefs
    // is git-synced now, so a key carrying THIS box's paths must stay local.
    // Mirrors MACHINE_LOCAL_PREFIXES in src/web/routes/ui-prefs.ts.
    expect(syncable('open-walnut-file-explorer-selected:local:/Users/me/repo')).toBe(false);
  });

  it('falls back to the default when the stored value is garbage', () => {
    localStorage.setItem(LAUNCHER_PIN_TIER_KEY, 'top');   // an older/invalid tier name
    expect(readLastPinTier()).toBe('satellite');
    localStorage.setItem(LAUNCHER_PIN_TIER_KEY, '');
    expect(readLastPinTier()).toBe('satellite');
  });

  it('remembers a custom tier id (ct_*) as the next default', () => {
    // A stale id (tier since deleted) self-heals server-side into Satellite,
    // so the passthrough never seeds an invalid pin.
    rememberPinTier('ct_abcd1234');
    expect(readLastPinTier()).toBe('ct_abcd1234');
    expect(freshLauncherMeta().pinTier).toBe('ct_abcd1234');
  });

  it('survives a storage that throws (private mode / quota)', () => {
    const throwing = {
      getItem: () => { throw new Error('SecurityError'); },
      setItem: () => { throw new Error('QuotaExceeded'); },
    };
    const spyGet = vi.spyOn(localStorage, 'getItem').mockImplementation(throwing.getItem);
    const spySet = vi.spyOn(localStorage, 'setItem').mockImplementation(throwing.setItem);
    try {
      expect(readLastPinTier()).toBe('satellite');
      expect(() => rememberPinTier('focus')).not.toThrow();
    } finally {
      spyGet.mockRestore();
      spySet.mockRestore();
    }
  });
});
