/**
 * Regression tests for the shared fuzzy util (web/src/utils/fuzzy.ts).
 * fuzzyScore weights are PINNED here — FileMentionPopup and SessionFileExplorer
 * rank with them (via recentFolders re-export); changing weights must be a
 * conscious decision that updates this file.
 */
import { describe, it, expect, vi } from 'vitest';
import * as client from '../../../web/src/api/client';
import { tokenize, isSubsequence, fuzzyScore, matchQuality, qualityRank } from '../../../web/src/utils/fuzzy';
// The re-export path older callers use must remain intact.
import { fuzzyScore as reExported, fuzzyMatchRecents, getRecentFolders } from '../../../web/src/utils/recentFolders';

describe('tokenize', () => {
  it('splits on punctuation and lowercases', () => {
    expect(tokenize('a/b-c_d')).toEqual(['a', 'b', 'c', 'd']);
    expect(tokenize('MyLongPackageName')).toEqual(['mylongpackagename']);
  });
});

describe('isSubsequence', () => {
  it('in-order chars match', () => {
    expect(isSubsequence('mrn', 'marina')).toBe(true);
    expect(isSubsequence('nrm', 'marina')).toBe(false);
  });
});

describe('fuzzyScore — pinned weights', () => {
  it('substring of full path = +10 (+ token partials)', () => {
    // 'walnut' hits: substring(+10), lastSeg substring(+6), exact token(+4), lastSeg token(+2)
    expect(fuzzyScore('walnut', '/code/walnut')).toBe(22);
  });
  it('mid-path segment hit without folder-name hit', () => {
    // 'code' in '/code/walnut': substring(+10) + exact token(+4); NOT in last segment
    expect(fuzzyScore('code', '/code/walnut')).toBe(14);
  });
  it('subsequence-only fallback = 1', () => {
    expect(fuzzyScore('mrn', '/x/marina')).toBe(1);
  });
  it('no signal = 0', () => {
    expect(fuzzyScore('zzz', '/a/b')).toBe(0);
  });
  it('re-export from recentFolders stays wired', () => {
    expect(reExported('walnut', '/code/walnut')).toBe(22);
  });
});

describe('recent folder ranking', () => {
  it('retains usage counts while isolating candidates to the requested host', async () => {
    const get = vi.spyOn(client, 'apiGet').mockResolvedValue({ dirs: [
      { cwd: '/projects/walnut', host: null, count: 1186 },
      { cwd: '/projects/walnut', host: 'remote', count: 9999 },
    ] });
    try {
      expect(await getRecentFolders()).toEqual([{ path: '/projects/walnut', host: undefined, count: 1186 }]);
      expect(await getRecentFolders('remote')).toEqual([{ path: '/projects/walnut', host: 'remote', count: 9999 }]);
      get.mockRejectedValueOnce(new Error('Unavailable'));
      expect(await getRecentFolders()).toEqual([]);
      expect(await getRecentFolders()).toHaveLength(1);
      // An older server sends no count; recency order still holds.
      get.mockResolvedValueOnce({ dirs: [{ cwd: '/projects/walnut', host: null }] });
      expect(await getRecentFolders()).toEqual([{ path: '/projects/walnut', host: undefined, count: undefined }]);
    } finally { get.mockRestore(); }
  });

  it('ranks a frequently used workspace above equally matching nearby data folders', () => {
    const folders = [
      { path: '/home/demo/.open-walnut', count: 117 },
      { path: '/home/demo/projects/walnut', count: 1186 },
      { path: '/home/demo/.open-walnut/conversations/walnut' },
      { path: '/home/demo/.open-walnut/skills/walnut' },
    ];
    expect(fuzzyMatchRecents('walnut', folders)[0].path).toBe('/home/demo/projects/walnut');
  });

  it('keeps the empty query in recency order so a just-used folder stays visible', () => {
    const folders = [
      { path: '/home/demo/new-project', count: 1 },
      { path: '/home/demo/projects/walnut', count: 1186 },
      { path: '/home/demo' },
    ];
    expect(fuzzyMatchRecents('', folders)).toEqual(folders);
  });

  it('keeps stronger matches ahead of usage frequency', () => {
    const folders = [
      { path: '/projects/walnut/archive', count: 1000 },
      { path: '/projects/walnut', count: 1 },
    ];
    expect(fuzzyMatchRecents('walnut', folders).map(r => r.path)).toEqual([
      '/projects/walnut', '/projects/walnut/archive',
    ]);
  });

  it('breaks equal frequency ties by server recency and preserves unvisited matches', () => {
    const folders = [
      { path: '/new/walnut', count: 5 },
      { path: '/older/walnut', count: 5 },
      { path: '/nearby/walnut' },
      { path: '/nearby/other' },
    ];
    expect(fuzzyMatchRecents('walnut', folders)).toEqual(folders.slice(0, 3));
    expect(fuzzyMatchRecents('missing', folders)).toEqual([]);
    expect(fuzzyMatchRecents('', [])).toEqual([]);
  });

  it('handles dense results and case-insensitive queries without mutating candidates', () => {
    const folders = Array.from({ length: 600 }, (_, i) => ({ path: `/project-${i}/walnut`, count: i }));
    const original = [...folders];
    expect(fuzzyMatchRecents(' WALNUT ', folders)[0]).toBe(folders[599]);
    expect(fuzzyMatchRecents('', folders)).toHaveLength(600);
    expect(folders).toEqual(original);
  });
});

describe('matchQuality bands', () => {
  it('prefix > substring > subsequence > none', () => {
    expect(matchQuality('mar', 'marina')).toBe('prefix');
    expect(matchQuality('rin', 'marina')).toBe('substring');
    expect(matchQuality('mrn', 'marina')).toBe('subsequence');
    expect(matchQuality('xyz', 'marina')).toBe('none');
  });
  it('case-insensitive', () => {
    expect(matchQuality('MAR', 'Marina')).toBe('prefix');
  });
  it('empty needle is prefix (admit-all)', () => {
    expect(matchQuality('', 'anything')).toBe('prefix');
  });
  it('qualityRank is strictly ordered', () => {
    expect(qualityRank('prefix')).toBeGreaterThan(qualityRank('substring'));
    expect(qualityRank('substring')).toBeGreaterThan(qualityRank('subsequence'));
    expect(qualityRank('subsequence')).toBeGreaterThan(qualityRank('none'));
  });
});
