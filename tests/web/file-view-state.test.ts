/**
 * Files-panel "resume where I left off" store.
 *
 * Contract under test (the user-visible behavior from the 2026-07-28 report —
 * "every time I open a file I have to click it again, and it starts at the top"):
 *   - The file you were reading is remembered PER host + tree root, so reopening
 *     the Files panel reselects it instead of showing the empty preview pane.
 *   - Each file's scroll offset is remembered PER host + path, so a long document
 *     resumes at your reading position.
 *   - Scrolling back to the top DROPS the entry — a stale offset must not resurrect
 *     later ("I scrolled up, then it jumped down again").
 *   - The scroll map is capped, evicting oldest-written first, so a long-lived
 *     browser profile can't grow localStorage without bound.
 *   - Corrupt / non-object / denied storage degrades to "start at the top" instead
 *     of throwing into a render (this store sits in a useEffect on every file open).
 *
 * Node env: localStorage is stubbed with the minimal surface the module touches
 * (same style as launcher-pin-tier.test.ts).
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
  raw() { return this.store; }
}

let storage: FakeStorage;

beforeEach(async () => {
  storage = new FakeStorage();
  vi.stubGlobal('localStorage', storage);
  vi.resetModules();
});

async function load() {
  return await import('../../web/src/utils/file-view-state');
}

describe('selected file memory (per host + root)', () => {
  it('round-trips the file being read', async () => {
    const { saveSelectedFile, loadSelectedFile } = await load();
    saveSelectedFile(undefined, '/repo', '/repo/docs/README.md');
    expect(loadSelectedFile(undefined, '/repo')).toBe('/repo/docs/README.md');
  });

  it('keys separately per host and per root — no cross-talk', async () => {
    const { saveSelectedFile, loadSelectedFile } = await load();
    saveSelectedFile(undefined, '/repo', '/repo/a.md');
    saveSelectedFile('devbox', '/repo', '/repo/b.md');
    saveSelectedFile(undefined, '/other', '/other/c.md');
    expect(loadSelectedFile(undefined, '/repo')).toBe('/repo/a.md');
    expect(loadSelectedFile('devbox', '/repo')).toBe('/repo/b.md');
    expect(loadSelectedFile(undefined, '/other')).toBe('/other/c.md');
  });

  it('saving null clears it (file deleted / user navigated away)', async () => {
    const { saveSelectedFile, loadSelectedFile } = await load();
    saveSelectedFile(undefined, '/repo', '/repo/a.md');
    saveSelectedFile(undefined, '/repo', null);
    expect(loadSelectedFile(undefined, '/repo')).toBeNull();
  });

  it('an unvisited root has no memory', async () => {
    const { loadSelectedFile } = await load();
    expect(loadSelectedFile(undefined, '/never/seen')).toBeNull();
  });
});

describe('per-file scroll offset', () => {
  it('round-trips an offset for the right file only', async () => {
    const { saveFileScroll, loadFileScroll } = await load();
    saveFileScroll(undefined, '/repo/long.md', { top: 1200 });
    expect(loadFileScroll(undefined, '/repo/long.md')?.top).toBe(1200);
    expect(loadFileScroll(undefined, '/repo/other.md')).toBeNull();
    // Same path on a different host is a different file.
    expect(loadFileScroll('devbox', '/repo/long.md')).toBeNull();
  });

  it('remembers Source-vs-Preview mode alongside the offset', async () => {
    const { saveFileScroll, loadFileScroll } = await load();
    saveFileScroll(undefined, '/repo/a.md', { top: 500, source: true });
    expect(loadFileScroll(undefined, '/repo/a.md')?.source).toBe(true);
    saveFileScroll(undefined, '/repo/b.md', { top: 500 });
    expect(loadFileScroll(undefined, '/repo/b.md')?.source).toBeUndefined();
  });

  it('scrolling back to the top forgets the entry (no resurrection)', async () => {
    const { saveFileScroll, loadFileScroll } = await load();
    saveFileScroll(undefined, '/repo/a.md', { top: 900 });
    saveFileScroll(undefined, '/repo/a.md', { top: 0 });
    expect(loadFileScroll(undefined, '/repo/a.md')).toBeNull();
  });

  it('a top offset with Source mode is still kept (mode is worth remembering)', async () => {
    const { saveFileScroll, loadFileScroll } = await load();
    saveFileScroll(undefined, '/repo/a.md', { top: 0, source: true });
    expect(loadFileScroll(undefined, '/repo/a.md')).toEqual({ top: 0, source: true });
  });

  it('offsets are rounded — no sub-pixel noise in storage', async () => {
    const { saveFileScroll, loadFileScroll } = await load();
    saveFileScroll(undefined, '/repo/a.md', { top: 640.7 });
    expect(loadFileScroll(undefined, '/repo/a.md')?.top).toBe(641);
  });

  it('caps the map, evicting oldest-written first', async () => {
    const { saveFileScroll, loadFileScroll } = await load();
    for (let i = 0; i < 320; i++) saveFileScroll(undefined, `/repo/f${i}.md`, { top: 100 + i });
    expect(loadFileScroll(undefined, '/repo/f0.md')).toBeNull();     // evicted
    expect(loadFileScroll(undefined, '/repo/f319.md')?.top).toBe(419); // newest kept
    const stored = JSON.parse(storage.getItem('open-walnut-file-view-scroll')!);
    expect(Object.keys(stored).length).toBeLessThanOrEqual(300);
  });

  it('re-saving a file refreshes its position in the eviction order', async () => {
    const { saveFileScroll, loadFileScroll } = await load();
    saveFileScroll(undefined, '/repo/keep.md', { top: 111 });
    for (let i = 0; i < 299; i++) saveFileScroll(undefined, `/repo/f${i}.md`, { top: 200 });
    // Touch it again so it is the newest write, then overflow by one more file.
    saveFileScroll(undefined, '/repo/keep.md', { top: 222 });
    saveFileScroll(undefined, '/repo/overflow.md', { top: 300 });
    expect(loadFileScroll(undefined, '/repo/keep.md')?.top).toBe(222);
  });
});

describe('degrades safely instead of throwing', () => {
  it('corrupt JSON reads as empty', async () => {
    const { loadFileScroll, saveFileScroll } = await load();
    storage.setItem('open-walnut-file-view-scroll', '{not json');
    expect(loadFileScroll(undefined, '/repo/a.md')).toBeNull();
    // And a later write still succeeds (map is rebuilt from scratch).
    expect(() => saveFileScroll(undefined, '/repo/a.md', { top: 50 })).not.toThrow();
    expect(loadFileScroll(undefined, '/repo/a.md')?.top).toBe(50);
  });

  it('a non-object payload (array / string / null) reads as empty', async () => {
    const { loadFileScroll } = await load();
    for (const bad of ['[1,2,3]', '"str"', 'null', '42']) {
      storage.setItem('open-walnut-file-view-scroll', bad);
      expect(loadFileScroll(undefined, '/repo/a.md')).toBeNull();
    }
  });

  it('a malformed entry (missing/NaN top) reads as empty', async () => {
    const { loadFileScroll } = await load();
    storage.setItem(
      'open-walnut-file-view-scroll',
      JSON.stringify({ 'local /repo/a.md': { source: true }, 'local /repo/b.md': { top: 'x' } }),
    );
    expect(loadFileScroll(undefined, '/repo/a.md')).toBeNull();
    expect(loadFileScroll(undefined, '/repo/b.md')).toBeNull();
  });

  it('a throwing localStorage (Safari private mode / quota) never propagates', async () => {
    const { saveFileScroll, loadFileScroll, saveSelectedFile, loadSelectedFile } = await load();
    vi.stubGlobal('localStorage', {
      getItem() { throw new Error('denied'); },
      setItem() { throw new Error('quota'); },
      removeItem() { throw new Error('denied'); },
    });
    expect(() => saveFileScroll(undefined, '/repo/a.md', { top: 10 })).not.toThrow();
    expect(loadFileScroll(undefined, '/repo/a.md')).toBeNull();
    expect(() => saveSelectedFile(undefined, '/repo', '/repo/a.md')).not.toThrow();
    expect(loadSelectedFile(undefined, '/repo')).toBeNull();
  });
});
