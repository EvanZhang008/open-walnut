/**
 * 2026-08 cloud-incident regressions — sync-side pieces of the fix.
 *
 * Root cause chain: compaction's pause flag lived only in the forked worker's
 * memory, so the server's 30s tick kept committing mid-rewrite → every
 * compaction failed tree verification for 9 days → the data repo regrew to
 * 6.5GB → its pushes wedged the cloud hub (99.85% CPU for a week; the phone
 * app showed "offline" because TLS handshakes starved).
 *
 * Pinned here:
 *   1. sync() must be a no-op while compactionInProgress is set — it runs its
 *      own `add -A` + commit, so gating only commitIfDirty() is not enough.
 *   2. After the primary force-pushes a compacted (rewritten) main, the other
 *      box's sync must ADOPT the new chain, not merge the old fat history
 *      back in (which would resurrect everything compaction removed).
 */

import { execSync } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createMockConstants } from '../helpers/mock-constants.js';

vi.mock('../../src/constants.js', () => createMockConstants());

import {
  sync,
  initSync,
  setRemote,
  setCompactionInProgress,
  noteNetworkFailure,
  resetSyncGuardForTest,
} from '../../src/integrations/git-sync.js';
import { WALNUT_HOME } from '../../src/constants.js';

let tmpDir: string;

function sh(cmd: string, cwd: string, env?: Record<string, string>): string {
  return execSync(cmd, { cwd, encoding: 'utf-8', timeout: 30_000, stdio: ['pipe', 'pipe', 'pipe'], env: env ? { ...process.env, ...env } : undefined }).trim();
}

/** Author and committer date `offsetSec` from now, as git's raw date format. */
function at(offsetSec: number): Record<string, string> {
  const d = `${Math.floor(Date.now() / 1000) + offsetSec} +0000`;
  return { GIT_AUTHOR_DATE: d, GIT_COMMITTER_DATE: d };
}

beforeEach(async () => {
  tmpDir = WALNUT_HOME;
  await fsp.rm(tmpDir, { recursive: true, force: true });
  await fsp.mkdir(tmpDir, { recursive: true });
});

afterEach(async () => {
  setCompactionInProgress(false);
  resetSyncGuardForTest();
  await fsp.rm(tmpDir, { recursive: true, force: true });
});

describe('sync ↔ compaction coordination', () => {
  it('sync() is a no-op while compactionInProgress is set (would move main mid-rewrite)', async () => {
    initSync();
    sh('git config user.email t@t && git config user.name t', tmpDir);
    await fsp.writeFile(path.join(tmpDir, 'dirty.txt'), 'uncommitted\n', 'utf-8');

    setCompactionInProgress(true);
    const result = await sync();
    expect(result).toEqual({ pulled: 0, pushed: 0, conflicts: 0 });
    // The dirty file must NOT have been committed.
    expect(sh('git status --porcelain', tmpDir)).toContain('dirty.txt');

    // …and the same tree syncs normally once the flag clears.
    setCompactionInProgress(false);
    await sync();
    expect(sh('git status --porcelain', tmpDir)).toBe('');
  });
});

describe('sync adopts a rewritten upstream (post-compaction force-push)', () => {
  // Two sub-cases, matching how `pull --rebase` reacts to a rewritten upstream:
  //  a) local-only commits REPLAY cleanly onto the new chain → rebase handles
  //     it, no special path needed (pin it so a git behavior change surfaces).
  //  b) the replay CONFLICTS → rebase aborts → lwwMerge sees no merge base →
  //     hard-adopt origin/main, old head parked on pre-rewrite-backup.

  let bare: string;
  let other: string;

  beforeEach(async () => {
    bare = `${tmpDir}-rewrite-origin.git`;
    other = `${tmpDir}-rewrite-clone`;
    await fsp.rm(bare, { recursive: true, force: true });
    await fsp.rm(other, { recursive: true, force: true });
    await fsp.mkdir(bare, { recursive: true });
    sh('git init --bare -b main', bare);
    initSync();
    sh('git config user.email t@t && git config user.name t', tmpDir);
    setRemote(bare);
    await fsp.writeFile(path.join(tmpDir, 'data.txt'), 'original\n', 'utf-8');
    sh('git add -A && git commit -m base', tmpDir);
    sh('git push origin main', tmpDir);
    sh(`git clone "${bare}" "${other}"`, tmpDir);
    sh('git config user.email p@p && git config user.name p', other);
  });

  afterEach(async () => {
    await fsp.rm(bare, { recursive: true, force: true });
    await fsp.rm(other, { recursive: true, force: true });
  });

  /**
   * Force-push a compacted root (single commit, given tree) from `other`. Dated an
   * hour ahead unless told otherwise, so a local commit made in the test reads as
   * older than the rewrite and is not carried across it by time.
   */
  function compactAndForcePush(treeRef: string, offsetSec = 3600): string {
    const tree = sh(`git rev-parse ${treeRef}`, other);
    const newRoot = sh(`git commit-tree ${tree} -m "compacted"`, other, at(offsetSec));
    sh(`git push --force origin ${newRoot}:refs/heads/main`, other);
    return newRoot;
  }

  it('clean replay: local-only commit survives on top of the compacted chain', async () => {
    // Local commits an edit the compacted tree doesn't conflict with.
    await fsp.writeFile(path.join(tmpDir, 'other.txt'), 'local work\n', 'utf-8');
    sh('git add -A && git commit -m "local work"', tmpDir);

    const newRoot = compactAndForcePush('main^{tree}');
    await sync();

    // Rebase replayed the local commit onto the new root — nothing lost.
    expect(sh('git rev-parse HEAD^', tmpDir)).toBe(newRoot);
    expect(sh('git log -1 --format=%s', tmpDir)).toBe('local work');
    expect(await fsp.readFile(path.join(tmpDir, 'other.txt'), 'utf-8')).toBe('local work\n');
  });

  it('conflicting replay of a commit older than the rewrite: hard-adopt origin/main, park old head on pre-rewrite-backup', async () => {
    // The "primary" advanced data.txt to v2 and compacted THAT tree.
    await fsp.writeFile(path.join(other, 'data.txt'), 'v2\n', 'utf-8');
    sh('git add -A && git commit -m v2', other);
    const newRoot = compactAndForcePush('main^{tree}');

    // Local meanwhile edited the SAME line from the old base — the replay
    // onto the compacted chain conflicts, so rebase aborts.
    await fsp.writeFile(path.join(tmpDir, 'data.txt'), 'local-edit\n', 'utf-8');
    sh('git add -A && git commit -m "local edit"', tmpDir);
    const oldHead = sh('git rev-parse HEAD', tmpDir);

    const result = await sync();

    // Adopted the rewritten chain instead of merging the old fat one back in.
    expect(result.pulled).toBe(1);
    expect(sh('git rev-parse HEAD', tmpDir)).toBe(newRoot);
    // Hub still points at the compacted root — our push-back didn't refatten it.
    expect(sh('git rev-parse main', bare)).toBe(newRoot);
    // The losing local edit stays recoverable from the backup ref.
    expect(sh('git rev-parse pre-rewrite-backup', tmpDir)).toBe(oldHead);
    expect(sh('git show pre-rewrite-backup:data.txt', tmpDir)).toBe('local-edit');
    // Working tree matches the adopted chain.
    expect(await fsp.readFile(path.join(tmpDir, 'data.txt'), 'utf-8')).toBe('v2\n');
  });

  // 2026-10-12: the cloud box adopted a rewrite at 11:05 and then held the old
  // pack beside a full copy of the new chain (2.1GB of data as 3.5GB of packs)
  // for 9 hours, raising "Data Repo Growing Too Large" twice, until a restart
  // happened to let maintenance run. The adoption itself now asks for the gc.
  it('an adoption brings a maintenance pass forward instead of leaving duplicate packs until the daily check', async () => {
    const { startGitMaintenance, readLastRun } = await import('../../src/integrations/git-maintenance.js');
    const marker = path.join(tmpDir, '.git', 'walnut-last-maintenance');
    // Maintained a minute ago with room to grow: nothing but the rewrite can make a pass due.
    const lastAt = Date.now() - 60_000;
    await fsp.writeFile(marker, JSON.stringify({ at: lastAt, packBytesAfter: 1024 ** 3 }));
    const handle = startGitMaintenance({ startDelayMs: 60 * 60_000, rewriteDelayMs: 50 });
    try {
      await fsp.writeFile(path.join(other, 'data.txt'), 'v2\n', 'utf-8');
      sh('git add -A && git commit -m v2', other);
      const newRoot = compactAndForcePush('main^{tree}');
      await fsp.writeFile(path.join(tmpDir, 'data.txt'), 'local-edit\n', 'utf-8');
      sh('git add -A && git commit -m "local edit"', tmpDir);

      await sync();
      expect(sh('git rev-parse HEAD', tmpDir)).toBe(newRoot);

      const deadline = Date.now() + 30_000;
      while (readLastRun(path.join(tmpDir, '.git')).at === lastAt && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 100));
      }
      expect(readLastRun(path.join(tmpDir, '.git')).at).toBeGreaterThan(lastAt);
      // The gc kept the parked chain: the backup ref still resolves.
      expect(sh('git show pre-rewrite-backup:data.txt', tmpDir)).toBe('local-edit');
      expect(sh('git fsck --no-progress', tmpDir)).not.toMatch(/missing|error/i);
    } finally {
      handle.stop();
    }
  });

  it('a rewrite pass that had to stand down keeps the rewrite for the next pass', async () => {
    const { startGitMaintenance, readLastRun } = await import('../../src/integrations/git-maintenance.js');
    const gitDir = path.join(tmpDir, '.git');
    const lastAt = Date.now() - 60_000;
    await fsp.writeFile(path.join(gitDir, 'walnut-last-maintenance'), JSON.stringify({ at: lastAt, packBytesAfter: 1024 ** 3 }));
    // The rewrite pass waits 3s: the push that follows the adoption inside sync()
    // can outlast a shorter delay on a loaded machine, and the pass would then run
    // before the test holds the repo (it failed that way at HEAD too, 2026-10-28).
    const handle = startGitMaintenance({ startDelayMs: 60 * 60_000, rewriteDelayMs: 3_000 });
    try {
      await fsp.writeFile(path.join(other, 'data.txt'), 'v2\n', 'utf-8');
      sh('git add -A && git commit -m v2', other);
      compactAndForcePush('main^{tree}');
      await fsp.writeFile(path.join(tmpDir, 'data.txt'), 'local-edit\n', 'utf-8');
      sh('git add -A && git commit -m "local edit"', tmpDir);
      await sync();

      // Compaction holds the repo when the rewrite pass fires: it stands down.
      setCompactionInProgress(true);
      await new Promise((r) => setTimeout(r, 4_000));
      expect(readLastRun(gitDir).at).toBe(lastAt);

      // The next pass (here the daily tick's) still runs the rewrite gc.
      setCompactionInProgress(false);
      const [worktree] = await handle.runOnce();
      expect(worktree.reason).toBe('rewrite');
      expect(worktree.ran).toBe(true);
      expect(readLastRun(gitDir).at).toBeGreaterThan(lastAt);
    } finally {
      handle.stop();
    }
  });

  it('an ordinary merge does not ask for a maintenance pass', async () => {
    const { setRewriteAdoptedListener } = await import('../../src/integrations/git-sync.js');
    let adopted = 0;
    setRewriteAdoptedListener(() => { adopted++; });
    try {
      await fsp.writeFile(path.join(other, 'theirs.txt'), 'theirs\n', 'utf-8');
      sh('git add -A && git commit -m theirs', other);
      sh('git push origin main', other);
      await fsp.writeFile(path.join(tmpDir, 'data.txt'), 'local-edit\n', 'utf-8');
      sh('git add -A && git commit -m "local edit"', tmpDir);
      await sync();
      expect(adopted).toBe(0);
    } finally {
      setRewriteAdoptedListener(null);
    }
  });

  it('shared-ancestry rewrite (filter-repo style): adopts the force-moved upstream instead of merging the old chain back', async () => {
    // Both sides share `base` AND `v2`: the primary publishes v2 normally and
    // local pulls it, so the later rewrite keeps a common ancestor.
    await fsp.writeFile(path.join(other, 'data.txt'), 'v2\n', 'utf-8');
    sh('git add -A && git commit -m v2', other);
    sh('git push origin main', other);
    await sync();
    const base = sh('git rev-parse HEAD^', tmpDir);
    expect(sh('git show HEAD:data.txt', tmpDir)).toBe('v2');

    // The primary rewrites v2 in place (a new commit on the SAME parent, with
    // the scrubbed content) and force-pushes — what a path scrub leaves behind.
    sh(`git reset -q --hard ${base}`, other);
    await fsp.writeFile(path.join(other, 'data.txt'), 'v2 scrubbed\n', 'utf-8');
    sh('git add -A && git commit -m "v2 (rewritten)"', other);
    const rewritten = sh('git rev-parse HEAD', other);
    sh('git push --force origin main', other);

    // Local meanwhile edits the same line: the replay conflicts, so the sync
    // lands in lwwMerge, where a merge base now EXISTS (base).
    await fsp.writeFile(path.join(tmpDir, 'data.txt'), 'local-edit\n', 'utf-8');
    sh('git add -A && git commit -m "local edit"', tmpDir);
    const oldHead = sh('git rev-parse HEAD', tmpDir);
    const oldV2 = sh('git rev-parse HEAD^', tmpDir);

    const result = await sync();

    // Adopted, not merged: the local edit (newer than the rewrite) is carried
    // onto the rewritten chain as one commit, the pre-scrub v2 the hub already
    // had is NOT replayed (no merge, not in history), and the hub took it
    // fast-forward.
    expect(result.pulled).toBe(1);
    expect(sh('git rev-parse HEAD^', tmpDir)).toBe(rewritten);
    expect(sh('git log -1 --format=%s', tmpDir)).toBe('local edit');
    expect(sh('git rev-list --count --merges HEAD', tmpDir)).toBe('0');
    expect(() => sh(`git merge-base --is-ancestor ${oldV2} HEAD`, tmpDir)).toThrow();
    expect(sh('git rev-parse main', bare)).toBe(sh('git rev-parse HEAD', tmpDir));
    expect(sh('git rev-parse pre-rewrite-backup', tmpDir)).toBe(oldHead);
    expect(await fsp.readFile(path.join(tmpDir, 'data.txt'), 'utf-8')).toBe('local-edit\n');
  });

  it('ordinary divergence with a shared ancestor still merges (a fast-forwarded upstream is not a rewrite)', async () => {
    // The primary adds a NEW file on top of base (origin/main moves forward,
    // the old remote-tracking head stays an ancestor); local adds its own.
    await fsp.writeFile(path.join(other, 'theirs.txt'), 'theirs\n', 'utf-8');
    sh('git add -A && git commit -m theirs', other);
    sh('git push origin main', other);
    await fsp.writeFile(path.join(tmpDir, 'data.txt'), 'local-edit\n', 'utf-8');
    sh('git add -A && git commit -m "local edit"', tmpDir);

    await sync();

    // Both edits survive; nothing was parked on a backup ref.
    expect(await fsp.readFile(path.join(tmpDir, 'theirs.txt'), 'utf-8')).toBe('theirs\n');
    expect(await fsp.readFile(path.join(tmpDir, 'data.txt'), 'utf-8')).toBe('local-edit\n');
    expect(() => sh('git rev-parse --verify -q pre-rewrite-backup', tmpDir)).toThrow();
  });

  // 2026-10-28: the hub's chain and this box's no longer shared a commit (this
  // box's own compaction had rewritten main and died before its push). The
  // adoption reset to the hub's chain and three auto-saves from 07:23 to 07:27
  // left the working tree. Each case below is a local commit made AFTER the
  // point the other chain was cut from, then the adoption.
  describe('local commits newer than the rewrite are carried onto the new chain', () => {
    async function localCommit(file: string, content: string, subject: string, env?: Record<string, string>): Promise<void> {
      await fsp.mkdir(path.dirname(path.join(tmpDir, file)), { recursive: true });
      await fsp.writeFile(path.join(tmpDir, file), content, 'utf-8');
      sh(`git add -A && git commit -q -m "${subject}"`, tmpDir, env);
    }

    it('the incident: commits after the rewrite base survive an adoption that skipped the rebase', async () => {
      // The rewrite keeps base's tree (compaction does), cut before the local work.
      const newRoot = compactAndForcePush('main^{tree}', -60);
      await localCommit('cron-jobs.json', '{"jobs":[{"id":"t1"}]}\n', 'auto-save 07:23:54 (17 files)');
      await localCommit('triggers/new/check.sh', 'echo\n', 'open-walnut sync 07:23:56');
      await localCommit('boards/b.json', '{"html":"x"}\n', 'auto-save 07:27:02 (5 files)');
      const oldHead = sh('git rev-parse HEAD', tmpDir);
      // As at 07:24:58: a failed fetch sends the next pull straight to the merge path.
      noteNetworkFailure();

      const result = await sync();

      expect(result.pulled).toBe(1);
      expect(sh(`git rev-list --count ${newRoot}..HEAD`, tmpDir)).toBe('3');
      expect(sh('git merge-base --is-ancestor ' + newRoot + ' HEAD && echo yes', tmpDir)).toBe('yes');
      expect(sh('git log --format=%s -3', tmpDir).split('\n')).toEqual([
        'auto-save 07:27:02 (5 files)', 'open-walnut sync 07:23:56', 'auto-save 07:23:54 (17 files)',
      ]);
      expect(sh('git rev-parse HEAD^{tree}', tmpDir)).toBe(sh(`git rev-parse ${oldHead}^{tree}`, tmpDir));
      expect(await fsp.readFile(path.join(tmpDir, 'cron-jobs.json'), 'utf-8')).toBe('{"jobs":[{"id":"t1"}]}\n');
      expect(await fsp.readFile(path.join(tmpDir, 'triggers/new/check.sh'), 'utf-8')).toBe('echo\n');
      expect(sh('git status --porcelain', tmpDir)).toBe('');
      // The hub moved fast-forward onto the carried commits; the old head stays parked.
      expect(sh('git rev-parse main', bare)).toBe(sh('git rev-parse HEAD', tmpDir));
      expect(sh('git rev-parse pre-rewrite-backup', tmpDir)).toBe(oldHead);
    });

    it('the same with the rebase path open', async () => {
      const newRoot = compactAndForcePush('main^{tree}', -60);
      await localCommit('cron-jobs.json', '{"jobs":[]}\n', 'local one');
      await localCommit('notes.md', 'two\n', 'local two');
      await sync();
      expect(sh(`git rev-list --count ${newRoot}..HEAD`, tmpDir)).toBe('2');
      expect(await fsp.readFile(path.join(tmpDir, 'notes.md'), 'utf-8')).toBe('two\n');
      expect(sh('git rev-parse main', bare)).toBe(sh('git rev-parse HEAD', tmpDir));
    });

    it('this box rewrote its own main (the 2026-10-28 direction): its later commits land on the hub chain', async () => {
      await localCommit('data.txt', 'v2\n', 'auto-save 06:57:48 (2 files)');
      sh('git push -q origin main', tmpDir);
      const hubHead = sh('git rev-parse HEAD', tmpDir);
      // A local compaction swap: same tree, a fresh root, never pushed.
      const rewritten = sh('git commit-tree HEAD^{tree} -m "compacted: auto-save 06:57:48 (2 files)"', tmpDir);
      sh(`git update-ref refs/heads/main ${rewritten}`, tmpDir);
      await localCommit('cron-jobs.json', '{"jobs":[{"id":"new"}]}\n', 'auto-save 07:23:54 (17 files)');
      await localCommit('boards/b.json', '{}\n', 'auto-save 07:27:02 (5 files)');
      noteNetworkFailure();

      await sync();

      expect(sh('git rev-parse HEAD~2', tmpDir)).toBe(hubHead);
      expect(await fsp.readFile(path.join(tmpDir, 'cron-jobs.json'), 'utf-8')).toBe('{"jobs":[{"id":"new"}]}\n');
      expect(await fsp.readFile(path.join(tmpDir, 'boards/b.json'), 'utf-8')).toBe('{}\n');
      expect(sh('git rev-parse main', bare)).toBe(sh('git rev-parse HEAD', tmpDir));
    });

    it('the hub built on its rewrite meanwhile: the carried commits merge with the newer hub work', async () => {
      compactAndForcePush('main^{tree}', -60);
      sh('git fetch -q origin && git reset -q --hard origin/main', other);
      await fsp.writeFile(path.join(other, 'theirs.txt'), 'theirs\n', 'utf-8');
      sh('git add -A && git commit -q -m theirs && git push -q origin main', other);
      await localCommit('mine.txt', 'mine\n', 'local work');
      noteNetworkFailure();

      await sync();

      expect(await fsp.readFile(path.join(tmpDir, 'theirs.txt'), 'utf-8')).toBe('theirs\n');
      expect(await fsp.readFile(path.join(tmpDir, 'mine.txt'), 'utf-8')).toBe('mine\n');
      expect(sh('git rev-parse main', bare)).toBe(sh('git rev-parse HEAD', tmpDir));
      expect(sh(`git merge-base --is-ancestor ${sh('git rev-parse main', other)} HEAD && echo yes`, tmpDir)).toBe('yes');
    });

    it('a path scrub (dates and subjects kept, a file removed): the later commit is carried, the removal stands', async () => {
      await fsp.writeFile(path.join(tmpDir, 'data.txt'), 'with secret\n', 'utf-8');
      await localCommit('secret.txt', 'token\n', 'auto-save with secret', at(-120));
      sh('git push -q origin main', tmpDir);
      const scrubbedFrom = sh('git rev-parse HEAD', tmpDir);
      // filter-repo style: the same commit (author date, subject) without secret.txt.
      sh('git fetch -q origin && git reset -q --hard origin/main', other);
      const meta = sh('git log -1 --format=%ad --date=raw', other);
      sh('git rm -q secret.txt', other);
      sh('git commit -q --amend -m "auto-save with secret"', other, { GIT_AUTHOR_DATE: meta, GIT_COMMITTER_DATE: meta });
      sh('git push -q --force origin main', other);
      const scrubbed = sh('git rev-parse HEAD', other);
      // Local, after the scrubbed commit: edits data.txt, touches the secret, adds a file.
      await fsp.writeFile(path.join(tmpDir, 'data.txt'), 'later\n', 'utf-8');
      await fsp.writeFile(path.join(tmpDir, 'secret.txt'), 'token2\n', 'utf-8');
      await fsp.writeFile(path.join(tmpDir, 'added.txt'), 'added\n', 'utf-8');
      sh('git add -A && git commit -q -m later', tmpDir);
      noteNetworkFailure();

      await sync();

      expect(sh('git rev-parse HEAD^', tmpDir)).toBe(scrubbed);
      expect(sh('git log -1 --format=%s', tmpDir)).toBe('later');
      expect(await fsp.readFile(path.join(tmpDir, 'data.txt'), 'utf-8')).toBe('later\n');
      expect(await fsp.readFile(path.join(tmpDir, 'added.txt'), 'utf-8')).toBe('added\n');
      expect(() => sh('git cat-file -e HEAD:secret.txt', tmpDir)).toThrow();
      expect(() => sh(`git merge-base --is-ancestor ${scrubbedFrom} HEAD`, tmpDir)).toThrow();
      expect(sh('git rev-parse main', bare)).toBe(sh('git rev-parse HEAD', tmpDir));
    });

    it('a rewrite no commit matches: only local commits newer than its newest commit are carried', async () => {
      await localCommit('old.txt', 'old\n', 'before the rewrite', at(-600));
      await fsp.writeFile(path.join(other, 'data.txt'), 'other tree\n', 'utf-8');
      sh('git add -A && git commit -q -m other', other);
      const newRoot = compactAndForcePush('main^{tree}', -300);
      await localCommit('new.txt', 'new\n', 'after the rewrite', at(-10));
      noteNetworkFailure();

      await sync();

      expect(sh('git rev-parse HEAD^', tmpDir)).toBe(newRoot);
      expect(await fsp.readFile(path.join(tmpDir, 'new.txt'), 'utf-8')).toBe('new\n');
      expect(await fsp.readFile(path.join(tmpDir, 'data.txt'), 'utf-8')).toBe('other tree\n');
      // Older than the rewrite and not in it: parked, not replayed over it.
      expect(fs.existsSync(path.join(tmpDir, 'old.txt'))).toBe(false);
      expect(sh('git show pre-rewrite-backup:old.txt', tmpDir)).toBe('old');
    });

    it('a merge commit that pulled in a file the hub later scrubbed does not bring it back', async () => {
      // The other box publishes S1 with a secret; this box merges it (a true
      // merge, its own work in between) and has not pushed when the scrub lands.
      await fsp.writeFile(path.join(other, 'secret.txt'), 'token\n', 'utf-8');
      await fsp.writeFile(path.join(other, 'theirs.txt'), 'theirs\n', 'utf-8');
      sh('git add -A && git commit -q -m S1 && git push -q origin main', other);
      await localCommit('mine.txt', 'mine\n', 'local work');
      sh('git fetch -q origin && git merge -q --no-edit origin/main', tmpDir);
      expect(sh('git cat-file -e HEAD:secret.txt && echo yes', tmpDir)).toBe('yes');
      // The scrub: S1 again without the secret, same date and subject.
      const meta = sh('git log -1 --format=%ad --date=raw', other);
      sh('git rm -q secret.txt', other);
      sh('git commit -q --amend -m S1', other, { GIT_AUTHOR_DATE: meta, GIT_COMMITTER_DATE: meta });
      sh('git push -q --force origin main', other);
      noteNetworkFailure();

      await sync();

      expect(() => sh('git cat-file -e HEAD:secret.txt', tmpDir)).toThrow();
      expect(fs.existsSync(path.join(tmpDir, 'secret.txt'))).toBe(false);
      expect(await fsp.readFile(path.join(tmpDir, 'mine.txt'), 'utf-8')).toBe('mine\n');
      expect(await fsp.readFile(path.join(tmpDir, 'theirs.txt'), 'utf-8')).toBe('theirs\n');
      expect(() => sh('git cat-file -e main:secret.txt', bare)).toThrow();
    });

    it('a conflict on a store goes to the newer lastUpdated, not to the side being carried', async () => {
      // The rebuilt chain matches nothing here; base is what the hub had, so the
      // replay starts there, onto the rebuilt tip, which already holds a NEWER store.
      await fsp.writeFile(path.join(other, 'store.json'), JSON.stringify({ lastUpdated: '2026-06-01T00:00:00.000Z', v: 'remote' }) + '\n', 'utf-8');
      sh('git add -A', other);
      const tree = sh('git write-tree', other);
      const rebuilt = sh(`git commit-tree ${tree} -m rebuilt`, other, at(-300));
      sh(`git push -q --force origin ${rebuilt}:refs/heads/main`, other);
      await localCommit('store.json', JSON.stringify({ lastUpdated: '2026-01-01T00:00:00.000Z', v: 'local' }) + '\n', 'older store write', at(-10));
      await localCommit('mine.txt', 'mine\n', 'local work', at(-5));
      noteNetworkFailure();

      await sync();

      // The older store write left nothing to carry; only the later commit lands.
      expect(sh('git rev-parse HEAD^', tmpDir)).toBe(rebuilt);
      expect(JSON.parse(await fsp.readFile(path.join(tmpDir, 'store.json'), 'utf-8')).v).toBe('remote');
      expect(await fsp.readFile(path.join(tmpDir, 'mine.txt'), 'utf-8')).toBe('mine\n');
    });
  });
});
