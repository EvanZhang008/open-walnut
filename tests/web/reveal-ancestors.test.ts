/**
 * REGRESSION: the file explorer's "reveal the selected file" walk could never
 * terminate when the tree root was the filesystem root.
 *
 * `parentPath('/')` returns `'/'`, and the loop's only exit condition was
 * `dir.startsWith(rootNorm + '/')`. With root `/`, rootNorm is `''` so the prefix
 * is `'/'` — which `'/'` satisfies forever. As an inline React effect that was an
 * unbounded loop: the tab pegged a core with no rendered error and no console
 * message, so it looked like a freeze rather than a crash.
 *
 * The invariant pinned here is termination on the fixed point, not the prefix test.
 * These are pure-function tests; a hang shows up as the vitest timeout.
 */
import { describe, it, expect } from 'vitest';
import { revealAncestors } from '@/components/sessions/reveal-ancestors';

describe('revealAncestors', () => {
  it('lists ancestors nearest-first, excluding the root itself', () => {
    expect(revealAncestors('/repo', '/repo/src/core/foo.ts'))
      .toEqual(['/repo/src/core', '/repo/src']);
  });

  it('returns nothing for a direct child of the root (already visible)', () => {
    expect(revealAncestors('/repo', '/repo/foo.ts')).toEqual([]);
  });

  it('returns nothing for a file outside the tree', () => {
    expect(revealAncestors('/repo', '/other/foo.ts')).toEqual([]);
  });

  it('tolerates a trailing slash on the root', () => {
    expect(revealAncestors('/repo/', '/repo/a/b.ts')).toEqual(['/repo/a']);
  });

  // The incident: root '/' made the prefix '/' , which parentPath('/') === '/'
  // satisfies forever. Must TERMINATE (and not include '/' more than once).
  it('TERMINATES when the tree root is the filesystem root', () => {
    const out = revealAncestors('/', '/var/log/system.log');
    expect(out).toEqual(['/var/log', '/var']);
    expect(out.filter((d) => d === '/')).toHaveLength(0);
  });

  it('TERMINATES for a top-level file under root /', () => {
    expect(revealAncestors('/', '/etc')).toEqual([]);
  });

  it('TERMINATES for a two-segment path under root / (parentPath returns "/")', () => {
    // parentPath('/var/log') === '/var'; parentPath('/var') === '/' → fixed point.
    expect(revealAncestors('/', '/var/log')).toEqual(['/var']);
  });
});
