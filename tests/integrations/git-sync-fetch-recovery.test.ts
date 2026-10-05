/**
 * Regression tests for the 2026-08-23 disk-burial incident.
 *
 * The first fetch after a weekly history compaction must move the ENTIRE
 * rewritten chain (measured 2m33s on the cloud box), but every git-sync fetch
 * ran with the 15s fail-fast NETWORK_TIMEOUT. The 30s tick therefore killed
 * the same fetch forever, and each kill left a partial tmp_pack_* corpse in
 * objects/pack: 92 corpses / 79GB in 73 minutes → disk 100%, ENOSPC, the SSM
 * agent couldn't even fork. Two independent defenses:
 *
 *  1. A fetch-failure STREAK widens the next fetch's timeout
 *     (fetchTimeoutForStreak) so a big-but-legitimate transfer can finish.
 *  2. The fetch-failure path sweeps dead tmp_pack corpses immediately
 *     (sweepDeadFetchPacks), age-gated so live transfers are never touched —
 *     the weekly maintenance sweep's 24h grace is a full disk at one corpse
 *     per tick.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fsp from 'node:fs/promises';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { vi } from 'vitest';
import { createMockConstants } from '../helpers/mock-constants.js';

vi.mock('../../src/constants.js', () => createMockConstants());

import {
  fetchTimeoutForStreak,
  sweepDeadFetchPacks,
  initSync,
  setRemote,
  sync,
  gitPullWalnut,
  noteNetworkFailure,
  resetSyncGuardForTest,
  getSyncGuardState,
  FETCH_TIMEOUT,
  FETCH_RECOVERY_TIMEOUT,
  FETCH_STREAK_FOR_RECOVERY,
  FETCH_DEBRIS_MIN_AGE_MS,
} from '../../src/integrations/git-sync.js';
import { WALNUT_HOME } from '../../src/constants.js';
import { execSync } from 'node:child_process';
import { log } from '../../src/logging/index.js';

describe('fetchTimeoutForStreak', () => {
  it('keeps the fail-fast timeout below the streak threshold', () => {
    for (let s = 0; s < FETCH_STREAK_FOR_RECOVERY; s++) {
      expect(fetchTimeoutForStreak(s)).toBe(FETCH_TIMEOUT);
    }
  });

  it('widens to the recovery timeout at and beyond the threshold', () => {
    expect(fetchTimeoutForStreak(FETCH_STREAK_FOR_RECOVERY)).toBe(FETCH_RECOVERY_TIMEOUT);
    expect(fetchTimeoutForStreak(133)).toBe(FETCH_RECOVERY_TIMEOUT);
  });

  it('recovery timeout actually fits the measured post-compaction fetch (2m33s)', () => {
    expect(FETCH_RECOVERY_TIMEOUT).toBeGreaterThan(153_000);
  });
});

describe('sweepDeadFetchPacks', () => {
  let repoDir: string;
  let packDir: string;

  beforeEach(async () => {
    repoDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'wn-fetch-sweep-'));
    packDir = path.join(repoDir, '.git', 'objects', 'pack');
    await fsp.mkdir(packDir, { recursive: true });
  });

  afterEach(async () => {
    await fsp.rm(repoDir, { recursive: true, force: true });
  });

  function corpse(name: string, ageMs: number): string {
    const p = path.join(packDir, name);
    fs.writeFileSync(p, 'dead pack bytes');
    const t = new Date(Date.now() - ageMs);
    fs.utimesSync(p, t, t);
    return p;
  }

  it('deletes tmp_pack corpses older than the age gate', () => {
    const dead = corpse('tmp_pack_8EnV8G', FETCH_DEBRIS_MIN_AGE_MS + 60_000);
    expect(sweepDeadFetchPacks(repoDir)).toBe(1);
    expect(fs.existsSync(dead)).toBe(false);
  });

  it('never touches a fresh tmp_pack (could be a live transfer)', () => {
    const live = corpse('tmp_pack_xZvLjw', 10_000);
    expect(sweepDeadFetchPacks(repoDir)).toBe(0);
    expect(fs.existsSync(live)).toBe(true);
  });

  it('never touches real packs or indexes, whatever their age', () => {
    const pack = corpse('pack-0fecdd3b.pack', FETCH_DEBRIS_MIN_AGE_MS * 10);
    const idx = corpse('pack-0fecdd3b.idx', FETCH_DEBRIS_MIN_AGE_MS * 10);
    expect(sweepDeadFetchPacks(repoDir)).toBe(0);
    expect(fs.existsSync(pack)).toBe(true);
    expect(fs.existsSync(idx)).toBe(true);
  });

  it('is a no-op on a repo with no pack dir', () => {
    expect(sweepDeadFetchPacks(path.join(repoDir, 'nonexistent'))).toBe(0);
  });

  it('incident shape: a pile of old corpses goes, the in-flight one stays', () => {
    for (let i = 0; i < 5; i++) corpse(`tmp_pack_dead${i}`, FETCH_DEBRIS_MIN_AGE_MS + i * 30_000 + 1_000);
    const live = corpse('tmp_pack_current', 5_000);
    expect(sweepDeadFetchPacks(repoDir)).toBe(5);
    expect(fs.existsSync(live)).toBe(true);
  });
});

// ── The sweep runs on every pass, and a streak skips the doomed pull ──
//
// 2026-10-05, cloud box: one rewrite adoption left 19 tmp_pack_* corpses
// (7.5GB) that nothing swept. The failure-path sweep saw only corpses older
// than the age gate at the LAST failure; the successful recovery fetch never
// swept; and every tick first ran `pull --rebase` under the 60s budget, the
// same transfer the 15s fetch had just lost, adding a 1.4GB corpse per tick.

describe('sync() over a real origin: corpse sweep and streak pull', () => {
  let bareDir: string;
  let cloneDir: string;

  function run(cmd: string, cwd: string): string {
    return execSync(cmd, { cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  }

  beforeEach(async () => {
    resetSyncGuardForTest();
    await fsp.rm(WALNUT_HOME, { recursive: true, force: true });
    await fsp.mkdir(WALNUT_HOME, { recursive: true });
    bareDir = `${WALNUT_HOME}-origin.git`;
    cloneDir = `${WALNUT_HOME}-clone`;
    await fsp.rm(bareDir, { recursive: true, force: true });
    await fsp.rm(cloneDir, { recursive: true, force: true });
    await fsp.mkdir(bareDir, { recursive: true });
    run('git init -q --bare -b main', bareDir);
    initSync();
    run('git config user.email box@test.local && git config user.name box', WALNUT_HOME);
    setRemote(bareDir);
    await fsp.writeFile(path.join(WALNUT_HOME, 'base.md'), 'base\n');
    run('git add -A && git commit -q -m base && git push -q -u origin main', WALNUT_HOME);
    run(`git clone -q "${bareDir}" "${cloneDir}"`, WALNUT_HOME);
    run('git config user.email other@test.local && git config user.name other', cloneDir);
  });

  afterEach(async () => {
    resetSyncGuardForTest();
    await fsp.rm(bareDir, { recursive: true, force: true });
    await fsp.rm(cloneDir, { recursive: true, force: true });
    await fsp.rm(WALNUT_HOME, { recursive: true, force: true });
  });

  function corpseInHome(name: string, ageMs: number): string {
    const p = path.join(WALNUT_HOME, '.git', 'objects', 'pack', name);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, 'dead pack bytes');
    const t = new Date(Date.now() - ageMs);
    fs.utimesSync(p, t, t);
    return p;
  }

  it('a SUCCESSFUL sync sweeps the corpses older than the age gate and keeps a fresh one', async () => {
    const dead = corpseInHome('tmp_pack_dead01', FETCH_DEBRIS_MIN_AGE_MS + 60_000);
    const fresh = corpseInHome('tmp_pack_fresh1', 5_000);
    // The remote moved, so this sync fetches and merges: the path that never swept.
    await fsp.writeFile(path.join(cloneDir, 'other.md'), 'other\n');
    run('git add -A && git commit -q -m other && git push -q origin main', cloneDir);

    const result = await sync();

    expect(result.pulled).toBe(1);
    expect(fs.existsSync(dead)).toBe(false);
    expect(fs.existsSync(fresh)).toBe(true);
  }, 30_000);

  it('with no streak a diverged tick rebases (linear history, the pull path)', async () => {
    await fsp.writeFile(path.join(cloneDir, 'other.md'), 'other\n');
    run('git add -A && git commit -q -m other && git push -q origin main', cloneDir);
    await fsp.writeFile(path.join(WALNUT_HOME, 'mine.md'), 'mine\n');

    await sync();

    // `pull --rebase` put the local commit on top of upstream: one parent, and
    // upstream's commit is its parent.
    expect(run('git log -1 --format=%P', WALNUT_HOME).split(' ')).toHaveLength(1);
    expect(run('git log -1 --format=%s HEAD~1', WALNUT_HOME)).toBe('other');
  }, 30_000);

  it('during a fetch-failure streak the tick skips `pull --rebase` and goes to the merge path', async () => {
    await fsp.writeFile(path.join(cloneDir, 'other.md'), 'other\n');
    run('git add -A && git commit -q -m other && git push -q origin main', cloneDir);
    await fsp.writeFile(path.join(WALNUT_HOME, 'mine.md'), 'mine\n');
    noteNetworkFailure();

    const result = await sync();

    // lwwMerge joined the two sides with a merge commit: two parents, and the
    // streak closed on the fetch that worked.
    expect(result.pulled).toBe(1);
    expect(run('git log -1 --format=%P', WALNUT_HOME).split(' ')).toHaveLength(2);
    expect(getSyncGuardState().consecutiveNetworkFailures).toBe(0);
    expect(run('git ls-files', WALNUT_HOME).split('\n')).toEqual(expect.arrayContaining(['base.md', 'mine.md', 'other.md']));
  }, 30_000);

  it('gitPullWalnut stands aside while a sync is in flight, then pulls again once it is over', async () => {
    const debug = vi.spyOn(log.git, 'debug');
    try {
      await fsp.writeFile(path.join(cloneDir, 'other.md'), 'other\n');
      run('git add -A && git commit -q -m other && git push -q origin main', cloneDir);

      const inflight = sync();
      await gitPullWalnut();
      expect(debug.mock.calls.some(([msg]) => String(msg).includes('a sync is in flight'))).toBe(true);
      await inflight;

      // Once the tick is over the event path pulls for real again.
      await fsp.writeFile(path.join(cloneDir, 'later.md'), 'later\n');
      run('git add -A && git commit -q -m later && git push -q origin main', cloneDir);
      await gitPullWalnut();
      expect(fs.existsSync(path.join(WALNUT_HOME, 'later.md'))).toBe(true);
    } finally {
      debug.mockRestore();
    }
  }, 30_000);

  it('gitPullWalnut stands aside during a fetch-failure streak: the tick owns recovery', async () => {
    const debug = vi.spyOn(log.git, 'debug');
    try {
      await fsp.writeFile(path.join(cloneDir, 'other.md'), 'other\n');
      run('git add -A && git commit -q -m other && git push -q origin main', cloneDir);
      noteNetworkFailure();

      await gitPullWalnut();

      expect(fs.existsSync(path.join(WALNUT_HOME, 'other.md'))).toBe(false);
      expect(debug.mock.calls.some(([msg]) => String(msg).includes('fetch failure streak'))).toBe(true);
    } finally {
      debug.mockRestore();
    }
  }, 30_000);
});
