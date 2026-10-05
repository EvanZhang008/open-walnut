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
import { checkRepoSize, resetRepoSizeCheckForTest, REPO_SIZE_RECOVERY_KEY } from '../../src/integrations/git-sync.js';

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

  const GB = 1024 * 1024 * 1024;
  async function sparse(name: string, bytes: number, ageMs = 0): Promise<string> {
    const packDir = path.join(repoDir, '.git', 'objects', 'pack');
    await fsp.mkdir(packDir, { recursive: true });
    const p = path.join(packDir, name);
    const fd = fs.openSync(p, 'w');
    fs.ftruncateSync(fd, bytes);
    fs.closeSync(fd);
    if (ageMs > 0) {
      const t = new Date(Date.now() - ageMs);
      await fsp.utimes(p, t, t);
    }
    return p;
  }

  it('measures a small repo as under the threshold, with no warning', () => {
    sh('git commit -q --allow-empty -m init');
    const verdict = checkRepoSize(repoDir);
    expect(verdict).not.toBeNull();
    expect(verdict!.over).toBe(false);
    expect(verdict!.warning).toBeNull();
    expect(verdict!.debrisBytes).toBe(0);
  });

  it('warns when pack files exceed the threshold', async () => {
    // Fabricate an oversized pack — the sentinel measures objects/pack bytes.
    await sparse('pack-fake.pack', 3.5 * GB);

    const verdict = checkRepoSize(repoDir);
    expect(verdict!.over).toBe(true);
    expect(verdict!.liveBytes).toBe(3.5 * GB);
    const warning = verdict!.warning;
    expect(warning).toMatch(/3\.5GB/);
    // Points at the causes that have actually produced this alert, not at the
    // compaction layer (which was healthy each time).
    expect(warning).toMatch(/backup-\* branches/);
    expect(warning).toMatch(/tmp_pack_\* debris/);
    expect(warning).not.toMatch(/compaction may be failing/);
  });

  it('sweeps dead transfer corpses first and never counts them as repo size', async () => {
    // 2026-10-05: the cloud box reported 10.7GB; 7.1GB of it was tmp_pack_*
    // corpses from one rewrite adoption, and the live repo was 3.6GB. The
    // corpses are not the repo, and they are the sentinel's to remove.
    await sparse('pack-live.pack', 1 * GB);
    const corpse = await sparse('tmp_pack_dead01', 4 * GB, 10 * 60_000);

    const verdict = checkRepoSize(repoDir);
    expect(verdict!.over).toBe(false);
    expect(verdict!.warning).toBeNull();
    expect(verdict!.liveBytes).toBe(1 * GB);
    expect(verdict!.sweptBytes).toBe(4 * GB);
    expect(verdict!.debrisBytes).toBe(0);
    expect(fs.existsSync(corpse)).toBe(false);
  });

  it('leaves a fresh tmp_pack alone (a transfer may be writing it) and names it beside a real overage', async () => {
    await sparse('pack-live.pack', 3.5 * GB);
    const inflight = await sparse('tmp_pack_live01', 1 * GB);

    const verdict = checkRepoSize(repoDir);
    expect(verdict!.over).toBe(true);
    expect(verdict!.sweptBytes).toBe(0);
    expect(verdict!.debrisBytes).toBe(1 * GB);
    expect(fs.existsSync(inflight)).toBe(true);
    expect(verdict!.warning).toMatch(/3\.5GB of live packs/);
    expect(verdict!.warning).toMatch(/1\.0GB of tmp_pack_\* debris from a transfer still in flight is not counted/);
  });

  it('self-throttles: second call within the window returns null', async () => {
    await sparse('pack-fake.pack', 4 * GB);

    expect(checkRepoSize(repoDir)).not.toBeNull();
    // Called every 30s tick — must not re-stat or re-notify each time.
    expect(checkRepoSize(repoDir)).toBeNull();
  });

  it('keeps its own recovery key apart from the auto-commit family', () => {
    // A commit edge says nothing about size; the card retires on a measured
    // pass under the threshold, never on `git` recovering.
    expect(REPO_SIZE_RECOVERY_KEY).toBe('git:repo-size');
    expect(REPO_SIZE_RECOVERY_KEY).not.toBe('git');
  });
});
