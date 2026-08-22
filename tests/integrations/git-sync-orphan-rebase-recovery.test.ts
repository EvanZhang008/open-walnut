/**
 * Orphaned-rebase self-heal — regression suite for the 2026-08-22 incident:
 * a server restart mid-`pull --rebase` left `.git/rebase-merge` behind; the
 * surgery guard (correctly) froze all auto-commits, but nothing ever cleaned
 * up the dead state, so sync stayed frozen for 22 HOURS across five restarts
 * while 365 local commits piled up unpushed.
 *
 * recoverOrphanedGitSurgery() is the fix: age-gated (a LIVE rebase is
 * untouchable), preserves both sides (pre-rebase commits AND live worktree
 * writes), and always ends with main unfrozen.
 *
 * Real git repos, real conflicted rebases — never mkdir-faked state, except
 * the one test that pins marker-dir cleanup (an empty dir with no head-name
 * is by definition not git-authored).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { createMockConstants } from '../helpers/mock-constants.js';

vi.mock('../../src/constants.js', () => createMockConstants('walnut-orphanrebase-test'));

import {
  recoverOrphanedGitSurgery,
  isGitSurgeryInProgress,
  ORPHAN_SURGERY_MIN_AGE_MS,
} from '../../src/integrations/git-sync.js';
import { WALNUT_HOME } from '../../src/constants.js';

let repo: string;

function run(cmd: string, cwd: string): string {
  return execSync(cmd, { cwd, encoding: 'utf-8', timeout: 30_000, stdio: ['pipe', 'pipe', 'pipe'] }).trim();
}

/** Drive the repo into a REAL conflicted rebase (what a killed pull leaves). */
async function startConflictedRebase(dir: string): Promise<void> {
  await fsp.writeFile(path.join(dir, 'f.md'), 'base\n');
  run('git add -A && git commit -q -m base', dir);
  run('git checkout -q -b side', dir);
  await fsp.writeFile(path.join(dir, 'f.md'), 'side\n');
  run('git commit -qam side', dir);
  run('git checkout -q main', dir);
  await fsp.writeFile(path.join(dir, 'f.md'), 'main\n');
  run('git commit -qam main', dir);
  try {
    run('git rebase side', dir);
  } catch {
    // Expected — the conflict strands .git/rebase-merge, HEAD detached.
  }
}

/** Backdate the surgery state dir so the age gate sees it as orphaned. */
async function backdate(p: string, ageMs = ORPHAN_SURGERY_MIN_AGE_MS + 60_000): Promise<void> {
  const old = new Date(Date.now() - ageMs);
  await fsp.utimes(p, old, old);
}

beforeEach(async () => {
  repo = WALNUT_HOME;
  await fsp.rm(repo, { recursive: true, force: true });
  await fsp.mkdir(repo, { recursive: true });
  run('git init -q -b main', repo);
  run('git config user.email t@t && git config user.name t', repo);
});

afterEach(async () => {
  await fsp.rm(repo, { recursive: true, force: true });
});

describe('recoverOrphanedGitSurgery — age gate', () => {
  it('NEVER touches a fresh rebase (a human may be mid-surgery right now)', async () => {
    await startConflictedRebase(repo);
    expect(isGitSurgeryInProgress(repo)).toBe(true);

    const result = await recoverOrphanedGitSurgery(repo);
    expect(result.recovered).toBe(false);
    expect(isGitSurgeryInProgress(repo)).toBe(true); // untouched
    expect(fs.existsSync(path.join(repo, '.git', 'rebase-merge'))).toBe(true);
  });

  it('is a no-op on a quiet repo', async () => {
    await fsp.writeFile(path.join(repo, 'a.md'), 'x\n');
    run('git add -A && git commit -q -m init', repo);
    const result = await recoverOrphanedGitSurgery(repo);
    expect(result.recovered).toBe(false);
  });
});

describe('recoverOrphanedGitSurgery — orphaned rebase (the incident shape)', () => {
  it('unfreezes main, keeps pre-rebase commits AND live worktree writes', async () => {
    await startConflictedRebase(repo);
    const preRebaseTip = run('git rev-parse main', repo);
    // Server keeps writing while sync is frozen — the newest data on disk.
    await fsp.writeFile(path.join(repo, 'live-write.md'), 'written during the freeze\n');
    await backdate(path.join(repo, '.git', 'rebase-merge'));

    const result = await recoverOrphanedGitSurgery(repo);
    expect(result.recovered).toBe(true);
    expect(result.kind).toBe('rebase');
    expect(result.mergedBack).toBe(true);

    // Sync is unfrozen: back on main, no surgery state left.
    expect(isGitSurgeryInProgress(repo)).toBe(false);
    expect(run('git rev-parse --abbrev-ref HEAD', repo)).toBe('main');
    // Both histories preserved.
    run(`git merge-base --is-ancestor ${preRebaseTip} HEAD`, repo); // throws if not
    expect(fs.readFileSync(path.join(repo, 'live-write.md'), 'utf-8')).toContain('during the freeze');
    // The conflicted file resolved toward the live disk (-X theirs), repo sane.
    expect(run('git status --porcelain', repo)).toBe('');
    expect(run('git fsck --no-progress', repo)).not.toMatch(/error/i);
  });

  it('parks the live snapshot on a rescue branch (recoverable even if merge logic changes)', async () => {
    await startConflictedRebase(repo);
    await fsp.writeFile(path.join(repo, 'precious.md'), 'do not lose me\n');
    await backdate(path.join(repo, '.git', 'rebase-merge'));

    const result = await recoverOrphanedGitSurgery(repo);
    expect(result.rescueBranch).toMatch(/^rescue-orphaned-rebase-/);
    const branches = run('git branch --list "rescue-orphaned-rebase-*"', repo);
    expect(branches).toContain('rescue-orphaned-rebase-');
    expect(run(`git show ${result.rescueBranch}:precious.md`, repo)).toContain('do not lose me');
  });

  it('handles a rebase orphaned with NO extra live writes (clean freeze)', async () => {
    await startConflictedRebase(repo);
    // Resolve the conflicted file exactly as the rebase left it — no new writes.
    await backdate(path.join(repo, '.git', 'rebase-merge'));
    const result = await recoverOrphanedGitSurgery(repo);
    expect(result.recovered).toBe(true);
    expect(isGitSurgeryInProgress(repo)).toBe(false);
    expect(run('git rev-parse --abbrev-ref HEAD', repo)).toBe('main');
  });
});

describe('recoverOrphanedGitSurgery — other orphan kinds', () => {
  it('removes a marker dir (rebase-apply with no head-name) as plain debris', async () => {
    await fsp.writeFile(path.join(repo, 'a.md'), 'x\n');
    run('git add -A && git commit -q -m init', repo);
    const marker = path.join(repo, '.git', 'rebase-apply');
    await fsp.mkdir(marker, { recursive: true });
    await backdate(marker);

    const result = await recoverOrphanedGitSurgery(repo);
    expect(result.recovered).toBe(true);
    expect(result.kind).toBe('marker');
    expect(fs.existsSync(marker)).toBe(false);
    expect(isGitSurgeryInProgress(repo)).toBe(false);
  });

  it('aborts an orphaned conflicted merge (remote side is safe in origin)', async () => {
    // Build a real conflicted merge.
    await fsp.writeFile(path.join(repo, 'm.md'), 'base\n');
    run('git add -A && git commit -q -m base', repo);
    run('git checkout -q -b other', repo);
    await fsp.writeFile(path.join(repo, 'm.md'), 'other\n');
    run('git commit -qam other', repo);
    run('git checkout -q main', repo);
    await fsp.writeFile(path.join(repo, 'm.md'), 'main\n');
    run('git commit -qam main', repo);
    try { run('git merge other', repo); } catch { /* conflict expected */ }
    const mergeHead = path.join(repo, '.git', 'MERGE_HEAD');
    expect(fs.existsSync(mergeHead)).toBe(true);
    await backdate(mergeHead);

    const result = await recoverOrphanedGitSurgery(repo);
    expect(result.recovered).toBe(true);
    expect(result.kind).toBe('merge');
    expect(fs.existsSync(mergeHead)).toBe(false);
    expect(isGitSurgeryInProgress(repo)).toBe(false);
    // main content restored (merge aborted, not half-committed).
    expect(fs.readFileSync(path.join(repo, 'm.md'), 'utf-8')).toBe('main\n');
  });

  it('leaves a FRESH conflicted merge alone', async () => {
    await fsp.writeFile(path.join(repo, 'm.md'), 'base\n');
    run('git add -A && git commit -q -m base', repo);
    run('git checkout -q -b other', repo);
    await fsp.writeFile(path.join(repo, 'm.md'), 'other\n');
    run('git commit -qam other', repo);
    run('git checkout -q main', repo);
    await fsp.writeFile(path.join(repo, 'm.md'), 'main\n');
    run('git commit -qam main', repo);
    try { run('git merge other', repo); } catch { /* conflict expected */ }

    const result = await recoverOrphanedGitSurgery(repo);
    expect(result.recovered).toBe(false);
    expect(fs.existsSync(path.join(repo, '.git', 'MERGE_HEAD'))).toBe(true);
  });
});
