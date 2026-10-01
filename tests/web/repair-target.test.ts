/**
 * Where an "Improve Walnut" / "Fix Walnut" draft points, and what its hint says.
 *
 * Load-bearing because the old gate was `installDir` (a source checkout only), so
 * an npm install never got a repair entry at all although the server could clone
 * the source on demand. The target now follows GET /api/config `selfRepair`, and
 * the hint names the folder (or the clone to be) instead of "Walnut's checkout".
 */
import { describe, it, expect } from 'vitest';
import { deriveRepairTarget, repairHint } from '@/pages/repair-target';
import type { SelfRepairInfo } from '@/api/config';

const REPO = 'https://example.invalid/open-walnut.git';

function info(over: Partial<SelfRepairInfo>): SelfRepairInfo {
  return { available: true, source: null, cloneDir: '/home/u/open-walnut', repoUrl: REPO, ...over };
}

describe('deriveRepairTarget', () => {
  it('a source checkout is the target, no clone needed', () => {
    expect(deriveRepairTarget(info({ source: { dir: '/code/walnut', kind: 'running' } })))
      .toEqual({ dir: '/code/walnut', cloneNeeded: false, repoUrl: REPO });
  });

  it('a configured checkout or an existing clone is used the same way', () => {
    expect(deriveRepairTarget(info({ source: { dir: '/src/mine', kind: 'configured' } }))?.dir).toBe('/src/mine');
    expect(deriveRepairTarget(info({ source: { dir: '/home/u/open-walnut', kind: 'clone' } })))
      .toEqual({ dir: '/home/u/open-walnut', cloneNeeded: false, repoUrl: REPO });
  });

  it('an npm install with no source points at the clone dir and says a clone is needed', () => {
    expect(deriveRepairTarget(info({ source: null })))
      .toEqual({ dir: '/home/u/open-walnut', cloneNeeded: true, repoUrl: REPO });
  });

  it('no repair possible (cloud, no git, occupied clone path) means no target', () => {
    for (const reason of ['cloud', 'no-git', 'clone-dir-occupied']) {
      expect(deriveRepairTarget(info({ available: false, reason }))).toBeNull();
    }
  });

  it('an unknown or missing answer means no target', () => {
    expect(deriveRepairTarget(null)).toBeNull();
    expect(deriveRepairTarget(undefined)).toBeNull();
    // Defensive: available with neither a source nor a clone dir has nowhere to run.
    expect(deriveRepairTarget(info({ cloneDir: '' }))).toBeNull();
  });
});

describe('repairHint', () => {
  it('a checkout: names the full folder', () => {
    expect(repairHint({ dir: '/Users/a/code/open-walnut', cloneNeeded: false, repoUrl: REPO })).toBe(
      "Opens a session in Walnut's own source at /Users/a/code/open-walnut. Describe what to change or fix; paste a screenshot (\u2318V) if you have one.",
    );
  });

  it('a clone to make: names the repo and where it lands', () => {
    expect(repairHint({ dir: '/home/u/open-walnut', cloneNeeded: true, repoUrl: REPO })).toBe(
      `Walnut's source is not on this computer yet. Start clones ${REPO} into /home/u/open-walnut first, then opens a session there.`,
    );
  });

  it('no target known: a generic line that still says what Start does', () => {
    expect(repairHint(null)).toContain("Walnut's own source");
  });

  it('keeps a path with spaces and non-ASCII characters whole', () => {
    // \u00e9 is a Latin small e with an acute accent.
    const dir = '/Users/a/My Projects/caf\u00e9/open-walnut';
    expect(repairHint({ dir, cloneNeeded: false, repoUrl: REPO })).toContain(`at ${dir}.`);
  });

  it('no em or en dashes in either sentence', () => {
    for (const cloneNeeded of [false, true]) {
      expect(repairHint({ dir: '/x', cloneNeeded, repoUrl: REPO })).not.toMatch(/[\u2013\u2014]/);
    }
    expect(repairHint(null)).not.toMatch(/[\u2013\u2014]/);
  });
});
