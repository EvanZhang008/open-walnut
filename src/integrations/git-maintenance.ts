/**
 * Scheduled git maintenance for the data repos — the missing gc that let the
 * cloud companion's disk fill to 100% (2026-08-12 ENOSPC outage).
 *
 * What the incident forensics found, and what each sweep below answers:
 *
 *  - 28 packs / 9.5GB in the cloud worktree clone while only 1.7GB was live.
 *    `git gc` never consolidated them because 21 packs were pinned by orphaned
 *    `.keep` files — a fetch killed mid-transfer (our own 15s timeout group-kill)
 *    leaves its quarantine `.keep` behind forever. → sweep stale `.keep`.
 *  - 2.6GB of `tmp_pack_*` in objects/pack — pushes/fetches killed mid-pack.
 *    → sweep stale `tmp_pack_*` / `tmp_obj_*`.
 *  - 42 `tmp_objdir-incoming-*` quarantine dirs (~5.6GB) in the bare hub —
 *    every `git receive-pack` killed mid-push (client timeout, group-kill)
 *    strands its quarantine dir. → sweep stale quarantine dirs.
 *  - A stale `gc.log` ("Automatic cleanup will not be performed until the file
 *    is removed") which silently disabled EVERY `gc --auto` the post-push hook
 *    spawned — the hub had a gc trigger all along and it was a no-op for days.
 *    → remove stale gc.log before running gc.
 *  - 30k unreachable pre-compaction commits kept alive by 65k reflog entries
 *    and the self-replacing `pre-rewrite-backup` branch. → reflog expiry via
 *    gc config; age out `pre-rewrite-backup` after BACKUP_BRANCH_MAX_AGE_DAYS.
 *
 * CPU lessons (t4g.small, 2 vCPU) are baked into the gc invocation: `nice`d,
 * single-threaded (`pack.threads=1`), bounded window memory, and
 * `gc.autoDetach=false` so the child stays in our process group and the
 * group-kill timeout in execGitGroup can actually reap it.
 *
 * Scheduling: checked daily, run when the last completed maintenance is older
 * than MAINTENANCE_INTERVAL_DAYS *or* the pack dir has grown past
 * SIZE_TRIGGER_BYTES (size trigger — same philosophy as checkRepoSize, but
 * acting instead of just warning).
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WALNUT_HOME, CLOUD_MODE } from '../constants.js';
import {
  execGitGroup,
  setCompactionInProgress,
  waitForSyncSettled,
  compactionInProgress,
} from './git-sync.js';
import { log } from '../logging/index.js';

/** Run at most once per this many days (unless the size trigger fires). */
export const MAINTENANCE_INTERVAL_DAYS = 7;
/** Pack-dir bytes above which maintenance runs regardless of the calendar. */
export const SIZE_TRIGGER_BYTES = 2 * 1024 * 1024 * 1024;
/** Debris (tmp packs, .keep, quarantine dirs, gc.log) older than this is swept. */
export const DEBRIS_MAX_AGE_MS = 24 * 60 * 60 * 1000;
/** `pre-rewrite-backup` (old chain parked by a history-rewrite adoption) max age. */
export const BACKUP_BRANCH_MAX_AGE_DAYS = 14;
/** Hard budget for one gc run — group-killed past this (see execGitGroup). */
const GC_TIMEOUT_MS = 30 * 60_000;
/** How often the scheduler re-evaluates whether maintenance is due. */
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
/** Marker file (inside the git dir — per-repo, machine-local, never synced). */
const LAST_RUN_FILE = 'walnut-last-maintenance';

export interface MaintenanceResult {
  repo: string;
  ran: boolean;
  reason?: 'interval' | 'size' | 'forced';
  sweptFiles: number;
  packBytesBefore: number;
  packBytesAfter: number;
  error?: string;
}

/** Resolve the actual git dir: `.git` subdir for worktrees, the dir itself for bare repos. */
export function resolveGitDir(repoDir: string): string {
  const dotGit = path.join(repoDir, '.git');
  try {
    if (fs.statSync(dotGit).isDirectory()) return dotGit;
  } catch { /* fall through */ }
  return repoDir;
}

/** Total bytes of *.pack under objects/pack (mirror of checkRepoSize's measure). */
export function packDirBytes(gitDir: string): number {
  let total = 0;
  try {
    const packDir = path.join(gitDir, 'objects', 'pack');
    for (const e of fs.readdirSync(packDir, { withFileTypes: true })) {
      if (!e.isFile()) continue;
      try { total += fs.statSync(path.join(packDir, e.name)).size; } catch { /* raced */ }
    }
  } catch { /* no pack dir */ }
  return total;
}

function isStale(p: string, now: number): boolean {
  try {
    return now - fs.statSync(p).mtimeMs > DEBRIS_MAX_AGE_MS;
  } catch {
    return false;
  }
}

/**
 * Sweep the debris a killed git process leaves behind. Everything here is
 * age-gated: anything younger than DEBRIS_MAX_AGE_MS may belong to an
 * in-flight fetch/push and must be left alone.
 * Exported for tests.
 */
export function sweepGitDebris(gitDir: string, now = Date.now()): number {
  let swept = 0;
  const rm = (p: string, recursive = false): void => {
    try {
      if (recursive) fs.rmSync(p, { recursive: true, force: true });
      else fs.unlinkSync(p);
      swept++;
      log.git.warn('git-maintenance swept stale debris', { path: p });
    } catch { /* best-effort */ }
  };

  // objects/pack: tmp_pack_* (killed pack transfer) + orphaned .keep (killed
  // fetch quarantine — pins its pack against every future repack).
  const packDir = path.join(gitDir, 'objects', 'pack');
  try {
    for (const e of fs.readdirSync(packDir)) {
      const p = path.join(packDir, e);
      if ((e.startsWith('tmp_pack_') || e.endsWith('.keep')) && isStale(p, now)) rm(p);
    }
  } catch { /* no pack dir */ }

  // objects/: tmp_objdir-incoming-* (killed receive-pack quarantine dirs — the
  // hub had 42 of them holding ~5.6GB) and loose tmp_obj_* files.
  const objDir = path.join(gitDir, 'objects');
  try {
    for (const e of fs.readdirSync(objDir, { withFileTypes: true })) {
      const p = path.join(objDir, e.name);
      if (e.isDirectory() && e.name.startsWith('tmp_objdir-') && isStale(p, now)) rm(p, true);
      else if (e.isFile() && e.name.startsWith('tmp_obj')) { if (isStale(p, now)) rm(p); }
    }
    // Loose-object fan-out dirs can also hold tmp_obj_* (crashed object writes).
    for (const e of fs.readdirSync(objDir)) {
      if (!/^[0-9a-f]{2}$/.test(e)) continue;
      const fanout = path.join(objDir, e);
      let entries: string[] = [];
      try { entries = fs.readdirSync(fanout); } catch { continue; }
      for (const f of entries) {
        if (f.startsWith('tmp_obj')) {
          const p = path.join(fanout, f);
          if (isStale(p, now)) rm(p);
        }
      }
    }
  } catch { /* unreadable */ }

  // A stale gc.log permanently disables `gc --auto` ("Automatic cleanup will
  // not be performed until the file is removed") — the silent killer that made
  // the hub's post-push gc a no-op while the disk filled.
  const gcLog = path.join(gitDir, 'gc.log');
  if (isStale(gcLog, now)) rm(gcLog);

  return swept;
}

function readLastRun(gitDir: string): number {
  try {
    const t = Date.parse(fs.readFileSync(path.join(gitDir, LAST_RUN_FILE), 'utf-8').trim());
    return Number.isFinite(t) ? t : 0;
  } catch {
    return 0;
  }
}

function writeLastRun(gitDir: string): void {
  try {
    fs.writeFileSync(path.join(gitDir, LAST_RUN_FILE), new Date().toISOString(), 'utf-8');
  } catch { /* best-effort */ }
}

/** Why maintenance should run now, or null if it shouldn't. Exported for tests. */
export function maintenanceDue(gitDir: string, now = Date.now()): 'interval' | 'size' | null {
  if (packDirBytes(gitDir) >= SIZE_TRIGGER_BYTES) return 'size';
  const last = readLastRun(gitDir);
  if (now - last >= MAINTENANCE_INTERVAL_DAYS * 86_400_000) return 'interval';
  return null;
}

/**
 * The gc invocation, shaped by the CPU-starvation lessons:
 *  - `nice -n 10`: never compete with the web server for the 2 vCPUs.
 *  - `pack.threads=1` + bounded window memory: one repack thread peaks ~2GB
 *    less than the default all-cores behavior on a multi-GB repo.
 *  - `gc.autoDetach=false`: keep the child in OUR process group so the
 *    timeout group-kill in execGitGroup reaps it (a detached gc would be
 *    exactly the orphan-process storm of 2026-08-06 again).
 *  - `--prune=1.hour.ago` (not `now`): objects written by a concurrent
 *    push/commit in the last hour are never pruned from under it.
 *  - reflog expiry via config: unreachable reflog entries (the adopted-away
 *    pre-compaction chain) age out after a day instead of git's default 30/90.
 */
async function runGc(repoDir: string): Promise<void> {
  await execGitGroup(
    'nice -n 10 git '
    + '-c gc.autoDetach=false -c pack.threads=1 -c pack.windowMemory=256m '
    + '-c gc.reflogExpire=7.days.ago -c gc.reflogExpireUnreachable=1.day.ago '
    + 'gc --prune=1.hour.ago --quiet',
    { cwd: repoDir, timeout: GC_TIMEOUT_MS },
  );
}

/**
 * Age out `pre-rewrite-backup`: lwwMerge parks the pre-compaction chain on it
 * when adopting a rewritten upstream, and while the branch exists gc can never
 * collect that chain (30k commits / most of the 9.5GB in the incident repo).
 * It is self-replacing on the next rewrite, so anything older than
 * BACKUP_BRANCH_MAX_AGE_DAYS has survived a full recovery window.
 */
async function expireBackupBranch(repoDir: string): Promise<void> {
  try {
    const tipDate = await execGitGroup(
      'git log -1 --format=%ct pre-rewrite-backup --',
      { cwd: repoDir, timeout: 30_000 },
    );
    const ageDays = (Date.now() / 1000 - Number(tipDate.trim())) / 86_400;
    if (Number.isFinite(ageDays) && ageDays > BACKUP_BRANCH_MAX_AGE_DAYS) {
      await execGitGroup('git branch -D pre-rewrite-backup', { cwd: repoDir, timeout: 30_000 });
      log.git.warn('git-maintenance expired pre-rewrite-backup branch', { ageDays: Math.round(ageDays) });
    }
  } catch { /* branch absent — the common case */ }
}

/**
 * Maintain one repo: sweep debris → (worktree only) pause sync → gc → resume.
 *
 * `pauseSync` must be true for the WALNUT_HOME worktree — the 30s auto-commit
 * tick writing objects mid-gc is a corruption risk, and the pause reuses the
 * exact mechanism compaction uses (compactionInProgress + waitForSyncSettled).
 * The bare hub needs no pause: pushes land in quarantine dirs and
 * `--prune=1.hour.ago` keeps concurrent receive-packs safe.
 */
export async function maintainRepo(
  repoDir: string,
  opts: { pauseSync?: boolean; force?: boolean } = {},
): Promise<MaintenanceResult> {
  const gitDir = resolveGitDir(repoDir);
  const result: MaintenanceResult = {
    repo: repoDir,
    ran: false,
    sweptFiles: 0,
    packBytesBefore: 0,
    packBytesAfter: 0,
  };

  const due = opts.force ? 'forced' : maintenanceDue(gitDir);
  if (!due) return result;
  result.reason = due;
  result.packBytesBefore = packDirBytes(gitDir);

  // Debris sweep is cheap and safe regardless of what gc later does.
  result.sweptFiles = sweepGitDebris(gitDir);

  const mustPause = opts.pauseSync === true;
  if (mustPause) {
    if (compactionInProgress) {
      // Compaction owns the repo right now (it runs its own gc at the end) —
      // stand down entirely rather than queueing a second heavy rewrite.
      log.git.info('git-maintenance skipped — history compaction in progress');
      return result;
    }
    setCompactionInProgress(true);
    await waitForSyncSettled();
  }
  try {
    await expireBackupBranch(repoDir);
    await runGc(repoDir);
    result.ran = true;
    writeLastRun(gitDir);
  } catch (err) {
    result.error = err instanceof Error ? err.message : String(err);
    log.git.warn('git-maintenance gc failed', { repo: repoDir, error: result.error });
  } finally {
    if (mustPause) setCompactionInProgress(false);
  }

  result.packBytesAfter = packDirBytes(gitDir);
  if (result.ran) {
    log.git.info('git-maintenance complete', {
      repo: repoDir,
      reason: result.reason,
      sweptFiles: result.sweptFiles,
      packBytesBefore: result.packBytesBefore,
      packBytesAfter: result.packBytesAfter,
    });
  }
  return result;
}

/** The bare hub repo dir on a cloud box, or null elsewhere (mirrors git-http.ts). */
export function hubRepoDir(): string | null {
  if (!CLOUD_MODE) return null;
  const root = process.env.WALNUT_GIT_HUB_DIR ?? '/var/lib/walnut/git';
  const repo = path.join(root, 'walnut-data.git');
  try {
    return fs.statSync(repo).isDirectory() ? repo : null;
  } catch {
    return null;
  }
}

// ── Deploy-bundle hygiene (cloud box) ────────────────────────────────────────
// Code deploys stage a git bundle + seed script in the system temp dir; a
// successful deploy never cleaned them up (~35MB each, forever). Swept on the
// same schedule as repo maintenance. Patterns are deliberately narrow — only
// artifacts our own deploy flow writes, and only when stale.

const DEPLOY_DEBRIS_RE = /^(?:wn[-.].*\.bundle(?:\.\w+)?|walnut-[\w.-]*\.(?:bundle|tar\.gz|tgz)|deploy-seed[\w.-]*\.sh|wn\.bundle)$/;
/** Deploy artifacts older than this are certainly not part of an in-flight deploy. */
const DEPLOY_DEBRIS_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** Sweep stale deploy bundles from `dir` (default: system temp). Exported for tests. */
export function sweepDeployBundles(dir = os.tmpdir(), now = Date.now()): number {
  let swept = 0;
  let entries: string[] = [];
  try { entries = fs.readdirSync(dir); } catch { return 0; }
  for (const name of entries) {
    if (!DEPLOY_DEBRIS_RE.test(name)) continue;
    const p = path.join(dir, name);
    try {
      if (now - fs.statSync(p).mtimeMs <= DEPLOY_DEBRIS_MAX_AGE_MS) continue;
      fs.unlinkSync(p);
      swept++;
      log.web.info('git-maintenance removed stale deploy artifact', { path: p });
    } catch { /* best-effort */ }
  }
  return swept;
}

// ── Scheduler ────────────────────────────────────────────────────────────────

export interface GitMaintenanceHandle {
  stop: () => void;
  /** Run one full maintenance pass now (ignores the daily check cadence, not the due-ness rules unless forced). */
  runOnce: (force?: boolean) => Promise<MaintenanceResult[]>;
}

/**
 * Start the daily scheduler. Covers, in order:
 *   1. the data worktree (WALNUT_HOME) — every box, sync paused during gc;
 *   2. the bare hub repo — cloud box only;
 *   3. stale deploy bundles in the temp dir — cloud box only.
 *
 * First pass runs after a 10-minute start delay: far past the 30s sync-tick
 * boundary and the 75s compaction start, and past the lifetime of any test
 * server (several e2e suites run a real startServer for 2-4 minutes with a
 * real temp hub repo — a first pass inside that window would gc a fixture
 * mid-test).
 */
export function startGitMaintenance(opts: { startDelayMs?: number } = {}): GitMaintenanceHandle {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const pass = async (force = false): Promise<MaintenanceResult[]> => {
    const results: MaintenanceResult[] = [];
    try {
      results.push(await maintainRepo(WALNUT_HOME, { pauseSync: true, force }));
    } catch (err) {
      log.git.warn('git-maintenance worktree pass failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
    const hub = hubRepoDir();
    if (hub) {
      try {
        results.push(await maintainRepo(hub, { pauseSync: false, force }));
      } catch (err) {
        log.git.warn('git-maintenance hub pass failed', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    if (CLOUD_MODE) {
      try { sweepDeployBundles(); } catch { /* best-effort */ }
    }
    return results;
  };

  const tick = async (): Promise<void> => {
    try {
      await pass();
    } finally {
      if (!stopped) {
        timer = setTimeout(() => { void tick(); }, CHECK_INTERVAL_MS);
        timer.unref?.();
      }
    }
  };
  timer = setTimeout(() => { void tick(); }, opts.startDelayMs ?? 10 * 60_000);
  timer.unref?.();

  log.git.info('git-maintenance scheduler started', {
    intervalDays: MAINTENANCE_INTERVAL_DAYS,
    sizeTriggerBytes: SIZE_TRIGGER_BYTES,
    hub: hubRepoDir() ?? undefined,
  });

  return {
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
    runOnce: (force = false) => pass(force),
  };
}
