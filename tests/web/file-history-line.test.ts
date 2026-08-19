/**
 * Editor-style positioned history (2026-08-18 feedback: "Back should return to
 * the exact position I jumped FROM, like every code editor").
 *
 * Contract:
 *  - A reference jump pushes {path, line} — Forward returns to the landing spot.
 *  - stampFileHistoryLine pins the DEPARTURE line on the current entry, so Back
 *    lands where the reader was, not at the file top.
 *  - Legacy string-array stacks in localStorage migrate on read.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

class FakeStorage {
  private store = new Map<string, string>();
  getItem(k: string) { return this.store.get(k) ?? null; }
  setItem(k: string, v: string) { this.store.set(k, v); }
  removeItem(k: string) { this.store.delete(k); }
}

beforeEach(() => {
  vi.stubGlobal('localStorage', new FakeStorage());
  vi.resetModules();
});

async function load() {
  return await import('../../web/src/utils/file-view-state');
}

describe('positioned history entries', () => {
  it('a jump records its landing line; a same-file jump to a NEW line still pushes', async () => {
    const { pushFileHistory } = await load();
    let h = pushFileHistory({ entries: [], index: -1 }, '/repo/a.go');
    h = pushFileHistory(h, '/repo/b.go', 42);
    expect(h.entries).toEqual([{ path: '/repo/a.go' }, { path: '/repo/b.go', line: 42 }]);
    // Same file, different line = a real stop (jumping between refs in one file).
    h = pushFileHistory(h, '/repo/b.go', 99);
    expect(h.entries[2]).toEqual({ path: '/repo/b.go', line: 99 });
    // Same file, same line = no-op.
    expect(pushFileHistory(h, '/repo/b.go', 99)).toBe(h);
  });

  it('stampFileHistoryLine pins the departure position on the CURRENT entry', async () => {
    const { pushFileHistory, stampFileHistoryLine } = await load();
    let h = pushFileHistory({ entries: [], index: -1 }, '/repo/a.go');
    // Reading a.go at line 919, then cmd+clicking away → stamp, then push.
    h = stampFileHistoryLine(h, '/repo/a.go', 919);
    h = pushFileHistory(h, '/repo/b.go', 42);
    // Back now knows to return to a.go:919.
    expect(h.entries[0]).toEqual({ path: '/repo/a.go', line: 919 });
  });

  it('stamp is a no-op when the current entry is a different file or already there', async () => {
    const { stampFileHistoryLine } = await load();
    const h = { entries: [{ path: '/repo/a.go', line: 5 }], index: 0 };
    expect(stampFileHistoryLine(h, '/repo/other.go', 9)).toBe(h);
    expect(stampFileHistoryLine(h, '/repo/a.go', 5)).toBe(h);
  });

  it('legacy string-array stacks migrate on read (old localStorage persists)', async () => {
    const { loadFileHistory } = await load();
    localStorage.setItem(
      'open-walnut-file-explorer-history:local:session:s1',
      JSON.stringify({ entries: ['/repo/a.md', '/repo/b.md'], index: 1 }),
    );
    expect(loadFileHistory(undefined, 'session:s1')).toEqual({
      entries: [{ path: '/repo/a.md' }, { path: '/repo/b.md' }],
      index: 1,
    });
  });

  it('lined entries round-trip through storage; junk lines are dropped', async () => {
    const { saveFileHistory, loadFileHistory } = await load();
    saveFileHistory(undefined, 'session:s1', { entries: [{ path: '/a', line: 7 }], index: 0 });
    expect(loadFileHistory(undefined, 'session:s1').entries).toEqual([{ path: '/a', line: 7 }]);
    localStorage.setItem(
      'open-walnut-file-explorer-history:local:session:s2',
      JSON.stringify({ entries: [{ path: '/a', line: -3 }, { path: '/b', line: 1.5 }, { path: '/c', line: 2 }], index: 0 }),
    );
    expect(loadFileHistory(undefined, 'session:s2').entries).toEqual([
      { path: '/a' }, { path: '/b' }, { path: '/c', line: 2 },
    ]);
  });
});
