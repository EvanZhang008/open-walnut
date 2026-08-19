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

describe('scope normalization (the 2026-08-09 root cause)', () => {
  it('a trailing slash is the SAME scope — /repo and /repo/ must not split the memory', async () => {
    const { saveSelectedFile, loadSelectedFile } = await load();
    saveSelectedFile(undefined, '/repo/', '/repo/a.md');
    expect(loadSelectedFile(undefined, '/repo')).toBe('/repo/a.md');
  });

  it('THE BUG: two entry points keyed by tree root never met; one scope fixes it', async () => {
    const { saveSelectedFile, loadSelectedFile } = await load();
    // What used to happen: the chat file-path click rooted the explorer at the
    // clicked file's PARENT dir and saved under that; the Files chip rooted at the
    // session cwd and read a different key → empty "Select a file to preview".
    const sessionCwd = '/repo';
    const clickRoot = '/repo/src/web';
    saveSelectedFile(undefined, clickRoot, '/repo/src/web/App.tsx');
    expect(loadSelectedFile(undefined, sessionCwd)).toBeNull(); // the old, broken keying
    // With both callers passing one stable SCOPE, the chip finds it.
    saveSelectedFile(undefined, sessionCwd, '/repo/src/web/App.tsx');
    expect(loadSelectedFile(undefined, sessionCwd)).toBe('/repo/src/web/App.tsx');
  });
});

describe('session isolation (the follow-up bug: cwd is NOT a session)', () => {
  it('THE BUG: two sessions in the SAME repo must not share a memory', async () => {
    const { sessionScope, saveSelectedFile, loadSelectedFile } = await load();
    // The first fix keyed the scope on the session CWD. Two sessions opened on the
    // same repo share a cwd, so they shared a key: opening a file in session 1 made
    // it appear in session 2. Sessions are completely isolated — the id is the key.
    const s1 = sessionScope('sess-1');
    const s2 = sessionScope('sess-2');
    expect(s1).not.toBe(s2);

    saveSelectedFile(undefined, s1, '/repo/a.md');
    expect(loadSelectedFile(undefined, s2)).toBeNull(); // no leak into the sibling
    saveSelectedFile(undefined, s2, '/repo/b.md');
    expect(loadSelectedFile(undefined, s1)).toBe('/repo/a.md'); // and none back
  });

  it('back/forward history is per session too — no shared stack', async () => {
    const {
      sessionScope, loadFileHistory, saveFileHistory, pushFileHistory,
    } = await load();
    const s1 = sessionScope('sess-1');
    const s2 = sessionScope('sess-2');

    saveFileHistory(undefined, s1, pushFileHistory(loadFileHistory(undefined, s1), '/repo/a.md'));
    // Session 2 starts with an EMPTY stack — its Back button must be dead, not
    // wired to whatever the neighbouring session was reading.
    expect(loadFileHistory(undefined, s2)).toEqual({ entries: [], index: -1 });

    saveFileHistory(undefined, s2, pushFileHistory(loadFileHistory(undefined, s2), '/repo/b.md'));
    expect(loadFileHistory(undefined, s1).entries).toEqual([{ path: '/repo/a.md' }]);
    expect(loadFileHistory(undefined, s2).entries).toEqual([{ path: '/repo/b.md' }]);
  });

  it('a session scope cannot collide with a session-less path scope', async () => {
    const { sessionScope, saveSelectedFile, loadSelectedFile } = await load();
    // The standalone FileViewer overlay has no session and falls back to the tree
    // root — a path. The prefix keeps the two namespaces apart even if a session
    // were ever named like a path.
    const scoped = sessionScope('/repo');
    saveSelectedFile(undefined, scoped, '/repo/a.md');
    expect(loadSelectedFile(undefined, '/repo')).toBeNull();
  });

  it('the same session keeps ONE memory regardless of where the tree is rooted', async () => {
    const { sessionScope, saveSelectedFile, loadSelectedFile } = await load();
    // Both fixes have to hold at once: isolated across sessions, yet stable across
    // the two entry points WITHIN a session (which resolve to different roots).
    const scope = sessionScope('sess-1');
    saveSelectedFile(undefined, scope, '/repo/src/web/App.tsx');
    expect(loadSelectedFile(undefined, scope)).toBe('/repo/src/web/App.tsx');
  });
});

describe('back/forward history (browser semantics)', () => {
  it('pushes visited files in order and points at the newest', async () => {
    const { pushFileHistory } = await load();
    let h = { entries: [] as { path: string; line?: number }[], index: -1 };
    h = pushFileHistory(h, '/repo/a.md');
    h = pushFileHistory(h, '/repo/b.md');
    expect(h).toEqual({ entries: [{ path: '/repo/a.md' }, { path: '/repo/b.md' }], index: 1 });
  });

  it('re-opening the file already shown is a no-op (no duplicate stack entries)', async () => {
    const { pushFileHistory } = await load();
    const h = pushFileHistory({ entries: [{ path: '/repo/a.md' }], index: 0 }, '/repo/a.md');
    expect(h).toEqual({ entries: [{ path: '/repo/a.md' }], index: 0 });
  });

  it('re-visiting an EARLIER file still pushes (browsers keep repeat visits)', async () => {
    const { pushFileHistory } = await load();
    const h = pushFileHistory({ entries: [{ path: '/repo/a.md' }, { path: '/repo/b.md' }], index: 1 }, '/repo/a.md');
    expect(h).toEqual({ entries: [{ path: '/repo/a.md' }, { path: '/repo/b.md' }, { path: '/repo/a.md' }], index: 2 });
  });

  it('navigating after Back truncates the forward tail — that future is gone', async () => {
    const { pushFileHistory } = await load();
    // a → b → c, then Back twice (index 0), then open d.
    const h = pushFileHistory({ entries: [{ path: '/a' }, { path: '/b' }, { path: '/c' }], index: 0 }, '/d');
    expect(h).toEqual({ entries: [{ path: '/a' }, { path: '/d' }], index: 1 });
  });

  it('caps the stack, dropping oldest — the index follows the shift', async () => {
    const { pushFileHistory, HISTORY_MAX_ENTRIES } = await load();
    let h = { entries: [] as { path: string; line?: number }[], index: -1 };
    for (let i = 0; i < HISTORY_MAX_ENTRIES + 10; i++) h = pushFileHistory(h, `/f${i}.md`);
    expect(h.entries.length).toBe(HISTORY_MAX_ENTRIES);
    expect(h.index).toBe(HISTORY_MAX_ENTRIES - 1);
    expect(h.entries[0]!.path).toBe('/f10.md'); // the first 10 were evicted
    expect(h.entries[h.index]!.path).toBe(`/f${HISTORY_MAX_ENTRIES + 9}.md`);
  });

  it('round-trips through storage, keyed per host + scope', async () => {
    const { saveFileHistory, loadFileHistory } = await load();
    saveFileHistory(undefined, '/repo', { entries: [{ path: '/repo/a' }, { path: '/repo/b' }], index: 0 });
    expect(loadFileHistory(undefined, '/repo')).toEqual({ entries: [{ path: '/repo/a' }, { path: '/repo/b' }], index: 0 });
    expect(loadFileHistory('devbox', '/repo').entries).toEqual([]);
    expect(loadFileHistory(undefined, '/other').entries).toEqual([]);
  });

  it('an empty stack clears storage instead of persisting a husk', async () => {
    const { saveFileHistory } = await load();
    saveFileHistory(undefined, '/repo', { entries: [{ path: '/a' }], index: 0 });
    saveFileHistory(undefined, '/repo', { entries: [], index: -1 });
    expect(storage.getItem('open-walnut-file-explorer-history:local:/repo')).toBeNull();
  });

  it('a stored index out of range is clamped, never stranded on a hole', async () => {
    const { loadFileHistory } = await load();
    storage.setItem('open-walnut-file-explorer-history:local:/repo', JSON.stringify({ entries: ['/a', '/b'], index: 9 }));
    expect(loadFileHistory(undefined, '/repo').index).toBe(1);
    storage.setItem('open-walnut-file-explorer-history:local:/repo', JSON.stringify({ entries: ['/a', '/b'], index: -5 }));
    expect(loadFileHistory(undefined, '/repo').index).toBe(0);
  });

  it('corrupt / non-string entries degrade to no history (buttons stay disabled)', async () => {
    const { loadFileHistory } = await load();
    for (const bad of ['{not json', '[1,2]', 'null', '{"entries":"nope"}', '{"entries":[]}']) {
      storage.setItem('open-walnut-file-explorer-history:local:/repo', bad);
      expect(loadFileHistory(undefined, '/repo')).toEqual({ entries: [], index: -1 });
    }
    storage.setItem('open-walnut-file-explorer-history:local:/repo', JSON.stringify({ entries: ['/a', 5, null, '/b'], index: 3 }));
    expect(loadFileHistory(undefined, '/repo').entries).toEqual([{ path: '/a' }, { path: '/b' }]);
  });

  it('a deleted file leaves the stack — Back must not land on a dead file', async () => {
    const { removeFromFileHistory } = await load();
    const e = (path: string) => ({ path });
    // Deleting the CURRENT entry lands on its predecessor.
    expect(removeFromFileHistory({ entries: [e('/a'), e('/b'), e('/c')], index: 1 }, '/b'))
      .toEqual({ entries: [e('/a'), e('/c')], index: 0 });
    // Deleting an earlier entry keeps you on the same file (index shifts left).
    expect(removeFromFileHistory({ entries: [e('/a'), e('/b'), e('/c')], index: 2 }, '/a'))
      .toEqual({ entries: [e('/b'), e('/c')], index: 1 });
    // Every occurrence goes, not just the first.
    expect(removeFromFileHistory({ entries: [e('/a'), e('/b'), e('/a')], index: 2 }, '/a'))
      .toEqual({ entries: [e('/b')], index: 0 });
    // Removing the only entry empties the stack.
    expect(removeFromFileHistory({ entries: [e('/a')], index: 0 }, '/a'))
      .toEqual({ entries: [], index: -1 });
    // A path that isn't there returns the SAME object (lets callers skip a write).
    const h = { entries: [e('/a')], index: 0 };
    expect(removeFromFileHistory(h, '/zzz')).toBe(h);
  });

  it('a throwing localStorage never propagates out of the history store', async () => {
    const { saveFileHistory, loadFileHistory } = await load();
    vi.stubGlobal('localStorage', {
      getItem() { throw new Error('denied'); },
      setItem() { throw new Error('quota'); },
      removeItem() { throw new Error('denied'); },
    });
    expect(() => saveFileHistory(undefined, '/repo', { entries: [{ path: '/a' }], index: 0 })).not.toThrow();
    expect(loadFileHistory(undefined, '/repo')).toEqual({ entries: [], index: -1 });
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
