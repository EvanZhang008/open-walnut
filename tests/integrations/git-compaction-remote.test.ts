/**
 * Remote-coordination tests for git history compaction — the 2026-08 cloud
 * incident regression suite.
 *
 * Compaction REWRITES main; with a hub remote configured the rewritten chain
 * must be force-pushed (with lease) or every later sync wedges on
 * non-fast-forward. These tests run compactGitHistory against a REAL local
 * bare "hub" remote and verify:
 *   - the compacted chain lands on the hub (same head both sides)
 *   - unreachable remote → defer (skip), local history untouched
 *   - remote ahead of local → defer (never destroy unmerged hub commits)
 *   - push rejected (lease lost) → rollback to the pre-compaction chain
 */

import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { describe, it, expect, afterEach } from 'vitest';
import { compactGitHistory } from '../../src/integrations/git-compaction.js';

const tempDirs: string[] = [];

function tmp(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
});

function sh(cwd: string, cmd: string): string {
  return execSync(cmd, { cwd, stdio: 'pipe', encoding: 'utf-8' }).trim();
}

/** Working repo with `count` commits spread over `spanDays`, so the tiered
 *  selection has something to compact (needs ≥50 commits, >10% reduction). */
function seedRepo(dir: string, count: number, spanDays: number): void {
  sh(dir, 'git init --initial-branch=main .');
  sh(dir, 'git config user.email t@t && git config user.name t');
  for (let i = 0; i < count; i++) {
    const daysAgo = spanDays - (i * spanDays) / count;
    const iso = new Date(Date.now() - daysAgo * 86_400_000).toISOString();
    fs.writeFileSync(path.join(dir, 'data.txt'), `v${i}\n`, 'utf-8');
    execSync(`git add -A && git commit -m "c${i}"`, {
      cwd: dir, stdio: 'pipe',
      env: { ...process.env, GIT_AUTHOR_DATE: iso, GIT_COMMITTER_DATE: iso },
    });
  }
}

function addHub(repoDir: string): string {
  const hub = tmp('compact-hub-');
  sh(hub, 'git init --bare --initial-branch=main .');
  sh(repoDir, `git remote add origin "${hub}"`);
  sh(repoDir, 'git push -u origin main');
  return hub;
}

describe('compactGitHistory remote coordination', () => {
  it('force-pushes the compacted chain to the hub (heads match, hub history shrinks)', () => {
    const repo = tmp('compact-repo-');
    seedRepo(repo, 120, 60);
    const hub = addHub(repo);
    const hubBefore = Number(sh(hub, 'git rev-list --count main'));

    const result = compactGitHistory(repo);

    expect(result.error).toBeUndefined();
    expect(result.skipped).toBeUndefined();
    expect(result.after).toBeLessThan(result.before);
    // The hub must carry the SAME rewritten chain — anything else wedges sync.
    expect(sh(repo, 'git rev-parse main')).toBe(sh(hub, 'git rev-parse main'));
    expect(Number(sh(hub, 'git rev-list --count main'))).toBeLessThan(hubBefore);
  });

  it('defers (skip, history untouched) when the remote is unreachable', () => {
    const repo = tmp('compact-repo-');
    seedRepo(repo, 60, 60);
    sh(repo, 'git remote add origin /nonexistent/hub.git');
    const headBefore = sh(repo, 'git rev-parse main');

    const result = compactGitHistory(repo);

    expect(result.skipped).toBe(true);
    expect(sh(repo, 'git rev-parse main')).toBe(headBefore);
  });

  it('defers when origin/main has commits not merged locally (never destroys hub work)', () => {
    const repo = tmp('compact-repo-');
    seedRepo(repo, 60, 60);
    const hub = addHub(repo);

    // Simulate the cloud box pushing a commit the Mac hasn't pulled yet.
    const other = tmp('compact-other-');
    sh(other, `git clone "${hub}" .`);
    sh(other, 'git config user.email o@o && git config user.name o');
    fs.writeFileSync(path.join(other, 'cloud.txt'), 'from cloud\n', 'utf-8');
    sh(other, 'git add -A && git commit -m "cloud edit" && git push origin main');

    const headBefore = sh(repo, 'git rev-parse main');
    const result = compactGitHistory(repo);

    expect(result.skipped).toBe(true);
    expect(sh(repo, 'git rev-parse main')).toBe(headBefore);
    // The cloud commit survives on the hub.
    expect(sh(hub, 'git log --format=%s -1 main')).toBe('cloud edit');
  });

  it('rolls back to the pre-compaction chain when the push is rejected', () => {
    const repo = tmp('compact-repo-');
    seedRepo(repo, 120, 60);
    const hub = addHub(repo);
    const headBefore = sh(repo, 'git rev-parse main');
    const countBefore = Number(sh(repo, 'git rev-list --count main'));

    // Reject every push — models a lost lease / hub-side failure.
    const hook = path.join(hub, 'hooks', 'pre-receive');
    fs.writeFileSync(hook, '#!/bin/sh\necho rejected >&2\nexit 1\n', { mode: 0o755 });

    const result = compactGitHistory(repo);

    expect(result.error).toMatch(/push of compacted history failed/);
    // Local main restored — repo and hub still agree, sync keeps working.
    expect(sh(repo, 'git rev-parse main')).toBe(headBefore);
    expect(Number(sh(repo, 'git rev-list --count main'))).toBe(countBefore);
    expect(sh(hub, 'git rev-parse main')).toBe(headBefore);
  });

  it('still compacts a repo with no remote at all (local-only path unchanged)', () => {
    const repo = tmp('compact-repo-');
    seedRepo(repo, 120, 60);

    const result = compactGitHistory(repo);

    expect(result.error).toBeUndefined();
    expect(result.after).toBeLessThan(result.before);
  });
});
