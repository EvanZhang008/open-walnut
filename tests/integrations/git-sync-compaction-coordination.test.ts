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
} from '../../src/integrations/git-sync.js';
import { WALNUT_HOME } from '../../src/constants.js';

let tmpDir: string;

function sh(cmd: string, cwd: string): string {
  return execSync(cmd, { cwd, encoding: 'utf-8', timeout: 30_000, stdio: ['pipe', 'pipe', 'pipe'] }).trim();
}

beforeEach(async () => {
  tmpDir = WALNUT_HOME;
  await fsp.rm(tmpDir, { recursive: true, force: true });
  await fsp.mkdir(tmpDir, { recursive: true });
});

afterEach(async () => {
  setCompactionInProgress(false);
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

  /** Force-push a compacted root (single commit, given tree) from `other`. */
  function compactAndForcePush(treeRef: string): string {
    const tree = sh(`git rev-parse ${treeRef}`, other);
    const newRoot = sh(`git commit-tree ${tree} -m "compacted"`, other);
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

  it('conflicting replay: hard-adopt origin/main, park old head on pre-rewrite-backup', async () => {
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
});
