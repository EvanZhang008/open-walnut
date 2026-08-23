/**
 * Session-launcher pin-tier default — and the deliberate ABSENCE of stickiness.
 *
 * Contract under test (the user-visible behavior):
 *   - EVERY launcher opens on SATELLITE. Not just a brand-new browser: the tier
 *     used to be remembered from the last pick and mirrored across browsers, so
 *     one "Focus" on a genuinely urgent session made every later ordinary session
 *     open on Focus — which is how the pinned working set filled up with work
 *     nobody was doing. A per-launch decision is not a preference.
 *   - The retired pref is never READ again, whatever is left in storage: a value
 *     mirrored from another browser (or from before the change) must not resurrect
 *     the old behavior. MainPage's mount-time sweep deletes it; this file pins the
 *     half that matters — that reading it is gone.
 *   - Moving off Satellite is still a one-click override in the picker, and the
 *     background parse may write the tier (covered by the draft-parse tests) —
 *     neither is persisted between launches.
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
// so the test can import the real `syncable` predicate without a fetch stack.
vi.mock('../../web/src/api/client', () => ({
  apiGet: async () => ({ prefs: {} }),
  apiPut: async () => ({}),
}));
vi.mock('../../web/src/api/device-token', () => ({ getDeviceToken: () => null }));

const {
  DEFAULT_META,
  LEGACY_LAUNCHER_PIN_TIER_KEY,
  freshLauncherMeta,
} = await import('../../web/src/components/sessions/task-meta-constants');
const { syncable } = await import('../../web/src/utils/ui-prefs-sync');

beforeEach(() => {
  localStorage.clear();
});

describe('session launcher pin tier', () => {
  it('defaults every launch to satellite', () => {
    expect(DEFAULT_META.pinTier).toBe('satellite');
    expect(freshLauncherMeta().pinTier).toBe('satellite');
  });

  it('keeps the rest of the launcher defaults intact', () => {
    const meta = freshLauncherMeta();
    expect(meta.unread).toBe(false);
    expect(meta.priority).toBe('none');
    expect(meta.model).toBeUndefined();
    expect(meta.engine).toBeUndefined();
  });

  it('hands back a FRESH object each time (callers mutate it)', () => {
    const first = freshLauncherMeta();
    first.pinTier = 'focus';
    expect(freshLauncherMeta().pinTier).toBe('satellite');
    expect(DEFAULT_META.pinTier).toBe('satellite');
  });

  it('ignores a leftover sticky-tier value, whatever it says', () => {
    // The exact regression the stickiness caused: a stored 'focus' (this browser's
    // own old pick, or one synced in from another) must NOT steer a new launch.
    for (const stale of ['focus', 'wait', 'backlog', 'none', 'ct_abcd1234', 'top', '']) {
      localStorage.setItem(LEGACY_LAUNCHER_PIN_TIER_KEY, stale);
      expect(freshLauncherMeta().pinTier).toBe('satellite');
    }
  });

  it('still names the retired pref as a syncable key, so the sweep can retract it', () => {
    // The sweep works by DELETING the key, and a deletion only propagates to the
    // other browsers if ui-prefs-sync mirrors this key at all. Asserted against
    // the real predicate: if the allowlist ever narrowed, the stale value would
    // survive on every other device with a green suite.
    expect(syncable(LEGACY_LAUNCHER_PIN_TIER_KEY)).toBe(true);
  });

  it('does NOT sync keys whose name embeds an absolute path', () => {
    // Same predicate, opposite direction (2026-08 config/share move): ui-prefs
    // is git-synced now, so a key carrying THIS box's paths must stay local.
    // Mirrors MACHINE_LOCAL_PREFIXES in src/web/routes/ui-prefs.ts.
    expect(syncable('open-walnut-file-explorer-selected:local:/Users/me/repo')).toBe(false);
  });

  it('survives a storage that throws (private mode / quota)', () => {
    // freshLauncherMeta no longer touches storage at all, which is the point —
    // a launcher that can't read a pref can't be broken by one either.
    const spyGet = vi.spyOn(localStorage, 'getItem').mockImplementation(() => {
      throw new Error('SecurityError');
    });
    try {
      expect(freshLauncherMeta().pinTier).toBe('satellite');
    } finally {
      spyGet.mockRestore();
    }
  });
});
