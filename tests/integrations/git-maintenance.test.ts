/**
 * Scheduled git maintenance — debris sweep, due-ness triggers, gc execution,
 * and deploy-bundle hygiene (2026-08-12 disk-full outage regression suite).
 *
 * Uses REAL git repos in a temp WALNUT_HOME (same pattern as the other
 * git-sync suites); only the clock inputs are controlled.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { createMockConstants } from '../helpers/mock-constants.js';

vi.mock('../../src/constants.js', () => createMockConstants('walnut-gitmaint-test'));

import {
  sweepGitDebris,
  sweepDeployBundles,
  sweepKilledGcPacks,
  expireCompactionBackups,
  staleCompactionBackups,
  maintenanceDue,
  maintainRepo,
  readLastRun,
  resolveGitDir,
  packDirBytes,
  staleQuarantineDirs,
  SIZE_TRIGGER_BYTES,
  SIZE_REGROWTH_RATIO,
  DEBRIS_MAX_AGE_MS,
  DEBRIS_COUNT_TRIGGER,
  COMPACTION_BACKUP_MAX_AGE_DAYS,
  FAILED_GC_BACKOFF_MS,
} from '../../src/integrations/git-maintenance.js';
import { WALNUT_HOME } from '../../src/constants.js';

function run(cmd: string, cwd: string): string {
  return execSync(cmd, { cwd, encoding: 'utf-8', timeout: 30_000, stdio: ['pipe', 'pipe', 'pipe'] }).trim();
}

/** Init a real repo with one commit at `dir`. */
async function initRepo(dir: string): Promise<void> {
  await fsp.mkdir(dir, { recursive: true });
  run('git init -q -b main', dir);
  run('git config user.email t@t && git config user.name t', dir);
  await fsp.writeFile(path.join(dir, 'a.md'), 'hello\n');
  run('git add -A && git commit -q -m init', dir);
}

/** Write a file and backdate its mtime so age gates treat it as stale. */
async function writeStale(p: string, ageMs = DEBRIS_MAX_AGE_MS + 60_000): Promise<void> {
  await fsp.mkdir(path.dirname(p), { recursive: true });
  await fsp.writeFile(p, 'x');
  const old = new Date(Date.now() - ageMs);
  await fsp.utimes(p, old, old);
}

async function mkdirStale(p: string, ageMs = DEBRIS_MAX_AGE_MS + 60_000): Promise<void> {
  await fsp.mkdir(p, { recursive: true });
  const old = new Date(Date.now() - ageMs);
  await fsp.utimes(p, old, old);
}

let repo: string;
let gitDir: string;

beforeEach(async () => {
  repo = WALNUT_HOME;
  await fsp.rm(repo, { recursive: true, force: true });
  await initRepo(repo);
  gitDir = path.join(repo, '.git');
});

afterEach(async () => {
  await fsp.rm(repo, { recursive: true, force: true });
});

describe('sweepGitDebris', () => {
  it('removes every stale debris family the incident box accumulated', async () => {
    // tmp pack (killed transfer), orphaned .keep (pins its pack), quarantine
    // dir (killed receive-pack), tmp_obj in a fan-out dir, stale gc.log.
    await writeStale(path.join(gitDir, 'objects', 'pack', 'tmp_pack_AbCdEf'));
    await writeStale(path.join(gitDir, 'objects', 'pack', 'pack-deadbeef.keep'));
    await mkdirStale(path.join(gitDir, 'objects', 'tmp_objdir-incoming-XyZzY'));
    await writeStale(path.join(gitDir, 'objects', 'ab', 'tmp_obj_qQqQqQ'));
    await writeStale(path.join(gitDir, 'gc.log'));

    const swept = sweepGitDebris(gitDir);
    expect(swept).toBe(5);
    expect(fs.existsSync(path.join(gitDir, 'objects', 'pack', 'tmp_pack_AbCdEf'))).toBe(false);
    expect(fs.existsSync(path.join(gitDir, 'objects', 'pack', 'pack-deadbeef.keep'))).toBe(false);
    expect(fs.existsSync(path.join(gitDir, 'objects', 'tmp_objdir-incoming-XyZzY'))).toBe(false);
    expect(fs.existsSync(path.join(gitDir, 'objects', 'ab', 'tmp_obj_qQqQqQ'))).toBe(false);
    expect(fs.existsSync(path.join(gitDir, 'gc.log'))).toBe(false);
  });

  it('leaves FRESH debris alone — it may belong to an in-flight fetch/push', async () => {
    const fresh = path.join(gitDir, 'objects', 'pack', 'tmp_pack_Fresh1');
    await fsp.mkdir(path.dirname(fresh), { recursive: true });
    await fsp.writeFile(fresh, 'x'); // mtime = now
    const freshKeep = path.join(gitDir, 'objects', 'pack', 'pack-live.keep');
    await fsp.writeFile(freshKeep, 'x');
    const freshDir = path.join(gitDir, 'objects', 'tmp_objdir-incoming-Live');
    await fsp.mkdir(freshDir, { recursive: true });

    expect(sweepGitDebris(gitDir)).toBe(0);
    expect(fs.existsSync(fresh)).toBe(true);
    expect(fs.existsSync(freshKeep)).toBe(true);
    expect(fs.existsSync(freshDir)).toBe(true);
  });

  it('never touches real packs, indexes, or loose objects', async () => {
    // Create a real pack via git itself.
    run('git repack -a -d -q', repo);
    const packDir = path.join(gitDir, 'objects', 'pack');
    const before = fs.readdirSync(packDir).sort();
    expect(before.some((f) => f.endsWith('.pack'))).toBe(true);
    sweepGitDebris(gitDir);
    expect(fs.readdirSync(packDir).sort()).toEqual(before);
    expect(run('git fsck --no-progress', repo)).not.toMatch(/missing|error/i);
  });
});

describe('maintenanceDue', () => {
  it('is due on a repo that has never run maintenance (interval trigger)', () => {
    expect(maintenanceDue(gitDir)).toBe('interval');
  });

  it('is NOT due right after a successful run', async () => {
    const result = await maintainRepo(repo, { force: true });
    expect(result.ran).toBe(true);
    expect(maintenanceDue(gitDir)).toBeNull();
  });

  it('size trigger fires even inside the calendar window', async () => {
    await maintainRepo(repo, { force: true }); // stamp last-run = now
    // Fabricate a pack file above the size trigger without writing GBs: the
    // measurement stats file SIZE, so truncate-to-length is enough (sparse).
    const bigPack = path.join(gitDir, 'objects', 'pack', 'pack-big.pack');
    const fd = await fsp.open(bigPack, 'w');
    await fd.truncate(SIZE_TRIGGER_BYTES + 1);
    await fd.close();
    expect(packDirBytes(gitDir)).toBeGreaterThan(SIZE_TRIGGER_BYTES);
    expect(maintenanceDue(gitDir)).toBe('size');
  });

  // 2026-08-21 incident: 519 quarantine dirs (30GB) while the pack dir sat at
  // 1.3GB — neither the size trigger nor the weekly calendar fired for 9 days
  // and the disk crossed the 90% write-block watermark.
  it('debris-count trigger fires inside the calendar window when quarantine dirs pile up', async () => {
    await maintainRepo(repo, { force: true }); // stamp last-run = now
    for (let i = 0; i < DEBRIS_COUNT_TRIGGER; i++) {
      await mkdirStale(path.join(gitDir, 'objects', `tmp_objdir-incoming-x${i}`));
    }
    expect(staleQuarantineDirs(gitDir)).toBe(DEBRIS_COUNT_TRIGGER);
    expect(maintenanceDue(gitDir)).toBe('debris');
    // And a maintenance pass actually clears them (sweep runs before gc).
    const result = await maintainRepo(repo);
    expect(result.reason).toBe('debris');
    expect(result.sweptFiles).toBeGreaterThanOrEqual(DEBRIS_COUNT_TRIGGER);
    expect(staleQuarantineDirs(gitDir)).toBe(0);
  });

  it('debris trigger ignores FRESH quarantine dirs (in-flight pushes) and stays quiet below threshold', async () => {
    await maintainRepo(repo, { force: true });
    // Fresh dirs: may belong to a live receive-pack — never counted.
    for (let i = 0; i < DEBRIS_COUNT_TRIGGER + 5; i++) {
      await fsp.mkdir(path.join(gitDir, 'objects', `tmp_objdir-incoming-fresh${i}`), { recursive: true });
    }
    expect(staleQuarantineDirs(gitDir)).toBe(0);
    // Stale but below threshold: the daily sweep-with-gc is not worth it yet.
    for (let i = 0; i < DEBRIS_COUNT_TRIGGER - 1; i++) {
      await mkdirStale(path.join(gitDir, 'objects', `tmp_objdir-incoming-old${i}`));
    }
    expect(staleQuarantineDirs(gitDir)).toBe(DEBRIS_COUNT_TRIGGER - 1);
    expect(maintenanceDue(gitDir)).toBeNull();
  });

  it('staleQuarantineDirs is safe on a repo with no objects dir', () => {
    expect(staleQuarantineDirs('/nonexistent/repo/.git')).toBe(0);
  });

  // 2026-09-10: a repo that gc cannot shrink below the trigger (pinned history,
  // large tracked files) was "due by size" at every check, so every server
  // restart re-ran an 11-minute gc that freed nothing, and one of them was
  // killed at its budget. Size must mean GROWTH since the last run.
  it('size trigger does not re-fire while the pack has not grown since the last run', async () => {
    const bigPack = path.join(gitDir, 'objects', 'pack', 'pack-big.pack');
    await fsp.mkdir(path.dirname(bigPack), { recursive: true });
    const grow = async (bytes: number): Promise<void> => {
      const fd = await fsp.open(bigPack, 'w');
      await fd.truncate(bytes);
      await fd.close();
    };
    await grow(SIZE_TRIGGER_BYTES + 1);
    expect(maintenanceDue(gitDir)).toBe('size');

    // The run leaves the pack exactly where it was (nothing to free).
    const result = await maintainRepo(repo, { force: true });
    expect(result.ran).toBe(true);
    // The recorded floor is the whole pack dir (fake pack + the real one gc wrote).
    const floor = readLastRun(gitDir).packBytesAfter!;
    expect(floor).toBeGreaterThan(SIZE_TRIGGER_BYTES);
    expect(maintenanceDue(gitDir)).toBeNull();

    // A few percent of growth is still "the same repo"...
    await grow(Math.floor(floor * 1.05));
    expect(maintenanceDue(gitDir)).toBeNull();
    // ...real regrowth past the ratio fires again.
    await grow(Math.ceil(floor * SIZE_REGROWTH_RATIO) + 1);
    expect(maintenanceDue(gitDir)).toBe('size');
  });

  it('reads the pre-JSON marker (bare ISO timestamp) as a real last run with no size on record', async () => {
    const when = new Date(Date.now() - 60_000);
    await fsp.writeFile(path.join(gitDir, 'walnut-last-maintenance'), when.toISOString());
    const last = readLastRun(gitDir);
    expect(last.at).toBe(when.getTime());
    expect(last.packBytesAfter).toBeUndefined();
    // No recorded size → one size-triggered run is still allowed after upgrade.
    const bigPack = path.join(gitDir, 'objects', 'pack', 'pack-big.pack');
    await fsp.mkdir(path.dirname(bigPack), { recursive: true });
    const fd = await fsp.open(bigPack, 'w');
    await fd.truncate(SIZE_TRIGGER_BYTES + 1);
    await fd.close();
    expect(maintenanceDue(gitDir)).toBe('size');
  });
});

/** compaction's backup name for a day `daysAgo` before `now`. */
function backupNameDaysAgo(daysAgo: number, now = Date.now()): string {
  return `backup-${new Date(now - daysAgo * 86_400_000).toISOString().slice(0, 10).replace(/-/g, '')}`;
}

describe('expireCompactionBackups', () => {
  // Compaction's backup-YYYYMMDD is the entire pre-compaction chain, disjoint
  // from main; while it exists gc can free nothing compaction dropped.
  it('deletes backup-* branches whose NAME date is past the max age and keeps fresh ones', async () => {
    const old = backupNameDaysAgo(COMPACTION_BACKUP_MAX_AGE_DAYS + 2);
    const fresh = backupNameDaysAgo(1);
    // Every branch points at the same (old) tip: age must come from the name,
    // not the commit. A repo idle for a week gets a backup whose tip is already
    // old on the day compaction creates it, and that recovery point must live.
    const oldEpoch = Math.floor(Date.now() / 1000) - 30 * 86_400;
    execSync(`GIT_COMMITTER_DATE=@${oldEpoch} git commit -q --allow-empty -m old`, { cwd: repo, stdio: 'pipe' });
    run(`git branch ${old} HEAD`, repo);
    run(`git branch ${fresh} HEAD`, repo);
    run('git branch pre-rewrite-backup HEAD', repo);
    run('git branch backup-not-a-date HEAD', repo);

    expect(staleCompactionBackups(gitDir)).toEqual([old]);
    const expired = await expireCompactionBackups(repo);

    expect(expired).toEqual([old]);
    const branches = run('git branch --list', repo);
    expect(branches).not.toContain(old);
    expect(branches).toContain(fresh);
    expect(branches).toMatch(/pre-rewrite-backup/);   // a different family, different rule
    expect(branches).toMatch(/backup-not-a-date/);    // not compaction's shape — untouched
    expect(staleCompactionBackups(gitDir)).toEqual([]);
  });

  it('finds a backup branch that gc has moved into packed-refs', async () => {
    const old = backupNameDaysAgo(COMPACTION_BACKUP_MAX_AGE_DAYS + 2);
    run(`git branch ${old} HEAD`, repo);
    run('git pack-refs --all', repo);
    expect(fs.existsSync(path.join(gitDir, 'refs', 'heads', old))).toBe(false);
    expect(staleCompactionBackups(gitDir)).toEqual([old]);
  });

  it('is a no-op on a repo with no backup branches', async () => {
    expect(await expireCompactionBackups(repo)).toEqual([]);
  });

  it('an aged backup makes maintenance due on its own, and the pass clears it', async () => {
    await maintainRepo(repo, { force: true }); // stamp last-run = now
    expect(maintenanceDue(gitDir)).toBeNull();
    run(`git branch ${backupNameDaysAgo(COMPACTION_BACKUP_MAX_AGE_DAYS + 2)} HEAD`, repo);
    expect(maintenanceDue(gitDir)).toBe('backup');
    const result = await maintainRepo(repo, { pauseSync: true });
    expect(result.reason).toBe('backup');
    expect(result.ran).toBe(true);
    expect(maintenanceDue(gitDir)).toBeNull();
  });
});

describe('failed gc backoff', () => {
  it('a recorded failure holds the size and backup triggers for a day but not the weekly interval', async () => {
    const bigPack = path.join(gitDir, 'objects', 'pack', 'pack-big.pack');
    await fsp.mkdir(path.dirname(bigPack), { recursive: true });
    const fd = await fsp.open(bigPack, 'w');
    await fd.truncate(SIZE_TRIGGER_BYTES + 1);
    await fd.close();
    run(`git branch ${backupNameDaysAgo(COMPACTION_BACKUP_MAX_AGE_DAYS + 2)} HEAD`, repo);
    const now = Date.now();
    const marker = path.join(gitDir, 'walnut-last-maintenance');

    // A gc that was killed 10 minutes ago: neither fixable-by-gc trigger may re-fire yet.
    await fsp.writeFile(marker, JSON.stringify({ at: now - 2 * 86_400_000, failedAt: now - 10 * 60_000 }));
    expect(maintenanceDue(gitDir, now)).toBeNull();
    // Yesterday's failure has aged out: size wins again.
    await fsp.writeFile(marker, JSON.stringify({ at: now - 2 * 86_400_000, failedAt: now - FAILED_GC_BACKOFF_MS - 1 }));
    expect(maintenanceDue(gitDir, now)).toBe('size');
    // A failure never blocks the weekly attempt: a permanently failing gc still gets its interval run.
    await fsp.writeFile(marker, JSON.stringify({ at: now - 8 * 86_400_000, failedAt: now - 10 * 60_000 }));
    expect(maintenanceDue(gitDir, now)).toBe('interval');
  });
});

describe('sweepKilledGcPacks', () => {
  it('removes only the tmp packs that appeared during the killed gc', async () => {
    const packDir = path.join(gitDir, 'objects', 'pack');
    await fsp.mkdir(packDir, { recursive: true });
    // A tmp pack that predates the gc may belong to a live fetch: keep it, however young.
    await fsp.writeFile(path.join(packDir, 'tmp_pack_preexisting'), 'x');
    const before = new Set(['tmp_pack_preexisting']);
    // The 856MB ghost: written by the gc we group-killed, younger than the 24h age gate.
    await fsp.writeFile(path.join(packDir, 'tmp_pack_fromKilledGc'), 'x');
    run('git repack -a -d -q', repo);

    expect(sweepKilledGcPacks(gitDir, before)).toBe(1);
    expect(fs.existsSync(path.join(packDir, 'tmp_pack_fromKilledGc'))).toBe(false);
    expect(fs.existsSync(path.join(packDir, 'tmp_pack_preexisting'))).toBe(true);
    expect(fs.readdirSync(packDir).some((f) => f.endsWith('.pack'))).toBe(true);
    expect(run('git fsck --no-progress', repo)).not.toMatch(/missing|error/i);
  });
});

describe('maintainRepo', () => {
  it('runs a real gc that consolidates loose objects into a pack', async () => {
    // Make loose objects: several commits without repack.
    for (let i = 0; i < 3; i++) {
      await fsp.writeFile(path.join(repo, `f${i}.md`), `content ${i}\n`);
      run(`git add -A && git commit -q -m c${i}`, repo);
    }
    const result = await maintainRepo(repo, { pauseSync: true, force: true });
    expect(result.error).toBeUndefined();
    expect(result.ran).toBe(true);
    // gc packed everything; repo still healthy.
    expect(run('git fsck --no-progress', repo)).not.toMatch(/error/i);
    expect(run('git log --oneline', repo).split('\n').length).toBe(4);
  });

  it('resolves a bare repo dir (hub shape) and gc succeeds there too', async () => {
    const bare = path.join(os.tmpdir(), `walnut-gitmaint-bare-${Date.now()}`);
    run(`git clone -q --bare "${repo}" "${bare}"`, os.tmpdir());
    try {
      expect(resolveGitDir(bare)).toBe(bare);
      const result = await maintainRepo(bare, { force: true });
      expect(result.error).toBeUndefined();
      expect(result.ran).toBe(true);
    } finally {
      await fsp.rm(bare, { recursive: true, force: true });
    }
  });

  it('does nothing when not due and not forced', async () => {
    await maintainRepo(repo, { force: true });
    const second = await maintainRepo(repo);
    expect(second.ran).toBe(false);
    expect(second.reason).toBeUndefined();
  });
});

describe('sweepDeployBundles', () => {
  let dir: string;
  beforeEach(async () => {
    dir = path.join(os.tmpdir(), `walnut-deploy-sweep-${Date.now()}`);
    await fsp.mkdir(dir, { recursive: true });
  });
  afterEach(async () => {
    await fsp.rm(dir, { recursive: true, force: true });
  });

  it('removes stale deploy artifacts and nothing else', async () => {
    await writeStale(path.join(dir, 'wn.bundle'));
    await writeStale(path.join(dir, 'walnut-deploy.tar.gz'));
    await writeStale(path.join(dir, 'deploy-seed.sh'));
    await writeStale(path.join(dir, 'unrelated.tar.gz')); // stale but NOT ours
    await fsp.writeFile(path.join(dir, 'wn-fresh.bundle'), 'x'); // ours but fresh

    const swept = sweepDeployBundles(dir);
    expect(swept).toBe(3);
    expect(fs.existsSync(path.join(dir, 'unrelated.tar.gz'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'wn-fresh.bundle'))).toBe(true);
  });

  it('is safe on a missing directory', () => {
    expect(sweepDeployBundles(path.join(dir, 'nope'))).toBe(0);
  });
});
