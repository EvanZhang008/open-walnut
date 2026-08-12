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
  maintenanceDue,
  maintainRepo,
  resolveGitDir,
  packDirBytes,
  SIZE_TRIGGER_BYTES,
  DEBRIS_MAX_AGE_MS,
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
