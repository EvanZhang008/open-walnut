/**
 * The matching rules that decide which local commits a rewrite left out
 * (src/integrations/git-sync-rewrite-carry.ts). The repo-level cases, the
 * 2026-10-28 incident included, are in git-sync-compaction-coordination.test.ts.
 */
import { describe, it, expect } from 'vitest';
import { findRewriteAnchor, type ChainCommit } from '../../src/integrations/git-sync-rewrite-carry.js';

const c = (hash: string, tree: string, t: number, subject = hash): ChainCommit =>
  ({ hash, tree, authorAt: t, committerAt: t, subject });

describe('findRewriteAnchor', () => {
  it('matches by tree: the newest local commit whose tree the new chain holds', () => {
    const local = [c('l3', 'T3', 300), c('l2', 'T2', 200), c('l1', 'T1', 100)];
    const remote = [c('r2', 'T2', 200, 'compacted'), c('r1', 'T1', 100)];
    expect(findRewriteAnchor(local, remote)).toEqual({ local: 'l2', remote: 'r2', by: 'tree' });
  });

  it('a tree that recurs on the new chain maps to its newest commit there', () => {
    const local = [c('l2', 'T1', 200)];
    const remote = [c('r3', 'T1', 300), c('r1', 'T1', 100)];
    expect(findRewriteAnchor(local, remote)?.remote).toBe('r3');
  });

  it('matches by author date and subject when a scrub changed the tree', () => {
    const local = [c('l3', 'T3', 300), c('l2', 'T2', 200, 'auto-save 07:00'), c('l1', 'T1', 100)];
    const remote = [c('r2', 'T2-scrubbed', 200, 'auto-save 07:00'), c('r1', 'T1-scrubbed', 100)];
    expect(findRewriteAnchor(local, remote)).toEqual({ local: 'l2', remote: 'r2', by: 'author-date' });
  });

  it('the same subject at another time is not a match', () => {
    const local = [c('l2', 'T2', 200, 'auto-save'), c('l1', 'T1', 100, 'auto-save')];
    const remote = [c('r1', 'R1', 150, 'auto-save')];
    expect(findRewriteAnchor(local, remote)).toEqual({ local: 'l1', remote: 'r1', by: 'time' });
  });

  it('falls back to time: the newest local commit no newer than the newest rewritten one', () => {
    const local = [c('l3', 'T3', 500), c('l2', 'T2', 300), c('l1', 'T1', 100)];
    const remote = [c('r1', 'R1', 400)];
    expect(findRewriteAnchor(local, remote)).toEqual({ local: 'l2', remote: 'r1', by: 'time' });
  });

  it('no anchor when every local commit is newer than the whole new chain, or a chain is empty', () => {
    expect(findRewriteAnchor([c('l1', 'T1', 500)], [c('r1', 'R1', 400)])).toBeNull();
    expect(findRewriteAnchor([], [c('r1', 'R1', 400)])).toBeNull();
    expect(findRewriteAnchor([c('l1', 'T1', 500)], [])).toBeNull();
  });
});
