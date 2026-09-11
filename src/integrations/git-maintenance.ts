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
/**
 * Compaction's `backup-YYYYMMDD` branches max age. Each one is the WHOLE
 * pre-compaction chain (commit-tree rewrote every commit, so it shares no commit
 * with main), and while it exists gc can free nothing compaction dropped. One
 * compaction cycle is long enough to notice a bad rewrite; the tree-hash check
 * before the swap is the real safety net. 2026-09-10: two of these pinned 30,747
 * commits / 71GB of blobs (1.3GB of them half-downloaded model files) on a repo
 * whose live history was a third of that.
 */
export const COMPACTION_BACKUP_MAX_AGE_DAYS = 7;
/**
 * A size-triggered gc must have grown the pack dir by this much since the last
 * completed run to fire again. Once a repo sits above SIZE_TRIGGER_BYTES for
 * good (large tracked files, pinned history), "over the threshold" is true at
 * every check; without this, each server restart spent 11 minutes of niced
 * single-threaded repack that freed nothing (5 deploys → 3 gcs on 2026-09-10,
 * one of them killed at the 30-minute budget, leaving 856MB of tmp_pack).
 */
export const SIZE_REGROWTH_RATIO = 1.1;
/** Hard budget for one gc run — group-killed past this (see execGitGroup). */
const GC_TIMEOUT_MS = 30 * 60_000;
/** How often the scheduler re-evaluates whether maintenance is due. */
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
/** Marker file (inside the git dir — per-repo, machine-local, never synced). */
const LAST_RUN_FILE = 'walnut-last-maintenance';

export type MaintenanceReason = 'interval' | 'size' | 'debris' | 'backup' | 'forced';

export interface MaintenanceResult {
  repo: string;
  ran: boolean;
  reason?: MaintenanceReason;
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

/** What the marker remembers about the last runs. Exported for tests. */
export interface LastRun {
  /** Last COMPLETED run (0 = never). Drives the weekly interval. */
  at: number;
  /** Pack-dir bytes right after that run's gc; undefined for a pre-2026-09 marker. */
  packBytesAfter?: number;
  /** Last run that failed or was killed at its budget; undefined when the last run succeeded. */
  failedAt?: number;
}

/** A failed gc holds the size trigger off for this long (the weekly interval still applies). */
export const FAILED_GC_BACKOFF_MS = 24 * 60 * 60 * 1000;

/**
 * The marker is JSON now, but older installs wrote a bare ISO timestamp: read
 * both, so an upgrade never looks like "never ran" and gcs on the spot. (The
 * reverse direction, an LKG rollback to a build that still expects the bare
 * string, parses the JSON as NaN → "never ran" and does ONE extra gc. Accepted.)
 */
export function readLastRun(gitDir: string): LastRun {
  try {
    const raw = fs.readFileSync(path.join(gitDir, LAST_RUN_FILE), 'utf-8').trim();
    if (raw.startsWith('{')) {
      const parsed = JSON.parse(raw) as { at?: unknown; packBytesAfter?: unknown; failedAt?: unknown };
      const at = typeof parsed.at === 'number' ? parsed.at : Date.parse(String(parsed.at));
      return {
        at: Number.isFinite(at) ? at : 0,
        packBytesAfter: typeof parsed.packBytesAfter === 'number' ? parsed.packBytesAfter : undefined,
        failedAt: typeof parsed.failedAt === 'number' ? parsed.failedAt : undefined,
      };
    }
    const t = Date.parse(raw);
    return { at: Number.isFinite(t) ? t : 0 };
  } catch {
    return { at: 0 };
  }
}

function writeLastRun(gitDir: string, run: LastRun): void {
  try {
    fs.writeFileSync(path.join(gitDir, LAST_RUN_FILE), JSON.stringify(run), 'utf-8');
  } catch { /* best-effort */ }
}

/**
 * Count stale receive-pack quarantine dirs — the debris class packDirBytes is
 * blind to. 2026-08-21 incident: 519 of them (30GB!) piled up in 9 days while
 * the pack dir sat at 1.3GB, so the size trigger never fired and the disk hit
 * the 90% write-block watermark. Counting is O(readdir), no du needed.
 */
export function staleQuarantineDirs(gitDir: string, now = Date.now()): number {
  let count = 0;
  try {
    const objDir = path.join(gitDir, 'objects');
    for (const e of fs.readdirSync(objDir, { withFileTypes: true })) {
      if (e.isDirectory() && e.name.startsWith('tmp_objdir-') && isStale(path.join(objDir, e.name), now)) count++;
    }
  } catch { /* unreadable */ }
  return count;
}

/** Stale quarantine dirs above this force a maintenance pass regardless of pack size. */
export const DEBRIS_COUNT_TRIGGER = 10;

/** Compaction's backup branch name → the UTC day it encodes, or null. */
function backupNameDate(name: string): number | null {
  const m = /^backup-(\d{4})(\d{2})(\d{2})$/.exec(name);
  if (!m) return null;
  const t = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Number.isFinite(t) ? t : null;
}

/**
 * Names of compaction backup branches whose encoded date is past the max age.
 * Reads refs from disk (loose files, then packed-refs: gc packs them), so the
 * scheduler can ask this without spawning git. Exported for tests.
 */
export function staleCompactionBackups(gitDir: string, now = Date.now()): string[] {
  const names = new Set<string>();
  try {
    for (const e of fs.readdirSync(path.join(gitDir, 'refs', 'heads'))) {
      if (/^backup-\d{8}$/.test(e)) names.add(e);
    }
  } catch { /* no loose heads */ }
  try {
    for (const line of fs.readFileSync(path.join(gitDir, 'packed-refs'), 'utf-8').split('\n')) {
      const m = /^[0-9a-f]{40,64} refs\/heads\/(backup-\d{8})$/.exec(line.trim());
      if (m) names.add(m[1]);
    }
  } catch { /* no packed-refs */ }
  const maxAgeMs = COMPACTION_BACKUP_MAX_AGE_DAYS * 86_400_000;
  return [...names].filter((n) => {
    const d = backupNameDate(n);
    return d !== null && now - d > maxAgeMs;
  }).sort();
}

/**
 * Why maintenance should run now, or null if it shouldn't. Exported for tests.
 *
 * The size trigger fires on GROWTH past the line, not on being past it: a repo
 * the last gc left at 2.6GB has not changed at 2.6GB, and re-running the same
 * gc against it can only produce the same 2.6GB. A marker without a recorded
 * size (older build) counts as growth once, so the upgrade still gets one run.
 * A gc that failed or was killed holds the size trigger off for a day: retrying
 * the same doomed gc 10 minutes after every restart is the loop, not the fix.
 *
 * The backup trigger is the one cause of a too-large repo that is certain to be
 * fixable: an aged compaction backup is dead weight by definition.
 */
export function maintenanceDue(gitDir: string, now = Date.now()): Exclude<MaintenanceReason, 'forced'> | null {
  const last = readLastRun(gitDir);
  const pack = packDirBytes(gitDir);
  const recentlyFailed = last.failedAt !== undefined && now - last.failedAt < FAILED_GC_BACKOFF_MS;
  if (pack >= SIZE_TRIGGER_BYTES && !recentlyFailed) {
    const floor = last.packBytesAfter;
    if (floor === undefined || floor <= 0 || pack >= floor * SIZE_REGROWTH_RATIO) return 'size';
  }
  if (staleQuarantineDirs(gitDir, now) >= DEBRIS_COUNT_TRIGGER) return 'debris';
  if (staleCompactionBackups(gitDir, now).length > 0 && !recentlyFailed) return 'backup';
  if (now - last.at >= MAINTENANCE_INTERVAL_DAYS * 86_400_000) return 'interval';
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
 * Age out compaction's `backup-YYYYMMDD` branches (see
 * COMPACTION_BACKUP_MAX_AGE_DAYS). Compaction itself only trims by COUNT, so
 * without this the most recent pre-compaction chain lives forever on a repo
 * that stops compacting (nothing to compact, or a remote that stays away).
 *
 * Age comes from the DATE IN THE NAME, i.e. when the recovery point was made,
 * not from the tip's commit time: a repo idle for a week gets a backup whose
 * tip is already "old" on the day it is created, and the tip rule would delete
 * that recovery point at the very next pass. Same rule as the scheduler's
 * `staleCompactionBackups`, so a branch this refuses to delete can never keep
 * re-triggering a pass. Exported for tests.
 */
export async function expireCompactionBackups(repoDir: string, now = Date.now()): Promise<string[]> {
  const expired: string[] = [];
  for (const name of staleCompactionBackups(resolveGitDir(repoDir), now)) {
    try {
      await execGitGroup(`git branch -D ${name}`, { cwd: repoDir, timeout: 30_000 });
      expired.push(name);
      const ageDays = Math.round((now - (backupNameDate(name) ?? now)) / 86_400_000);
      log.git.warn('git-maintenance expired compaction backup branch', { branch: name, ageDays });
    } catch { /* raced with compaction deleting it — fine */ }
  }
  return expired;
}

/** `tmp_pack_*` names present in the pack dir right now. */
function tmpPackNames(gitDir: string): Set<string> {
  try {
    return new Set(fs.readdirSync(path.join(gitDir, 'objects', 'pack')).filter((e) => e.startsWith('tmp_pack_')));
  } catch {
    return new Set();
  }
}

/**
 * Remove the tmp_pack_* files OUR gc left behind when it was group-killed at
 * its budget. The general sweep is age-gated at 24h because a young tmp_pack
 * may belong to an in-flight fetch or push; but a file that did not exist
 * before this gc started and appeared while it ran was written by that gc,
 * and the gc is dead. Leaving it for the age gate meant an 856MB ghost sat
 * in the pack dir for a day, counted by every size measurement (2026-09-10:
 * it was what tipped the 3GB repo-size alert). Exported for tests.
 */
export function sweepKilledGcPacks(gitDir: string, before: Set<string>): number {
  let swept = 0;
  for (const name of tmpPackNames(gitDir)) {
    if (before.has(name)) continue;
    const p = path.join(gitDir, 'objects', 'pack', name);
    try {
      fs.unlinkSync(p);
      swept++;
      log.git.warn('git-maintenance removed the tmp pack of a killed gc', { path: p });
    } catch { /* best-effort */ }
  }
  return swept;
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
  const tmpPacksBefore = tmpPackNames(gitDir);
  try {
    await expireBackupBranch(repoDir);
    await expireCompactionBackups(repoDir);
    await runGc(repoDir);
    result.ran = true;
    writeLastRun(gitDir, { at: Date.now(), packBytesAfter: packDirBytes(gitDir) });
  } catch (err) {
    result.error = err instanceof Error ? err.message : String(err);
    log.git.warn('git-maintenance gc failed', { repo: repoDir, error: result.error });
    // Remember the failure so the size trigger backs off (see maintenanceDue);
    // the completed-run fields are kept as they were.
    const last = readLastRun(gitDir);
    writeLastRun(gitDir, { ...last, failedAt: Date.now() });
    // Only where this process holds the repo alone. On the bare hub nothing
    // quiesces pushes, and an in-flight receive-pack writes tmp_pack_* under
    // the same prefix; deleting that would fail the push mid-transfer.
    if (mustPause) result.sweptFiles += sweepKilledGcPacks(gitDir, tmpPacksBefore);
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
