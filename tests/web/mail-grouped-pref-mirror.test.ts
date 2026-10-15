/**
 * The Grouped / All mail switch's server mirror is not re-sent on every page load (N19: a phone
 * boot wrote `PUT /groups/pref` each time, before the first screen). A load sends it only when this
 * browser has not told the server that value in the last day; a change is always sent.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  GROUPED_MIRRORED_KEY,
  GROUPED_PREF_KEY,
  readGroupedPref,
  resetGroupedPrefForTests,
  writeGroupedPref,
} from '../../web/src/apps/mail/mail-grouped-pref';

let puts: Array<{ url: string; body: unknown }> = [];
let kept: Map<string, string>;

function installStorage(): Map<string, string> {
  const map = new Map<string, string>();
  vi.stubGlobal('window', {
    localStorage: {
      getItem: (key: string) => map.get(key) ?? null,
      setItem: (key: string, value: string) => { map.set(key, value); },
      removeItem: (key: string) => { map.delete(key); },
    },
  });
  return map;
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

beforeEach(() => {
  puts = [];
  kept = installStorage();
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    if ((init?.method ?? 'GET') === 'PUT') puts.push({ url: String(input), body: JSON.parse(String(init?.body)) });
    return new Response(JSON.stringify({ on: true }), { status: 200, headers: { 'content-type': 'application/json' } });
  }));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('grouped preference mirror across page loads', () => {
  it('the first load ever sends it once, and a second load sends nothing', async () => {
    resetGroupedPrefForTests({ fromStorage: true });
    expect(readGroupedPref()).toBe(true);
    readGroupedPref();
    await settle();
    expect(puts.map((p) => p.body)).toEqual([{ on: true }]);
    expect(JSON.parse(kept.get(GROUPED_MIRRORED_KEY)!).on).toBe(true);
    // A new page in the same browser.
    resetGroupedPrefForTests({ fromStorage: true });
    expect(readGroupedPref()).toBe(true);
    await settle();
    expect(puts).toHaveLength(1);
  });

  it('a change is sent at once, and the next load does not repeat it', async () => {
    resetGroupedPrefForTests({ fromStorage: true });
    readGroupedPref();
    await settle();
    writeGroupedPref(false);
    await settle();
    expect(puts.map((p) => p.body)).toEqual([{ on: true }, { on: false }]);
    resetGroupedPrefForTests({ fromStorage: true });
    expect(readGroupedPref()).toBe(false);
    await settle();
    expect(puts).toHaveLength(2);
  });

  it('a value this browser mirrored over a day ago is sent again on load', async () => {
    kept.set(GROUPED_PREF_KEY, JSON.stringify({ on: false }));
    kept.set(GROUPED_MIRRORED_KEY, JSON.stringify({ on: false, at: Date.now() - 25 * 60 * 60_000 }));
    resetGroupedPrefForTests({ fromStorage: true });
    expect(readGroupedPref()).toBe(false);
    await settle();
    expect(puts.map((p) => p.body)).toEqual([{ on: false }]);
  });

  it('a stored mirror of the other value does not stop the load from sending this one', async () => {
    kept.set(GROUPED_PREF_KEY, JSON.stringify({ on: false }));
    kept.set(GROUPED_MIRRORED_KEY, JSON.stringify({ on: true, at: Date.now() }));
    resetGroupedPrefForTests({ fromStorage: true });
    readGroupedPref();
    await settle();
    expect(puts.map((p) => p.body)).toEqual([{ on: false }]);
  });
});
