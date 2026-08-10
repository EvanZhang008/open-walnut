/**
 * Regression tests for the 2026-08-03 data-repo mass-revert incident.
 *
 * Mechanism: the hub box's fetch/pull failed for ~8h (network timeouts, process
 * group killed), so its worktree froze on a pre-reorg tree while the primary
 * pushed an 11-commit notes reorg. When the network recovered, the sync tick
 * ran `add -A` + commit BEFORE pulling — snapshotting the entire stale tree
 * (2233 renames reverted + deleted files resurrected) on top of the new tip,
 * silently undoing 8h of the user's work. The commit message claimed
 * "(1 files)" because the count was computed before the add.
 *
 * Guards under test (each maps to one link of that chain):
 *  1. Mass-revert circuit breaker: huge dirty set + revert signal → refuse
 *     commit, enter pull-only safe mode (assessCommitSafety / commitIfDirty).
 *  2. Order inversion: first successful cycle after a fetch/pull failure
 *     streak pulls BEFORE committing (sync()).
 *  3. Torn-worktree sentinel: worktree massively disagreeing with fresh HEAD
 *     right after a pull → safe mode (verifyWorktreeAfterPull).
 *  4. Timeout split: pull (does a checkout) gets a longer budget than fetch.
 *  5. Honest commit counts: "(N files)" is computed from what is staged.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fsp from 'node:fs/promises';
import { execSync } from 'node:child_process';
import path from 'node:path';
import { vi } from 'vitest';
import { createMockConstants } from '../helpers/mock-constants.js';

vi.mock('../../src/constants.js', () => createMockConstants('walnut-massrevert-test'));

import {
  initSync,
  setRemote,
  sync,
  commitIfDirty,
  assessCommitSafety,
  verifyWorktreeAfterPull,
  getSyncGuardState,
  clearSyncSafeMode,
  resetSyncGuardForTest,
  noteNetworkFailure,
  noteNetworkSuccess,
  getSyncStatus,
  isGitSurgeryInProgress,
  effectiveMassDirtyThreshold,
  resetTrackedCountCacheForTest,
  MASS_DIRTY_THRESHOLD,
  FAILURE_STREAK_FOR_PULL_FIRST,
  RESURRECTION_TRIP_COUNT,
  PULL_TIMEOUT,
  FETCH_TIMEOUT,
} from '../../src/integrations/git-sync.js';
import { WALNUT_HOME } from '../../src/constants.js';

let tmpDir: string;

function run(cmd: string, cwd: string, env?: Record<string, string>): string {
  return execSync(cmd, {
    cwd,
    encoding: 'utf-8',
    timeout: 30_000,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: env ? { ...process.env, ...env } : undefined,
  }).trim();
}

/** Fabricate a porcelain-style dirty line list: n untracked paths. */
function untrackedLines(n: number, prefix = 'notes/old'): string[] {
  return Array.from({ length: n }, (_, i) => `?? ${prefix}/file-${i}.md`);
}

/**
 * Drive the repo into a REAL conflicted rebase, so `.git/rebase-merge` exists
 * exactly as it does when a human (or a script) is mid-surgery. Not faked with
 * mkdir: the point is that the guard sees what git actually writes.
 */
async function startConflictedRebase(repo: string): Promise<void> {
  run('git config user.email t@t && git config user.name t', repo);
  await fsp.writeFile(path.join(repo, 'f.md'), 'base\n');
  run('git add -A && git commit -q -m base', repo);
  run('git checkout -q -b side', repo);
  await fsp.writeFile(path.join(repo, 'f.md'), 'side\n');
  run('git commit -qam side', repo);
  run('git checkout -q main', repo);
  await fsp.writeFile(path.join(repo, 'f.md'), 'main\n');
  run('git commit -qam main', repo);
  try {
    run('git rebase side', repo);
  } catch {
    // Expected: the conflict is the whole point — git stops and leaves
    // .git/rebase-merge behind.
  }
}

/**
 * Inflate `git ls-files` cheaply by writing entries straight into the index
 * (one blob, N paths, one subprocess) instead of creating N real files.
 * NOTE: the worktree then lacks those paths, so `git status` reports them all
 * as deletions — only use this for tests that pass dirtyLines in explicitly.
 */
function seedIndexWithTrackedPaths(repo: string, count: number): void {
  const sha = execSync('git hash-object -w --stdin', {
    cwd: repo, input: 'x\n', encoding: 'utf-8', timeout: 30_000,
  }).trim();
  const lines = Array.from({ length: count }, (_, i) => `100644 ${sha} 0\tbulk/f${i}.md`);
  execSync('git update-index --index-info', {
    cwd: repo, input: `${lines.join('\n')}\n`, encoding: 'utf-8', timeout: 30_000,
  });
  resetTrackedCountCacheForTest(); // the count was cached before this seeding
}

beforeEach(async () => {
  tmpDir = WALNUT_HOME;
  await fsp.rm(tmpDir, { recursive: true, force: true });
  await fsp.mkdir(tmpDir, { recursive: true });
  resetSyncGuardForTest();
});

afterEach(async () => {
  resetSyncGuardForTest();
  await fsp.rm(tmpDir, { recursive: true, force: true });
});

// ── Guard 6: surgery-in-progress (2026-08-04 incident) ──

describe('isGitSurgeryInProgress', () => {
  it('is false on a quiet repo', () => {
    initSync();
    expect(isGitSurgeryInProgress()).toBe(false);
  });

  it('is true during a real conflicted rebase, and false again after --abort', async () => {
    initSync();
    await startConflictedRebase(tmpDir);
    // Sanity: git really did leave the surgery marker behind.
    await expect(fsp.stat(path.join(tmpDir, '.git', 'rebase-merge'))).resolves.toBeDefined();

    expect(isGitSurgeryInProgress()).toBe(true);

    run('git rebase --abort', tmpDir);
    expect(isGitSurgeryInProgress()).toBe(false);
  });

  it('is true during an unfinished merge (MERGE_HEAD present)', async () => {
    initSync();
    run('git config user.email t@t && git config user.name t', tmpDir);
    await fsp.writeFile(path.join(tmpDir, 'f.md'), 'base\n');
    run('git add -A && git commit -q -m base', tmpDir);
    run('git checkout -q -b other', tmpDir);
    await fsp.writeFile(path.join(tmpDir, 'f.md'), 'other\n');
    run('git commit -qam other', tmpDir);
    run('git checkout -q main', tmpDir);
    await fsp.writeFile(path.join(tmpDir, 'f.md'), 'mine\n');
    run('git commit -qam mine', tmpDir);
    try {
      run('git merge --no-edit other', tmpDir);
    } catch { /* conflict expected — leaves MERGE_HEAD */ }

    expect(isGitSurgeryInProgress()).toBe(true);
    run('git merge --abort', tmpDir);
    expect(isGitSurgeryInProgress()).toBe(false);
  });

  it('reports per-repo, so an unrelated repo\'s rebase does not gate this one', async () => {
    initSync();
    const other = `${tmpDir}-other-surgery`;
    await fsp.rm(other, { recursive: true, force: true });
    await fsp.mkdir(other, { recursive: true });
    try {
      run('git init -q -b main .', other);
      await startConflictedRebase(other);
      expect(isGitSurgeryInProgress(other)).toBe(true);
      expect(isGitSurgeryInProgress(tmpDir)).toBe(false);
    } finally {
      await fsp.rm(other, { recursive: true, force: true });
    }
  });
});

describe('commitIfDirty surgery guard', () => {
  it('refuses to commit mid-rebase and leaves the rebase intact', async () => {
    initSync();
    await startConflictedRebase(tmpDir);
    const headBefore = run('git rev-parse HEAD', tmpDir);

    // The auto-save tick fires while the human is still resolving.
    const committed = await commitIfDirty();

    expect(committed).toBe(false);
    expect(run('git rev-parse HEAD', tmpDir)).toBe(headBefore);
    // Crucially: the rebase is STILL in progress — the guard must not have
    // aborted or completed the human's surgery, only stood down.
    expect(isGitSurgeryInProgress()).toBe(true);
  });

  it('commits normally once the surgery finishes', async () => {
    initSync();
    await startConflictedRebase(tmpDir);
    expect(await commitIfDirty()).toBe(false);

    run('git rebase --abort', tmpDir);
    await fsp.writeFile(path.join(tmpDir, 'after.md'), 'ok\n');

    expect(await commitIfDirty()).toBe(true);
    expect(run('git log -1 --format=%s', tmpDir)).toMatch(/^auto-save /);
  });
});

describe('sync() surgery guard', () => {
  it('stands down entirely mid-rebase (no commit, and the rebase is not aborted)', async () => {
    initSync();
    await startConflictedRebase(tmpDir);
    const headBefore = run('git rev-parse HEAD', tmpDir);

    const result = await sync();

    expect(result).toEqual({ pulled: 0, pushed: 0, conflicts: 0 });
    expect(run('git rev-parse HEAD', tmpDir)).toBe(headBefore);
    // pullFromRemote runs `rebase --abort` on a failed `pull --rebase`, which
    // would silently destroy the in-flight rebase. It must never be reached.
    expect(isGitSurgeryInProgress()).toBe(true);
  });
});

// ── Guard 7: dynamic mass-dirty threshold ──

describe('effectiveMassDirtyThreshold', () => {
  it('floors at MASS_DIRTY_THRESHOLD on a small repo', async () => {
    initSync();
    await fsp.writeFile(path.join(tmpDir, 'a.md'), 'a\n');
    run('git add -A && git -c user.email=t@t -c user.name=t commit -q -m a', tmpDir);
    resetTrackedCountCacheForTest();

    await expect(effectiveMassDirtyThreshold()).resolves.toBe(MASS_DIRTY_THRESHOLD);
  });

  it('scales to 5% of tracked files on a large repo', async () => {
    initSync();
    seedIndexWithTrackedPaths(tmpDir, 20_000);

    // 5% of 20k = 1000, well above the 300 floor.
    await expect(effectiveMassDirtyThreshold()).resolves.toBe(1_000);
  });

  it('caches the tracked count (a second call does not re-measure)', async () => {
    initSync();
    seedIndexWithTrackedPaths(tmpDir, 20_000);
    await expect(effectiveMassDirtyThreshold()).resolves.toBe(1_000);

    // Index shrinks, but the cached count keeps the threshold where it was.
    run('git read-tree --empty', tmpDir);
    await expect(effectiveMassDirtyThreshold()).resolves.toBe(1_000);

    resetTrackedCountCacheForTest();
    await expect(effectiveMassDirtyThreshold()).resolves.toBe(MASS_DIRTY_THRESHOLD);
  });

  it('a 400-file dirty set is NOT "mass" on a 20k-file repo (no safe mode from size alone)', async () => {
    initSync();
    seedIndexWithTrackedPaths(tmpDir, 20_000);
    for (let i = 0; i < FAILURE_STREAK_FOR_PULL_FIRST; i++) noteNetworkFailure();

    // 400 > the old flat 300 but < 5% of 20k → the stale-after-outage trip
    // (which requires the mass condition) must not fire.
    const res = await assessCommitSafety(untrackedLines(400, 'import/new'));

    expect(res.ok).toBe(true);
    expect(getSyncGuardState().safeMode).toBe(false);
  });
});

// ── Guard 8: resurrection trips independently of the mass threshold ──

describe('resurrection check is independent of the mass threshold', () => {
  /** History where `notes/old-layout/f*.md` existed and was then deleted. */
  async function withDeletedUpstreamLayout(n: number): Promise<void> {
    run('git config user.email t@t && git config user.name t', tmpDir);
    const oldDir = path.join(tmpDir, 'notes', 'old-layout');
    await fsp.mkdir(oldDir, { recursive: true });
    for (let i = 0; i < n; i++) {
      await fsp.writeFile(path.join(oldDir, `f${i}.md`), `v${i}\n`);
    }
    run('git add -A && git commit -q -m "old layout"', tmpDir);
    run('git rm -rq notes/old-layout && git commit -q -m "reorg: delete old layout"', tmpDir);
  }

  it('trips on resurrections alone, far BELOW the mass threshold', async () => {
    initSync();
    const n = RESURRECTION_TRIP_COUNT + 5;
    await withDeletedUpstreamLayout(n);
    resetTrackedCountCacheForTest();

    // 30 dirty lines — a tenth of the old flat 300, so the pre-Phase-0 code
    // returned ok:true here and would have committed the partial revert.
    const dirty = Array.from({ length: n }, (_, i) => `?? notes/old-layout/f${i}.md`);
    expect(dirty.length).toBeLessThan(MASS_DIRTY_THRESHOLD);

    const res = await assessCommitSafety(dirty);

    expect(res.ok).toBe(false);
    expect(res.reason).toBe('mass-revert-suspect');
    expect(getSyncGuardState().safeMode).toBe(true);
  });

  it('stays latched while the sub-threshold resurrection persists', async () => {
    initSync();
    const n = RESURRECTION_TRIP_COUNT + 5;
    await withDeletedUpstreamLayout(n);
    resetTrackedCountCacheForTest();
    const dirty = Array.from({ length: n }, (_, i) => `?? notes/old-layout/f${i}.md`);

    await assessCommitSafety(dirty);
    expect(getSyncGuardState().safeMode).toBe(true);

    // Same anomaly next tick: must NOT auto-clear just because it is small.
    const again = await assessCommitSafety(dirty);
    expect(again.ok).toBe(false);
    expect(getSyncGuardState().safeMode).toBe(true);
  });

  it('clears once the resurrected paths are gone', async () => {
    initSync();
    const n = RESURRECTION_TRIP_COUNT + 5;
    await withDeletedUpstreamLayout(n);
    resetTrackedCountCacheForTest();
    const dirty = Array.from({ length: n }, (_, i) => `?? notes/old-layout/f${i}.md`);
    await assessCommitSafety(dirty);
    expect(getSyncGuardState().safeMode).toBe(true);

    const res = await assessCommitSafety(untrackedLines(n, 'notes/brand-new'));

    expect(res.ok).toBe(true);
    expect(getSyncGuardState().safeMode).toBe(false);
  });

  it('never runs the history scan below RESURRECTION_TRIP_COUNT dirty lines', async () => {
    initSync();
    await withDeletedUpstreamLayout(RESURRECTION_TRIP_COUNT + 5);
    resetTrackedCountCacheForTest();

    // Cost bound: 24 dirty lines is under the floor, so even though EVERY one of
    // them is a resurrected path, no scan happens and the commit is allowed.
    const dirty = Array.from({ length: RESURRECTION_TRIP_COUNT - 1 },
      (_, i) => `?? notes/old-layout/f${i}.md`);

    await expect(assessCommitSafety(dirty)).resolves.toEqual({ ok: true });
    expect(getSyncGuardState().safeMode).toBe(false);
  });
});

// ── Guard 4: fetch/pull timeout split ──

describe('timeout split (fetch vs pull)', () => {
  it('pull budget is at least 60s and strictly larger than the fetch budget', () => {
    // Pull = fetch + CHECKOUT; killing the checkout half at the fetch budget
    // is what tore the hub worktree. This pins the split so a refactor cannot
    // silently re-unify them.
    expect(PULL_TIMEOUT).toBeGreaterThanOrEqual(60_000);
    expect(PULL_TIMEOUT).toBeGreaterThan(FETCH_TIMEOUT);
  });
});

// ── Guard 1: mass-revert circuit breaker (pure logic level) ──

describe('assessCommitSafety', () => {
  beforeEach(() => {
    initSync();
  });

  it('allows a small dirty set unconditionally', async () => {
    await expect(assessCommitSafety(untrackedLines(5))).resolves.toEqual({ ok: true });
    expect(getSyncGuardState().safeMode).toBe(false);
  });

  it('allows a huge dirty set when there is NO revert signal (legit bulk import)', async () => {
    const res = await assessCommitSafety(untrackedLines(MASS_DIRTY_THRESHOLD + 50, 'import/new'));
    expect(res.ok).toBe(true);
    expect(getSyncGuardState().safeMode).toBe(false);
  });

  it('refuses a huge dirty set right after a fetch/pull failure streak and enters safe mode', async () => {
    for (let i = 0; i < FAILURE_STREAK_FOR_PULL_FIRST; i++) noteNetworkFailure();

    const res = await assessCommitSafety(untrackedLines(MASS_DIRTY_THRESHOLD + 1));
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('mass-revert-suspect');
    const guard = getSyncGuardState();
    expect(guard.safeMode).toBe(true);
    expect(guard.safeModeReason).toBe('mass-revert-suspect');
  });

  it('refuses a mass resurrection of recently-deleted upstream paths (no failure streak needed)', async () => {
    // Upstream (this repo's history) deleted a batch of old-layout files…
    const oldDir = path.join(tmpDir, 'notes', 'old-layout');
    await fsp.mkdir(oldDir, { recursive: true });
    const n = RESURRECTION_TRIP_COUNT + 5;
    for (let i = 0; i < n; i++) {
      await fsp.writeFile(path.join(oldDir, `f${i}.md`), `v${i}\n`);
    }
    run('git add -A && git commit -q -m "old layout"', tmpDir);
    run('git rm -rq notes/old-layout && git commit -q -m "reorg: delete old layout"', tmpDir);

    // …and a stale box "resurrects" them as untracked files.
    const dirty = Array.from({ length: MASS_DIRTY_THRESHOLD + 10 }, (_, i) =>
      i < n ? `?? notes/old-layout/f${i}.md` : `?? notes/other/x${i}.md`);

    const res = await assessCommitSafety(dirty);
    expect(res.ok).toBe(false);
    expect(getSyncGuardState().safeMode).toBe(true);
  });

  it('while in safe mode, keeps refusing while the anomaly persists', async () => {
    for (let i = 0; i < FAILURE_STREAK_FOR_PULL_FIRST; i++) noteNetworkFailure();
    await assessCommitSafety(untrackedLines(MASS_DIRTY_THRESHOLD + 1));
    expect(getSyncGuardState().safeMode).toBe(true);

    // Streak resets (network is back), but the huge dirty set is still there.
    noteNetworkSuccess();
    const res = await assessCommitSafety(untrackedLines(MASS_DIRTY_THRESHOLD + 1));
    expect(res.ok).toBe(false);
    expect(getSyncGuardState().safeMode).toBe(true);
  });

  it('auto-clears safe mode once the dirty set shrinks below the threshold', async () => {
    for (let i = 0; i < FAILURE_STREAK_FOR_PULL_FIRST; i++) noteNetworkFailure();
    await assessCommitSafety(untrackedLines(MASS_DIRTY_THRESHOLD + 1));
    expect(getSyncGuardState().safeMode).toBe(true);

    const res = await assessCommitSafety(untrackedLines(3));
    expect(res.ok).toBe(true);
    expect(getSyncGuardState().safeMode).toBe(false);
  });

  it('clearSyncSafeMode is the human-visible escape hatch', async () => {
    for (let i = 0; i < FAILURE_STREAK_FOR_PULL_FIRST; i++) noteNetworkFailure();
    await assessCommitSafety(untrackedLines(MASS_DIRTY_THRESHOLD + 1));
    expect(getSyncGuardState().safeMode).toBe(true);

    clearSyncSafeMode('operator repaired the tree');
    expect(getSyncGuardState().safeMode).toBe(false);
    expect(getSyncGuardState().safeModeReason).toBeNull();
  });

  it('getSyncStatus surfaces safeMode', async () => {
    initSync();
    expect(getSyncStatus().safeMode).toBe(false);
    for (let i = 0; i < FAILURE_STREAK_FOR_PULL_FIRST; i++) noteNetworkFailure();
    await assessCommitSafety(untrackedLines(MASS_DIRTY_THRESHOLD + 1));
    expect(getSyncStatus().safeMode).toBe(true);
  });
});

// ── Guard 1 wired into commitIfDirty (the function that committed the incident) ──

describe('commitIfDirty circuit breaker', () => {
  it('refuses to commit a mass resurrection and leaves the worktree/history untouched', async () => {
    initSync();
    run('git config user.email t@t && git config user.name t', tmpDir);

    // History: old layout existed, then was deleted (the user's reorg).
    const oldDir = path.join(tmpDir, 'notes', 'Areas');
    await fsp.mkdir(oldDir, { recursive: true });
    const resurrectCount = RESURRECTION_TRIP_COUNT + 10;
    for (let i = 0; i < resurrectCount; i++) {
      await fsp.writeFile(path.join(oldDir, `a${i}.md`), `content ${i}\n`);
    }
    run('git add -A && git commit -q -m "old layout"', tmpDir);
    run('git rm -rq notes/Areas && git commit -q -m "reorg: PARA move"', tmpDir);
    const headBefore = run('git rev-parse HEAD', tmpDir);

    // The stale-worktree state: the deleted files are back on disk, plus
    // enough other untracked noise to cross the mass threshold.
    await fsp.mkdir(oldDir, { recursive: true });
    for (let i = 0; i < resurrectCount; i++) {
      await fsp.writeFile(path.join(oldDir, `a${i}.md`), `content ${i}\n`);
    }
    const noiseDir = path.join(tmpDir, 'notes', 'stale');
    await fsp.mkdir(noiseDir, { recursive: true });
    for (let i = 0; i < MASS_DIRTY_THRESHOLD; i++) {
      await fsp.writeFile(path.join(noiseDir, `s${i}.md`), `stale ${i}\n`);
    }

    const committed = await commitIfDirty();

    expect(committed).toBe(false);
    expect(run('git rev-parse HEAD', tmpDir)).toBe(headBefore); // no commit made
    expect(getSyncGuardState().safeMode).toBe(true);
    // Nothing staged either — a later manual commit can't silently include it.
    expect(run('git diff --cached --name-only', tmpDir)).toBe('');
  });

  it('still commits normal small changes (happy path unchanged)', async () => {
    initSync();
    await fsp.writeFile(path.join(tmpDir, 'note.md'), 'hello\n');

    const committed = await commitIfDirty();

    expect(committed).toBe(true);
    expect(run('git log -1 --format=%s', tmpDir)).toMatch(/auto-save .* \(1 files\)/);
  });

  it('clears safe mode automatically when the worktree is clean again', async () => {
    initSync();
    for (let i = 0; i < FAILURE_STREAK_FOR_PULL_FIRST; i++) noteNetworkFailure();
    await assessCommitSafety(untrackedLines(MASS_DIRTY_THRESHOLD + 1));
    expect(getSyncGuardState().safeMode).toBe(true);

    // Worktree is clean (the human reset it) — commitIfDirty stands down.
    await commitIfDirty();
    expect(getSyncGuardState().safeMode).toBe(false);
  });
});

// ── Guard 5: honest "(N files)" count ──

describe('honest commit file counts', () => {
  it('auto-save message counts what was actually staged (dir with many files ≠ "1 files")', async () => {
    initSync();
    // A single untracked DIRECTORY used to collapse to one `?? dir/` porcelain
    // line — the incident commit said "(1 files)" while reverting 2233 paths.
    const dir = path.join(tmpDir, 'notes', 'bulk');
    await fsp.mkdir(dir, { recursive: true });
    for (let i = 0; i < 7; i++) {
      await fsp.writeFile(path.join(dir, `f${i}.md`), `x${i}\n`);
    }

    const committed = await commitIfDirty();

    expect(committed).toBe(true);
    expect(run('git log -1 --format=%s', tmpDir)).toContain('(7 files)');
  });

  it('sync() commit message also carries the staged count', async () => {
    initSync();
    const dir = path.join(tmpDir, 'notes', 'batch');
    await fsp.mkdir(dir, { recursive: true });
    for (let i = 0; i < 4; i++) {
      await fsp.writeFile(path.join(dir, `g${i}.md`), `y${i}\n`);
    }

    const result = await sync();

    expect(result.pushed).toBe(1);
    expect(run('git log -1 --format=%s', tmpDir)).toContain('(4 files)');
  });
});

// ── Guard 3: torn-worktree sentinel ──

describe('verifyWorktreeAfterPull', () => {
  it('passes on a near-clean tree', async () => {
    initSync();
    await fsp.writeFile(path.join(tmpDir, 'small.md'), 'ok\n');
    await expect(verifyWorktreeAfterPull('test')).resolves.toBe(true);
    expect(getSyncGuardState().safeMode).toBe(false);
  });

  it('enters safe mode when the tree massively disagrees with HEAD', async () => {
    initSync();
    const dir = path.join(tmpDir, 'torn');
    await fsp.mkdir(dir, { recursive: true });
    for (let i = 0; i < MASS_DIRTY_THRESHOLD + 5; i++) {
      await fsp.writeFile(path.join(dir, `t${i}.md`), `torn ${i}\n`);
    }

    await expect(verifyWorktreeAfterPull('test')).resolves.toBe(false);
    const guard = getSyncGuardState();
    expect(guard.safeMode).toBe(true);
    expect(guard.safeModeReason).toBe('torn-worktree');
  });
});

// ── Guard 2 + end-to-end: order inversion and incident replay over a real origin ──

describe('sync() after an outage (real two-clone setup)', () => {
  let bareDir: string;
  let cloneDir: string;

  beforeEach(async () => {
    bareDir = `${tmpDir}-origin.git`;
    cloneDir = `${tmpDir}-clone`;
    await fsp.rm(bareDir, { recursive: true, force: true });
    await fsp.rm(cloneDir, { recursive: true, force: true });
    await fsp.mkdir(bareDir, { recursive: true });

    run('git init --bare -b main', bareDir);
    initSync();
    run('git config user.email hub@test.local && git config user.name hub-box', tmpDir);
    setRemote(bareDir);
    await fsp.writeFile(path.join(tmpDir, 'base.md'), 'base\n');
    run('git add -A && git commit -q -m base && git push -q origin main', tmpDir);
    run(`git clone -q "${bareDir}" "${cloneDir}"`, tmpDir);
    run('git config user.email primary@test.local && git config user.name primary-box', cloneDir);
  });

  afterEach(async () => {
    await fsp.rm(bareDir, { recursive: true, force: true });
    await fsp.rm(cloneDir, { recursive: true, force: true });
  });

  it('pulls BEFORE committing on the first cycle after a failure streak (stale tree refreshed, no bogus commit)', async () => {
    // Primary box reorganizes: old/ → new/ (rename), pushed to origin.
    const oldDir = path.join(cloneDir, 'old');
    await fsp.mkdir(oldDir, { recursive: true });
    for (let i = 0; i < 5; i++) {
      await fsp.writeFile(path.join(oldDir, `n${i}.md`), `note ${i}\n`);
    }
    run('git add -A && git commit -q -m "add notes" && git push -q origin main', cloneDir);
    run('git mv old new && git commit -q -m "reorg" && git push -q origin main', cloneDir);

    // Hub box was cut off while that happened.
    for (let i = 0; i < FAILURE_STREAK_FOR_PULL_FIRST; i++) noteNetworkFailure();

    const result = await sync();

    // The pull-first path refreshed the worktree to the reorg…
    expect(result.pulled).toBe(1);
    const files = run('git ls-files', tmpDir).split('\n');
    expect(files).toContain('new/n0.md');
    expect(files).not.toContain('old/n0.md');
    // …and no revert commit was created on top of it.
    expect(run('git log -1 --format=%s', tmpDir)).toBe('reorg');
    expect(getSyncGuardState().safeMode).toBe(false);
    expect(getSyncGuardState().consecutiveNetworkFailures).toBe(0);
  });

  it('INCIDENT REPLAY: a stale worktree resurrection after an outage is refused, upstream reorg survives', async () => {
    // 1. Shared history: an old layout everyone has.
    const mkFiles = async (dir: string, n: number): Promise<void> => {
      await fsp.mkdir(dir, { recursive: true });
      for (let i = 0; i < n; i++) {
        await fsp.writeFile(path.join(dir, `f${i}.md`), `body ${i}\n`);
      }
    };
    const resurrectCount = RESURRECTION_TRIP_COUNT + 10;
    await mkFiles(path.join(tmpDir, 'notes', 'OldLayout'), resurrectCount);
    run('git add -A && git commit -q -m "old layout" && git push -q origin main', tmpDir);
    run('git pull -q origin main', cloneDir);

    // 2. Primary box deletes the old layout (the user's reorg) and pushes.
    run('git rm -rq notes/OldLayout && git commit -q -m "restructure: PARA reorg" && git push -q origin main', cloneDir);
    const reorgTip = run('git rev-parse HEAD', cloneDir);

    // 3. Hub is cut off for hours (failure streak), worktree frozen pre-reorg…
    for (let i = 0; i < FAILURE_STREAK_FOR_PULL_FIRST; i++) noteNetworkFailure();
    // …and to model the torn/stale disk state the incident produced, the old
    // files are ALSO present as untracked noise beyond the mass threshold.
    // (Simulate: hub's checkout died — HEAD will move on pull, but stale extra
    // files linger on disk as untracked resurrections.)
    await mkFiles(path.join(tmpDir, 'notes', 'stale-extra'), MASS_DIRTY_THRESHOLD);

    const result = await sync();

    // Pull-first landed the reorg; tracked state matches upstream.
    expect(result.pulled).toBe(1);
    expect(run('git ls-files', tmpDir).split('\n')).not.toContain('notes/OldLayout/f0.md');
    // The mass untracked residue was NOT committed — origin still at the reorg tip.
    expect(run('git rev-parse main', bareDir)).toBe(reorgTip);
    // And the guard is loud: safe mode is on (torn worktree / mass dirt).
    expect(getSyncGuardState().safeMode).toBe(true);

    // 4. Human repairs the tree (removes the stale residue) → next cycle stands down.
    await fsp.rm(path.join(tmpDir, 'notes', 'stale-extra'), { recursive: true, force: true });
    await sync();
    expect(getSyncGuardState().safeMode).toBe(false);
  });

  it('safe mode still PULLS upstream changes (pull-only, not sync-off)', async () => {
    // Enter safe mode via a mass dirty set + streak.
    for (let i = 0; i < FAILURE_STREAK_FOR_PULL_FIRST; i++) noteNetworkFailure();
    await assessCommitSafety(untrackedLines(MASS_DIRTY_THRESHOLD + 1));
    expect(getSyncGuardState().safeMode).toBe(true);

    // Upstream adds a file.
    await fsp.writeFile(path.join(cloneDir, 'fresh.md'), 'from primary\n');
    run('git add -A && git commit -q -m fresh && git push -q origin main', cloneDir);

    const result = await sync();

    expect(result.pulled).toBe(1);
    await expect(fsp.readFile(path.join(tmpDir, 'fresh.md'), 'utf-8')).resolves.toBe('from primary\n');
    // But nothing was pushed/committed from this box.
    expect(run('git rev-parse main', bareDir)).toBe(run('git rev-parse origin/main', tmpDir));
  });
});
