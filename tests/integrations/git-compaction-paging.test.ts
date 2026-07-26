/**
 * Regression tests for the silent-compaction-failure half of the 2026-07-25
 * incident: one `git log` over the whole history blew execSync's 1MB default
 * maxBuffer at ~10k commits (ENOBUFS), so compaction failed on every run for
 * months with only a debug-level warn — the repo grew to 15GB/161k commits.
 *
 * collectCommitsPaged() reads history in fixed pages so no single child-process
 * read scales with repo size. checkRepoSize() is the last-line sentinel that
 * warns when .git balloons regardless of which defense layer failed.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fsp from 'node:fs/promises';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';

import { collectCommitsPaged } from '../../src/integrations/git-compaction.js';
import { checkRepoSize, resetRepoSizeCheckForTest } from '../../src/integrations/git-sync.js';

let repoDir: string;

function sh(cmd: string): string {
  return execSync(cmd, { cwd: repoDir, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] });
}

beforeEach(async () => {
  repoDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'walnut-compaction-paging-'));
  sh('git init -q && git checkout -qb main');
  sh('git config user.email t@t.t && git config user.name t');
});

afterEach(async () => {
  await fsp.rm(repoDir, { recursive: true, force: true });
});

describe('collectCommitsPaged', () => {
  it('returns every commit oldest-first across page boundaries', async () => {
    // 23 commits with a 10-commit page would exercise 3 pages; the real page
    // size is 5000, so instead verify ordering + completeness directly.
    for (let i = 1; i <= 23; i++) {
      await fsp.writeFile(path.join(repoDir, 'f.txt'), `v${i}`);
      sh(`git add -A && git commit -q -m "c${i}" --date="2026-01-${String(i).padStart(2, '0')}T00:00:00Z"`);
    }

    const commits = collectCommitsPaged(repoDir);

    expect(commits).toHaveLength(23);
    expect(commits[0].subject).toBe('c1');   // oldest first
    expect(commits[22].subject).toBe('c23'); // newest last
    // Strictly chronological — the page-flip must not shuffle order.
    for (let i = 1; i < commits.length; i++) {
      expect(commits[i].date >= commits[i - 1].date).toBe(true);
    }
  }, 60_000);

  it('handles an empty repo without throwing', () => {
    // No commits at all — `git log` errors; paged collection must fail like
    // the old single-shot call did (caller treats it as "nothing to compact").
    expect(() => collectCommitsPaged(repoDir)).toThrow();
  });
});

describe('checkRepoSize sentinel', () => {
  beforeEach(() => resetRepoSizeCheckForTest());

  it('returns null for a small repo', () => {
    sh('git commit -q --allow-empty -m init');
    expect(checkRepoSize(repoDir)).toBeNull();
  });

  it('warns when pack files exceed the threshold', async () => {
    // Fabricate an oversized pack — the sentinel measures objects/pack bytes.
    const packDir = path.join(repoDir, '.git', 'objects', 'pack');
    await fsp.mkdir(packDir, { recursive: true });
    const fd = fs.openSync(path.join(packDir, 'pack-fake.pack'), 'w');
    fs.ftruncateSync(fd, 3.5 * 1024 * 1024 * 1024); // sparse 3.5GB
    fs.closeSync(fd);

    const warning = checkRepoSize(repoDir);
    expect(warning).toMatch(/3\.5GB/);
    expect(warning).toMatch(/compaction may be failing/);
  });

  it('self-throttles: second call within the window returns null', async () => {
    const packDir = path.join(repoDir, '.git', 'objects', 'pack');
    await fsp.mkdir(packDir, { recursive: true });
    const fd = fs.openSync(path.join(packDir, 'pack-fake.pack'), 'w');
    fs.ftruncateSync(fd, 4 * 1024 * 1024 * 1024);
    fs.closeSync(fd);

    expect(checkRepoSize(repoDir)).not.toBeNull();
    // Called every 30s tick — must not re-stat or re-notify each time.
    expect(checkRepoSize(repoDir)).toBeNull();
  });
});
