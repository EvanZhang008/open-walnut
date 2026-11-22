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
import {
  checkRepoSize, resetRepoSizeCheckForTest, REPO_SIZE_RECOVERY_KEY,
  judgeRepoSize, sumDistinctBlobBytes, trackedUserFileBytes, isUserAttachmentPath, USER_FILE_DIRS,
} from '../../src/integrations/git-sync.js';
import { artifactsDir } from '../../src/core/artifacts/paths.js';
import { NOTE_ATTACHMENT_DIR } from '../../src/core/notes/attachment-dir.js';
import { WALNUT_HOME, NOTES_DIR } from '../../src/constants.js';

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

describe("repo-size budget: the user's own files are not the repo growing", () => {
  const GB = 1024 * 1024 * 1024;
  const m = (liveBytes: number) => ({ liveBytes, debrisBytes: 0, sweptBytes: 0 });

  it('judges on top of the user files: the real 2026-11-22 numbers are healthy, a doubled history is not', () => {
    // 4.7GB of live packs, 3.1GB of them files attached to the user's notes.
    expect(judgeRepoSize(m(4.7 * GB), 3.1 * GB).over).toBe(false);
    // Without the allowance the same repo was "over" every 6h (the alarm).
    expect(judgeRepoSize(m(4.7 * GB), 0).over).toBe(true);
    // A pinned backup doubling the history still alarms, and names the allowance.
    const doubled = judgeRepoSize(m(8 * GB), 3.1 * GB);
    expect(doubled.over).toBe(true);
    expect(doubled.userBytes).toBe(3.1 * GB);
    expect(doubled.warning).toMatch(/threshold 3GB plus the 3\.1GB of files attached to your notes/);
  });

  it('counts each distinct attachment blob once; skips submodules and files outside attachment folders', () => {
    const rec = (type: string, oid: string, size: string, p: string) => `100644 ${type} ${oid} ${size.padStart(7)}\t${p}`;
    const out = [
      rec('blob', 'a'.repeat(40), '100', 'artifacts/x/_attachment/one photo.jpg'),
      rec('blob', 'a'.repeat(40), '100', 'artifacts/y/_attachment/same photo.jpg'),
      rec('blob', 'b'.repeat(40), '50', 'notes/y/_attachment/tab\there \u65e5\u672c.mov'),
      rec('blob', 'd'.repeat(40), '7000', 'artifacts/nodes/t1/drawings/download.bin'),
      rec('blob', 'e'.repeat(40), '9000', 'artifacts/x/_attachment'),
      rec('commit', 'c'.repeat(40), '-', 'artifacts/x/_attachment/sub'),
      '',
    ].join('\0');
    expect(sumDistinctBlobBytes(out)).toBe(150);
    expect(sumDistinctBlobBytes('')).toBe(0);
    expect(isUserAttachmentPath('artifacts/a/_attachment/b/c.png')).toBe(true);
    expect(isUserAttachmentPath('artifacts/a/_attachment.png')).toBe(false);
  });

  it('measures only attachments in HEAD of a real repo; 0 with no commit or no such folder', async () => {
    expect(await trackedUserFileBytes(repoDir)).toBe(0);
    await fsp.writeFile(path.join(repoDir, 'cron-jobs.json'), 'x'.repeat(9000));
    sh('git add -A && git commit -q -m json');
    expect(await trackedUserFileBytes(repoDir)).toBe(0);
    const att = path.join(repoDir, 'artifacts', 'notes', 'trip', NOTE_ATTACHMENT_DIR);
    await fsp.mkdir(att, { recursive: true });
    await fsp.mkdir(path.join(repoDir, 'notes', 'old', NOTE_ATTACHMENT_DIR), { recursive: true });
    await fsp.mkdir(path.join(repoDir, 'artifacts', 'nodes', 't1'), { recursive: true });
    await fsp.writeFile(path.join(att, 'v.bin'), Buffer.alloc(3000, 1));
    await fsp.writeFile(path.join(att, 'copy of v.bin'), Buffer.alloc(3000, 1));
    await fsp.writeFile(path.join(repoDir, 'notes', 'old', NOTE_ATTACHMENT_DIR, 'w.bin'), Buffer.alloc(500, 2));
    await fsp.writeFile(path.join(repoDir, 'artifacts', 'nodes', 't1', 'dump.log'), Buffer.alloc(4000, 3));
    sh('git add -A && git commit -q -m files');
    expect(await trackedUserFileBytes(repoDir)).toBe(3500);
  });

  it('guard: every root of the notes vault is a USER_FILE_DIRS entry', () => {
    // A new root for the vault must join USER_FILE_DIRS, or its attachments alarm as growth again.
    for (const root of [artifactsDir(), NOTES_DIR]) {
      const top = path.relative(WALNUT_HOME, root).split(path.sep)[0];
      expect(USER_FILE_DIRS as readonly string[]).toContain(top);
    }
  });

  it('guard: no source file names the attachment folder by hand', () => {
    // Every writer and reader of note attachments names the folder through
    // NOTE_ATTACHMENT_DIR, so a renamed or second attachment folder cannot slip
    // past the sentinel's allowance unseen.
    const srcDir = path.resolve(__dirname, '../../src');
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (/\.(ts|tsx|js|mjs)$/.test(e.name) && !p.endsWith(path.join('notes', 'attachment-dir.ts'))) {
          // Code lines only (prose in comments may name the folder): a string or
          // template literal holding the name is a writer or reader of its own.
          const code = fs.readFileSync(p, 'utf-8').split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l));
          // The bare name as a literal, or inside a path literal (no spaces: not prose).
          const named = (l: string) => /(['"`])_attachment\1/.test(l) || /(['"`])[^\s'"`]*\/_attachment\/?[^\s'"`]*\1/.test(l);
          if (code.some(named)) offenders.push(path.relative(srcDir, p));
        }
      }
    };
    walk(srcDir);
    expect(offenders).toEqual([]);
  });
});
