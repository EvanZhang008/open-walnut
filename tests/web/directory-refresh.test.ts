import { describe, expect, it } from 'vitest';
import { visibleDirectoryPaths, applyDirectoryListings } from '@/components/sessions/directory-refresh';
import type { DirEntry } from '@/api/files';

const dir = (name: string): DirEntry => ({ name, type: 'dir' });
const file = (name: string, size = 1): DirEntry => ({ name, type: 'file', size });

describe('visible directory refresh', () => {
  it('walks only reachable expanded directories and deduplicates overlapping roots', () => {
    const children = new Map([
      ['/repo', [dir('docs'), dir('closed')]],
      ['/repo/docs', [dir('deep'), file('readme.md')]],
      ['/repo/docs/deep', []],
      ['/repo/closed', [dir('old')]],
    ]);
    expect(visibleDirectoryPaths(['/repo', '/repo/docs'], new Set([
      '/repo/docs', '/repo/docs/deep', '/repo/closed/old', '/repo/deleted',
    ]), children)).toEqual(['/repo', '/repo/docs', '/repo/docs/deep']);
    expect(visibleDirectoryPaths([], new Set(['/repo/docs']), children)).toEqual([]);
  });

  it('does not cap a tree at the server batch size', () => {
    const children = new Map([['/repo', Array.from({ length: 130 }, (_, i) => dir(`dir-${i}`))]]);
    const expanded = new Set(Array.from({ length: 130 }, (_, i) => `/repo/dir-${i}`));
    expect(visibleDirectoryPaths(['/repo'], expanded, children)).toHaveLength(131);
  });

  it('invalidates a deleted directory and its descendants without reviving a stale same-batch answer', () => {
    const current = new Map([
      ['/repo', [dir('docs'), dir('docs-other')]],
      ['/repo/docs', [dir('deep')]],
      ['/repo/docs/deep', [file('gone.txt')]],
      ['/repo/docs-other', [file('keep.txt')]],
    ]);
    const next = applyDirectoryListings(current, [
      { path: '/repo', entries: [dir('docs-other')] },
      { path: '/repo/docs', entries: [file('stale.txt')] },
    ]);
    expect(next.has('/repo/docs')).toBe(false);
    expect(next.has('/repo/docs/deep')).toBe(false);
    expect(next.get('/repo/docs-other')).toBe(current.get('/repo/docs-other'));
    const recreated = applyDirectoryListings(next, [{ path: '/repo', entries: [dir('docs'), dir('docs-other')] }]);
    expect(recreated.has('/repo/docs')).toBe(false);
  });

  it('unchanged rows preserve the map and row identities', () => {
    const entries = [dir('docs'), file('readme.md')];
    const current = new Map([['/repo', entries]]);
    expect(applyDirectoryListings(current, [{ path: '/repo', entries: entries.map(e => ({ ...e })) }])).toBe(current);
  });

  it('adds, deletes, renames and changes types or sizes without replacing unchanged directories', () => {
    const untouched = [file('keep.txt')];
    const current = new Map([['/repo', [file('old.txt')]], ['/other', untouched]]);
    for (const entries of [[file('new.txt')], [], [dir('old.txt')], [file('old.txt', 2)]]) {
      const next = applyDirectoryListings(current, [{ path: '/repo', entries }]);
      expect(next).not.toBe(current);
      expect(next.get('/repo')).toEqual(entries);
      expect(next.get('/other')).toBe(untouched);
      expect(current.get('/repo')).toEqual([file('old.txt')]);
    }
  });
});
