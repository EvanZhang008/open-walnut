/**
 * Regression tests for the shared fuzzy util (web/src/utils/fuzzy.ts).
 * fuzzyScore weights are PINNED here — FileMentionPopup and SessionFileExplorer
 * rank with them (via recentFolders re-export); changing weights must be a
 * conscious decision that updates this file.
 */
import { describe, it, expect } from 'vitest';
import { tokenize, isSubsequence, fuzzyScore, matchQuality, qualityRank } from '../../../web/src/utils/fuzzy';
// The re-export path older callers use must remain intact.
import { fuzzyScore as reExported } from '../../../web/src/utils/recentFolders';

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
