/**
 * Unit tests for the unified path-selector ranking: sort-key ordering, the
 * admission rule (user-verified "Marina" example), frecency decay, and
 * section building (host grouping / local-first / no cross-host dedup).
 */
import { describe, it, expect } from 'vitest';
import {
  frecencyScore,
  rankCandidates,
  buildSections,
  type Candidate,
} from '../../../web/src/components/sessions/path-selector/ranking';
import { classifyInput } from '../../../web/src/components/sessions/path-selector/input-model';
import type { WorkingDirEntry } from '../../../web/src/api/sessions';

const NOW = new Date('2026-07-14T00:00:00Z').getTime();

function hist(cwd: string, count: number, daysAgo: number, host: string | null = null): WorkingDirEntry {
  return {
    cwd, host, project: 'Test', count,
    lastUsed: new Date(NOW - daysAgo * 86400_000).toISOString(),
  };
}

const live = (cwd: string, depth: number, history?: WorkingDirEntry): Candidate =>
  ({ cwd, host: null, source: 'live', depth, history });

describe('frecencyScore', () => {
  it('decays with age — 7-day half-life', () => {
    const fresh = frecencyScore(10, new Date(NOW).toISOString(), NOW);
    const week = frecencyScore(10, new Date(NOW - 7 * 86400_000).toISOString(), NOW);
    const twoWeeks = frecencyScore(10, new Date(NOW - 14 * 86400_000).toISOString(), NOW);
    expect(fresh).toBeCloseTo(10, 5);
    expect(week).toBeCloseTo(5, 5);
    expect(twoWeeks).toBeCloseTo(2.5, 5);
  });
  it('recent low-count can beat stale high-count', () => {
    const recent = frecencyScore(3, new Date(NOW - 86400_000).toISOString(), NOW);   // 1d old
    const stale = frecencyScore(50, new Date(NOW - 40 * 86400_000).toISOString(), NOW); // 40d old
    expect(recent).toBeGreaterThan(stale);
  });
});

describe('rankCandidates — the Marina example (user-verified)', () => {
  const base = '/w/team/';
  const marinaLeaf = live(base + 'Marina', 1);
  const deepNoHist = live(base + 'Marina/NestedSubproject', 2);

  it('leaf-segment hit ranks first by default', () => {
    const state = classifyInput(base + 'Marina');
    const ranked = rankCandidates(state, [deepNoHist, marinaLeaf], NOW);
    // deep candidate matching only mid-path, not in history → dropped entirely
    expect(ranked.map(r => r.cwd)).toEqual([base + 'Marina']);
  });

  it('a LEAF-prefix hit outranks a history-only mid-path match (relevance > frecency)', () => {
    // Typing 'Marina' means the user wants the folder literally named Marina —
    // not a frequently-visited child whose only tie to 'Marina' is a parent-path
    // (mid-path) match. History decides order only AMONG equally-relevant hits,
    // so it must NOT resurrect a mid-path match above a leaf-prefix one. (This is
    // the same shape as the real 'mcp' → 'mcps' bug: the leaf hit must lead.)
    const state = classifyInput(base + 'Marina');
    const deepWithHist = live(base + 'Marina/NestedSubproject', 2, hist(base + 'Marina/NestedSubproject', 5, 1));
    const ranked = rankCandidates(state, [marinaLeaf, deepWithHist], NOW);
    expect(ranked[0].cwd).toBe(base + 'Marina');
    expect(ranked[1].cwd).toBe(base + 'Marina/NestedSubproject');
  });

  it('among two leaf-prefix hits, the history one wins (frecency tiebreak)', () => {
    // Both leaf-hit 'mcp': history breaks the tie, so a frequently-used sibling
    // still floats above a never-visited one of equal match quality.
    const state = classifyInput(base + 'mcp');
    const fresh = live(base + 'mcp-a', 1);
    const known = live(base + 'mcp-b', 1, hist(base + 'mcp-b', 5, 1));
    const ranked = rankCandidates(state, [fresh, known], NOW);
    expect(ranked[0].cwd).toBe(base + 'mcp-b');
    expect(ranked[1].cwd).toBe(base + 'mcp-a');
  });
});

describe('rankCandidates — sort keys', () => {
  it('history hits sort above non-history, ordered by frecency', () => {
    const state = classifyInput('/p/x');
    const ranked = rankCandidates(state, [
      live('/p/xylophone', 1),
      live('/p/xen', 1, hist('/p/xen', 2, 1)),        // fresh
      live('/p/xact', 1, hist('/p/xact', 100, 60)),   // stale (60d)
    ], NOW);
    expect(ranked[0].cwd).toBe('/p/xen');       // frecency 2*decay(1d) ≈ 1.8
    expect(ranked[1].cwd).toBe('/p/xact');      // frecency 100*decay(60d) ≈ 0.26
    expect(ranked[2].cwd).toBe('/p/xylophone'); // no history
  });

  it('exact leaf-prefix hit beats a high-frecency history subsequence match (the mcp bug)', () => {
    // Real report: typing '/root/mcp' surfaced '/root/software/virtual-shadow-employee'
    // (26 sessions, high frecency, but 'mcp' only a mid-path subsequence) ABOVE
    // '/root/mcps' (leaf prefix). Relevance must win: the leaf hit leads.
    const state = classifyInput('/root/mcp');
    const ranked = rankCandidates(state, [
      live('/root/software/virtual-shadow-employee', 2, hist('/root/software/virtual-shadow-employee', 26, 1)),
      live('/root/mcps', 1, hist('/root/mcps', 2, 0)),
    ], NOW);
    expect(ranked[0].cwd).toBe('/root/mcps');
  });

  it('quality bands: prefix > substring > subsequence', () => {
    const state = classifyInput('/p/mar');
    const ranked = rankCandidates(state, [
      live('/p/zmarina', 1),   // substring hit ("mar" inside)
      live('/p/marina', 1),    // prefix hit
      live('/p/mxaxr', 1),     // subsequence hit
    ], NOW);
    expect(ranked.map(r => r.cwd)).toEqual(['/p/marina', '/p/zmarina', '/p/mxaxr']);
  });

  it('shallower depth wins within the same band, then alphabetical', () => {
    const state = classifyInput('/p/');
    const ranked = rankCandidates(state, [
      live('/p/b/deep', 2),
      live('/p/zz', 1),
      live('/p/aa', 1),
    ], NOW);
    expect(ranked.map(r => r.cwd)).toEqual(['/p/aa', '/p/zz', '/p/b/deep']);
  });

  it('empty needle (dir-browse) admits everything', () => {
    const state = classifyInput('/p/');
    const ranked = rankCandidates(state, [live('/p/one', 1), live('/p/two', 1)], NOW);
    expect(ranked).toHaveLength(2);
  });
});

describe('buildSections', () => {
  it('single-host: history section then live section', () => {
    const state = classifyInput('/p/x');
    const ranked = rankCandidates(state, [
      live('/p/xen', 1),
      { cwd: '/p/xor', host: null, source: 'history', depth: 1, history: hist('/p/xor', 3, 1) },
    ], NOW);
    const sections = buildSections(ranked, { hostGrouping: false, hostActivity: new Map() });
    expect(sections.map(s => s.id)).toEqual(['history', 'live']);
  });

  it('host grouping: local first, remotes by activity desc', () => {
    const state = classifyInput('/home/');
    const mk = (host: string | null): Candidate => ({ cwd: '/home/x', host, source: 'live', depth: 1 });
    const ranked = rankCandidates(state, [mk('beta'), mk(null), mk('alpha')], NOW);
    const sections = buildSections(ranked, {
      hostGrouping: true,
      hostActivity: new Map([['alpha', 50], ['beta', 10]]),
    });
    expect(sections.map(s => s.hostKey)).toEqual(['__local__', 'alpha', 'beta']);
  });

  it('same path on two hosts = two entries, never deduped', () => {
    const state = classifyInput('/home/');
    const ranked = rankCandidates(state, [
      { cwd: '/home/proj', host: null, source: 'live', depth: 1 },
      { cwd: '/home/proj', host: 'clouddev', source: 'live', depth: 1 },
    ], NOW);
    expect(ranked).toHaveLength(2);
    const sections = buildSections(ranked, { hostGrouping: true, hostActivity: new Map() });
    expect(sections).toHaveLength(2);
  });
});
