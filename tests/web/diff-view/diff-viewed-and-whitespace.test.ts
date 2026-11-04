/**
 * The Changed tab's per-file Viewed marks (diffViewed.ts) and its Ignore
 * whitespace diff (diffPatch.ts), against the real `diff` + react-diff-view.
 *
 *  - A mark is a signature of the change it was ticked at: the same change
 *    stays Viewed, a new version reads Changed, for every kind of list row
 *    (names-only git rows, light session rows, full-content rows).
 *  - Marks are per session AND per comparison, stored under a prefix the
 *    ui-prefs mirror does not sync, and the oldest sessions are dropped.
 *  - Ignore whitespace hides lines that differ only in spaces, tabs or line
 *    endings, and keeps every real change.
 *
 * Runs under vitest.diff-view.config.ts (localStorage is a stub here).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { isDelete, isInsert, markEdits, tokenize } from 'react-diff-view';
import type { SessionFileChange } from '@/api/session-changes';
import { buildFileData, differsOnlyInWhitespace, unmarkWhitespaceEdits } from '@/components/sessions/diffPatch';
import { changeSignature, compareKey, loadViewedMarks, saveViewedMarks, viewedState, VIEWED_STORAGE_PREFIX } from '@/components/sessions/diffViewed';

class FakeStorage {
  store = new Map<string, string>();
  get length() { return this.store.size; }
  key(i: number) { return [...this.store.keys()][i] ?? null; }
  getItem(k: string) { return this.store.get(k) ?? null; }
  setItem(k: string, v: string) { this.store.set(k, v); }
  removeItem(k: string) { this.store.delete(k); }
}

let storage: FakeStorage;
beforeEach(() => { storage = new FakeStorage(); vi.stubGlobal('localStorage', storage); });

function change(over: Partial<SessionFileChange> = {}): SessionFileChange {
  return { filePath: '/repo/src/a.ts', relPath: 'src/a.ts', before: 'one\n', after: 'two\n', status: 'modified', ops: 1, partial: false, ...over };
}

describe('Viewed marks', () => {
  it('a mark holds while the change is the same and reads Changed once it is not, for every row kind', () => {
    const rows: Array<[SessionFileChange, boolean, SessionFileChange]> = [
      // names-only git row (branch / commit): the working-tree blob id
      [change({ sig: 'aaa', before: '', after: '' }), true, change({ sig: 'bbb', before: '', after: '' })],
      // light session row: one more edit by the session
      [change({ before: '', after: '', ops: 2 }), true, change({ before: '', after: '', ops: 3 })],
      // full-content row (uncommitted / not yet pushed)
      [change(), false, change({ after: 'three\n' })],
    ];
    for (const [first, light, later] of rows) {
      const marks = { [first.filePath]: changeSignature(first, light)! };
      expect(viewedState(marks, first.filePath, changeSignature(first, light))).toBe('viewed');
      expect(viewedState(marks, first.filePath, changeSignature({ ...first }, light))).toBe('viewed');
      expect(viewedState(marks, later.filePath, changeSignature(later, light))).toBe('changed');
      expect(viewedState({}, first.filePath, changeSignature(first, light))).toBe('unviewed');
    }
  });

  it('a status change (modified to deleted) is a new version too', () => {
    const a = change({ sig: 'x' });
    const marks = { [a.filePath]: changeSignature(a, true)! };
    expect(viewedState(marks, a.filePath, changeSignature({ ...a, status: 'deleted' }, true))).toBe('changed');
  });

  it('marks are kept per session and per comparison', () => {
    saveViewedMarks('s1', compareKey({ base: 'branch' }), { '/repo/a.ts': 'g:1' });
    saveViewedMarks('s1', compareKey({ base: 'commit', commit: 'abc1234' }), { '/repo/b.ts': 'g:2' });
    saveViewedMarks('s2', compareKey({ base: 'session' }), { '/repo/c.ts': 'o:1' });
    expect(loadViewedMarks('s1', 'branch:')).toEqual({ '/repo/a.ts': 'g:1' });
    expect(loadViewedMarks('s1', 'commit:abc1234')).toEqual({ '/repo/b.ts': 'g:2' });
    expect(loadViewedMarks('s1', 'session')).toEqual({});
    expect(loadViewedMarks('s2', 'session')).toEqual({ '/repo/c.ts': 'o:1' });
    expect(compareKey({ base: 'branch', ref: 'origin/main' })).toBe('branch:origin/main');
    // Clearing the last mark of a session removes its key.
    saveViewedMarks('s2', 'session', {});
    expect(storage.getItem(VIEWED_STORAGE_PREFIX + 's2')).toBeNull();
  });

  it('never syncs: the key prefix is outside the ui-prefs mirror (open-walnut-*, walnut-todo-*)', () => {
    expect(VIEWED_STORAGE_PREFIX.startsWith('open-walnut-')).toBe(false);
    expect(VIEWED_STORAGE_PREFIX.startsWith('walnut-todo-')).toBe(false);
  });

  it('drops the oldest sessions past the cap, keeping the newest', () => {
    const now = vi.spyOn(Date, 'now');
    for (let i = 0; i < 160; i++) {
      now.mockReturnValue(1_000_000 + i);
      saveViewedMarks(`s${i}`, 'session', { '/f': 'o:1' });
    }
    now.mockRestore();
    const kept = [...storage.store.keys()].filter((k) => k.startsWith(VIEWED_STORAGE_PREFIX));
    expect(kept.length).toBeLessThanOrEqual(150);
    expect(storage.getItem(VIEWED_STORAGE_PREFIX + 's159')).not.toBeNull();
    expect(storage.getItem(VIEWED_STORAGE_PREFIX + 's0')).toBeNull();
  });

  it('unreadable storage reads as no marks, never a throw', () => {
    storage.setItem(VIEWED_STORAGE_PREFIX + 'bad', '{not json');
    expect(loadViewedMarks('bad', 'session')).toEqual({});
    saveViewedMarks('bad', 'session', { '/f': 'o:1' });
    expect(loadViewedMarks('bad', 'session')).toEqual({ '/f': 'o:1' });
  });
});

describe('Ignore whitespace', () => {
  const lines = (file: ReturnType<typeof buildFileData>) => file!.hunks.flatMap((h) => h.changes);

  it('a reindent (tabs to spaces) and trailing spaces vanish; a real edit next to them stays', () => {
    const before = 'function f() {\n\tconst a = 1\n\treturn a\n}\n';
    const after = 'function f() {\n  const a = 2  \n  return a\n}\n';
    const plain = lines(buildFileData(change({ before, after })));
    expect(plain.filter(isInsert)).toHaveLength(2);
    const ignored = lines(buildFileData(change({ before, after }), { ignoreWhitespace: true }));
    expect(ignored.filter(isInsert).map((c) => c.content)).toEqual(['  const a = 2  ']);
    expect(ignored.filter(isDelete).map((c) => c.content)).toEqual(['\tconst a = 1']);
  });

  it('a file that changed only in whitespace has no diff, and says so', () => {
    const before = 'a b\n\tc\n';
    const after = 'a  b\r\n    c\n';
    expect(differsOnlyInWhitespace(before, after)).toBe(true);
    expect(buildFileData(change({ before, after }), { ignoreWhitespace: true })).toBeNull();
    expect(buildFileData(change({ before, after }))).not.toBeNull();
    expect(differsOnlyInWhitespace('a\n', 'b\n')).toBe(false);
    expect(differsOnlyInWhitespace('a\n', 'a\n')).toBe(false);
  });

  it('an added blank line still counts (it is a line, not whitespace inside one)', () => {
    const ignored = lines(buildFileData(change({ before: 'a\nb\n', after: 'a\n\nb\n' }), { ignoreWhitespace: true }));
    expect(ignored.filter(isInsert)).toHaveLength(1);
  });

  it('intra-line marks skip whitespace: a re-indented line with one changed word marks only the word', () => {
    const before = 'function f() {\n\tconst total = 1\n\treturn total\n}\n';
    const after = 'function f() {\n    const total = 2   \n    return total + offset\n}\n';
    const file = buildFileData(change({ before, after }), { ignoreWhitespace: true })!;
    type Node = { type: string; value?: string; children?: Node[] };
    const text = (n: Node): string => (n.value ?? '') + (n.children ?? []).map(text).join('');
    const edits = (lines: Node[][]): string[] => {
      const out: string[] = [];
      const walk = (n: Node) => { if (n.type === 'edit') out.push(text(n)); (n.children ?? []).forEach(walk); };
      lines.forEach((l) => l.forEach(walk));
      return out;
    };
    const plain = tokenize(file.hunks, { highlight: false, enhancers: [markEdits(file.hunks, { type: 'block' })] });
    // Without the pass, the new indentation / trailing spaces light up too.
    expect(edits(plain.new as Node[][]).some((t) => /^\s|\s$/.test(t))).toBe(true);
    const blind = tokenize(file.hunks, { highlight: false, enhancers: [markEdits(file.hunks, { type: 'block' }), unmarkWhitespaceEdits] });
    const marked = [...edits(blind.old as Node[][]), ...edits(blind.new as Node[][])];
    expect(marked.length).toBeGreaterThan(0);
    for (const t of marked) expect(t, JSON.stringify(t)).toMatch(/^\S(.*\S)?$/s);
    expect(edits(blind.new as Node[][]).join('')).toContain('2');
    // Spaces INSIDE one marked run stay marked: ' + offset' reads as one edit, not word pieces.
    expect(edits(blind.new as Node[][])).toContain('+ offset');
  });
});
