/**
 * Session-launcher last-path memory (cwd/host a new draft column opens on).
 *
 * Contract under test:
 *   - Read is SYNCHRONOUS and works on first paint with zero network. That's the
 *     whole reason this memory exists instead of reusing the working-dirs cache,
 *     which is null until its first fetch.
 *   - A brand-new browser has no memory → null (callers then show the picker).
 *   - Round-trips cwd + host + optional hostLabel.
 *   - `host: null` means "local machine" and must survive the round trip AS null,
 *     never as the string "null" or undefined — a bogus host routes a launch at
 *     the wrong machine.
 *   - The key is `open-walnut-`-prefixed so ui-prefs-sync mirrors it to the
 *     server; asserted against the REAL predicate so a narrowed allowlist can't
 *     silently make the memory device-local.
 *   - Corrupt JSON / disabled storage degrade to null instead of throwing during
 *     render (this is read from a useState initializer).
 *
 * Node env: localStorage is stubbed with the minimal surface the module touches
 * (same harness as launcher-pin-tier.test.ts).
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
  LAUNCHER_LAST_PATH_KEY,
  readLastLaunchPath,
  rememberLaunchPath,
} = await import('../../web/src/components/sessions/task-meta-constants');
const { syncable } = await import('../../web/src/utils/ui-prefs-sync');

beforeEach(() => {
  localStorage.clear();
});

describe('session launcher last path', () => {
  it('is null on a brand-new browser', () => {
    expect(readLastLaunchPath()).toBeNull();
  });

  it('round-trips cwd + named host + label', () => {
    rememberLaunchPath({ cwd: '/Users/me/repo', host: 'devbox', hostLabel: 'Dev Box' });
    expect(readLastLaunchPath()).toEqual({
      cwd: '/Users/me/repo',
      host: 'devbox',
      hostLabel: 'Dev Box',
    });
  });

  it('round-trips a local launch with host null (never "null" or undefined)', () => {
    rememberLaunchPath({ cwd: '/Users/me/repo', host: null });
    const read = readLastLaunchPath();
    expect(read).toEqual({ cwd: '/Users/me/repo', host: null });
    expect(read!.host).toBeNull();
    expect('hostLabel' in read!).toBe(false);
  });

  it('overwrites the previous memory (last launch wins)', () => {
    rememberLaunchPath({ cwd: '/a', host: 'h1' });
    rememberLaunchPath({ cwd: '/b', host: null });
    expect(readLastLaunchPath()).toEqual({ cwd: '/b', host: null });
  });

  it('returns null for corrupt JSON instead of throwing', () => {
    localStorage.setItem(LAUNCHER_LAST_PATH_KEY, '{not json');
    expect(() => readLastLaunchPath()).not.toThrow();
    expect(readLastLaunchPath()).toBeNull();
  });

  it('returns null for structurally wrong values', () => {
    // Shapes a stale/foreign writer could leave behind. All must degrade to
    // "never launched" rather than seeding a launch with an empty cwd.
    for (const raw of ['null', '"/Users/me/repo"', '42', '[]', '{}', '{"cwd":""}', '{"cwd":123}']) {
      localStorage.setItem(LAUNCHER_LAST_PATH_KEY, raw);
      expect(readLastLaunchPath()).toBeNull();
    }
  });

  it('coerces a blank/non-string host to null rather than passing it through', () => {
    localStorage.setItem(LAUNCHER_LAST_PATH_KEY, JSON.stringify({ cwd: '/x', host: '' }));
    expect(readLastLaunchPath()).toEqual({ cwd: '/x', host: null });
    localStorage.setItem(LAUNCHER_LAST_PATH_KEY, JSON.stringify({ cwd: '/x', host: 7, hostLabel: 7 }));
    expect(readLastLaunchPath()).toEqual({ cwd: '/x', host: null });
  });

  it('syncs across browsers: the key passes ui-prefs-sync\'s own allowlist', () => {
    // Asserted against the REAL predicate, not a hardcoded prefix: if the
    // allowlist were narrowed, this cross-device memory would quietly become
    // device-local while a prefix-string assertion still passed.
    expect(syncable(LAUNCHER_LAST_PATH_KEY)).toBe(true);
    rememberLaunchPath({ cwd: '/Users/me/repo', host: null });
    expect(localStorage.getItem(LAUNCHER_LAST_PATH_KEY)).toBe(
      JSON.stringify({ cwd: '/Users/me/repo', host: null }),
    );
  });

  it('survives a storage that throws (private mode / quota)', () => {
    const spyGet = vi.spyOn(localStorage, 'getItem').mockImplementation(() => {
      throw new Error('SecurityError');
    });
    const spySet = vi.spyOn(localStorage, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceeded');
    });
    try {
      expect(readLastLaunchPath()).toBeNull();
      expect(() => rememberLaunchPath({ cwd: '/x', host: null })).not.toThrow();
    } finally {
      spyGet.mockRestore();
      spySet.mockRestore();
    }
  });
});
