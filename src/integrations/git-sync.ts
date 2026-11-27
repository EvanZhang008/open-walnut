import { execSync, exec, spawn } from 'node:child_process';
import { gitChildEnv } from '../lib/git-env.js';
import { withUtilityQosClamp } from '../lib/background-qos.js';
import { promisify } from 'node:util';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CLOUD_MODE, WALNUT_HOME } from '../constants.js';
import { NOTE_ATTACHMENT_DIR } from '../core/notes/attachment-dir.js';
import { bus, EventNames } from '../core/event-bus.js';
import { markCriticalSection } from '../core/event-loop-monitor.js';
import { safeKillProcessGroup } from '../core/process-group-kill.js';
import { gitQuietAt, oldestOwnGitStart, refuseGitInQuiet, trackOwnGit } from './git-children.js';
import { log } from '../logging/index.js';
import { SYNCED_FILE_EXTENSIONS, SYNCED_FILE_MAX_BYTES, SYNCED_FILES_DIR } from '../core/plugins/plugin-file-rules.js';
import {
  healJsonFileFromHistory,
  jsonCandidatesFromPorcelain,
  readFileBounded,
  scanForConflictMarkers,
} from '../utils/json-conflict-recovery.js';
import { SECRET_IGNORE_PATTERNS } from './git-sync-secrets.js';
import { GIT_TEMP_IGNORE_LINES, sweepGitTempLeftovers } from './git-sync-temp-leftovers.js';
import { releasePrivateDataHolds } from './git-sync-private-data.js';
import { carryLocalCommits, must, type CarryResult, type GitStatusRunner } from './git-sync-rewrite-carry.js';
import { mergeRecords } from './git-sync-records.js';
import { setWriteGateOverdueListener } from '../utils/write-gate.js';
import {
  applyInFlight, applyPending, applyTargetToWorktree, recoverInterruptedApply, type ApplyGit, type ApplyOutcome, type HeldPull,
} from './git-sync-apply.js';
import {
  chooseLww, lwwMergeMessage, mergeTreeWriteTreeSupported, parseConflictStages, resolveDivergence, type DivergedResult, type LwwClock,
} from './git-sync-merge.js';
import { accountDoorsGuarded, outwardDoorRefusal } from '../core/leader/switch/doors.js';
import {
  addListed,
  addTimeoutFor,
  listPendingFiles,
  planStage,
  routinePathspecs,
  runLargeFileLane,
  STAGE_BIG_FILE_THRESHOLD,
  type GitRunner,
  type PendingFile,
  type StagePlan,
} from './git-sync-large-files.js';

export interface SyncStatus {
  initialized: boolean;
  remoteConfigured: boolean;
  lastSyncAt: string | null;
  pendingChanges: number;
  branch: string;
  /** True while the mass-revert guard holds sync in pull-only safe mode. */
  safeMode: boolean;
  /** True while the disk watermark holds sync in pull-only mode (disk ≥90%). */
  diskPullOnly: boolean;
}

const LOCAL_TIMEOUT = 30_000;
/** The least a tick's status waits (porcelainStatus scales it up for what it may hash). */
const STATUS_TIMEOUT = 120_000;
/** Fetch/push/ls-remote — pure network transfers, fail fast. */
const NETWORK_TIMEOUT = 15_000;
/**
 * Pull = fetch + CHECKOUT. On a fat data repo a checkout can easily exceed 15s
 * (especially on a CPU-starved box), and execGitGroup kills the whole process
 * group on timeout — which is how the 2026-08-03 hub ended up with a TORN
 * worktree: HEAD moved to the new tip but the checkout died halfway, leaving
 * 2000+ files stale on disk. The next `add -A` then snapshotted that stale
 * tree as a mass revert. Give checkout-bearing ops room to finish.
 */
export const PULL_TIMEOUT = 60_000;
/** Exported for tests pinning the fetch/pull timeout split. */
export const FETCH_TIMEOUT = NETWORK_TIMEOUT;
/**
 * After this many consecutive fetch failures, the next fetch runs with
 * FETCH_RECOVERY_TIMEOUT instead of NETWORK_TIMEOUT. A failure STREAK means
 * the transfer is bigger than the fail-fast window — the canonical case is
 * the first fetch after a history compaction, which must move the entire
 * rewritten chain (measured 2m33s on the cloud box). Killing it at 15s just
 * guarantees it never completes, and each kill leaves a tmp_pack_* corpse:
 * 2026-08-23 the 30s tick looped this way 92 times and buried the disk under
 * 79GB of dead packs in 73 minutes (disk 100%, SSM agent couldn't fork).
 */
export const FETCH_STREAK_FOR_RECOVERY = 3;
export const FETCH_RECOVERY_TIMEOUT = 10 * 60_000;

/** Pick the fetch timeout for the current failure streak (pure, for tests). */
export function fetchTimeoutForStreak(streak: number): number {
  return streak >= FETCH_STREAK_FOR_RECOVERY ? FETCH_RECOVERY_TIMEOUT : NETWORK_TIMEOUT;
}

/**
 * Minimum corpse age before the failure-path sweep may delete a tmp_pack_*.
 * A LIVE transfer touches its tmp_pack continuously, so anything untouched
 * for minutes is a kill corpse from an earlier cycle. The weekly maintenance
 * sweep (DEBRIS_MAX_AGE_MS = 24h) is far too slow for the kill-loop case —
 * at one ~590MB-1.7GB corpse per 30s tick, 24h of grace is a full disk.
 */
export const FETCH_DEBRIS_MIN_AGE_MS = 5 * 60_000;

/**
 * Sweep dead tmp_pack_* corpses left by OUR OWN killed fetches. Runs on the
 * fetch-failure path only, age-gated so a genuinely in-flight transfer
 * (ours under the single-flight latch, or any other process's) is never
 * touched. Exported for tests.
 */
export function sweepDeadFetchPacks(repoDir: string, now = Date.now()): number {
  const packDir = path.join(repoDir, '.git', 'objects', 'pack');
  let swept = 0;
  let entries: string[] = [];
  try { entries = fs.readdirSync(packDir); } catch { return 0; }
  for (const e of entries) {
    if (!e.startsWith('tmp_pack_')) continue;
    const p = path.join(packDir, e);
    try {
      if (now - fs.statSync(p).mtimeMs > FETCH_DEBRIS_MIN_AGE_MS) {
        fs.unlinkSync(p);
        swept++;
        log.git.warn('git-sync swept a dead fetch pack corpse', { path: p });
      }
    } catch { /* raced — fine */ }
  }
  return swept;
}
/** Grace period between SIGTERM and SIGKILL when reaping a git process group. */
const KILL_GRACE_MS = 3_000;

/**
 * Flag set while history compaction runs, to pause auto-commits AND sync.
 *
 * ⚠️ Process-boundary trap (root cause of the 2026-08 cloud incident): the
 * compaction worker is a FORKED child (dist/workers/git-compaction-worker.js),
 * so runScheduledCompaction() setting this flag inside the worker pauses
 * nothing in the server. The PARENT must set it around the fork (server.ts
 * does). When only the worker set it, the 30s tick kept committing while the
 * worker rebuilt history, `main` moved between collection and verify, and
 * every compaction run for 9 days failed "verification failed: trees differ" —
 * the data repo regrew to 25k commits/6.5GB and its pushes wedged the cloud box.
 */
export let compactionInProgress = false;
export function setCompactionInProgress(v: boolean): void {
  compactionInProgress = v;
}

/**
 * Operator pause marker: `<gitdir>/walnut-sync-paused.json` holding
 * `{ "until": "<ISO time>", "reason": "..." }`. While it is active every
 * auto-commit, sync tick, scheduled compaction and gc stands down, so a human
 * (or a script) can rewrite the data repo's history in place with nothing
 * else moving `main` underneath. It lives in .git/ so it is never part of the
 * tree, and it MUST carry an expiry: a marker without a valid future `until`
 * is ignored and removed, so a forgotten or malformed file can never silently
 * stop the user's backups for good.
 */
export const SYNC_PAUSE_MARKER = 'walnut-sync-paused.json';
let lastPauseLogAt = 0;

export function syncPauseReason(gitDir = path.join(WALNUT_HOME, '.git')): string | null {
  const file = path.join(gitDir, SYNC_PAUSE_MARKER);
  let raw: string;
  try { raw = fs.readFileSync(file, 'utf-8'); } catch { return null; }
  let until = NaN;
  let reason = 'operator pause';
  try {
    const parsed = JSON.parse(raw) as { until?: unknown; reason?: unknown };
    until = typeof parsed.until === 'string' ? Date.parse(parsed.until) : NaN;
    if (typeof parsed.reason === 'string' && parsed.reason) reason = parsed.reason;
  } catch { /* malformed → expired below */ }
  if (!Number.isFinite(until) || until <= Date.now()) {
    log.git.warn('git-sync pause marker expired or malformed — removing it and resuming', { file });
    try { fs.unlinkSync(file); } catch { /* best-effort */ }
    return null;
  }
  const now = Date.now();
  if (now - lastPauseLogAt > 5 * 60_000) {
    lastPauseLogAt = now;
    log.git.info('git-sync paused by operator marker', { reason, until: new Date(until).toISOString() });
  }
  return reason;
}

/** True while compaction owns the repo OR an operator pause marker is active. */
export function isSyncPaused(): boolean {
  return compactionInProgress || syncPauseReason() !== null;
}

/**
 * Resolves when no sync() and no gitPullWalnut() is in flight. Callers set the
 * compaction flag first, then wait here, so a mid-flight pull/push can't
 * interleave with a history rewrite, a gc or the boot-time crash recovery (the
 * flag only stops NEW ticks and pulls, not one already past its check).
 */
export async function waitForSyncSettled(): Promise<void> {
  try { await syncInflight; } catch { /* a failed sync is still settled */ }
  try { await pullInflight; } catch { /* a failed pull is still settled */ }
}

// Network git subcommands that may authenticate against a remote. Only these
// get the credential-helper guard — local ops never touch credentials.
const NETWORK_GIT_RE = /^(?:clone|fetch|pull|push|ls-remote)\b/;

// Declared here (not next to the async git helpers below) because
// credentialGuardArgsAsync() uses it and `const` bindings are not hoisted.
const execAsync = promisify(exec);

/**
 * When the repo's remote URL already embeds credentials (https://user:token@host),
 * neutralize ALL credential helpers (system/global/local) for network git ops via
 * `-c credential.helper=`. Otherwise git calls the helper's `store` action after
 * every successful auth — on macOS (osxkeychain) that write pops a
 * "Keychain Not Found" dialog when the process has no keychain session, and it's
 * pointless anyway: the token in the URL always wins, the stored copy is never read.
 *
 * IMPORTANT: only guard when the URL carries credentials. If it doesn't, a helper
 * (e.g. keychain) may be the user's ONLY credential source — disabling it would
 * silently break their sync with 401s.
 */
export function credentialGuardArgs(cwd?: string): string[] {
  try {
    const urls = execSync('git config --get-regexp "remote\\..*\\.url"', {
      cwd: cwd ?? WALNUT_HOME,
      timeout: LOCAL_TIMEOUT,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      env: gitChildEnv(undefined, process.env, cwd ?? WALNUT_HOME),
    });
    // https://ANYTHING@host — userinfo present means embedded credentials
    if (/https?:\/\/[^/\s]+@/.test(urls)) return ['-c', 'credential.helper='];
  } catch {
    // No remotes / not a repo — nothing to guard
  }
  return [];
}

/**
 * Async twin of credentialGuardArgs — MUST be used by the async tick path.
 * The sync version spawns a child process with execSync, which blocks the whole
 * event loop; gitAsync() called it on every network op, so the "async" sync path
 * still froze all HTTP requests once per fetch/push. Remote URLs effectively never
 * change at runtime, so the answer is cached after the first resolution.
 */
let credentialGuardCache: { cwd: string; args: string[] } | null = null;

/** Drop the cached guard answer — call whenever the remote URL changes. */
export function invalidateCredentialGuardCache(): void {
  credentialGuardCache = null;
}

export async function credentialGuardArgsAsync(cwd?: string): Promise<string[]> {
  const dir = cwd ?? WALNUT_HOME;
  if (credentialGuardCache?.cwd === dir) return credentialGuardCache.args;

  let args: string[] = [];
  try {
    const { stdout } = await execAsync('git config --get-regexp "remote\\..*\\.url"', {
      cwd: dir,
      timeout: LOCAL_TIMEOUT,
      encoding: 'utf-8',
      env: gitChildEnv(undefined, process.env, dir),
    });
    if (/https?:\/\/[^/\s]+@/.test(stdout)) args = ['-c', 'credential.helper='];
  } catch {
    // No remotes / not a repo — nothing to guard
  }
  credentialGuardCache = { cwd: dir, args };
  return args;
}

export function git(args: string, options?: { cwd?: string; timeout?: number; env?: Record<string, string> }): string {
  refuseGitInQuiet(options?.cwd ?? WALNUT_HOME, args);
  const guard = NETWORK_GIT_RE.test(args) ? credentialGuardArgs(options?.cwd).join(' ') : '';
  return execSync(`git ${guard ? `${guard} ` : ''}${args}`, {
    cwd: options?.cwd ?? WALNUT_HOME,
    timeout: options?.timeout ?? LOCAL_TIMEOUT,
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
    // gitChildEnv, never a bare inherit: an inherited GIT_DIR / GIT_WORK_TREE
    // outranks the cwd above, so a process launched from a git hook (git exports
    // those while running one) would auto-commit the data repo into that repo.
    env: gitChildEnv(options?.env, process.env, options?.cwd ?? WALNUT_HOME),
  }).trim();
}

export function gitSafe(args: string, options?: { cwd?: string; timeout?: number; env?: Record<string, string> }): string | null {
  try {
    return git(args, options);
  } catch {
    return null;
  }
}

// ── Async variants for the periodic tick path ───────────────────────────────
// The 30s auto-commit/sync tick used to run the whole git chain through
// execSync — every `pull`/`push` network round-trip (1-2s) blocked the event
// loop, and ALL HTTP requests stalled behind it. The tick path now uses these
// async variants; the sync `git()`/`gitSafe()` stay for one-shot callers
// (init, compaction, CLI) where blocking is acceptable.
//
// The precondition probes (is git installed / is it a repo / has a remote) were
// the leftover: they kept using gitSafe() and so kept freezing the loop on every
// tick and every session result. See "Cached async preconditions" below.

// Git children of this process, and a leader switch's stop of them: git-children.ts.
export { GitQuiet, endGitQuiet, gitQuietAt, oldestOwnGitStart, quietGitWriters } from './git-children.js';

/**
 * Run git in its own process GROUP and kill the whole group on timeout.
 *
 * Why not execAsync's `timeout`: it signals only the top-level `git`, but a
 * network op is a process TREE — `git push` → `git-remote-https` → `send-pack`
 * → `pack-objects`. Killing the parent orphans the children (they reparent to
 * pid 1) and they keep burning CPU and RAM. On a large data repo `pack-objects`
 * alone holds ~1.9GB and runs for minutes, so every timed-out tick leaked one
 * more. Observed 2026-07-25: four concurrent orphaned push trees, load average
 * 211, swap exhausted, every HTTP request timing out at 15s.
 *
 * `detached: true` puts the child in a new process group (pgid == child pid),
 * so `kill(-pgid)` reaps the parent AND every descendant.
 *
 * Exported for git-maintenance.ts, which runs long gc/repack children under
 * the same group-kill discipline.
 */
export async function execGitGroup(
  command: string,
  opts: { cwd: string; timeout: number; env?: NodeJS.ProcessEnv },
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    refuseGitInQuiet(opts.cwd, command);
    // Backups, gc and repacks are background work: in the utility band when the
    // server was raised above it (background-qos.ts). The clamp execs, so the
    // group leader is still the child and the group kill below still reaps it.
    const [cmd, cmdArgs] = withUtilityQosClamp('/bin/sh', ['-c', command]);
    const child = spawn(cmd, cmdArgs, {
      cwd: opts.cwd,
      // Strip here, not only in gitAsync: git-maintenance and the plugin paths call
      // this helper directly without an env, and `git branch -D` under an inherited
      // GIT_DIR would delete branches in whatever repo the launcher was holding.
      env: gitChildEnv(opts.env, process.env, opts.cwd),
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    trackOwnGit(opts.cwd, child);

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    child.stdout?.setEncoding('utf-8');
    child.stderr?.setEncoding('utf-8');
    child.stdout?.on('data', (d: string) => { stdout += d; });
    child.stderr?.on('data', (d: string) => { stderr += d; });

    // Escalate SIGTERM → SIGKILL on the GROUP (negative pid). `git` traps TERM
    // and can take a while to unwind a large pack, so don't trust it to exit.
    const killGroup = (signal: NodeJS.Signals): void => {
      safeKillProcessGroup(child.pid, signal);
    };

    const timer = setTimeout(() => {
      timedOut = true;
      killGroup('SIGTERM');
      setTimeout(() => killGroup('SIGKILL'), KILL_GRACE_MS).unref?.();
    }, opts.timeout);
    timer.unref?.();

    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      if (timedOut) {
        reject(new Error(`git timed out after ${opts.timeout}ms (process group killed): ${command}`));
      } else if (code === 0) {
        resolve(stdout);
      } else {
        reject(new Error(`git exited ${code}: ${stderr.trim() || stdout.trim()}`));
      }
    });
  });
}

export async function execGitArgsGroup(
  args: string[],
  opts: { cwd: string; timeout: number; env?: NodeJS.ProcessEnv; /** Written to git's stdin, which is closed otherwise. */ input?: string; holdsNoLock?: boolean },
): Promise<string> {
  const { code, stdout, stderr } = await execGitArgsStatus(args, opts);
  if (code === 0) return stdout.trim();
  throw new Error(`git exited ${code}: ${stderr.trim() || stdout.trim()}`);
}

/**
 * The same spawn, answering with the exit code instead of throwing on a non-zero
 * one (stdout untrimmed), for commands whose exit code is a result: `merge-tree`
 * exits 1 when the merge conflicts. A timeout or a spawn failure still rejects.
 */
export async function execGitArgsStatus(
  args: string[],
  opts: {
    cwd: string; timeout: number; env?: NodeJS.ProcessEnv; input?: string;
    /** A command that takes no lock in .git (hash-object, ls-files): it does not stop clearStaleLock. */
    holdsNoLock?: boolean;
  },
): Promise<{ code: number; stdout: string; stderr: string }> {
  const { code, stdout, stderr } = await execGitArgsRaw(args, opts);
  return { code, stdout: stdout.toString('utf-8'), stderr };
}

/**
 * The same spawn with stdout as bytes (a blob's content, `cat-file --batch`), or
 * written straight into `stdoutFd` (a large blob into its temp file, never held
 * in memory).
 */
export async function execGitArgsRaw(
  args: string[],
  opts: { cwd: string; timeout: number; env?: NodeJS.ProcessEnv; input?: string; stdoutFd?: number; holdsNoLock?: boolean },
): Promise<{ code: number; stdout: Buffer; stderr: string }> {
  return new Promise((resolve, reject) => {
    refuseGitInQuiet(opts.cwd, args);
    const childEnv = gitChildEnv(opts.env, process.env, opts.cwd);
    const [cmd, cmdArgs] = withUtilityQosClamp('git', args, { searchPath: childEnv.PATH ?? '' });
    const child = spawn(cmd, cmdArgs, {
      cwd: opts.cwd,
      env: childEnv,
      detached: true,
      stdio: [opts.input === undefined ? 'ignore' : 'pipe', opts.stdoutFd ?? 'pipe', 'pipe'],
    });
    trackOwnGit(opts.cwd, child, !opts.holdsNoLock);
    if (opts.input !== undefined) {
      // A git that exits before reading it all reports through 'close'; the pipe error is noise.
      child.stdin?.on('error', () => undefined);
      child.stdin?.end(opts.input);
    }
    const chunks: Buffer[] = [];
    let stderr = '';
    let timedOut = false;
    child.stderr?.setEncoding('utf-8');
    child.stdout?.on('data', (data: Buffer | string) => { chunks.push(typeof data === 'string' ? Buffer.from(data) : data); });
    child.stderr?.on('data', (data: string) => { stderr += data; });

    const killGroup = (signal: NodeJS.Signals): void => {
      safeKillProcessGroup(child.pid, signal);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup('SIGTERM');
      setTimeout(() => killGroup('SIGKILL'), KILL_GRACE_MS).unref?.();
    }, opts.timeout);
    timer.unref?.();

    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (timedOut) reject(new Error(`git timed out after ${opts.timeout}ms (process group killed)`));
      else resolve({ code: code ?? -1, stdout: Buffer.concat(chunks), stderr });
    });
  });
}

export async function gitAsync(args: string, options?: { cwd?: string; timeout?: number; env?: Record<string, string> }): Promise<string> {
  // Async guard resolution: the sync credentialGuardArgs() spawns via execSync and
  // would block the event loop on every network op, defeating this whole path.
  const guard = NETWORK_GIT_RE.test(args)
    ? (await credentialGuardArgsAsync(options?.cwd)).join(' ')
    : '';
  const stdout = await execGitGroup(`git ${guard ? `${guard} ` : ''}${args}`, {
    cwd: options?.cwd ?? WALNUT_HOME,
    timeout: options?.timeout ?? LOCAL_TIMEOUT,
    // execGitGroup builds the child env (gitChildEnv with this cwd) from this.
    env: options?.env,
  });
  return stdout.trim();
}

export async function gitSafeAsync(args: string, options?: { cwd?: string; timeout?: number; env?: Record<string, string> }): Promise<string | null> {
  try {
    return await gitAsync(args, options);
  } catch {
    return null;
  }
}

export function isGitAvailable(): boolean {
  try {
    execSync('git --version', { timeout: LOCAL_TIMEOUT, stdio: ['pipe', 'pipe', 'pipe'] });
    return true;
  } catch {
    return false;
  }
}

/**
 * Is the data home a repository of its own? Not "inside some work tree": a data
 * home that sits inside another repository (a home directory kept in git, a
 * project checkout, OPEN_WALNUT_HOME pointed into one) made every auto-commit and
 * push act on THAT repository's whole tree (2026-10-30: a fresh install with its
 * data home inside a checkout staged the checkout's own files). Such a data home
 * gets a repository of its own from initSync, nested in the outer one.
 *
 * Read off `rev-parse --show-prefix` run in the data home: empty at a work tree's
 * top, the relative path inside an outer one, and a failure outside any. No path
 * comparison, so case, symlinks and a `.git` file (a worktree) cannot misjudge it.
 */
export function isOwnRepoPrefix(prefix: string | null): boolean {
  return prefix !== null && prefix.trim() === '';
}

function isRepo(): boolean {
  return isOwnRepoPrefix(gitSafe('rev-parse --show-prefix'));
}

/** isRepo for another directory (compaction takes its repo as an argument). */
export function isOwnRepoAt(dir: string): boolean {
  return isOwnRepoPrefix(gitSafe('rev-parse --show-prefix', { cwd: dir }));
}

function hasRemote(): boolean {
  const remotes = gitSafe('remote');
  return remotes !== null && remotes.length > 0;
}

function getBranch(): string {
  return gitSafe('rev-parse --abbrev-ref HEAD') ?? 'main';
}

// ── Cached async preconditions for the tick / event paths ────────────────────
// autoSync() (the ~30s git tick) and gitPullWalnut() (EVERY session:result /
// session:error, i.e. constantly with several live sessions) both open with the
// same precondition triple — is git installed, is WALNUT_HOME a repo, does it
// have a remote — and all three ran through the SYNCHRONOUS gitSafe(). That is
// three blocking child-process spawns per tick AND per finished turn; a
// production CPU profile caught the trio as ONE 175ms burst of frozen event
// loop, which stalls every HTTP route (CLAUDE.md "Never block the web server").
//
// All three answers are near-constant for a process lifetime, so they are probed
// asynchronously and reused. Freshness comes from EXPLICIT invalidation at the
// only two places that can change them (initSync creates the repo, setRemote
// adds/rewrites the remote); the TTL is just a backstop for a change made
// outside this process (a human running `git remote add` in the data dir).

/**
 * Backstop TTL for the repo/remote answers. Deliberately longer than the 30s
 * tick — every in-process mutation invalidates the cache directly, so the TTL
 * only has to cover an out-of-process edit, where a minute of lag is invisible.
 */
export const SYNC_PROBE_TTL_MS = 60_000;

interface ProbeState<T> {
  value: T | undefined;
  at: number;
  inflight: Promise<T> | null;
}

function newProbeState<T>(): ProbeState<T> {
  return { value: undefined, at: 0, inflight: null };
}

/**
 * TTL + single-flight around one async probe. N concurrent callers share ONE
 * child process — the entire point is to stop spawning per caller, and both hot
 * callers can genuinely fire together (several sessions finishing at once).
 *
 * `ttlFor` receives the resolved answer, so a probe can cache one outcome
 * forever and re-probe the other on the short TTL.
 *
 * `run` must never reject (each probe below swallows its own errors); the
 * single-flight slot is released on rejection anyway so one failure can't latch.
 */
async function cachedProbe<T>(
  state: ProbeState<T>,
  run: () => Promise<T>,
  ttlFor: (value: T) => number,
): Promise<T> {
  if (state.value !== undefined && Date.now() - state.at < ttlFor(state.value)) {
    return state.value;
  }
  if (state.inflight) return state.inflight;
  const inflight: Promise<T> = run().then((value) => {
    // An invalidation while this probe was in flight nulls the slot (and any
    // later caller started a fresh probe). Either way the answer in hand
    // predates the mutation, so it must NOT be written to the cache.
    if (state.inflight === inflight) {
      state.value = value;
      state.at = Date.now();
      state.inflight = null;
    }
    return value;
  });
  state.inflight = inflight;
  // Release the single-flight slot even on a rejection, so one failure can never
  // latch every future caller onto a dead promise. (The catch also keeps a
  // rejection from being reported as unhandled; each probe swallows its own.)
  inflight.catch(() => { /* intentionally ignored */ })
    .finally(() => { if (state.inflight === inflight) state.inflight = null; });
  return inflight;
}

const gitAvailableProbe = newProbeState<boolean>();
const repoProbe = newProbeState<boolean>();
const remoteProbe = newProbeState<boolean>();

/**
 * Async twin of isGitAvailable(), cached.
 *
 * A POSITIVE answer is cached forever: a git binary that resolved once does not
 * leave PATH for the life of a server process. A NEGATIVE answer is re-probed on
 * SYNC_PROBE_TTL_MS on purpose — git can be installed while the server runs, and
 * latching "no git" permanently would silently disable sync until a restart,
 * which is a worse failure than one cheap probe a minute.
 */
export async function isGitAvailableAsync(): Promise<boolean> {
  return cachedProbe(
    gitAvailableProbe,
    async () => {
      try {
        // process.cwd() matches the sync version, which passes no cwd at all.
        await execGitGroup('git --version', { cwd: process.cwd(), timeout: LOCAL_TIMEOUT });
        return true;
      } catch {
        return false;
      }
    },
    (available) => (available ? Infinity : SYNC_PROBE_TTL_MS),
  );
}

/** Async twin of isRepo(), cached. Invalidated by initSync()'s `git init`. */
export async function isRepoAsync(): Promise<boolean> {
  return cachedProbe(
    repoProbe,
    async () => isOwnRepoPrefix(await gitSafeAsync('rev-parse --show-prefix')),
    () => SYNC_PROBE_TTL_MS,
  );
}

/** Async twin of hasRemote(), cached. Invalidated by setRemote(). */
export async function hasRemoteAsync(): Promise<boolean> {
  return cachedProbe(
    remoteProbe,
    async () => {
      const remotes = await gitSafeAsync('remote');
      return remotes !== null && remotes.length > 0;
    },
    () => SYNC_PROBE_TTL_MS,
  );
}

/**
 * Async twin of getBranch(). NOT cached: a checkout changes it at any time and
 * the tick must act on the branch it is actually on (a stale name would push the
 * wrong ref). Async purely to keep the tick off execSync.
 */
async function getBranchAsync(): Promise<string> {
  return (await gitSafeAsync('rev-parse --abbrev-ref HEAD')) ?? 'main';
}

/**
 * Drop the cached "is a repo" / "has a remote" answers.
 *
 * MUST be called by every path that creates the repo or adds/rewrites the
 * remote, otherwise a cached `false` keeps the tick standing down after setup
 * and sync silently never starts until the TTL expires or the server restarts.
 * In-file callers: initSync() (git init) and setRemote() (remote add/set-url) —
 * the only two places in the codebase that mutate either fact.
 *
 * Also clears any IN-FLIGHT probe: a probe that started before the mutation
 * carries a pre-mutation answer, so a caller arriving after must not join it.
 */
export function invalidateSyncProbeCache(): void {
  repoProbe.value = undefined;
  repoProbe.at = 0;
  repoProbe.inflight = null;
  remoteProbe.value = undefined;
  remoteProbe.at = 0;
  remoteProbe.inflight = null;
}

/** Test hook: forget every probe answer, including git-availability. */
export function resetSyncProbeCacheForTest(): void {
  invalidateSyncProbeCache();
  gitAvailableProbe.value = undefined;
  gitAvailableProbe.at = 0;
  gitAvailableProbe.inflight = null;
}

/**
 * plugin-files/<id>/ (walnut.storage.files, src/core/plugins/plugin-file-area.ts) is
 * the one place a plugin writes into the synced history, and only small text belongs
 * there: everything under it is ignored, then folders and the text extensions come
 * back in, and hidden names and node_modules/ go out again (a nested repo's .git, an
 * editor's state, installed packages). The block must be LAST in the .gitignore. Git
 * takes the last rule that matches, so the unanchored rules above it (images/, media/,
 * tmp/, node_modules/ ...) would otherwise hide a plugin's own `images/` folder, and a
 * broad line appended after it could hide the text again. ensureCriticalIgnores moves
 * it back to the end.
 */
const PLUGIN_FILES_BLOCK_START = `# >>> ${SYNCED_FILES_DIR}: synced plugin text (walnut.storage.files). Keep this block last.`;
const PLUGIN_FILES_BLOCK_END = `# <<< ${SYNCED_FILES_DIR}`;
const PLUGIN_FILES_RULES = [
  `/${SYNCED_FILES_DIR}/**`,
  `!/${SYNCED_FILES_DIR}/**/`,
  ...SYNCED_FILE_EXTENSIONS.map((extension) => `!/${SYNCED_FILES_DIR}/**/*${extension}`),
  `/${SYNCED_FILES_DIR}/**/.*`,
  `/${SYNCED_FILES_DIR}/**/node_modules/`,
];
export const PLUGIN_FILES_IGNORE_BLOCK = [PLUGIN_FILES_BLOCK_START, ...PLUGIN_FILES_RULES, PLUGIN_FILES_BLOCK_END];

/**
 * `content` with the plugin-files block at its very end, wherever it was before. The
 * block is found by its markers; its own rules found outside it are dropped. Its rules
 * are only ever added to, never taken away or reordered: rules in it this build does not
 * know (a newer build's, on another box sharing the repo) stay where they are, and rules
 * it lacks go at its end, so two builds never rewrite the file back and forth.
 */
export function withPluginFilesBlockLast(content: string): string {
  const lines = content.split('\n');
  const kept: string[] = [];
  const found: string[] = [];
  const dropSeparator = () => { if (kept.length > 0 && kept[kept.length - 1].trim() === '') kept.pop(); };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line === PLUGIN_FILES_BLOCK_START) {
      dropSeparator();
      const end = lines.findIndex((other, j) => j > i && other.trim() === PLUGIN_FILES_BLOCK_END);
      if (end === -1) continue; // a start without its end: only the marker goes
      for (const rule of lines.slice(i + 1, end)) if (rule.trim()) found.push(rule.trim());
      i = end;
      continue;
    }
    // A stray end marker, or one of this block's own rules left outside it by a hand edit.
    if (line === PLUGIN_FILES_BLOCK_END || PLUGIN_FILES_RULES.includes(line)) continue;
    kept.push(lines[i]);
  }
  // A block that holds every rule of this build keeps its own order (a newer build's, with a
  // rule this one does not know in the middle); one that lacks some gets them at its end.
  const existing = found.filter((rule, index) => found.indexOf(rule) === index);
  const rules = existing.length === 0 ? PLUGIN_FILES_RULES : [...existing, ...PLUGIN_FILES_RULES.filter((rule) => !existing.includes(rule))];
  const body = kept.join('\n').replace(/\s+$/, '');
  const block = [PLUGIN_FILES_BLOCK_START, ...rules, PLUGIN_FILES_BLOCK_END];
  return `${body ? `${body}\n\n` : ''}${block.join('\n')}\n`;
}

const GITIGNORE_BODY = `# Binary / large / ephemeral
browser/
images/
media/
# Private original recordings use their own durable archive, not git history.
/voice-archive/
timeline/
sessions/streams/
# Ephemeral working area — daemon stream files (multi-MB, constantly appended).
# Syncing them would be the 15 GB data-repo starvation incident all over again.
tmp/
# Outside-activity samples (which app / which site, every 5s) are Mac-local by
# design: browsing hosts are a category of data change versus task ids, and the
# /api/time/apps routes answer 501 on the cloud replica anyway.
time-tracking/outside/

# The one-time copy of the Threads files taken before they moved into their database,
# and the database's copy of a node set aside before a merge (src/core/org/threads-backend.ts,
# threads-sync.ts): local rollback points, never history.
org/threads-backup/

# The artifacts folder's backups and the one tree's half-built shadow (src/core/artifacts/):
# whole copies of the notes taken before a move, local rollback points, never history.
/artifacts/.backup/
/artifacts/.unify-stage/

# SQLite (binary, self-managed)
*.sqlite
*.sqlite-shm
*.sqlite-wal

# Auth tokens (sensitive)
sync/ms-todo-tokens.json
auth.json
auth.json.bak
# Its write temps (auth.json.tmp-<pid>, auth.json.bak.tmp-<pid>) and the copy a
# parse failure sets aside (auth.json.unreadable-<time>) hold the same hashes, and
# a crash between write and rename orphans a temp. Root only.
/auth.json.*
# Cloud-provisioning job state — holds the pairing code (a live setup token)
# until the new instance claims itself. Never syncs, never reaches a remote.
cloud-setup-job.json
# Its write temp (job.ts persist(): <file>.tmp-<pid>-<hex>), orphaned by a crash
# between the write and the rename, holds the same code.
/cloud-setup-job.json.*

# Machine-local settings — MUST stay out of the sync history. These hold the STT
# engine, SSH hosts and provider credentials, which differ per box. Keep in sync
# with CRITICAL_IGNORES; a fresh install missing these is how a remote deletion
# reached ~/.open-walnut/config.yaml twice (2026-07-25 / 07-26).
#
# EXACT FILENAMES on purpose — do NOT broaden to config* or config/. Its sibling
# config/share/ (ui-prefs.json, stt-vocab.txt) is the SYNCED half of the config:
# cross-device user preferences that are supposed to be tracked. A wider pattern
# here would silently make them device-local again.
config.yaml
config.yaml.bak
# Still exact: only config.yaml's own siblings, its write temps
# (config.yaml.tmp-<pid>-<ms>, config.yaml.bak.tmp-...), which hold the same
# provider keys and are orphaned by a crash mid-write. Root only.
/config.yaml.*

# Sync state (ephemeral)
sync/ms-todo-delta.json
sync/*.json

# Task backups (redundant with git)
tasks/*.backup*
tasks/*.bak*
tasks/archive/

# Bounded-memory pre-write snapshots (bounded-memory-backup.ts) — machine-local
# rollback artifacts. Recovery always happens on the box that took the damage,
# and syncing them would multiply memory write churn into the history.
memory/**/*.bak.*

# Runtime ephemeral
session-message-queue.json
# The enqueue's spool (core/session-queue-spool.ts): rows this box's queue takes; another box
# would drain and deliver them a second time.
session-message-queue.json.spool/
# Cron RUNTIME state (nextRunAtMs etc.) is machine-local — syncing it echoes a
# stale due time back from the other box and re-fires jobs (2026-08-04 storm).
# Job DEFINITIONS (cron-jobs.json) still sync.
cron-state.json
# Watcher routine memory (what each watcher already saw and already acted on).
# Machine-local for the same reason as cron-state.json: an LWW echo of another
# box's older "acted" map would un-remember an outcome and re-fire it here.
routine-state/
# Inbox Triage's pending buffer (the mail/Slack arrivals one run has not read
# yet, plus its open claim). Machine-local for the cron-state.json reason again:
# an LWW echo of another box's buffer would deliver that box's Slack lines here,
# or un-deliver ours mid-claim.
triage-state.json
# Reply-request ledger: deadlineAt is a machine-local due time and the whole
# thing only means anything on the primary (the sweeper is !CLOUD_MODE). Syncing
# it would let LWW roll a settled row back to pending and re-notify — same class
# as the cron-state storm above.
session-requests.json
# The in-app editor running on this box (port, pid, instance id): machine-local.
code-server/instance.json
# Quiet mode holds (src/core/quiet/quiet-state.ts): machine-local runtime state.
# An LWW echo of another box's older holds would silence notifications here.
quiet.json
# Per-host records (src/providers/daemon-standalone.ts spawn journal: which
# sessions THIS host's Walnut started). Each box keeps its own; an LWW merge of
# another box's copy would drop this host's lines.
/local/
*.lock/
*.lock

# Logs + OS
*.log
hook-errors.log
.DS_Store
node_modules/

# ── Crash residue, dead stores, machine-local runtime state ─────────────────
# Every rule below was found TRACKED in a real data repo and removed in the
# 2026-08-09 cleanup. They existed ONLY in that box's hand-edited .gitignore, so
# a FRESH install re-leaked all of it — hence this block. Note the anchoring: a
# leading / means root-level only, and each one below that has it needs it.

# Atomic-write temp files. writeJsonFile() writes .open-walnut-<hex>.tmp beside
# the target then renames; a crash mid-write orphans the .tmp. NOT anchored —
# orphans appear in every dir that holds a JSON store. Nine were tracked, and one
# was a stale copy of sync/ms-todo-tokens.json with a live MS Graph accessToken.
# (src/core/tmp-sweep.ts deletes the stale ones on boot; this keeps them out of
# the index in the window before that runs.)
.open-walnut-*.tmp

# Forensic copies parked by the conflict-marker / corrupt-JSON self-heal
# (json-conflict-recovery.ts): the damaged original of a file that was restored
# from history. Kept on disk because one side of a conflict can be a local edit
# that never reached a commit — but NEVER tracked: committing the marker text
# under a second name is the same 2026-08-22 incident wearing a hat.
*.conflicted-*
*.corrupt-*

# Dead pre-SQLite stores (0-byte sessions.db / tasks.db leftovers). ROOT-LEVEL
# ONLY: a blanket *.db would also hide a store kept deeper in the tree.
/*.db

# One-shot migration output (e.g. chat-history.json.migrated, 1.8MB).
*.migrated

# Ad-hoc backup snapshots — git history already IS the backup.
*.backup.json
# ROOT-LEVEL only: notes/ may legitimately contain a note whose name has .bak.
/*.bak.*

# Local disk caches — cache/history (rebuilt from session JSONLs on demand)
# and cache/projections + cache/transcripts (the projection cache: written by
# the exporters on the primary, bridge-pushed to the cloud; see
# src/core/projection-cache.ts). Machine-local by definition — the bridge is
# their transport, never git. Root only: every Walnut cache lives at <home>/cache/,
# and a folder the user named cache inside notes/ or memory/ is their content.
/cache/

# Obsidian semantic index — chunks plus a ~71MB embeddings blob, both regenerable
# from notes/. Binary, so git stores a FULL copy per change (no delta).
.walnut-obsidian-search/

# Apple Health store (src/core/health/): personal health data stays on this Mac.
# ROOT-ANCHORED: a note folder called health/ inside notes/ is user content.
/health/

# Downloaded components (src/core/components/): platform binaries, one set per
# machine, fetched again on demand. ROOT-ANCHORED like /health/.
/components/

# Places store (src/core/places/): the visits the iPhone records stay on this Mac.
# ROOT-ANCHORED for the same reason.
/places/

# Hybrid-search embedding model download cache (src/core/search/wiring.ts). One
# ~600MB ONNX file plus the partial .tmp files a download writes; every version
# is a full binary copy in history. Re-downloaded on demand — never sync it.
# ROOT-ANCHORED: a note folder called models/ inside notes/ is user content.
/models/

# Plugin-store clones and private Plugin state are machine-local.
plugin-stores/
plugin-data/

# Routing ledgers, approval tokens and frozen incoming content stay on the primary.
/router/

# Asks waiting on the person, kept across a restart (src/core/kept-asks.ts): this
# server's own pending state, with approval wait-token hashes. Never synced.
/kept-asks/

# Voice Accuracy (src/core/stt/compare/): this machine's takes heard again by other
# engines. They point at this machine's own recordings, which never sync. ROOT-ANCHORED.
/stt-compare/

# Voice recordings + transcripts (machine-local binary). Pre-1a location; new
# writes go to tmp/stt-recordings/, but old installs still have this dir.
stt-debug/

# Audio capture. Both moved under tmp/ in phase 1a; kept here for older installs.
recordings/
recording-state.json

# Server singleton lock — holds THIS machine's pid/port; syncing it makes the
# other box think a dead pid owns the repo.
/server.lock.json

# History-compaction watermark — a per-machine progress marker.
/.last-compaction

# UI state (open panels, widths, last-viewed ids). Rewritten constantly; was
# worth ~45 commits/day on its own. ROOT-ANCHORED: the live copy moved to
# config/share/ui-prefs.json, which IS synced (cross-device layout), and this
# rule must not follow it there — it only silences the pre-2026-08 root file that
# older installs still have until the migration moves it.
/ui-prefs.json

# Prebuilt dtach binary (pre-1a location; now tmp/bin/). A platform-specific
# compiled artifact — rebuildable, and wrong for any other architecture.
/bin/

# Obsidian "new file" scratch names left at the vault root by an accidental
# Cmd-N. ROOT-LEVEL only — a real note deeper in notes/ must be unaffected
# (notes/_attachment/Untitled 1.png is genuine user data).
/Untitled*
/Pasted image *
/未命名*

# Obsidian's own state. .obsidian/ holds PLUGIN CONFIG, which in a real vault
# contained S3 credentials; .smart-env is the Smart Connections embeddings store
# (large, binary, regenerable). Neither is user content — notes/ is.
.obsidian/
.smart-env
secrets/
# The password vault when a server keeps it in the data home (a throwaway or fake-HOME
# server; the real one lives in ~/.local/state). machine.json there opens it. Root only.
/vault/

# Private documents sync regardless of credential-shaped text or file names.
# Dedicated machine-local Settings and secrets stores remain excluded above.

# Dead pre-SQLite session store. sessions.sqlite is the source of truth (ignored
# above). session-db-migration.ts still reads sessions.json and writes
# sessions.json.migrated-from-json.backup next to it, so a fresh install CAN
# recreate both. Its history was once 906GB across 112,725 versions.
sessions.json
sessions.json.*

# Ad-hoc backup snapshots at the WALNUT_HOME root (config.yaml.backup-<ts>,
# config.yaml.backup-preheal-<ts>, …) — git history already IS the backup.
# ROOT-ANCHORED on purpose: the hand-written rules these mirror were bare
# *.bak / *.backup, which would also silence any note in notes/ whose filename
# happens to contain .bak.
/*.bak
/*.bak-*
/*.backup
/*.backup.gz
/*.backup-*

# Temp copies git writes for a merge driver, left behind when the merge is killed:
# each a whole copy of a store (git-sync-temp-leftovers.ts).
${GIT_TEMP_IGNORE_LINES.join('\n')}
`;
export const GITIGNORE_CONTENT = withPluginFilesBlockLast(GITIGNORE_BODY);

/**
 * Ignore entries that MUST be present even in pre-existing repos whose
 * .gitignore predates them.
 *
 *  - auth.json (+ its backup) — device-token hashes; each box pairs its own
 *    devices. Losing it presents as a blanket 401 on every token.
 *  - config.yaml (+ its backup) — MACHINE-LOCAL settings: the STT engine, SSH
 *    hosts, provider credentials, per-device model lists. Never synced.
 *  - cron-state.json — per-machine cron RUNTIME state (nextRunAtMs etc.).
 *    Syncing it echoes a stale due time back from the other box and re-fires
 *    jobs (2026-08-04 storm). Pre-existing repos' .gitignore predates this
 *    file, so it needs both the append and the untrack self-heal.
 *  - cloud-setup-job.json — in-flight cloud provisioning state, including the
 *    pairing code that doubles as the new instance's setup token. A live secret
 *    must never reach the sync history. Its write temp is a glob, so it is in
 *    EXTRA_IGNORE_PATTERNS below, with the auth.json and config.yaml ones.
 *  - models/ — the hybrid-search embedding model cache: a 613MB ONNX file that
 *    the 30s auto-save committed on 2026-08-26 (plus eight partial-download
 *    .tmp copies, 1.3GB), and that every commit since then has carried. Not
 *    sensitive, but the single biggest thing in the data repo and regenerable
 *    by a download, so an existing install needs the untrack pass too.
 *  - health/: the Apple Health store (health.sqlite). Personal health data never
 *    leaves the Mac: not through git, not through the S3 backup. ROOT-ANCHORED
 *    like models/, because a health folder inside notes/ is the user's own notes.
 *  - places/: the visits the iPhone records once the user turns Places on
 *    (places.sqlite). Same rule as health/, and root-anchored for the same reason.
 *  - triage-state.json, session-requests.json, local/: each box's own runtime
 *    state (the triage buffer, the reply-request ledger, the per-host spawn
 *    journal; the reasons are in GITIGNORE_CONTENT). Ignored, but an install
 *    older than those rules still tracked them, so the Mac committed them on
 *    every change and the companion pulled them over its own (2026-10-21). The
 *    companion reads the Mac's reply requests from its copy
 *    (replication/kinds/requests.ts), and git was never their backup: a fresh
 *    install never tracked them. local/ is root-anchored like models/.
 *  - code-server/instance.json: the in-app editor running on THIS box (its port,
 *    pid and instance id). Tracked since 2026-08-18, so the other box read the
 *    Mac's running editor as its own. Not a credential (the editor binds loopback
 *    with no auth, and the id only detects a stale URL), just machine-local.
 *  - stt-compare/: Voice Accuracy's compared takes, with the text the user sent
 *    after each dictation. Each points at a recording of this machine (which
 *    never syncs), so another box could not use it.
 *
 * These are also actively untracked (see ensureMachineLocalUntracked): being
 * gitignored on THIS box while still tracked in the index is the dangerous
 * state — see that function for the incident this prevents.
 */
const CRITICAL_IGNORE_FILES = [
  'auth.json', 'auth.json.bak', 'cloud-setup-job.json', 'config.yaml', 'config.yaml.bak', 'cron-state.json',
  'triage-state.json', 'session-requests.json', 'code-server/instance.json',
];
/** Repo-relative dir prefixes: what the untrack pass matches `ls-files` output against. */
const CRITICAL_IGNORE_DIRS = ['health/', 'models/', 'places/', 'voice-archive/', 'plugin-data/', 'secrets/', 'local/', 'components/', 'vault/', 'router/', 'kept-asks/', 'stt-compare/'];
/**
 * The .gitignore LINE for a dir when it differs from the prefix. `models/` is
 * root-anchored: a `models` folder inside notes/ is user content, and an
 * unanchored rule would silently stop syncing every new note in it. The untrack
 * matcher stays on the bare prefix because `ls-files` prints repo-relative paths
 * (and git would take a leading `/` in that pathspec literally).
 */
const CRITICAL_IGNORE_LINES: Record<string, string> = {
  'health/': '/health/', 'models/': '/models/', 'places/': '/places/', 'voice-archive/': '/voice-archive/', 'local/': '/local/',
  'components/': '/components/', 'vault/': '/vault/', 'router/': '/router/', 'kept-asks/': '/kept-asks/', 'stt-compare/': '/stt-compare/',
};
const CRITICAL_IGNORES = [
  ...CRITICAL_IGNORE_FILES,
  ...CRITICAL_IGNORE_DIRS.map((dir) => CRITICAL_IGNORE_LINES[dir] ?? dir),
];

function criticalIgnoreTarget(file: string): { path: string; recursive: boolean } | null {
  if (CRITICAL_IGNORE_FILES.includes(file)) return { path: file, recursive: false };
  const directory = CRITICAL_IGNORE_DIRS.find((entry) => file.startsWith(entry));
  return directory ? { path: directory.slice(0, -1), recursive: true } : null;
}

function criticalTrackedTargets(files: string[]): Map<string, { recursive: boolean; files: string[] }> {
  const targets = new Map<string, { recursive: boolean; files: string[] }>();
  for (const file of files) {
    const target = criticalIgnoreTarget(file);
    if (!target) continue;
    const current = targets.get(target.path) ?? { recursive: target.recursive, files: [] };
    current.files.push(file);
    targets.set(target.path, current);
  }
  return targets;
}

/**
 * Ignore-only patterns: kept out of the .gitignore drift, but NOT fed to the
 * untrack pass, which matches exact paths and cannot resolve a glob.
 *
 * `memory/**\/*.bak.*` — bounded-memory pre-write snapshots. Purely local
 * rollback artifacts, rewritten on every memory mutation; they have never been
 * tracked, so there is no index state to repair, only churn to keep out.
 *
 * `*.conflicted-*` / `*.corrupt-*` — forensic copies parked by the
 * conflict-marker self-heal. These MUST be ignored in pre-existing repos too:
 * the heal writes one next to the file it repairs, and an untracked sidecar in
 * the data repo would be committed by the very next auto-save, putting the
 * marker text back into history under a new name.
 *
 * `time-tracking/outside/` — outside-activity samples (which app / which site,
 * every 5s) are Mac-local by design: browsing hosts are a category of data change
 * versus task ids, and the /api/time/apps routes answer 501 on the cloud replica
 * anyway. Listed here as well as in GITIGNORE_CONTENT so an EXISTING install stops
 * committing them (one auto-save per 30s would be ~2880 commits a day).
 */
const EXTRA_IGNORE_PATTERNS = [
  'memory/**/*.bak.*', 'tmp/', 'time-tracking/outside/', '*.conflicted-*', '*.corrupt-*',
  // A root `<x>.backup` compressed in place (data-copy-compact.ts) stays as ignored as it was.
  '/*.backup.gz',
  // git's merge-driver temps a killed merge leaves (git-sync-temp-leftovers.ts).
  ...GIT_TEMP_IGNORE_LINES,
  // Write temps and set-aside copies of the secret files above, left by a crash
  // mid-write: they hold the same secret (see GITIGNORE_CONTENT). Root only.
  '/auth.json.*', '/config.yaml.*', '/cloud-setup-job.json.*',
  // Template rules since 2026-08-10 that older installs never got: every
  // writeJsonFile() temp (sync/ms-todo-tokens.json's holds a Graph refresh token,
  // cache/revoke-queue/'s device token hashes), and the root cache/ itself, whose
  // revoke queue holds those hashes too.
  '.open-walnut-*.tmp', '/cache/',
  // quiet.json: machine-local runtime state (see GITIGNORE_CONTENT), new in 2026-09.
  'quiet.json',
  // The artifacts folder's backups and the one tree's shadow (2026-11): whole copies of the notes.
  '/artifacts/.backup/', '/artifacts/.unify-stage/',
  // (/local/, new in 2026-09, is a CRITICAL_IGNORE_DIRS entry since 2026-10: untracked too.)
];

/**
 * Data the REPLICA may never author a commit for. Not an ignore rule: the
 * PRIMARY must keep committing these (they are user data and git is their only
 * backup), so they cannot go in the .gitignore template — the split is per-BOX,
 * and CLOUD_MODE is what tells the two apart.
 *
 * `human-inbox/` is primary-authoritative in the same way session-requests.json
 * is primary-only: every `/api/v1/human-inbox` route on a replica RELAYS to the
 * primary over `server.human-inbox.*` (see core/human-inbox/relay.ts), and staging
 * a body there answers 501. The replica READS its local copy only when the
 * primary cannot be reached (core/human-inbox/replica-state.ts), and keeps the
 * reader's changes made meanwhile in cache/, never in this directory. So the
 * replica holds a read-only mirror it received over git, and the
 * only commit it could ever author against it is a REVERT of the primary's newer
 * write. That is not theoretical: 2026-08-30 a replica auto-save committed its
 * older index.json over the primary's, flipping a letter the human had read back
 * to unread and taking a thread turn with it.
 *
 * plugin-files/ (walnut.storage.files) is written by the primary's plugins only: the
 * SDK refuses a write on a replica, so a difference there is a stale mirror as well.
 *
 * notifications.json joined in stage 4d (docs/plan/walnut-companion-unified-replica.md),
 * as a FILE of its own (CLOUD_NEVER_STAGE_FILES below): the Mac owns the feed. The
 * companion's console reads it from the Mac and sends mark-read and dismiss there
 * (core/notifications/companion-feed.ts), and the cards the box writes about itself
 * live in its own store under cache/ and reach the Mac over the relay
 * (core/notifications/companion-cards.ts). The data dir's file on the box is the
 * Mac's, brought by git, which the box only reads while the Mac is away.
 */
export const CLOUD_NEVER_STAGE_DIRS = ['human-inbox', SYNCED_FILES_DIR];

/**
 * Files the replica never stages either, restored from HEAD when they diverge.
 * Unlike the dirs above, nothing on the box writes these any more, so a divergence
 * is a leftover of an older build (the box's last cards before 4d), restored with
 * an info line rather than an error.
 */
export const CLOUD_NEVER_STAGE_FILES = ['notifications.json'];

/** Every path the replica never stages: the dirs, then the files. */
const NEVER_STAGE_PATHS = [...CLOUD_NEVER_STAGE_DIRS, ...CLOUD_NEVER_STAGE_FILES];

/**
 * The `git add` for an auto-commit. On the primary this is the plain `add -A` it
 * has always been; on a replica the never-author paths are excluded by pathspec.
 * Pure, so a test can read the exact argument line for both shapes.
 */
export function stageAllArgs(cloudMode: boolean): string {
  if (!cloudMode || NEVER_STAGE_PATHS.length === 0) return 'add -A';
  return `add -A -- . ${neverStageTreeExcludes().map((spec) => `'${spec}'`).join(' ')}`;
}

/**
 * The replica's never-author paths as pathspecs of a whole-tree add. The bare name
 * excludes a directory or a file; the /** form keeps a directory's contents out too.
 */
function neverStageTreeExcludes(): string[] {
  return [
    ...CLOUD_NEVER_STAGE_DIRS.flatMap((dir) => [`:(exclude)${dir}`, `:(exclude)${dir}/**`]),
    ...CLOUD_NEVER_STAGE_FILES.map((file) => `:(exclude)${file}`),
  ];
}

/** Whether a repo path is one of the replica's never-author paths, or inside one. */
function isNeverStagePath(file: string): boolean {
  return NEVER_STAGE_PATHS.some((p) => file === p || file.startsWith(`${p}/`));
}

/** The one git runner factory of the staging paths: argv, a timeout, stdin. */
function gitArgvRunnerAt(root: string): GitRunner {
  return (args, o) => execGitArgsGroup(args, {
    cwd: root, timeout: o.timeout, holdsNoLock: o.holdsNoLock, ...(o.input === undefined ? {} : { input: o.input }),
  });
}

function gitRunnerAt(root: string): (args: string[], input?: string) => Promise<string> {
  const run = gitArgvRunnerAt(root);
  return (args, input) => run(args, { timeout: LOCAL_TIMEOUT, input });
}

/** Replay HEAD's commits made after an upstream rewrite's cut onto the new chain (refs untouched). */
async function carryLocalCommitsAcrossRewrite(localHead: string, remoteRef: string, published: string | null): Promise<CarryResult> {
  const indexFile = path.join(WALNUT_HOME, '.git', 'walnut-rewrite-carry.index');
  const run: GitStatusRunner = (args, opts) => execGitArgsStatus(args, { cwd: WALNUT_HOME, ...opts, timeout: Math.max(LOCAL_TIMEOUT, opts?.timeout ?? 0) });
  try {
    return await carryLocalCommits(run, localHead, remoteRef, indexFile, published);
  } finally {
    await fs.promises.rm(indexFile, { force: true }).catch(() => undefined);
  }
}

/**
 * Stage the worktree for an auto-commit, honouring the replica's never-author
 * list. Every routine commit path funnels through here.
 *
 * Three steps on a replica, and the third is the one that is easy to miss:
 *
 *  1. `add` with the dirs excluded — nothing new about them can be staged;
 *  2. `reset` those dirs — anything ALREADY in the index (an older build's
 *     `add -A`, a `rm --cached` pass) is dropped, so the guarantee holds for a
 *     box that is mid-upgrade rather than only for fresh dirt;
 *  3. restore the dirs from HEAD when they are dirty. Excluding a TRACKED dirty
 *     path from every commit leaves it dirty forever, and `git rebase` refuses
 *     outright with unstaged changes ("cannot rebase: You have unstaged
 *     changes") while `merge` refuses to overwrite them — so the pull half of
 *     the very next tick would fail too, and the replica would stop receiving
 *     ANY upstream data, not just letters. The replica has no authority over
 *     these paths, so HEAD is the honest answer, and the discard is logged.
 */
export async function stageAllForCommit(
  opts: { cwd?: string; cloudMode?: boolean } = {},
): Promise<{ deferred: PendingFile[]; cloudMode: boolean } | null> {
  const cloudMode = opts.cloudMode ?? CLOUD_MODE;
  const gitOpts = opts.cwd ? { cwd: opts.cwd } : undefined;
  const root = gitOpts?.cwd ?? WALNUT_HOME;
  // Every `add -A` of the home goes through here: never one with no ignore list (a leader
  // switch's promoted home, or one removed while the server runs: see ensureCriticalIgnores).
  if (path.resolve(root) === path.resolve(WALNUT_HOME) && !fs.existsSync(path.join(root, '.gitignore'))) {
    writeOrHealGitignore();
    if (!fs.existsSync(path.join(root, '.gitignore'))) throw new Error('git-sync: the data repo has no .gitignore and it could not be written, so nothing is staged');
  }
  await releasePrivateDataHolds(gitRunnerAt(root), root);
  if (cloudMode) await restoreNeverStagePaths(gitOpts);
  else await prepareSyncedPluginFiles(root);
  // The add's size: what it would hash, measured without hashing (git-sync-large-files.ts).
  const plan = await planRoutineAdd(root, cloudMode);
  // Last look before `add`, with no await between (git-sync-apply-recovery.ts): a
  // pull moving the tree, or one that stopped and is not settled, means no commit
  // now (null, nothing staged); a held one this tick already knows leaves its own
  // paths out (below).
  const holdBack = root === WALNUT_HOME ? pullHoldBack : { ids: [], paths: [] };
  if (applyPending(root, holdBack.ids)) return null;
  let deferred: PendingFile[] = [];
  if (!plan || plan.deferred.length === 0) {
    await gitAsync(stageAllArgs(cloudMode), { cwd: root, timeout: addTimeoutFor(plan?.routineBytes ?? 0) });
  } else {
    deferred = plan.deferred;
    const pathspecs = routinePathspecs(plan, cloudMode ? neverStageTreeExcludes() : []);
    if (pathspecs?.[0] === '.') {
      await execGitArgsGroup(['add', '-A', '--pathspec-from-file=-', '--pathspec-file-nul'], {
        cwd: root, timeout: addTimeoutFor(plan.routineBytes), input: pathspecs.join('\0'),
      });
    } else if (pathspecs) {
      // Only the routine files, named: one removed since the listing must not fail the rest.
      await addListed(gitArgvRunnerAt(root), root, plan.routine, { timeout: addTimeoutFor(plan.routineBytes) });
    }
    log.git.info('git-sync: large files wait for the background lane; the rest commits now', {
      routineFiles: plan.routine.length, routineBytes: plan.routineBytes,
      deferredFiles: deferred.length, deferredBytes: deferred.reduce((sum, f) => sum + f.bytes, 0),
    });
  }
  if (holdBack.paths.length > 0) {
    // What a held pull wrote is the hub's content, never this box's change: not staged,
    // and not handed to the large-file lane either.
    await unstageHeldPaths(root, holdBack.paths);
    const held = new Set(holdBack.paths);
    deferred = deferred.filter((f) => !held.has(f.path));
  }
  await afterStage(gitOpts, cloudMode);
  // cloudMode travels with the deferred files: the lane's own checks follow the same answer.
  return { deferred, cloudMode };
}

/** Leave a held pull's paths out of the index (git-sync-apply-recovery.ts). */
async function unstageHeldPaths(root: string, paths: string[]): Promise<void> {
  const unstaged = await execGitArgsStatus(['--literal-pathspecs', 'reset', '-q', '--pathspec-from-file=-', '--pathspec-file-nul'], {
    cwd: root, timeout: LOCAL_TIMEOUT, input: paths.map((p) => `${p}\0`).join(''),
  });
  if (unstaged.code !== 0) throw new Error(`could not leave a held pull's files out of the commit: ${unstaged.stderr.trim().slice(0, 300)}`);
}

/** The checks every add of the auto-commit is followed by. */
async function afterStage(gitOpts: { cwd?: string } | undefined, cloudMode: boolean): Promise<void> {
  if (!cloudMode) {
    await keepUnfitPluginFilesOut(gitOpts);
  } else {
    for (const p of NEVER_STAGE_PATHS) {
      // Best-effort: a repo with no HEAD yet (initSync's first commit) has nothing
      // to reset to, and there is nothing staged there to drop either.
      await gitSafeAsync(`reset -q -- "${p}"`, gitOpts);
    }
  }
}

/**
 * Measure the pending add and split it at the routine budget. Null when git cannot
 * list it: the add then runs as it always did, with the base timeout.
 */
async function planRoutineAdd(root: string, cloudMode: boolean): Promise<StagePlan | null> {
  try {
    const files = await listPendingFiles(gitArgvRunnerAt(root), root, cloudMode ? isNeverStagePath : undefined);
    return planStage(files);
  } catch (error) {
    log.git.warn('git-sync: could not measure the pending add; staging it whole', { error: error instanceof Error ? error.message : String(error) });
    return null;
  }
}

/** The timeout of a whole-tree `add -A` that may not defer anything: every pending byte, scaled. */
async function wholeTreeAddTimeout(root: string): Promise<number> {
  try {
    const files = await listPendingFiles(gitArgvRunnerAt(root), root);
    return addTimeoutFor(files.reduce((sum, f) => sum + f.bytes, 0));
  } catch {
    return addTimeoutFor(0);
  }
}

/**
 * `status --porcelain -uall` of the data repo for the tick. status hashes a tracked
 * file whose stat moved but whose size did not, and over git's big-file threshold
 * (512 MiB) it streams that hash about 7x slower than it reads (measured 2026-11-24:
 * 32 s for a touched 600 MB file, 6 s with the threshold raised). A status that times
 * out reads as a clean tree and the tick commits nothing, every tick: so the threshold
 * is raised and the timeout covers the bytes `diff-files` (stat only, no hashing) says
 * it may hash.
 */
async function porcelainStatus(root = WALNUT_HOME): Promise<string | null> {
  return gitSafeAsync(`-c core.bigFileThreshold=${STAGE_BIG_FILE_THRESHOLD} status --porcelain -uall`, {
    cwd: root, timeout: await statusTimeout(root),
  });
}

async function statusTimeout(root: string): Promise<number> {
  try {
    const tracked = await listPendingFiles(gitArgvRunnerAt(root), root, undefined, { untracked: false });
    return Math.max(STATUS_TIMEOUT, addTimeoutFor(tracked.reduce((sum, f) => sum + f.bytes, 0)));
  } catch {
    return STATUS_TIMEOUT;
  }
}

/** The timeout of an add of one named file: its size, scaled (a conflicted file may be any size). */
async function fileAddTimeout(root: string, file: string): Promise<number> {
  const stat = await fs.promises.lstat(path.join(root, file)).catch(() => null);
  return addTimeoutFor(stat?.isFile() ? stat.size : 0);
}

/**
 * The large-file lane, after the routine commit: stage and commit the deferred files
 * whose objects the background lane wrote already, and start writing the rest
 * (git-sync-large-files.ts). One file's failure only backs that file off. Returns
 * the files committed.
 */
export async function commitDeferredLargeFiles(
  deferred: PendingFile[],
  opts: { cwd?: string; cloudMode: boolean; message: (count: number) => string },
): Promise<number> {
  if (deferred.length === 0) return 0;
  const { cloudMode } = opts;
  const gitOpts = opts.cwd ? { cwd: opts.cwd } : undefined;
  const root = gitOpts?.cwd ?? WALNUT_HOME;
  const holdBack = root === WALNUT_HOME ? pullHoldBack : { ids: [], paths: [] };
  // A pull that starts while the lane hashes stops it: what it hashed may be older than what the pull writes.
  const lane = await runLargeFileLane(gitArgvRunnerAt(root), root, deferred, {
    shouldStop: () => isSyncPaused() || compactionInProgress || gitQuietAt(root) || applyPending(root, holdBack.ids),
    onFailure: (failure) => log.git.warn('git-sync: a large file could not be written to the data repo; it backs off and the rest keeps syncing', failure),
  });
  if (lane.staged.length === 0) return 0;
  // The last look before the commit, as stageAllForCommit's: a pull under way, or one stopped part way, commits nothing.
  if (applyPending(root, holdBack.ids)) {
    await unstageHeldPaths(root, lane.staged).catch(() => undefined);
    return 0;
  }
  await afterStage(gitOpts, cloudMode);
  const staged = await gitSafeAsync('diff --cached --name-only', gitOpts);
  const count = (staged ?? '').split('\n').filter((l) => l.trim().length > 0).length;
  if (count === 0) return 0;
  if (await gitSafeAsync(`commit -m "${opts.message(count)}"`, gitOpts) === null) return 0;
  log.git.info('git-sync: committed large files', { files: lane.staged.length, waiting: lane.left.length });
  return count;
}

const unfitPluginFilesReported = new Set<string>();
/**
 * plugin-files/.gitignore: the files keepUnfitPluginFilesOut kept out, so the next
 * `add -A` does not hash them again (a big file rewritten often would fill .git with
 * loose objects) and the tree reads clean. Written by Walnut only; it is a hidden name,
 * so the block above keeps it out of git, and the SDK never lets a plugin write it.
 */
const PLUGIN_FILES_LOCAL_IGNORE = '.gitignore';
const PLUGIN_FILES_LOCAL_IGNORE_HEADER = '# Written by Walnut git-sync: plugin files kept out of the synced history (over 1 MiB, binary, a link, or a nested repository). A line goes once its file is gone or fits.';

/** The gitignore line that matches exactly `relative` (a path inside plugin-files/); null when no line can (a line break in the name). */
function pluginFilesIgnoreLine(relative: string): string | null {
  if (/[\r\n]/.test(relative)) return null;
  return `/${relative.replace(/[\\*?[]/g, (c) => `\\${c}`).replace(/ +$/, (spaces) => spaces.replace(/ /g, '\\ '))}`;
}

function pluginFilesIgnoredPath(line: string): string | null {
  return line.startsWith('/') ? line.slice(1).replace(/\\(.)/g, '$1') : null;
}

/** Whether a file on disk would pass now: a regular file, small enough, no NUL. */
async function pluginFileFitsNow(file: string): Promise<boolean> {
  try {
    const stat = await fs.promises.lstat(file);
    if (!stat.isFile() || stat.size > SYNCED_FILE_MAX_BYTES) return false;
    return !(await fs.promises.readFile(file)).includes(0);
  } catch {
    return false;
  }
}

async function readPluginFilesLocalIgnore(dir: string): Promise<string[]> {
  const text = await fs.promises.readFile(path.join(dir, PLUGIN_FILES_LOCAL_IGNORE), 'utf-8').catch(() => '');
  return text.split('\n').filter((line) => line.startsWith('/'));
}

async function writePluginFilesLocalIgnore(dir: string, lines: string[]): Promise<void> {
  const file = path.join(dir, PLUGIN_FILES_LOCAL_IGNORE);
  if (lines.length === 0) { await fs.promises.rm(file, { force: true }); return; }
  await fs.promises.writeFile(file, `${PLUGIN_FILES_LOCAL_IGNORE_HEADER}\n${lines.join('\n')}\n`, 'utf-8');
}

let pluginFilesPrepareWarned = false;

/**
 * Before the add: lines of the local ignore whose file is gone or fits again come out, so
 * such a file syncs at once, and every nested repository under plugin-files/ goes in. A
 * nested repo has to be out BEFORE the add: one without a commit makes `add -A` fail for
 * the whole data folder ("does not have a commit checked out"), every tick, which would
 * stop the sync of everything else. `ls-files -o` lists such a folder as `dir/` (git does
 * not descend into it). Never throws: the add and the check after it still run.
 */
async function prepareSyncedPluginFiles(root: string): Promise<void> {
  const dir = path.join(root, SYNCED_FILES_DIR);
  if (!fs.existsSync(dir)) return;
  try {
    const lines = await readPluginFilesLocalIgnore(dir);
    const keep: string[] = [];
    for (const line of lines) {
      const relative = pluginFilesIgnoredPath(line);
      if (!relative) continue;
      const absolute = path.join(dir, relative);
      if (line.endsWith('/')) {
        // A nested repository stays out while it is one.
        if (fs.existsSync(path.join(absolute, '.git'))) keep.push(line);
        continue;
      }
      if (!(await fs.promises.lstat(absolute).then(() => true, () => false))) continue;
      if (await pluginFileFitsNow(absolute)) continue;
      keep.push(line);
    }
    const untracked = await execGitArgsGroup(['ls-files', '-o', '--exclude-standard', '-z', '--', SYNCED_FILES_DIR], { cwd: root, timeout: LOCAL_TIMEOUT });
    const nested = untracked.split('\0').filter((entry) => entry.endsWith('/'));
    for (const entry of nested) {
      const line = pluginFilesIgnoreLine(entry.slice(SYNCED_FILES_DIR.length + 1, -1));
      if (line && !keep.includes(`${line}/`)) keep.push(`${line}/`);
    }
    if (keep.length !== lines.length || keep.some((line, i) => line !== lines[i])) await writePluginFilesLocalIgnore(dir, keep);
    if (nested.length > 0) log.git.warn('git-sync: kept a nested repository under plugin-files/ out of the synced history', { folders: nested.slice(0, 20) });
  } catch (error) {
    if (!pluginFilesPrepareWarned) {
      pluginFilesPrepareWarned = true;
      log.git.warn('git-sync: could not check plugin-files/ before the add', { error: error instanceof Error ? error.message : String(error) });
    }
  }
}

/**
 * An entry under plugin-files/ staged new, changed or changed in type that is over the
 * size limit, holds binary data, or is a link (a symlink, a nested repo) stays out of
 * the commit: `rm --cached` after the add, the file on disk untouched, and a line in
 * plugin-files/.gitignore so later adds skip it. A tracked file that grew past the limit
 * so leaves the synced history (the commit records it deleted; the file stays on this
 * machine). `rm --cached` leaves nothing dirty: the commit right after takes the removal,
 * and the ignore line keeps the file untracked, so a pull is never blocked.
 * The SDK already refuses such a write; this catches a plugin that wrote into its folder
 * directly. It judges what was STAGED (the blob's size, git's own binary test), not the
 * file on disk, which may have changed since. When the unstage fails this throws, so the
 * tick commits nothing rather than the file. No shell: names go to git on stdin.
 */
async function keepUnfitPluginFilesOut(gitOpts: { cwd?: string } | undefined): Promise<void> {
  const root = gitOpts?.cwd ?? WALNUT_HOME;
  const dir = path.join(root, SYNCED_FILES_DIR);
  if (!fs.existsSync(dir)) return;
  const git = (args: string[], input?: string) => execGitArgsGroup(args, { cwd: root, timeout: LOCAL_TIMEOUT, ...(input === undefined ? {} : { input }) });
  const pathspec = ['--', SYNCED_FILES_DIR];
  // --no-renames: a new file that looks like a moved one is still new.
  const raw = await git(['diff', '--cached', '--no-renames', '--diff-filter=AMT', '--raw', '-z', '--no-abbrev', ...pathspec]);
  if (!raw) return;
  const added: Array<{ file: string; mode: string; blob: string }> = [];
  const fields = raw.split('\0');
  for (let i = 0; i + 1 < fields.length; i += 2) {
    const [, mode, , blob] = fields[i].split(' ');
    if (fields[i + 1]) added.push({ file: fields[i + 1], mode, blob });
  }
  if (added.length === 0) return;
  const unfit = new Map<string, string>();
  for (const entry of added) if (entry.mode !== '100644' && entry.mode !== '100755') unfit.set(entry.file, entry.mode === '160000' ? 'a nested repository' : 'a link');
  const blobs = added.filter((entry) => !unfit.has(entry.file));
  if (blobs.length > 0) {
    const sizes = (await git(['cat-file', '--batch-check=%(objectsize)'], blobs.map((entry) => entry.blob).join('\n') + '\n')).split('\n');
    blobs.forEach((entry, index) => {
      const size = Number(sizes[index]);
      if (Number.isFinite(size) && size > SYNCED_FILE_MAX_BYTES) unfit.set(entry.file, `${size} bytes, over ${SYNCED_FILE_MAX_BYTES}`);
    });
    // Git's own binary test on the staged blob: numstat shows "-" for binary.
    const numstat = await git(['diff', '--cached', '--no-renames', '--diff-filter=AMT', '--numstat', '-z', ...pathspec]);
    for (const row of numstat.split('\0')) {
      const match = /^-\t-\t(.+)$/s.exec(row);
      if (match && !unfit.has(match[1])) unfit.set(match[1], 'binary data');
    }
  }
  if (unfit.size === 0) return;
  const files = [...unfit.keys()];
  try {
    // -f: the staged blob may differ from the file and from HEAD already; --cached never touches the file.
    await git(['--literal-pathspecs', 'rm', '--cached', '-r', '-f', '-q', '--pathspec-from-file=-', '--pathspec-file-nul'], files.join('\0'));
  } catch (error) {
    // At least out of this commit: the index back to HEAD for them, then no commit this tick.
    await git(['--literal-pathspecs', 'reset', '-q', '--pathspec-from-file=-', '--pathspec-file-nul'], files.join('\0')).catch(() => undefined);
    throw new Error(`git-sync: could not keep ${files.length} unfit plugin file(s) out of the commit: ${error instanceof Error ? error.message : String(error)}`);
  }
  const lines = await readPluginFilesLocalIgnore(dir);
  for (const file of files) {
    const line = pluginFilesIgnoreLine(file.slice(SYNCED_FILES_DIR.length + 1));
    if (line && !lines.includes(line)) lines.push(line);
  }
  await writePluginFilesLocalIgnore(dir, lines).catch((error) => {
    log.git.warn('git-sync: could not record a kept-out plugin file', { error: error instanceof Error ? error.message : String(error) });
  });
  const fresh = files.filter((file) => !unfitPluginFilesReported.has(file));
  for (const file of fresh) unfitPluginFilesReported.add(file);
  if (fresh.length > 0) {
    log.git.warn('git-sync: kept a plugin file out of the commit; plugin-files/ holds small text only', {
      files: fresh.slice(0, 20).map((file) => ({ file, reason: unfit.get(file) })),
    });
  }
}

/**
 * Put the never-author dirs back to HEAD when a replica has diverged there.
 *
 * Asks git directly, SCOPED to those dirs, rather than reusing the caller's
 * porcelain snapshot: one cheap index-only call on the replica, and immune to a
 * trap that already bit this — `gitAsync` trims its whole stdout, so the FIRST
 * porcelain line of a `status` loses the leading space of a ` M path` status and
 * a fixed `slice(3)` then eats a character of the filename.
 *
 * Only TRACKED changes are restored. An untracked local file blocks nothing and
 * is left on disk for a human to look at.
 */
async function restoreNeverStagePaths(gitOpts: { cwd?: string } | undefined): Promise<void> {
  const scope = NEVER_STAGE_PATHS.map(p => `"${p}"`).join(' ');
  const status = await gitSafeAsync(`status --porcelain -- ${scope}`, gitOpts);
  if (!status) return;
  const diverged = status
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.length > 0 && !line.startsWith('??'))
    // Strip the XY status, whatever whitespace survived the trim.
    .map(line => line.replace(/^\S{1,2}\s+/, ''));
  if (diverged.length === 0) return;
  const inDirs = diverged.filter(f => !CLOUD_NEVER_STAGE_FILES.includes(f));
  if (inDirs.length > 0) {
    log.git.error(
      'git-sync: replica-local changes under a primary-authoritative path, restoring them from HEAD. '
      + 'This box relays every write for these paths, so a local difference is a stale mirror, and '
      + 'committing it would revert the primary (2026-08-30 incident).',
      { files: inDirs.slice(0, 20), count: inDirs.length, dirs: CLOUD_NEVER_STAGE_DIRS },
    );
  }
  const files = diverged.filter(f => CLOUD_NEVER_STAGE_FILES.includes(f));
  if (files.length > 0) {
    log.git.info('git-sync: restoring the Mac\'s copy of a file this box no longer writes', { files });
  }
  for (const p of NEVER_STAGE_PATHS) {
    // A path HEAD does not have yet fails here, harmlessly (nothing tracked to restore).
    await gitSafeAsync(`checkout -q HEAD -- "${p}"`, gitOpts);
  }
}

/**
 * Lines an older template wrote too wide, and the line that replaces each. Only
 * a line that is exactly the old one is rewritten; nothing else the user wrote is.
 * `cache/` (template 2026-08-10 until its anchoring) also hid every folder named
 * cache inside notes/ and memory/ from the sync.
 */
const REANCHORED_LINES = new Map<string, string>([['cache/', '/cache/']]);

/**
 * Append missing CRITICAL_IGNORES / EXTRA_IGNORE_PATTERNS to an existing
 * .gitignore (idempotent), after re-anchoring REANCHORED_LINES, and keep the
 * plugin-files block last. Called from ensureRepo() and every sync tick, so every
 * boot self-heals older installations.
 */
export function ensureCriticalIgnores(): void {
  const gitignorePath = path.join(WALNUT_HOME, '.gitignore');
  let content: string;
  try {
    content = fs.readFileSync(gitignorePath, 'utf-8');
  } catch {
    // No .gitignore: the template, here too. A repo can have `.git` and no .gitignore (a leader
    // switch's promoted home before the file was leader data; a file removed by hand), and an
    // `add -A` with no ignore list takes in tmp/, /voice-archive/ and the machine-local stores.
    // Not while the home is quiet for a leader switch's stop: the next leader's boot writes it.
    if (!gitQuietAt(WALNUT_HOME)) writeGitignore(gitignorePath, GITIGNORE_CONTENT);
    return;
  }
  // Retire only the scanner's blanket filename rules, not machine-local stores or user rules.
  const retired = new Set(SECRET_IGNORE_PATTERNS);
  const rewritten = content.split('\n').filter((line) => !retired.has(line.trim()))
    .map((line) => REANCHORED_LINES.get(line) ?? line).join('\n');
  const lines = new Set(rewritten.split('\n').map((l) => l.trim()));
  const missing = [...CRITICAL_IGNORES, ...EXTRA_IGNORE_PATTERNS].filter((entry) => !lines.has(entry));
  const suffix = missing.length === 0 ? '' : (
    (rewritten.endsWith('\n') ? '' : '\n')
    + '\n# Machine-local / sensitive: never synced\n'
    + missing.join('\n') + '\n'
  );
  // Appended lines land above the plugin-files block, which stays last.
  const next = withPluginFilesBlockLast(rewritten + suffix);
  if (next === content) return;
  writeGitignore(gitignorePath, next);
}

/**
 * Drop machine-local files from the INDEX while keeping them on disk.
 *
 * Being gitignored locally is NOT enough: .gitignore only stops git from
 * *adding* an untracked file. A file that is already tracked stays tracked, and
 * then a merge/pull that carries someone else's deletion of it DELETES THE
 * LOCAL FILE — .gitignore does not protect a tracked path.
 *
 * That is exactly how voice input broke (2026-07-25): config.yaml was
 * gitignored + untracked on one box, but still tracked here, so a merge from
 * origin applied the deletion and wiped ~/.open-walnut/config.yaml. The app
 * then rebuilt a minimal config from defaults, silently dropping `stt:` (plus
 * hosts/tools/plugins) — the mic went grey with "No STT engine configured".
 *
 * `rm --cached` stages the removal without touching the working tree, so after
 * this runs the path is untracked AND ignored, and no future merge can reach
 * the file on disk. Idempotent: no-ops once nothing ignored is still tracked.
 */
export function ensureMachineLocalUntracked(): string[] {
  // `ls-files -i -c --exclude-standard` = tracked paths that .gitignore says
  // should be ignored. Cheap (~20ms on a 3.7k-file repo).
  const tracked = gitSafe('ls-files -i -c --exclude-standard');
  if (!tracked) return [];
  const targets = criticalTrackedTargets(tracked
    .split('\n')
    .map((f) => f.trim())
    .filter(Boolean));
  if (targets.size === 0) return [];

  const untracked: string[] = [];
  for (const [target, detail] of targets) {
    const recursive = detail.recursive ? '-r ' : '';
    // --cached: index only. The files on disk remain untouched.
    if (gitSafe(`rm --cached --quiet -f ${recursive}-- "${target}"`) !== null) {
      untracked.push(...detail.files);
    }
  }
  if (untracked.length > 0) {
    log.git.warn(
      'git-sync untracked machine-local files that were still in the index — a remote deletion could have wiped them from disk',
      { files: untracked },
    );
  }
  return untracked;
}

/**
 * Async twin of ensureMachineLocalUntracked, for the sync tick.
 *
 * ensureRepo() runs this once at boot, but a merge happens every 30s and the
 * dangerous state can appear at runtime: any `add -A` after a critical file is
 * (re-)created while .gitignore hasn't caught up re-tracks it, and then the
 * NEXT pull can carry a remote deletion straight to disk. Re-checking right
 * before every pull closes that window instead of waiting for a restart.
 *
 * Must be async: the sync tick runs on the event loop and gitSafe's execSync
 * blocks every HTTP request for the duration (the bug fixed in 2928b29).
 */
async function ensureMachineLocalUntrackedAsync(atBoot = false): Promise<string[]> {
  // `ls-files -i` only reports paths the CURRENT .gitignore ignores, so the
  // ignore rules must exist before the query — otherwise a repo whose
  // .gitignore predates CRITICAL_IGNORES reports nothing and the guard no-ops.
  try { ensureCriticalIgnores(); } catch { /* best-effort */ }
  await sweepGitTempsAsync();
  const tracked = await gitSafeAsync('ls-files -i -c --exclude-standard');
  if (!tracked) return [];
  const targets = criticalTrackedTargets(tracked
    .split('\n')
    .map((f) => f.trim())
    .filter(Boolean));
  if (targets.size === 0) return [];

  const untracked: string[] = [];
  for (const [target, detail] of targets) {
    const recursive = detail.recursive ? '-r ' : '';
    if (await gitSafeAsync(`rm --cached --quiet -f ${recursive}-- "${target}"`) !== null) {
      untracked.push(...detail.files);
    }
  }
  if (untracked.length > 0 && atBoot) {
    log.git.warn(
      'git-sync untracked machine-local files that were still in the index — a remote deletion could have wiped them from disk',
      { files: untracked },
    );
  } else if (untracked.length > 0) {
    log.git.error(
      'git-sync found a machine-local file re-entering the index AT RUNTIME — untracked it before pulling. A remote deletion would have wiped it from disk (2026-07-25/26 incident).',
      { files: untracked },
    );
  }
  return untracked;
}

/** Untrack and remove the stale temp copies a killed git merge left at the root (after the ignore line exists). */
async function sweepGitTempsAsync(): Promise<void> {
  try {
    const sweep = await sweepGitTempLeftovers(WALNUT_HOME, (args) => gitSafeAsync(args));
    if (sweep.removed.length > 0) {
      log.git.warn('git-sync removed temp files a killed git merge left in the data repo', {
        removed: sweep.removed.length, untracked: sweep.untracked.length, bytes: sweep.bytes,
      });
    }
  } catch { /* best-effort: the next tick tries again */ }
}

/**
 * The .gitignore written whole or not at all (a temp file beside it, then a rename): a torn one
 * would still exist, so nothing would write it again, and the rules past the tear would be gone.
 */
function writeGitignore(gitignorePath: string, content: string): void {
  // Not while the home is quiet for a leader switch's stop (every writer of it comes here): the next leader's boot
  // writes it, and a stage in a quiet home is refused anyway.
  if (path.resolve(path.dirname(gitignorePath)) === path.resolve(WALNUT_HOME) && gitQuietAt(WALNUT_HOME)) return;
  // The template's own temp-file rule ignores it (`.open-walnut-*.tmp`): one left by a crash is never committed or copied.
  const tmp = path.join(path.dirname(gitignorePath), `.open-walnut-gitignore-${process.pid}.tmp`);
  try {
    fs.writeFileSync(tmp, content, 'utf-8');
    fs.renameSync(tmp, gitignorePath);
  } catch (err) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* gone */ }
    throw err;
  }
}

/** A new data home gets the standard .gitignore; an existing one gets its critical rules back. */
function writeOrHealGitignore(): void {
  const gitignorePath = path.join(WALNUT_HOME, '.gitignore');
  if (!fs.existsSync(gitignorePath)) {
    writeGitignore(gitignorePath, GITIGNORE_CONTENT);
  } else {
    ensureCriticalIgnores();
  }
}

/**
 * The data repo's own settings, made at every boot (ensureRepo) and setup (initSync).
 *
 * Identity: the data repo auto-commits without user interaction. Fresh CI runners
 * and minimal self-hosted installs often have no global Git identity, which used
 * to make initial commits and later auto-saves silently fail. An existing user
 * identity is kept; the repo-local fallback is set only when Git resolves none.
 *
 * Attributes: the user's own attributes file (core.attributesFile, or git's
 * default ~/.config/git/attributes) never applies here. Git-sync merges the data
 * stores itself (git-sync-merge.ts: per-file LWW, record merges), and a personal
 * merge driver mapped to `*.json` / `*.md` ran inside every pull's merge-tree
 * instead (2026-11-24: a syntax-aware driver took over 30 s, the merge timed
 * out on every tick for six hours, nothing synced, and each push was rejected
 * as diverged). The same file can carry a filter, eol or diff driver that would
 * rewrite what the stores hold on disk. A repo-local empty value outranks the
 * global one and every default, for every git process in this repo.
 *
 * Signing: a global commit.gpgsign would make every 30-second auto-commit ask
 * a signing agent the server has no session for, and each one fail silently.
 *
 * A setting that cannot be written (a stale config.lock) is logged and retried
 * at the next boot; it never turns sync off.
 */
const DATA_REPO_SETTINGS: ReadonlyArray<readonly [key: string, value: string]> = [
  ['core.attributesFile', ''],
  ['commit.gpgsign', 'false'],
];

function settingFailed(key: string, error: unknown): void {
  log.git.warn('git-sync: could not write a data repo setting; retried at the next boot', {
    key, error: (error instanceof Error ? error.message : String(error)).slice(0, 300),
  });
}

async function ensureDataRepoConfigAsync(): Promise<void> {
  if (!(await gitSafeAsync('config user.name'))) await gitAsync('config user.name "Open Walnut"');
  if (!(await gitSafeAsync('config user.email'))) await gitAsync('config user.email "open-walnut@localhost"');
  for (const [key, value] of DATA_REPO_SETTINGS) {
    if ((await gitSafeAsync(`config --local --get ${key}`)) === value) continue;
    try { await gitAsync(`config --local ${key} "${value}"`); } catch (error) { settingFailed(key, error); }
  }
}

/** Sync twin of ensureDataRepoConfigAsync(), for the CLI's setup (initSync). */
function ensureDataRepoConfig(): void {
  if (!gitSafe('config user.name')) git('config user.name "Open Walnut"');
  if (!gitSafe('config user.email')) git('config user.email "open-walnut@localhost"');
  for (const [key, value] of DATA_REPO_SETTINGS) {
    if (gitSafe(`config --local --get ${key}`) === value) continue;
    try { git(`config --local ${key} "${value}"`); } catch (error) { settingFailed(key, error); }
  }
}

export function initSync(remoteUrl?: string): void {
  if (!isRepo()) {
    // Inside another repository: the data home gets its own, nested in it. Say so
    // once, since a remote set up before this fix lives on the outer one.
    const outer = gitSafe('rev-parse --show-toplevel');
    if (outer) log.git.warn('git-sync: the data home sits inside another git repository; giving it a repository of its own', { dataHome: WALNUT_HOME, outer });
    try {
      git('init');
      git('checkout -b main');
    } finally {
      // A repo now exists where the cached probe answer says it does not, and the
      // tick/event paths read that cache — a stale `false` here is sync silently
      // never starting after setup. In a finally because `git init` can land even
      // if the checkout throws.
      invalidateSyncProbeCache();
    }
  }

  ensureDataRepoConfig();
  writeOrHealGitignore();

  if (remoteUrl) {
    setRemote(remoteUrl);
  }

  // Initial commit if repo is empty
  const hasCommits = gitSafe('log --oneline -1') !== null;
  if (!hasCommits) {
    // The first commit holds the .gitignore alone. Everything else waits for the
    // first tick, whose guarded stage (stageAllForCommit) applies every rule a bare
    // add here would skip: the secret scan (an existing data folder may already hold
    // a credential under a name no rule lists), the replica's never-author paths,
    // and plugin-files/'s size and type limits.
    git('add -- .gitignore');
    gitSafe('commit -m "open-walnut init"');
  }
}

export function setRemote(url: string): void {
  if (hasRemote()) {
    git(`remote set-url origin ${url}`);
  } else {
    git(`remote add origin ${url}`);
  }
  hardenGitConfigPerms(url);
  // The async guard caches per-cwd; changing the remote is the one thing that
  // invalidates it (e.g. swapping a credentialed HTTPS URL for SSH).
  invalidateCredentialGuardCache();
  // `remote add` flips hasRemote() false → true. The tick and gitPullWalnut read
  // the CACHED answer, so without this they keep standing down after the user
  // just configured a remote.
  invalidateSyncProbeCache();
}

/**
 * If the remote URL embeds credentials, .git/config now holds a plaintext
 * token — tighten it from git's default 0644 to owner-only.
 */
export function hardenGitConfigPerms(url: string, repoDir?: string): void {
  if (!/https?:\/\/[^/\s]+@/.test(url)) return;
  try {
    fs.chmodSync(path.join(repoDir ?? WALNUT_HOME, '.git', 'config'), 0o600);
  } catch {
    // Best-effort (e.g. exotic setups where .git is a file) — never fail the caller
  }
}

// ── Mass-revert circuit breaker + pull-only safe mode ───────────────────────
// Root cause guard for the 2026-08-03 data-repo incident: the hub box's
// fetch/pull timed out for ~8h (its worktree froze on an old tree), then a
// pull finally moved HEAD but the checkout was killed mid-way (15s timeout,
// process group reaped) — leaving a TORN worktree: HEAD at the new tip, disk
// still holding the old tree. The next `commitIfDirty` ran `add -A` BEFORE any
// pull and committed the entire stale tree (2233 renames reverted + deleted
// files resurrected) as one commit, silently undoing 8h of the user's work,
// with a commit message claiming "(1 files)". The guards below attack each
// link of that chain.

/**
 * Dirty-file count above which a snapshot is suspicious and gets vetted.
 * This is the FLOOR only — the live threshold is effectiveMassDirtyThreshold(),
 * which scales with repo size (a flat 300 is ~1% of a 30k-file repo, i.e. a
 * legitimate bulk edit trips it, while on a 200-file repo 300 can never trip).
 * Still exported: callers/tests pin the floor, and it is the documented minimum.
 */
export const MASS_DIRTY_THRESHOLD = 300;
/** Share of the tracked file count that also counts as a "mass" dirty set. */
const MASS_DIRTY_TRACKED_FRACTION = 0.05;
/** How long one `git ls-files` count is reused before recounting. */
const TRACKED_COUNT_TTL_MS = 10 * 60_000;
let trackedCountCache: { count: number; at: number } | null = null;

/**
 * Tracked-file count, cached for TRACKED_COUNT_TTL_MS. `git ls-files` on a
 * 30k-file repo is cheap but not free, and this is consulted from every tick
 * (twice: commitIfDirty + syncInner). On failure the last known count is reused
 * rather than collapsing to 0 — a transient git error must not silently lower
 * the breaker's sensitivity floor.
 */
async function trackedFileCount(): Promise<number> {
  const now = Date.now();
  if (trackedCountCache && now - trackedCountCache.at < TRACKED_COUNT_TTL_MS) {
    return trackedCountCache.count;
  }
  const out = await gitSafeAsync('ls-files');
  if (out === null) return trackedCountCache?.count ?? 0;
  const count = out.split('\n').filter((l) => l.trim().length > 0).length;
  trackedCountCache = { count, at: now };
  return count;
}

/**
 * Live mass-dirty threshold: max(MASS_DIRTY_THRESHOLD, 5% of tracked files).
 * Scales the circuit breaker with the repo so it keeps meaning "a suspiciously
 * large share of the repo changed at once" instead of a fixed file count.
 */
export async function effectiveMassDirtyThreshold(): Promise<number> {
  const tracked = await trackedFileCount();
  return Math.max(MASS_DIRTY_THRESHOLD, Math.ceil(tracked * MASS_DIRTY_TRACKED_FRACTION));
}

/** Test hook: drop the cached tracked-file count. */
export function resetTrackedCountCacheForTest(): void {
  trackedCountCache = null;
}

/** Consecutive fetch/pull failures after which the worktree is presumed stale. */
export const FAILURE_STREAK_FOR_PULL_FIRST = 3;
/**
 * Untracked dirty files that upstream's recent history deleted/renamed away —
 * at or above this count a huge dirty set is treated as a mass resurrection.
 */
export const RESURRECTION_TRIP_COUNT = 25;
/** How many recent commits to scan for deleted paths in the resurrection check. */
const RESURRECTION_LOG_DEPTH = 50;

interface SyncGuardState {
  safeMode: boolean;
  safeModeReason: string | null;
  safeModeSince: string | null;
  consecutiveNetworkFailures: number;
  /**
   * A pull that stopped part way and could not be finished or undone is held
   * (git-sync-apply-recovery.ts): its files stay out of auto-commits until a pull
   * settles them. The server shows it as a standing card while this is set.
   */
  heldPull: { since: string; paths: number; ids: string[] } | null;
}

const guard: SyncGuardState = {
  safeMode: false,
  safeModeReason: null,
  safeModeSince: null,
  consecutiveNetworkFailures: 0,
  heldPull: null,
};

/** The held pulls' paths that auto-commits leave out, and which held journals they come from. */
let pullHoldBack: { ids: string[]; paths: string[] } = { ids: [], paths: [] };

/** Re-log the ongoing safe-mode refusal at most this often (first hit is always loud). */
const SAFE_MODE_RELOG_MS = 10 * 60_000;
let lastSafeModeRefusalLog = 0;

/** Read-only view of the guard, for status endpoints and tests. */
export function getSyncGuardState(): Readonly<SyncGuardState> {
  return { ...guard };
}

/**
 * Human-visible escape hatch: stand down from pull-only safe mode. Called
 * automatically when the anomaly disappears (dirty set shrinks/clears), or
 * manually after a human has repaired the worktree.
 */
export function clearSyncSafeMode(reason = 'manual'): void {
  if (!guard.safeMode) return;
  log.git.warn('git-sync leaving pull-only safe mode — auto-commits resume', {
    reason,
    enteredFor: guard.safeModeReason,
    since: guard.safeModeSince,
  });
  guard.safeMode = false;
  guard.safeModeReason = null;
  guard.safeModeSince = null;
}

function enterSafeMode(reason: string, detail: Record<string, unknown>): void {
  const firstEntry = !guard.safeMode;
  if (firstEntry) {
    guard.safeMode = true;
    guard.safeModeReason = reason;
    guard.safeModeSince = new Date().toISOString();
  }
  // Loud on purpose — this is a refused data-destroying commit, not a hiccup.
  log.git.error(
    'git-sync entered PULL-ONLY SAFE MODE — refusing to auto-commit a suspicious mass change. '
    + 'Local files are untouched but will NOT be committed until the anomaly clears '
    + '(dirty set shrinks below threshold) or a human clears safe mode.',
    { reason, firstEntry, since: guard.safeModeSince, ...detail },
  );
}

// ── Disk-watermark pull-only latch ───────────────────────────────────────────
// Set by src/core/disk-watermark.ts when the data-dir filesystem crosses the
// critical watermark (90%). Distinct from the mass-revert safe mode above: that
// one protects against committing a BAD tree and auto-clears when the anomaly
// does; this one protects a nearly-full DISK — a commit writes objects and a
// push writes pack files locally, so both would race the filesystem to 0% and
// die mid-lock with ENOSPC (the 2026-08-12 cloud outage). Pulls stay allowed:
// receiving upstream deletions/compactions is how the box gets smaller.
let diskPullOnly = false;

/** Flip the disk latch (idempotent — repeated same-value calls are silent). */
export function setDiskPullOnly(v: boolean, detail?: Record<string, unknown>): void {
  if (diskPullOnly === v) return;
  diskPullOnly = v;
  if (v) {
    // warn, not error: the disk watermark's own card ('Data Disk Critically
    // Full', keyed 'disk') already says writes and sync are paused and retires
    // when space is freed. An error here minted a second, keyless card for the
    // same condition that never retired.
    log.git.warn(
      'git-sync entering DISK pull-only mode — data disk critically full. '
      + 'Auto-commits and pushes are paused until space is freed; pulls continue.',
      detail ?? {},
    );
  } else {
    log.git.warn('git-sync leaving disk pull-only mode — commits and pushes resume', detail ?? {});
  }
}

export function isDiskPullOnly(): boolean {
  return diskPullOnly;
}

/** Record a fetch/pull network failure; returns the current streak. */
export function noteNetworkFailure(): number {
  return ++guard.consecutiveNetworkFailures;
}

/**
 * Lines about the failure STREAK itself (its fetch timeout widened, the pull now
 * runs before the commit) are news once per streak, then debug. Each tick of an
 * outage used to repeat them at warn: 2026-11-19 the Mac could not resolve the
 * hub for six hours and each of them wrote ~110 warns an hour, raising the
 * health monitor's log-spike alarm. The failed attempt's own line keeps saying
 * why and the streak length; the logger folds its repeats (outage-repeat.ts).
 */
const streakTold = new Set<string>();

/** Whether `kind` is news in the current failure streak (true once, until the streak ends). */
export function streakNews(kind: string): boolean {
  if (streakTold.has(kind)) return false;
  streakTold.add(kind);
  return true;
}

/** Record a successful fetch/pull — resets the failure streak. */
export function noteNetworkSuccess(): void {
  guard.consecutiveNetworkFailures = 0;
  streakTold.clear();
}

// ── Bundle-push fallback (T65) ───────────────────────────────────────────────
// Endpoint-security TLS filters on some machines corrupt long sustained
// uploads: a push whose pack exceeds a few dozen MB dies mid-stream with
// "SSL bad record mac" — reproducibly (2026-08-22 controlled experiment; the
// hub accepted the same 250MB pack pushed locally in 20s). One-off failures
// are ordinary network weather; a STREAK of them while local commits pile up
// is the filter signature, so after PUSH_FAILURES_FOR_BUNDLE consecutive
// failures the delta is delivered through the chunked bundle channel
// (git-bundle-client.ts — small requests, one fresh connection each).

export const PUSH_FAILURES_FOR_BUNDLE = 3;
let pushFailureStreak = 0;

/**
 * Whether HEAD contains the tracking ref `origin/<branch>` — i.e. a push would
 * be a fast-forward. False when the branches diverged (or the ref is unknown):
 * then a push rejection is git protecting the hub's commit, not a dead link.
 * Local only: no network, one `merge-base` on refs we already have.
 */
async function localContainsRemoteTip(branch: string): Promise<boolean> {
  const remoteTip = await gitSafeAsync(`rev-parse --verify --quiet origin/${branch}`);
  if (!remoteTip) return true; // no tracking ref yet: nothing to diverge from
  const r = await gitSafeAsync(`merge-base --is-ancestor ${remoteTip.trim()} HEAD`);
  return r !== null;
}
/** Test seam for the fast-forward check above. */
export const localContainsRemoteTipForTest = localContainsRemoteTip;

async function tryBundlePushFallback(branch: string): Promise<boolean> {
  const remoteUrl = await gitSafeAsync('remote get-url origin');
  if (!remoteUrl) return false;
  // The bundle channel ends in a compare-and-swap on the hub's ref: it swaps
  // whatever the hub has for HEAD, so it must only ever carry a fast-forward.
  // (The hub refuses a non-fast-forward swap too since 2026-10-02; this check
  // keeps an older hub safe and spares the upload.)
  if (!(await localContainsRemoteTip(branch))) {
    log.git.warn('bundle push fallback refused — local branch diverged from origin (a swap would drop the hub\'s commits)', { branch });
    return false;
  }
  const remoteTip = await gitSafeAsync(`rev-parse origin/${branch}`);
  try {
    const { pushViaBundle, NOT_A_BUNDLE_HUB } = await import('./git-bundle-client.js');
    const result = await pushViaBundle({
      branch,
      remoteUrl,
      // CAS against the tip we believe; basis makes the bundle incremental
      // (only the un-pushed commits travel, not the whole history).
      oldValue: remoteTip ?? '',
      basis: remoteTip ?? undefined,
    });
    if (result.ok) {
      log.git.warn('sync push delivered via bundle channel after repeated push failures', {
        branch, bytes: result.bytes, chunks: result.chunks, streak: pushFailureStreak,
      });
      // Remote moved under us (from git's viewpoint) — refresh the tracking ref.
      await gitSafeAsync(`fetch origin ${branch}`, { timeout: FETCH_TIMEOUT });
      return true;
    }
    // An origin the channel cannot serve (a plain git or ssh remote) is not a failure
    // of the fallback: it never applies there, and warning it on every failed push
    // turned one outage into a warn per tick.
    log.git[result.error === NOT_A_BUNDLE_HUB ? 'debug' : 'warn']('bundle push fallback failed', { branch, error: result.error });
    return false;
  } catch (err) {
    log.git.warn('bundle push fallback threw', { error: err instanceof Error ? err.message : String(err) });
    return false;
  }
}

/** Test hook: reset all guard state between tests. */
export function resetSyncGuardForTest(): void {
  diskPullOnly = false;
  guard.safeMode = false;
  guard.safeModeReason = null;
  guard.safeModeSince = null;
  guard.consecutiveNetworkFailures = 0;
  guard.heldPull = null;
  pullHoldBack = { ids: [], paths: [] };
  streakTold.clear();
  clearStalledPulls();
  pushFailureStreak = 0;
  lastSafeModeRefusalLog = 0;
  lastSurgeryWarnLog = 0;
  // The tracked-file count is per-repo and cached for 10 minutes; tests rebuild
  // the fixture repo between cases, so a carried-over count would size the
  // breaker against the previous repo.
  resetTrackedCountCacheForTest();
  // Same reason for the precondition probes: a case that ran against a repo with
  // a remote must not leave "has a remote" cached for the next fixture.
  resetSyncProbeCacheForTest();
}

/**
 * True while the data repo is mid-surgery: a rebase, an am-session, or an
 * unfinished merge. In every one of those states the worktree is a TRANSIENT
 * intermediate — a partially replayed tree, or a merge with unresolved paths —
 * and `add -A` + commit snapshots it as real user intent. That is the
 * 2026-08-04 incident: the data repo's 30s auto-save fired while a rebase was
 * in progress and committed the mid-replay tree, resurrecting 2233 files.
 *
 * Cheap on purpose (three fs.existsSync calls, no git subprocess) because the
 * sync tick calls it twice every 30s.
 */
export function isGitSurgeryInProgress(repoDir = WALNUT_HOME): boolean {
  const gitDir = path.join(repoDir, '.git');
  return (
    fs.existsSync(path.join(gitDir, 'rebase-merge'))     // interactive/merge rebase
    || fs.existsSync(path.join(gitDir, 'rebase-apply'))  // `rebase --apply` / `git am`
    || fs.existsSync(path.join(gitDir, 'MERGE_HEAD'))    // merge with unresolved paths
  );
}

/**
 * Surgery state older than this is ORPHANED: no live process owns it. The only
 * rebase creator on the data repo is the legacy pull's `rebase` (legacyWorktreePull,
 * PULL_TIMEOUT=60s; the object-store pull writes no surgery state at all), so 30
 * minutes is 30× past any legitimate lifetime; a human mid-rebase keeps
 * the dir's mtime fresh by advancing through picks.
 */
export const ORPHAN_SURGERY_MIN_AGE_MS = 30 * 60_000;

export interface OrphanRecoveryResult {
  recovered: boolean;
  kind?: 'rebase' | 'merge' | 'marker';
  rescueBranch?: string;
  mergedBack?: boolean;
  error?: string;
}

/**
 * Recover from an ORPHANED rebase/merge in the data repo — the 2026-08-22
 * incident: a server restart mid-`pull --rebase` left `.git/rebase-merge`
 * behind, the surgery guard then (correctly) froze every auto-commit, and
 * nothing ever cleaned the state up: sync stayed frozen for 22 hours across
 * FIVE server restarts while local commits piled 365 deep.
 *
 * The guard must stay conservative (a LIVE rebase is untouchable), so this
 * runs only when the surgery state is provably orphaned: stale mtime, and by
 * construction at startup no previous in-process git can still own it.
 *
 * Rebase recovery preserves BOTH sides:
 *   1. snapshot the live worktree as a commit on the detached HEAD
 *      (server writes since the freeze — the newest data on the machine),
 *      parked on a rescue branch;
 *   2. `checkout -f <branch>` back to the pre-rebase tip (all local commits);
 *   3. `rebase --quit` to drop the dead state;
 *   4. merge the rescue branch back with `-X theirs` (live disk wins), and
 *      resolve any modify/delete leftovers the same way. If the merge cannot
 *      complete it is aborted — main is unfrozen either way and the rescue
 *      branch keeps the data recoverable.
 *
 * An orphaned MERGE (MERGE_HEAD, no owner) is simply aborted: the legacy pull
 * always commits or aborts within its own tick, so a leftover merge is half-applied state whose
 * remote side is still safe in origin/<branch> — the next pull redoes it.
 */
export async function recoverOrphanedGitSurgery(
  repoDir = WALNUT_HOME,
  minAgeMs = ORPHAN_SURGERY_MIN_AGE_MS,
): Promise<OrphanRecoveryResult> {
  const gitDir = path.join(repoDir, '.git');
  const opts = { cwd: repoDir };
  const stale = (p: string): boolean => {
    try { return Date.now() - fs.statSync(p).mtimeMs > minAgeMs; } catch { return false; }
  };

  for (const dirName of ['rebase-merge', 'rebase-apply']) {
    const stateDir = path.join(gitDir, dirName);
    if (!fs.existsSync(stateDir)) continue;
    if (!stale(stateDir)) return { recovered: false };

    const headNamePath = path.join(stateDir, 'head-name');
    if (!fs.existsSync(headNamePath)) {
      // No head-name = not a real rebase (e.g. a leftover pause marker) — debris.
      try { fs.rmSync(stateDir, { recursive: true, force: true }); } catch { /* best-effort */ }
      log.git.warn('git-sync removed an orphaned surgery marker dir', { dir: stateDir });
      return { recovered: true, kind: 'marker' };
    }

    const branch = fs.readFileSync(headNamePath, 'utf-8').trim().replace(/^refs\/heads\//, '');
    const rescueBranch = `rescue-orphaned-rebase-${new Date().toISOString().slice(0, 10)}`;
    log.git.warn('git-sync recovering from an ORPHANED rebase — sync has been frozen since it died', {
      dir: stateDir, branch, rescueBranch,
    });

    // 0. A dead rebase leaves CONFLICTED files on disk — full of markers. The
    //    snapshot below is an unconditional `add -A`, so without this the marker
    //    text becomes a commit and then rides the merge-back into the live file
    //    (2026-08-22: ui-prefs.json + a conversation file, both unreadable).
    const preSnapshot = (await porcelainStatus(repoDir)) ?? '';
    await healConflictMarkeredJsonFromStatus(
      preSnapshot.split('\n').filter((l) => l.trim().length > 0),
      'orphan-rebase-recovery:pre-snapshot',
      repoDir,
    );

    // 1. Snapshot the live worktree on the detached HEAD (newest data on disk).
    //    Deliberately a WHOLE-tree `add -A`, with no never-author exclusion
    //    (stageAllForCommit): step 2's `checkout -f` overwrites the worktree, so
    //    anything left out of this snapshot is destroyed rather than merely
    //    unpublished. A replica reverting a letter here is recoverable — the
    //    stores' `lastUpdated` content clock makes the primary's newer copy win
    //    the merge — while data this step drops is not.
    // plugin-files/ gets the tick's guard around the add: a nested repo without a commit
    // would make this add fail (and step 2 then overwrite what it did not snapshot).
    await prepareSyncedPluginFiles(repoDir);
    // Whole tree, so no large-file lane here: a timeout scaled to every pending byte
    // instead, and a snapshot that still fails stops the recovery BEFORE step 2's
    // `checkout -f` could overwrite what it did not take (git-sync-large-files.ts).
    if (await gitSafeAsync('add -A', { ...opts, timeout: await wholeTreeAddTimeout(repoDir) }) === null) {
      return { recovered: false, kind: 'rebase', rescueBranch, error: 'the live worktree could not be staged for the rescue snapshot' };
    }
    if (!CLOUD_MODE) await keepUnfitPluginFilesOut({ cwd: repoDir }).catch(() => undefined);
    await gitSafeAsync('commit -q -m "rescue: live worktree at orphaned-rebase recovery"', opts);
    const rescueTip = await gitSafeAsync('rev-parse HEAD', opts);
    if (rescueTip) await gitSafeAsync(`branch -f ${rescueBranch} ${rescueTip}`, opts);

    // 2. Back to the pre-rebase branch tip (keeps every un-replayed local commit).
    if (await gitSafeAsync(`checkout -f ${branch}`, { ...opts, timeout: PULL_TIMEOUT }) === null) {
      return { recovered: false, kind: 'rebase', rescueBranch, error: `checkout -f ${branch} failed` };
    }
    // Tip BEFORE the merge-back, so step 5 can ask what the rescue changed.
    const preMergeTip = await gitSafeAsync('rev-parse HEAD', opts);
    // 3. Drop the dead rebase state (quit keeps refs; fall back to rm).
    if (await gitSafeAsync('rebase --quit', opts) === null) {
      try { fs.rmSync(stateDir, { recursive: true, force: true }); } catch { /* best-effort */ }
    }

    // 4. Merge the live snapshot back — live disk wins content conflicts.
    let mergedBack = false;
    if (rescueTip) {
      const merge = await gitSafeAsync(`merge --no-edit -X theirs ${rescueBranch}`, { ...opts, timeout: PULL_TIMEOUT });
      if (merge !== null) {
        mergedBack = true;
      } else {
        // -X theirs does not cover modify/delete — resolve leftovers toward the
        // rescue side (it IS the live disk), then commit; abort if truly stuck.
        const unmerged = (await gitSafeAsync('diff --name-only --diff-filter=U', opts)) ?? '';
        let resolvedAll = unmerged.length > 0;
        for (const file of unmerged.split('\n').filter(Boolean)) {
          const take = await gitSafeAsync(`checkout ${rescueBranch} -- "${file}"`, opts);
          if (take === null && await gitSafeAsync(`rm -q -- "${file}"`, opts) === null) resolvedAll = false;
          else if (take !== null) await gitSafeAsync(`add -- "${file}"`, { ...opts, timeout: await fileAddTimeout(repoDir, file) });
        }
        if (resolvedAll
          && await gitSafeAsync('commit -q --no-edit -m "rescue: merge orphaned-rebase live snapshot"', opts) !== null) {
          mergedBack = true;
        } else {
          await gitSafeAsync('merge --abort', opts);
          log.git.error('git-sync orphaned-rebase recovery could not merge the live snapshot — kept on the rescue branch', {
            rescueBranch,
          });
        }
      }
    }
    // 5. Post-resolution sweep. The merge above resolves content automatically
    //    (-X theirs / checkout from the rescue branch), so it cannot introduce
    //    NEW markers — but marker text already committed on the rescue branch
    //    (e.g. a previous half-finished recovery, or a file whose repair failed
    //    in step 0) lands in the live tree here. Ask git what the rescue changed
    //    rather than reading `status`: after a successful merge commit the
    //    worktree is CLEAN, which is exactly how the bad content stayed invisible.
    if (mergedBack && preMergeTip) {
      const changed = (await gitSafeAsync(`diff --name-only ${preMergeTip} HEAD`, opts)) ?? '';
      const healed = await healConflictMarkeredJsonFiles(
        changed.split('\n').map((f) => f.trim()).filter((f) => f.endsWith('.json')),
        'orphan-rebase-recovery:post-merge',
        repoDir,
      );
      if (healed.restored.length > 0 || healed.quarantined.length > 0) {
        await gitSafeAsync('add -A', { ...opts, timeout: await wholeTreeAddTimeout(repoDir) });
        await gitSafeAsync('commit -q -m "rescue: restore JSON files that carried conflict markers"', opts);
      }
    }

    log.git.warn('git-sync orphaned-rebase recovery complete — sync unfrozen', {
      branch, rescueBranch, mergedBack,
    });
    return { recovered: true, kind: 'rebase', rescueBranch, mergedBack };
  }

  const mergeHead = path.join(gitDir, 'MERGE_HEAD');
  if (fs.existsSync(mergeHead) && stale(mergeHead)) {
    await gitSafeAsync('merge --abort', opts);
    if (fs.existsSync(mergeHead)) {
      try { fs.unlinkSync(mergeHead); } catch { /* best-effort */ }
    }
    log.git.warn('git-sync aborted an ORPHANED merge — remote side is safe in origin, next pull redoes it');
    return { recovered: true, kind: 'merge' };
  }

  return { recovered: false };
}

/** Re-log the ongoing surgery refusal at most this often (first hit is always loud). */
const SURGERY_RELOG_MS = 10 * 60_000;
let lastSurgeryWarnLog = 0;

/**
 * Log the surgery skip, throttled like the safe-mode re-log — a human rebase can
 * take minutes and the tick fires twice per 30s.
 */
function logSurgerySkip(context: string): void {
  const now = Date.now();
  if (now - lastSurgeryWarnLog < SURGERY_RELOG_MS) return;
  lastSurgeryWarnLog = now;
  log.git.warn(
    'git-sync skipping auto-commit — a git rebase/merge/am is IN PROGRESS in the data repo. '
    + 'Committing a mid-surgery worktree is the 2026-08-04 mass-resurrection incident. '
    + 'Pulls continue; commits resume once the surgery finishes or is aborted.',
    { context, repo: WALNUT_HOME },
  );
}

/** Strip the porcelain XY prefix; keep git's C-style quoting as-is (it is
 * consistent with `log --name-only` output, so set-matching still works). */
function porcelainPath(line: string): string {
  return line.slice(3).trim();
}

/**
 * Resurrection heuristic: untracked dirty paths that upstream's recent history
 * deleted (or renamed away — `--no-renames` splits renames into D+A). A stale
 * worktree snapshotted after upstream reorganized shows up as exactly this:
 * hundreds of "new" files at paths the fresh HEAD recently deleted. A LEGIT
 * local reorg looks different — its untracked paths are brand new, not
 * recently-deleted ones. Cost: one `git log` over the last 50 commits.
 */
async function countResurrections(
  dirtyLines: string[],
): Promise<{ resurrected: number; untracked: number; sample: string[] }> {
  const untracked = dirtyLines.filter((l) => l.startsWith('??')).map(porcelainPath);
  if (untracked.length === 0) return { resurrected: 0, untracked: 0, sample: [] };
  const deletedLog = await gitSafeAsync(
    `log -${RESURRECTION_LOG_DEPTH} --no-renames --diff-filter=D --name-only --format=`,
  );
  if (!deletedLog) return { resurrected: 0, untracked: untracked.length, sample: [] };
  const deleted = new Set(deletedLog.split('\n').map((s) => s.trim()).filter(Boolean));
  const hits = untracked.filter((p) => deleted.has(p));
  return { resurrected: hits.length, untracked: untracked.length, sample: hits.slice(0, 10) };
}

/**
 * Decide whether a dirty snapshot is safe to `add -A` + commit. Cheap by
 * design: counts + one recent-history scan, never content diffs.
 *
 * Two independent trip conditions:
 *
 *  1. MASS: dirty count ≥ effectiveMassDirtyThreshold() AND at least one revert
 *     signal — a fetch/pull failure streak (worktree presumed stale) or a mass
 *     resurrection of recently-deleted upstream paths. A huge dirty set with NO
 *     revert signal (e.g. a legitimate bulk import) is allowed with a loud warn.
 *  2. RESURRECTION ALONE: ≥ RESURRECTION_TRIP_COUNT untracked files sitting at
 *     paths upstream recently deleted, EVEN BELOW the mass threshold. Nothing
 *     legitimate re-creates 25 just-deleted paths; tying this signal to the mass
 *     count meant a partial revert (say 80 resurrected files on a small repo)
 *     sailed straight through.
 *
 * Cost bound: countResurrections (one `git log` over 50 commits) runs only when
 * the dirty set is already at least RESURRECTION_TRIP_COUNT lines.
 */
export async function assessCommitSafety(
  dirtyLines: string[],
): Promise<{ ok: boolean; reason?: string }> {
  const massThreshold = await effectiveMassDirtyThreshold();
  const isMass = dirtyLines.length >= massThreshold;
  // Below the resurrection floor nothing can trip — skip the `git log` entirely.
  const worthChecking = dirtyLines.length >= RESURRECTION_TRIP_COUNT;

  if (guard.safeMode) {
    // Stay latched while EITHER anomaly is still visible. The mass count alone
    // used to gate this, so a resurrection-triggered latch (which can sit well
    // below the mass threshold) would have been released on the very next tick
    // and committed the thing it just refused.
    const stillResurrecting = !isMass && worthChecking
      && (await countResurrections(dirtyLines)).resurrected >= RESURRECTION_TRIP_COUNT;
    if (!isMass && !stillResurrecting) {
      // Anomaly gone (human repaired the tree, or the mass change vanished).
      clearSyncSafeMode('dirty set shrank below threshold');
      return { ok: true };
    }
    // The tick runs every 30s and calls this from both commitIfDirty and
    // syncInner — throttle the repeat noise; entry + periodic re-log stay loud.
    const now = Date.now();
    if (now - lastSafeModeRefusalLog >= SAFE_MODE_RELOG_MS) {
      lastSafeModeRefusalLog = now;
      log.git.error(
        'git-sync SAFE MODE active — auto-commit refused (pull-only). '
        + 'Repair the worktree or clear safe mode to resume commits.',
        { reason: guard.safeModeReason, since: guard.safeModeSince, dirtyCount: dirtyLines.length },
      );
    }
    return { ok: false, reason: guard.safeModeReason ?? 'safe-mode' };
  }

  if (!worthChecking) return { ok: true };

  const streak = guard.consecutiveNetworkFailures;
  const res = await countResurrections(dirtyLines);
  const massResurrection = res.resurrected >= RESURRECTION_TRIP_COUNT;
  const staleAfterOutage = isMass && streak >= FAILURE_STREAK_FOR_PULL_FIRST;
  if (staleAfterOutage || massResurrection) {
    enterSafeMode('mass-revert-suspect', {
      dirtyCount: dirtyLines.length,
      massThreshold,
      consecutiveNetworkFailures: streak,
      resurrectedCount: res.resurrected,
      untrackedCount: res.untracked,
      resurrectedSample: res.sample,
      dirtySample: dirtyLines.slice(0, 10),
      trigger: massResurrection ? 'resurrection' : 'stale-after-outage',
    });
    return { ok: false, reason: 'mass-revert-suspect' };
  }

  if (isMass) {
    log.git.warn('git-sync committing an unusually large dirty set (no revert signals — allowing)', {
      dirtyCount: dirtyLines.length,
      massThreshold,
      dirtySample: dirtyLines.slice(0, 10),
    });
  }
  return { ok: true };
}

/**
 * Torn-worktree sentinel: right after a pull/merge/reset applied cleanly, the
 * worktree should be near-clean (syncInner commits everything first; only
 * files the app wrote DURING the pull may be dirty). A massive disagreement
 * means the checkout half of the pull died (e.g. killed on timeout) while the
 * ref half landed — the exact torn state that produced the 2026-08-03 mass
 * revert. Enter pull-only safe mode so no `add -A` can snapshot it.
 */
export async function verifyWorktreeAfterPull(context: string): Promise<boolean> {
  const status = await porcelainStatus();
  const lines = (status ?? '').split('\n').filter((l) => l.trim().length > 0);
  const massThreshold = await effectiveMassDirtyThreshold();
  if (lines.length < massThreshold) return true;
  enterSafeMode('torn-worktree', {
    context,
    dirtyCount: lines.length,
    massThreshold,
    dirtySample: lines.slice(0, 10),
  });
  return false;
}

// ── Conflict-marker guard (2026-08-22 incident) ─────────────────────────────
// A rescue/merge path left git conflict markers INSIDE two data-repo JSON files
// (`config/share/ui-prefs.json` carried nested `<<<<<<< HEAD` / `|||||||` diff3
// markers), and the 30s auto-save then committed that marker text as the file's
// real content. Every later read threw `Failed to parse …`: hours of 500s on
// /api/ui-prefs plus six crashes of a bus subscriber. Marker text is never data,
// so it must never be committed as the live file.
//
// The guard is a SCAN, not a parse of the whole repo: only paths git already
// reports as changed, only .json, and a bounded prefix read per file. Git
// subprocesses run ONLY for a file that actually looks conflicted, which is
// approximately never.

/**
 * Upper bound on files scanned per pass. A dirty set larger than this is
 * already the mass-revert breaker's problem, and the point of the cap is that a
 * 30s tick can never turn into thousands of file reads.
 */
export const MAX_MARKER_SCAN_FILES = 300;

export interface MarkerGuardResult {
  scanned: number;
  restored: string[];
  quarantined: string[];
}

/**
 * Restore (or quarantine) any of `relPaths` whose JSON carries conflict markers.
 *
 * Resolution = the last version of that path in git history that parses, tried
 * newest-first (HEAD, then up to 8 commits back). If NOTHING in history parses,
 * the file is quarantined as `<name>.conflicted-<ts>` rather than committed: a
 * missing file reads as "first run" and falls back cleanly, while marker text
 * takes routes down. Either way the live file never carries markers forward.
 */
export async function healConflictMarkeredJsonFiles(
  relPaths: string[],
  context: string,
  repoDir = WALNUT_HOME,
): Promise<MarkerGuardResult> {
  const result: MarkerGuardResult = { scanned: 0, restored: [], quarantined: [] };
  const candidates = relPaths.slice(0, MAX_MARKER_SCAN_FILES);
  if (relPaths.length > MAX_MARKER_SCAN_FILES) {
    log.git.warn('git-sync conflict-marker scan capped — dirty JSON set larger than the per-pass bound', {
      context, candidates: relPaths.length, cap: MAX_MARKER_SCAN_FILES,
    });
  }

  for (const rel of candidates) {
    const filePath = path.join(repoDir, rel);
    const read = await readFileBounded(filePath);
    if (!read) continue; // deleted / unreadable / not a file
    result.scanned++;
    if (!scanForConflictMarkers(read.text, read.truncated).conflicted) continue;

    const heal = await healJsonFileFromHistory({
      repoDir,
      filePath,
      relPath: rel,
      label: 'conflicted',
      quarantineOnFailure: true,
    });
    if (heal.action === 'restored') {
      result.restored.push(rel);
      log.git.error('git-sync: conflict markers found in JSON — restored last valid version', {
        file: rel, restoredFrom: heal.restoredFrom, parkedAt: heal.movedTo, context, repo: repoDir,
      });
    } else if (heal.action === 'quarantined') {
      result.quarantined.push(rel);
      log.git.error(
        'git-sync: conflict markers found in JSON and NO version in history parses — quarantined the file instead of committing marker text',
        { file: rel, parkedAt: heal.movedTo, context, repo: repoDir },
      );
    } else {
      log.git.error('git-sync: conflict markers found in JSON but the file could not be repaired', {
        file: rel, action: heal.action, error: heal.error, context, repo: repoDir,
      });
    }
  }
  return result;
}

/** Porcelain-driven twin: the auto-save paths already hold a status snapshot. */
export async function healConflictMarkeredJsonFromStatus(
  dirtyLines: string[],
  context: string,
  repoDir = WALNUT_HOME,
): Promise<MarkerGuardResult> {
  return healConflictMarkeredJsonFiles(jsonCandidatesFromPorcelain(dirtyLines), context, repoDir);
}

/**
 * Single-flight latch for sync(). The 30s tick used to rely on setTimeout
 * self-rescheduling for serialization ("the next tick is armed only AFTER the
 * current one finishes"), but that guarantee died with the timeout leak above:
 * on timeout the tick RESOLVED and armed the next one while the orphaned git
 * tree kept packing in the background. Every 60s stacked another layer.
 *
 * The latch makes overlap impossible even if a caller ignores the tick: a
 * concurrent call joins the in-flight sync instead of starting a second one.
 */
let syncInflight: Promise<{ pulled: number; pushed: number; conflicts: number }> | null = null;

export async function sync(): Promise<{ pulled: number; pushed: number; conflicts: number }> {
  // Compaction pause must gate sync() too, not just commitIfDirty(): syncInner
  // runs its own `add -A` + commit, so an unpaused tick would still move `main`
  // mid-rewrite and fail the tree verification.
  if (isSyncPaused()) {
    log.git.debug('git-sync skipped — history compaction or operator pause in progress');
    return { pulled: 0, pushed: 0, conflicts: 0 };
  }
  if (syncInflight) {
    log.git.debug('git-sync already in flight — joining instead of stacking');
    return syncInflight;
  }
  syncInflight = syncInner().finally(() => { syncInflight = null; });
  return syncInflight;
}

async function syncInner(): Promise<{ pulled: number; pushed: number; conflicts: number }> {
  let pulled = 0;
  let pushed = 0;
  let conflicts = 0;

  // Surgery-in-progress: a rebase/merge/am is mid-flight in the data repo, so
  // this whole cycle stands down. Checked FIRST, before any git call — mid-rebase
  // HEAD is detached, so getBranch() below would report "HEAD" rather than a
  // branch. Committing the transient tree is the incident (see
  // isGitSurgeryInProgress); pulling would be safe in isolation, but the pull
  // path is NOT surgery-safe either: the legacy pull runs `rebase --abort`
  // whenever its rebase fails, which would destroy the human's in-flight
  // rebase (verified: abort succeeds against a conflicted rebase-merge), and the
  // object-store apply would move a branch the human is rebasing.
  if (isGitSurgeryInProgress()) {
    // Self-heal an ORPHANED rebase/merge (stale state no process owns) instead
    // of freezing forever: the 2026-08-22 incident froze sync for 22 hours
    // across five restarts because nothing ever recovered the dead rebase.
    // Age-gated inside (30 min) so a live rebase is never touched; on the tick
    // that recovers, we still stand down and let the NEXT tick sync normally.
    const recovery = await recoverOrphanedGitSurgery();
    if (!recovery.recovered) logSurgerySkip('sync');
    return { pulled: 0, pushed: 0, conflicts: 0 };
  }

  // A pull that stopped part way (the process died mid-apply) is undone before
  // anything reads the status or commits; until it can be, the tick stands down.
  const settled = await recoverInterruptedPull();
  if (!settled.pull) return { pulled: 0, pushed: 0, conflicts: 0 };

  // Cached/async on purpose: this runs on the ~30s tick, and the sync twins are
  // execSync — two blocking spawns per tick before any real work started.
  const remote = await hasRemoteAsync();
  const branch = remote ? await getBranchAsync() : 'main';

  // Never let a machine-local file stay tracked: any pull below could apply a
  // remote deletion of it straight to disk. Runs unconditionally every cycle
  // (the dangerous state can appear at runtime); its `rm --cached` staging is
  // picked up by the dirty check and committed like the old flow did.
  await ensureMachineLocalUntrackedAsync();

  // -uall: an entirely-untracked directory otherwise collapses to one `?? dir/`
  // line, hiding a mass resurrection from both the threshold and the heuristic.
  const preStatus = await porcelainStatus();
  const preLines = (preStatus ?? '').split('\n').filter((l) => l.trim().length > 0);

  // ── Order inversion after an outage ──
  // Normally we commit BEFORE pulling so no local edit is ever unrecorded.
  // But after a fetch/pull failure streak the worktree is presumed STALE
  // (frozen on an old tree while upstream moved) — exactly the state where
  // `add -A` snapshots a mass revert (2026-08-03 incident). One-shot: refresh
  // the worktree from upstream FIRST, then let the commit see honest dirt.
  // Only when no TRACKED file is modified: git refuses to rebase/merge over
  // tracked changes anyway, and a frozen-then-recovered worktree is clean.
  const trackedDirty = preLines.filter((l) => !l.startsWith('??'));
  const pullFirst = remote
    && guard.consecutiveNetworkFailures >= FAILURE_STREAK_FOR_PULL_FIRST
    && trackedDirty.length === 0;
  if (pullFirst) {
    log.git[streakNews('pull-first') ? 'warn' : 'debug'](
      'git-sync recovering from a fetch/pull failure streak — pulling BEFORE commit this cycle so a stale worktree cannot be snapshotted',
      { consecutiveNetworkFailures: guard.consecutiveNetworkFailures, branch },
    );
    const first = await pullFromRemote(branch);
    pulled = first.pulled;
    conflicts += first.conflicts;
  }

  // ── Commit local changes (guarded) ──
  // Re-read after a possible pull; the pull may have absorbed or changed dirt.
  const status = pullFirst ? await porcelainStatus() : preStatus;
  const dirtyLines = pullFirst
    ? (status ?? '').split('\n').filter((l) => l.trim().length > 0)
    : preLines;
  if (dirtyLines.length === 0 && guard.safeMode) {
    // Tree is clean again (e.g. a human reset it) — the anomaly is gone.
    clearSyncSafeMode('worktree clean');
  }
  // Second layer, not redundant: the pull-first branch above can run for up to
  // PULL_TIMEOUT (60s), and a human can start a rebase inside that window. Three
  // existsSync calls are free relative to the failure they prevent. Bail on the
  // rest of the cycle (commit AND pull) for the reasons at the top of syncInner.
  if (isGitSurgeryInProgress()) {
    logSurgerySkip('syncInner:commit');
    return { pulled, pushed: 0, conflicts };
  }
  if (dirtyLines.length > 0 && !diskPullOnly && settled.commit) {
    const safety = await assessCommitSafety(dirtyLines);
    if (safety.ok) {
      // Never let marker text become the committed content of a JSON store
      // (2026-08-22). Runs on the dirty snapshot we already have, before add.
      await healConflictMarkeredJsonFromStatus(dirtyLines, 'syncInner:commit');

      // stageAllForCommit refuses (null) when a pull started (gitPullWalnut) or stopped since the check above.
      const stage = await stageAllForCommit();
      if (!stage) {
        log.git.info('git-sync: commit skipped, a pull is moving the tree or stopped part way');
      } else {
        // …and re-check: `add -A` itself can re-track a machine-local file the
        // instant before a pull could carry its remote deletion to disk.
        await ensureMachineLocalUntrackedAsync();

        // Count from what is ACTUALLY staged at commit time. The old code
        // counted a pre-add snapshot elsewhere, which is how the 2026-08-03
        // 2233-rename mass revert got committed as "(1 files)".
        const staged = await gitSafeAsync('diff --cached --name-only');
        const stagedCount = (staged ?? '').split('\n').filter((l) => l.trim().length > 0).length;
        const stamp = () => new Date().toISOString().replace(/[:.]/g, '-');
        if (stagedCount > 0) {
          await gitSafeAsync(`commit -m "open-walnut sync ${stamp()} (${stagedCount} files)"`);
          pushed = 1;
        }
        // Large files after the routine commit (git-sync-large-files.ts).
        const large = await commitDeferredLargeFiles(stage.deferred, {
          cloudMode: stage.cloudMode,
          message: (count) => `open-walnut sync ${stamp()} (${count} large files)`,
        });
        if (large > 0) pushed = 1;
      }
    }
    // safety.ok === false → pull-only safe mode: skip commit, still pull below
    // so the box keeps receiving upstream (assessCommitSafety already logged).
  }

  // ── Pull + push ──
  if (remote) {
    if (!pullFirst) {
      const result = await pullFromRemote(branch);
      pulled = result.pulled;
      conflicts += result.conflicts;
    }

    // Push (skipped in safe mode: nothing new was committed, and a torn/stale
    // box must not publish anything until a human or a clean cycle clears it.
    // Also skipped in disk pull-only mode: a push packs objects LOCALLY first,
    // which is exactly the write pressure the disk latch exists to stop).
    // The outward door: a machine without the write permission still pulls, and publishes nothing.
    if (!guard.safeMode && !diskPullOnly && accountDoorsGuarded() && outwardDoorRefusal('git-push', branch)) {
      log.git.debug('git-sync push skipped: this machine does not hold the write permission');
    } else if (!guard.safeMode && !diskPullOnly) {
      const pushResult = await gitSafeAsync(`push origin ${branch}`, { timeout: NETWORK_TIMEOUT });
      if (pushResult === null) {
        pushed = 0; // push failed
        // A push the hub REJECTED because the branches diverged (the pull above
        // deferred or failed, so origin holds a commit HEAD does not) is not a
        // transport failure: it must not feed the streak below, because the
        // bundle channel's ref update would then replace the hub's commit with
        // ours (2026-10-01: three times, each dropping one cloud auto-save and
        // triggering a reset on the other box). The next tick's pull merges
        // and the push goes through.
        if (!(await localContainsRemoteTip(branch))) {
          log.git.warn('git-sync: push rejected — local branch diverged from origin; waiting for the next pull', { branch });
        } else {
          // Endpoint-security TLS filters kill large sustained pushes mid-stream
          // (T65) — a push that keeps failing while commits pile up locally is
          // that signature, and retrying it every 30s just re-packs the same
          // doomed pack. After a few consecutive failures, deliver the delta
          // through the chunked bundle channel instead (small requests, one
          // connection each — the filters never see a long stream).
          pushFailureStreak++;
          if (pushFailureStreak >= PUSH_FAILURES_FOR_BUNDLE) {
            const delivered = await tryBundlePushFallback(branch);
            if (delivered) {
              pushed = 1;
              pushFailureStreak = 0;
            }
          }
        }
      } else {
        pushFailureStreak = 0;
      }
    }
  }

  return { pulled, pushed, conflicts };
}

// ── Pull: the remote's commits into the live working tree ───────────────────
// The live server reads and writes the JSON stores in this working tree while a
// pull runs, so a pull never lets git check anything out over it. Every case is
// computed in git's object store (a fast-forward needs nothing, a rewrite is
// carried by git-sync-rewrite-carry.ts, a divergence is replayed or LWW-merged
// by git-sync-merge.ts) and ONE function moves the working tree to the result
// (git-sync-apply.ts: preflight, temp file + rename, a compare-and-swap of the
// branch). 2026-11-24: `git merge` in the live tree left conflict markers in
// host-exec-grants.json for seconds and three tasks' host_exec reads were
// refused; earlier the same morning ten timed-out merges each fell back to
// `pull -X theirs` and overwrote live stores with the hub's older content.

interface PullResult { pulled: number; conflicts: number }
const NOTHING_PULLED: PullResult = { pulled: 0, conflicts: 0 };

/**
 * Where origin stood before a fetch that found its history rewritten (a
 * compaction, a path scrub), kept until the adoption lands. The fetch moves the
 * remote-tracking ref at once, so without it an adoption deferred by a busy
 * store, or a fetch gitPullWalnut made, would leave the next tick unable to tell
 * a shared-ancestry rewrite from ordinary divergence: it would merge the old
 * chain back in and undo the rewrite.
 */
export const REWRITE_FROM_REF = 'refs/walnut/sync-rewrite-from';

let pullStepTimeoutMs = LOCAL_TIMEOUT;
/** Test hook: the budget of each git step of a pull's merge, replay and apply (null: the default). */
export function setPullStepTimeoutForTest(ms: number | null): void {
  pullStepTimeoutMs = ms ?? LOCAL_TIMEOUT;
}

function pullGit(): ApplyGit {
  return {
    run: (args, opts) => execGitArgsStatus(args, { cwd: WALNUT_HOME, ...opts, timeout: Math.max(pullStepTimeoutMs, opts?.timeout ?? 0) }),
    raw: (args, opts) => execGitArgsRaw(args, { cwd: WALNUT_HOME, ...opts, timeout: opts?.timeout ?? pullStepTimeoutMs }),
  };
}

/**
 * The tick's fetch budget: a whole pull's while the link is healthy (the fetch
 * used to ride inside `pull --rebase` under PULL_TIMEOUT), then the failure
 * streak's ladder (fetchTimeoutForStreak), so a doomed transfer is not retried
 * under the long budget every tick.
 */
export function syncFetchTimeout(streak: number): number {
  return streak === 0 ? PULL_TIMEOUT : fetchTimeoutForStreak(streak);
}

/** A fetch that force-moved origin (not a fast-forward) records where it stood before. */
async function noteRewriteAcrossFetch(branch: string, before: string | null): Promise<void> {
  if (!before) return;
  const after = await gitSafeAsync(`rev-parse --verify -q origin/${branch}`);
  if (!after || after === before) return;
  if (await gitSafeAsync(`merge-base --is-ancestor ${before} ${after}`) !== null) return;
  // Keep the oldest: a second rewrite before the first is adopted is still one adoption.
  if (await gitSafeAsync(`rev-parse --verify -q ${REWRITE_FROM_REF}`)) return;
  await gitSafeAsync(`update-ref ${REWRITE_FROM_REF} ${before}`);
}

/**
 * The tick's pull: fetch with every guard the fetch grew, then integrate. Success
 * and failure feed the outage-streak tracker, and a pull that moved HEAD is
 * checked against a torn worktree.
 */
async function pullFromRemote(branch: string): Promise<PullResult> {
  // gitPullWalnut stands aside while a sync runs; a sync that starts during its pull waits for it.
  if (pullInflight) await pullInflight.catch(() => undefined);
  if (branch === 'HEAD') return NOTHING_PULLED; // detached: no branch of ours to move
  // Sweep dead transfer corpses on EVERY pull, not only after a failed fetch:
  // the failure-path sweep cannot see corpses younger than the age gate, and a
  // fetch that succeeded never swept at all (2026-10-05: one rewrite adoption
  // left 19 corpses / 7.5GB on the cloud box). Age-gated, so a transfer in
  // flight anywhere is never touched.
  sweepDeadFetchPacks(WALNUT_HOME);
  const before = await gitSafeAsync(`rev-parse --verify -q origin/${branch}`);
  if (!(await fetchOriginForSync(branch))) return NOTHING_PULLED;
  await noteRewriteAcrossFetch(branch, before);
  const result = await integrateRemoteSafely(branch, { before, merge: true });
  if (result.pulled === 1) clearStalledPulls();
  // Torn-worktree sentinel: the apply never moves the branch over a half-written
  // tree, but this is the guard every pull path keeps (a legacy git checkout can).
  if (result.pulled === 1) await verifyWorktreeAfterPull(`after pulling origin/${branch}`);
  return result;
}

async function fetchOriginForSync(branch: string): Promise<boolean> {
  // Clear stale locks BEFORE fetching: a crashed git can leave a ref lock that
  // makes every future fetch fail (a stale refs/remotes/origin/<branch>.lock
  // wedged sync permanently before this).
  await clearStaleLock();

  // A failure streak upgrades the timeout: a fetch that repeatedly dies at
  // NETWORK_TIMEOUT is usually a transfer BIGGER than the window (post-
  // compaction full-chain fetch), and killing it forever = tmp_pack_* debris
  // filling the disk (92 corpses / 79GB in 73min, 2026-08-23). Giving one
  // fetch 10 minutes is cheap; the single-flight latch keeps ticks from
  // stacking behind it.
  const fetchTimeout = syncFetchTimeout(guard.consecutiveNetworkFailures);
  if (fetchTimeout === FETCH_RECOVERY_TIMEOUT) {
    log.git[streakNews('widen-timeout') ? 'warn' : 'debug']('git-sync fetch failure streak — widening this fetch\'s timeout', {
      branch, streak: guard.consecutiveNetworkFailures, timeoutMs: fetchTimeout,
    });
  }
  let fetchError: unknown = null;
  try {
    await gitAsync(`fetch origin ${branch}`, { timeout: fetchTimeout });
  } catch (err) {
    fetchError = err;
  }
  // Lock contention is not a network failure: force-clear and retry once.
  if (fetchError && isLockContention(fetchError)) {
    await clearStaleLock(0);
    try {
      await gitAsync(`fetch origin ${branch}`, { timeout: fetchTimeout });
      fetchError = null;
      log.git.warn('git-sync fetch recovered after clearing a stale lock', { branch });
    } catch (retryErr) {
      fetchError = retryErr;
    }
  }
  if (fetchError) {
    const detail = fetchError instanceof Error ? fetchError.message : String(fetchError);
    // Feed the outage tracker: a long streak means the worktree is frozen on
    // an old tree, and the first recovered cycle must pull BEFORE committing.
    const streak = noteNetworkFailure();
    log.git.warn('git-sync fetch failed — skipping merge this cycle', {
      branch,
      // Name the cause: 246 failures were once logged without it, and a
      // 2.5-day-old lock went unnoticed.
      error: detail.slice(0, 400),
      lockContention: isLockContention(fetchError),
      consecutiveNetworkFailures: streak,
    });
    // Each killed fetch leaves its partial tmp_pack behind; sweep corpses now
    // (age-gated) instead of waiting for weekly maintenance.
    sweepDeadFetchPacks(WALNUT_HOME);
    return false;
  }
  noteNetworkSuccess();
  return true;
}

/** integrateRemote that never throws: a timed-out probe or step leaves everything as it was. */
async function integrateRemoteSafely(branch: string, opts: { before: string | null; merge: boolean }): Promise<PullResult> {
  try {
    return await integrateRemote(branch, opts);
  } catch (error) {
    log.git.warn('git-sync: the pull failed before anything moved — deferred to the next tick', {
      branch, error: (error instanceof Error ? error.message : String(error)).slice(0, 400),
    });
    return NOTHING_PULLED;
  }
}

/**
 * Bring origin/<branch> (already fetched) into HEAD and the working tree:
 * nothing to do, a fast-forward, a rewrite adoption, or a divergence. With
 * `merge: false` (gitPullWalnut) only a fast-forward lands; the tick does the rest.
 */
async function integrateRemote(branch: string, opts: { before: string | null; merge: boolean }): Promise<PullResult> {
  const remoteRef = `origin/${branch}`;
  const localHead = await gitSafeAsync('rev-parse HEAD');
  const remoteHead = await gitSafeAsync(`rev-parse ${remoteRef}`);
  if (!localHead || !remoteHead) return NOTHING_PULLED;
  // Every question below is asked so that a git that timed out or failed throws
  // (integrateRemoteSafely defers) instead of reading as "no": a "no merge base"
  // that was really a timeout would adopt ordinary divergence as a rewrite.
  const { run } = pullGit();
  const answer = async (args: string[], meaning: (code: number) => boolean | null): Promise<{ yes: boolean; stdout: string }> => {
    const r = await run(args);
    const yes = meaning(r.code);
    if (yes === null) throw new Error(`git ${args.join(' ')} exited ${r.code}: ${r.stderr.trim().slice(0, 300)}`);
    return { yes, stdout: r.stdout.trim() };
  };
  const zeroOrOne = (code: number): boolean | null => (code === 0 ? true : code === 1 ? false : null);
  const recorded = await answer(['rev-parse', '--verify', '-q', REWRITE_FROM_REF], zeroOrOne);
  const rewriteFrom = recorded.yes ? recorded.stdout : null;
  const isAncestor = async (a: string, b: string): Promise<boolean> =>
    (await answer(['merge-base', '--is-ancestor', a, b], zeroOrOne)).yes;
  // HEAD holds the remote's whole chain now: a recorded rewrite is behind us.
  const settled = async (): Promise<void> => {
    if (rewriteFrom) await gitSafeAsync(`update-ref -d ${REWRITE_FROM_REF}`);
  };

  if (localHead === remoteHead || await isAncestor(remoteHead, localHead)) {
    clearStalledPulls();
    await settled();
    return NOTHING_PULLED;
  }
  if (await isAncestor(localHead, remoteHead)) {
    if (!(await moveWorktree(branch, localHead, remoteHead, 'fast-forward'))) return NOTHING_PULLED;
    await settled();
    return { pulled: 1, conflicts: 0 };
  }
  if (!opts.merge) return NOTHING_PULLED;

  // Upstream history rewrite (compaction on the primary force-pushes a rewritten
  // main). Merging would join the OLD fat chain with the rewritten one and undo
  // the rewrite; the new chain is adopted instead (adoptRewrite). Two signals:
  // "no common ancestor" catches a compaction that rebuilds from a new root; a
  // path scrub (filter-repo) keeps the commits before the first scrubbed one, so
  // only the force-move of origin tells (a replica looped 7.5h on that merge,
  // 2026-09-11).
  const noMergeBase = !(await answer(['merge-base', localHead, remoteHead], zeroOrOne)).yes;
  const forceMoved = !noMergeBase && rewriteFrom !== null && !(await isAncestor(rewriteFrom, remoteHead));
  if (noMergeBase || forceMoved) {
    return adoptRewrite(branch, localHead, remoteHead, rewriteFrom ?? opts.before, noMergeBase ? 'no-merge-base' : 'upstream-force-moved');
  }

  if (!(await mergeTreeWriteTreeSupported(pullGit().run))) {
    return legacyWorktreePull({ kind: 'merge', branch, localHead, remoteHead });
  }
  const merged = await computeDivergence(localHead, remoteHead, remoteRef);
  if (!merged) return NOTHING_PULLED;
  if (!(await moveWorktree(branch, localHead, merged.head, merged.kind))) return NOTHING_PULLED;
  await settled();
  await announceDivergence(merged, localHead, remoteHead);
  return { pulled: 1, conflicts: merged.files.length };
}

/**
 * Adopt a rewritten upstream: park the old head on a self-replacing backup ref
 * (local-only commits stay recoverable there until the next rewrite), carry the
 * local commits made after the point the rewrite was cut from onto the new chain
 * (git-sync-rewrite-carry.ts), and move the working tree to the result.
 */
async function adoptRewrite(
  branch: string, localHead: string, remoteHead: string, published: string | null, reason: string,
): Promise<PullResult> {
  const remoteRef = `origin/${branch}`;
  const localOnly = published ? Number(await gitSafeAsync(`rev-list --count ${published}..HEAD`) || '0') : null;
  await gitSafeAsync('branch -f pre-rewrite-backup HEAD');
  let carried: CarryResult | null = null;
  try {
    carried = await carryLocalCommitsAcrossRewrite(localHead, remoteRef, published);
  } catch (error) {
    // The local commits stay on pre-rewrite-backup; say so loudly, because
    // the adoption below leaves them out of the working tree.
    log.git.error('git-sync: could not carry local commits across the upstream rewrite; they stay on pre-rewrite-backup', {
      localHead, remoteHead, error: error instanceof Error ? error.message : String(error), recoveryKey: 'git',
    });
  }
  let target = carried?.head ?? remoteHead;
  // Carried onto a commit the upstream has already built on: join the rest of
  // the new chain like any divergence.
  let merged: DivergedResult | null = null;
  // Without `merge-tree --write-tree` (git before 2.38) the carried chain lands
  // as it is; it shares history with the new chain, so the next tick's legacy
  // merge joins the rest (REWRITE_FROM_REF is dropped below, so it is no rewrite then).
  if (carried?.head && carried.anchor?.remote !== remoteHead && await mergeTreeWriteTreeSupported(pullGit().run)) {
    merged = await computeDivergence(carried.head, remoteHead, remoteRef);
    if (!merged) return NOTHING_PULLED;
    target = merged.head;
  }
  if (!(await moveWorktree(branch, localHead, target, 'rewrite adoption'))) return NOTHING_PULLED;
  await gitSafeAsync(`update-ref -d ${REWRITE_FROM_REF}`);
  log.git.warn('git-sync: upstream history rewritten — adopted the new chain; previous head saved on pre-rewrite-backup', {
    previousHead: localHead, newHead: remoteHead, reason,
    localOnlyCommitsParked: localOnly,
    carriedHead: carried?.head ?? null,
    carriedCommits: carried?.replayed ?? 0,
    anchor: carried?.anchor ?? null,
    keptLocal: carried?.keptLocal.slice(0, 50) ?? [],
    keptRemote: carried?.keptRemote.slice(0, 50) ?? [],
    keptRemoved: carried?.keptRemoved.slice(0, 50) ?? [],
    keptMerged: carried?.keptMerged.slice(0, 50) ?? [],
    squashed: carried?.squashed ?? false,
    fileLevel: carried?.fileLevel ?? false,
  });
  try { rewriteAdoptedListener?.(); } catch { /* the listener only schedules */ }
  if (merged && carried?.head) await announceDivergence(merged, carried.head, remoteHead);
  return { pulled: 1, conflicts: merged?.files.length ?? 0 };
}

/** The divergence's target commit, or null when a step failed or timed out (it built objects only: nothing moved). */
async function computeDivergence(localHead: string, remoteHead: string, remoteRef: string): Promise<DivergedResult | null> {
  const indexFile = path.join(WALNUT_HOME, '.git', 'walnut-sync-merge.index');
  try {
    return await resolveDivergence(pullGit().run, localHead, remoteHead, remoteRef, indexFile);
  } catch (error) {
    const detail = (error instanceof Error ? error.message : String(error)).slice(0, 400);
    notePullStalled(`the merge could not be computed: ${detail}`);
    log.git.warn('git-sync: could not compute the merge with origin — nothing changed, deferred to the next tick', {
      localHead, remoteHead, error: detail,
    });
    return null;
  } finally {
    await fs.promises.rm(indexFile, { force: true }).catch(() => undefined);
  }
}

/**
 * A pull that keeps failing to land leaves nothing synced while each tick logs one ordinary
 * deferral, and the visible symptom is a "push rejected" spike (2026-11-24: first a merge that
 * timed out on every tick, then host-exec-grants.json rewritten on every host_exec run, blocked
 * the pull for six hours). STALLED_PULL_TICKS pulls in a row that did not land, whatever the
 * reason, are named once as an error with the reason and the files that blocked every one of
 * them, so Health shows the cause. A pull that lands, or nothing to pull, ends the streak.
 */
const STALLED_PULL_TICKS = 10;
const stalled = { ticks: 0, named: false, reason: '', files: null as Set<string> | null };

export function notePullStalled(reason: string, files: string[] = []): void {
  stalled.ticks++;
  stalled.reason = reason;
  // Files in the way of every deferral of the streak (none once one deferral had none).
  stalled.files = stalled.files === null ? new Set(files) : new Set(files.filter((f) => stalled.files!.has(f)));
  if (stalled.ticks < STALLED_PULL_TICKS || stalled.named) return;
  stalled.named = true;
  log.git.error('git-sync: the pull has not landed for many ticks in a row, so nothing syncs', {
    pullsNotLanded: stalled.ticks, lastReason: reason.slice(0, 400), filesInTheWay: [...stalled.files].slice(0, 20), recoveryKey: 'git',
  });
}

function clearStalledPulls(): void {
  stalled.ticks = 0;
  stalled.named = false;
  stalled.reason = '';
  stalled.files = null;
}

/** Tests: the streak notePullStalled keeps. */
export function stalledPullsForTest(): { ticks: number; named: boolean; reason: string; files: string[] } {
  return { ticks: stalled.ticks, named: stalled.named, reason: stalled.reason, files: [...(stalled.files ?? [])] };
}

/**
 * Move the working tree and the branch from `oldHead` to `target` through the
 * one apply function. True when it landed; a deferral leaves the branch where it
 * was and the next tick tries again.
 */
async function moveWorktree(branch: string, oldHead: string, target: string, what: string): Promise<boolean> {
  let outcome: ApplyOutcome;
  try {
    outcome = await applyTargetToWorktree(pullGit(), {
      repoDir: WALNUT_HOME, branch, oldHead, target, isMachineLocal: (file) => criticalIgnoreTarget(file) !== null,
    });
  } catch (error) {
    const detail = (error instanceof Error ? error.message : String(error)).slice(0, 400);
    notePullStalled(`the working tree could not be moved: ${detail}`);
    log.git.warn('git-sync: could not move the working tree to the pulled commit — the branch did not move, deferred to the next tick', {
      what, branch, oldHead, target, error: detail,
    });
    return false;
  }
  if (outcome.status === 'needs-git') {
    return (await legacyWorktreePull({ kind: 'move', branch, oldHead, target, reason: outcome.reason })).pulled === 1;
  }
  if (outcome.status === 'deferred') {
    if (outcome.reason === 'dirty' || outcome.reason === 'raced') {
      // A store was written since this cycle's commit: the fetch in between can
      // take a minute, and notifications.json changes every time a card lands.
      // Nothing is wrong with either history, and remote-wins would be the wrong
      // answer; the next tick commits the write and pulls again.
      notePullStalled('a store was rewritten while the pull was in flight', outcome.files)
      log.git.warn('git-sync: a store changed while the pull was in flight — merge deferred to the next tick', {
        what, branch, localHead: oldHead, remoteHead: target, files: outcome.files.slice(0, 20),
        // raced: the apply had started; every path it changed was put back (leftAlone: the app rewrote them since).
        rolledBack: outcome.rollback ? { restored: outcome.rollback.restored, leftAlone: outcome.rollback.leftAlone.slice(0, 20) } : undefined,
      });
      if (outcome.rollback?.failed.length) {
        log.git.error('git-sync: an interrupted pull could not put every path back; commits wait until the next tick finishes the rollback', {
          what, branch, failed: outcome.rollback.failed.slice(0, 20), recoveryKey: 'git',
        });
      }
    } else {
      notePullStalled(`the apply deferred: ${outcome.reason}`, outcome.files)
      log.git.info('git-sync: pull deferred to the next tick', { what, branch, reason: outcome.reason });
    }
    return false;
  }
  if (outcome.overwroteIgnored.length > 0) {
    log.git.info('git-sync: the pull replaced or cleared ignored local files in its way (as git would)', {
      what, files: outcome.overwroteIgnored.slice(0, 20),
    });
  }
  if (outcome.keptLocal.length > 0) {
    log.git.warn('git-sync: the pull left machine-local files as they are; the other side\'s version stays in history', {
      what, files: outcome.keptLocal.slice(0, 20),
    });
  }
  if (outcome.indexStale) {
    // The tree and the branch are right; only git's index is behind. Every commit
    // path runs `add -A` first, so it cannot record a revert, and the next tick's
    // recovery runs `git reset -q` before anything reads the status.
    log.git.error('git-sync: the pull landed but the index could not be refreshed; repaired on the next tick', {
      what, branch, target, recoveryKey: 'git',
    });
  }
  clearStalledPulls();
  return true;
}

/**
 * Finish or undo a pull that stopped part way, before anything commits: a
 * commit of a half-applied tree would record the pulled content as a local
 * change stamped now, and LWW would let it beat a newer hub write. `commit`:
 * an auto-commit may run now. `pull`: the rest of the tick (pull, push) may run.
 * A pull that cannot be settled is held: its paths stay out of every commit
 * (pullHoldBack, applied in stageAllForCommit) and everything else syncs on; one
 * whose journal cannot be read names no paths, so it stops auto-commits.
 */
export async function recoverInterruptedPull(): Promise<{ commit: boolean; pull: boolean }> {
  const report = await recoverInterruptedApply(pullGit().run, WALNUT_HOME);
  if (report.outcome === 'busy') return { commit: false, pull: false };
  if (report.heldNow) {
    log.git.error('git-sync: a pull that stopped part way could not be finished or undone; its files are left as they are and kept out of auto-commits', {
      reason: report.heldNow.reason, branch: report.heldNow.branch, oldHead: report.heldNow.oldHead, target: report.heldNow.target,
      failed: report.rollback?.failed.slice(0, 20),
      hint: 'a held file settles when a pull replaces it, the app rewrites it, or HEAD holds it; an unreadable journal stays in .git/walnut-apply-held until a person removes it',
    });
  } else if (report.outcome === 'recovered' && (report.rollback || report.finished)) {
    log.git.warn('git-sync: settled a pull that stopped part way (the process died, or the index could not be refreshed)', {
      finished: report.finished ?? false,
      restored: report.rollback?.restored ?? 0,
      leftAlone: report.rollback?.leftAlone.slice(0, 20) ?? [],
    });
  }
  if (report.released?.length) log.git.info('git-sync: a held pull is settled; its files sync again', { released: report.released });
  if (report.outcome === 'failed') {
    log.git.error('git-sync: could not check for an interrupted pull; auto-commits wait for the next tick', {
      error: report.error, recoveryKey: 'git',
    });
    return { commit: false, pull: true };
  }
  const held = report.outcome === 'held' ? report.held ?? [] : [];
  pullHoldBack = { ids: held.map((h) => h.id).sort(), paths: [...new Set(held.flatMap((h) => h.waiting))] };
  guard.heldPull = held.length === 0 ? null : {
    since: guard.heldPull?.since ?? new Date().toISOString(), paths: pullHoldBack.paths.length, ids: pullHoldBack.ids,
  };
  if (held.length === 0) return { commit: true, pull: true };
  noteHeldPulls(held);
  return { commit: !held.some((h) => h.reason === 'unreadable'), pull: true };
}

/** A held pull is logged when it starts holding and then every 10 minutes; the standing card is the server's (heldPull). */
let heldPullsSaidAt = 0;
let heldPullsSaid = '';
function noteHeldPulls(held: HeldPull[]): void {
  const ids = held.map((h) => h.id).join(',');
  if (ids === heldPullsSaid && Date.now() - heldPullsSaidAt < 10 * 60_000) return;
  heldPullsSaid = ids;
  heldPullsSaidAt = Date.now();
  log.git.warn('git-sync: files of a pull that stopped part way are kept out of auto-commits until a pull settles them', {
    held: held.map((h) => ({ id: h.id, reason: h.reason, target: h.target, waiting: h.waiting.slice(0, 10), count: h.waiting.length })),
  });
}

// A writer that waited out a pull holding the rename gate goes ahead; say so (write-gate.ts).
setWriteGateOverdueListener((waitedMs) => {
  log.git.warn('git-sync: a write waited for a pull longer than the gate allows and went ahead', { waitedMs });
});

/** After a divergence landed: the LWW report for a merge with conflicts, and the marker guard on the files it chose. */
async function announceDivergence(merged: DivergedResult, localHead: string, remoteHead: string): Promise<void> {
  if (merged.kind === 'replay') {
    log.git.debug('git-sync: replayed local commits onto origin (linear history)', { replayed: merged.replayed, fileLevel: merged.fileLevel });
    return;
  }
  if (merged.files.length === 0) {
    log.git.info('git-sync: merged origin (no conflicts)', { localHead, remoteHead });
    return;
  }
  // The chosen blobs are one side's whole file, so this should find nothing;
  // but committing marker text as a JSON store's content is the 2026-08-22
  // incident, and the file list is in hand. A repair is dirty, and the next
  // auto-save commits it.
  await healConflictMarkeredJsonFiles(merged.files.filter((f) => f.endsWith('.json')), 'lwwMerge:resolved')
    .catch(() => undefined);
  announceLww(merged.files, merged.localWins, merged.remoteWins, merged.clocks, localHead, remoteHead);
}

/**
 * The UI hears about a conflict as ONE notification, never a dialog. `winner` is
 * the majority side (per-file detail is in the merge commit); `losingCommit`
 * points at the losing side's head for recovery:
 *   git log --all --full-history -- <file>   then   git show <losingCommit>:<file>
 */
function announceLww(
  files: string[], localWins: string[], remoteWins: string[], clocks: Record<string, LwwClock>,
  localHead: string, remoteHead: string,
): void {
  const winner: 'local' | 'remote' = localWins.length > remoteWins.length ? 'local' : 'remote';
  const losingCommit = winner === 'local' ? remoteHead : localHead;
  log.git.warn('git-sync auto-resolved same-hunk conflict (LWW)', {
    files, winner, losingCommit, localWins, remoteWins, clocks,
  });
  bus.emit(EventNames.SYNC_CONFLICT_RESOLVED, { files, winner, losingCommit }, ['web-ui'], {
    source: 'git-sync',
  });
}

/**
 * git's refusal when the working tree changed under a merge or rebase:
 * "Your local changes to the following files would be overwritten by merge"
 * / "cannot rebase: You have unstaged changes". A clock problem (the tree was
 * clean at commit time, a store moved during the fetch), never a content one.
 */
export function isDirtyTreeRefusal(gitError: string): boolean {
  return /would be overwritten by (?:merge|checkout)|you have unstaged changes|cannot rebase/i.test(gitError);
}

/** The file list git prints after a dirty-tree refusal (one indented path per line). */
export function dirtyFilesInRefusal(gitError: string): string[] {
  const files: string[] = [];
  for (const line of gitError.split('\n')) {
    const m = /^\s+(\S.*)$/.exec(line);
    if (m && !/^(?:Please|Aborting|error:|hint:)/.test(m[1])) files.push(m[1].trim());
  }
  return files;
}

type LegacyPlan =
  | { kind: 'move'; branch: string; oldHead: string; target: string; reason: string }
  | { kind: 'merge'; branch: string; localHead: string; remoteHead: string };

/**
 * The ONE place a pull lets git itself write the working tree (named by
 * tests/integrations/git-sync-worktree-writers-ratchet.test.ts). Two cases only:
 *
 *  - `move`: a target whose checkout converts content (a filter, eol or ident
 *    attribute, autocrlf) or renames by case only; git-sync-apply.ts says which.
 *    git's own two-tree checkout, which refuses a path written since the commit.
 *  - `merge`: a git without `merge-tree --write-tree` (before 2.38): rebase,
 *    else merge with per-file LWW, in the working tree as before.
 *
 * A timed-out, killed or failed git here aborts and defers to the next tick. It
 * never falls back to `pull -X theirs`: remote-wins is not an answer to a slow
 * machine (2026-11-24 07:14 to 07:25, ten 30 s merge timeouts in a row each did,
 * overwriting live stores with the hub's older content).
 */
async function legacyWorktreePull(plan: LegacyPlan): Promise<PullResult> {
  const timeout = pullStepTimeoutMs;
  if (plan.kind === 'move') {
    await gitSafeAsync('update-index -q --refresh', { timeout });
    if (await gitSafeAsync(`read-tree -m -u ${plan.oldHead} ${plan.target}`, { timeout }) === null) {
      log.git.warn('git-sync: git could not check the pulled commit out (a store changed since the commit, or git failed) — deferred to the next tick', {
        branch: plan.branch, oldHead: plan.oldHead, target: plan.target, why: plan.reason,
      });
      return NOTHING_PULLED;
    }
    if (await gitSafeAsync(`update-ref -m "git-sync: pull" refs/heads/${plan.branch} ${plan.target} ${plan.oldHead}`, { timeout }) === null) {
      // The tree and the index hold the target and the branch does not: the next
      // auto-save would record the pulled content as this box's own change. Put
      // both back to wherever the branch is now, with the same two-tree checkout.
      const branchAt = await gitSafeAsync(`rev-parse --verify -q refs/heads/${plan.branch}`, { timeout });
      const back = branchAt ? await gitSafeAsync(`read-tree -m -u ${plan.target} ${branchAt}`, { timeout }) : null;
      if (back === null) {
        // Could not: no auto-commit may take this tree until a person or a clean tree clears it.
        enterSafeMode('pull-cas-refused', { branch: plan.branch, oldHead: plan.oldHead, target: plan.target, branchAt });
      } else {
        log.git.warn('git-sync: the branch moved during the pull; the tree was put back to it, deferred to the next tick', {
          branch: plan.branch, oldHead: plan.oldHead, target: plan.target, branchAt,
        });
      }
      return NOTHING_PULLED;
    }
    return { pulled: 1, conflicts: 0 };
  }

  const { branch, localHead, remoteHead } = plan;
  const remoteRef = `origin/${branch}`;
  const deferred = async (message: string, detail: Record<string, unknown>, level: 'warn' | 'error'): Promise<PullResult> => {
    await gitSafeAsync('merge --abort', { timeout });
    log.git[level](message, { branch, localHead, remoteHead, ...detail });
    return NOTHING_PULLED;
  };

  // Linear history first, as `pull --rebase` gave (the fetch already ran).
  try {
    await gitAsync(`rebase ${remoteRef}`, { timeout });
    return { pulled: 1, conflicts: 0 };
  } catch {
    await gitSafeAsync('rebase --abort', { timeout });
  }

  // A true merge WITHOUT -X: non-overlapping edits auto-merge; overlapping ones
  // leave unmerged paths, resolved per file below.
  let mergeError: string;
  try {
    await gitAsync(`merge --no-edit ${remoteRef}`, { timeout });
    return { pulled: 1, conflicts: 0 };
  } catch (err) {
    mergeError = err instanceof Error ? err.message : String(err);
  }
  if (/timed out/i.test(mergeError)) {
    // Killed mid-merge: whatever it wrote is half a merge. Abort it; the remote side is safe in origin.
    return deferred('git-sync: the merge timed out — merge aborted, deferred to the next tick', { error: mergeError.slice(0, 400) }, 'warn');
  }
  const stages = parseConflictStages(((await gitSafeAsync('ls-files -u -z', { timeout })) ?? '').split('\0'));
  if (stages.size === 0) {
    if (isDirtyTreeRefusal(mergeError)) {
      return deferred('git-sync: a store changed while the pull was in flight — merge deferred to the next tick', {
        files: dirtyFilesInRefusal(mergeError),
      }, 'warn');
    }
    return deferred('git-sync merge failed with a NON-conflict error — merge aborted, deferred to the next tick. Investigate!', {
      error: mergeError.slice(0, 400), recoveryKey: 'git',
    }, 'error');
  }

  const localWins: string[] = [];
  const remoteWins: string[] = [];
  const mergedRecords: string[] = [];
  const clocks: Record<string, LwwClock> = {};
  const files = [...stages.keys()];
  try {
    for (const [file, s] of stages) {
      // A store of records: both sides merged (git-sync-records.ts), staged and written from the index.
      const records = await mergeRecords(pullGit().run, file, s.get(2), s.get(3));
      if (records) {
        const [mode, oid] = records.split(' ');
        await must(pullGit().run, ['update-index', '--cacheinfo', `${mode},${oid},${file}`]);
        await must(pullGit().run, ['checkout-index', '-f', '--', file]);
        clocks[file] = 'records';
        mergedRecords.push(file);
        continue;
      }
      const { side, clock } = await chooseLww(pullGit().run, file, s.get(2), s.get(3), localHead, remoteHead);
      clocks[file] = clock;
      const flag = side === 'local' ? '--ours' : '--theirs';
      if (await gitSafeAsync(`checkout ${flag} -- "${file}"`, { timeout }) !== null) {
        await gitSafeAsync(`add -- "${file}"`, { timeout: Math.max(timeout, await fileAddTimeout(WALNUT_HOME, file)) });
      } else {
        // The winning side deleted the file: no blob to restore, the delete stands.
        await gitSafeAsync(`rm -f -- "${file}"`, { timeout });
      }
      (side === 'local' ? localWins : remoteWins).push(file);
    }
    const stillUnmerged = await gitSafeAsync('diff --name-only --diff-filter=U', { timeout });
    if (stillUnmerged && stillUnmerged.trim().length > 0) {
      return deferred('git-sync LWW resolution left unmerged paths — merge aborted, deferred to the next tick. Investigate!', {
        unresolved: stillUnmerged.split('\n'), recoveryKey: 'git',
      }, 'error');
    }
    // Marker guard on the resolved set, staged file by file (never `add -A`: the
    // app keeps writing during a pull, and sweeping those writes into the merge
    // commit is not this function's job).
    const markerFix = await healConflictMarkeredJsonFiles(files.filter((f) => f.endsWith('.json')), 'lwwMerge:resolved');
    for (const f of markerFix.restored) await gitSafeAsync(`add -- "${f}"`, { timeout: Math.max(timeout, await fileAddTimeout(WALNUT_HOME, f)) });
    for (const f of markerFix.quarantined) await gitSafeAsync(`rm -q --cached --ignore-unmatch -- "${f}"`, { timeout });

    const msgFile = path.join(os.tmpdir(), `walnut-merge-msg-${process.pid}-${Date.now()}.txt`);
    fs.writeFileSync(msgFile, lwwMergeMessage(localWins, remoteWins, mergedRecords), 'utf-8');
    let committed: string | null;
    try {
      committed = await gitSafeAsync(`commit -F "${msgFile}"`, { timeout });
    } finally {
      try { fs.unlinkSync(msgFile); } catch { /* best-effort */ }
    }
    if (committed === null) {
      return deferred('git-sync LWW merge commit failed — merge aborted, deferred to the next tick', { files }, 'error');
    }
  } catch (error) {
    // A clock read timed out mid-resolution: never leave the repo mid-merge.
    return deferred('git-sync: the LWW resolution failed — merge aborted, deferred to the next tick', {
      files, error: (error instanceof Error ? error.message : String(error)).slice(0, 400),
    }, 'warn');
  }
  announceLww(files, localWins, remoteWins, clocks, localHead, remoteHead);
  return { pulled: 1, conflicts: files.length };
}

export async function autoSync(): Promise<void> {
  try {
    // Cached async probes — same three decisions, same short-circuit order, but
    // off the event loop (this runs on the ~30s tick; the sync twins are three
    // blocking spawns, profiled at 175ms of frozen loop in one burst).
    if (!(await isGitAvailableAsync()) || !(await isRepoAsync()) || !(await hasRemoteAsync())) return;
    await sync();
  } catch {
    // Never throw from autoSync
  }
}

/**
 * Pull latest data from the open-walnut git repo (best-effort, async).
 * Used by the server to fetch data pushed by remote hooks.
 * Silently does nothing if ~/.open-walnut/ is not a git repo or has no remote.
 *
 * Single-flight: session:result and session:error can fire together (multiple
 * sessions finishing at once) — concurrent callers share ONE in-flight pull
 * instead of racing two pulls into .git/index.lock contention.
 */
let pullInflight: Promise<void> | null = null;

export async function gitPullWalnut(): Promise<void> {
  if (pullInflight) return pullInflight;
  pullInflight = (async () => {
    const endSection = markCriticalSection('git-pull-walnut');
    try {
      // Cached async probes: this runs on EVERY session:result / session:error,
      // so the old execSync triple froze the event loop once per finished turn.
      if (!(await isGitAvailableAsync()) || !(await isRepoAsync()) || !(await hasRemoteAsync())) return;
      // The tick's sync owns the repo while it runs: a pull beside it races its
      // fetch and merge for index.lock and the refs, and during a rewrite
      // adoption it downloaded the same 1.8GB chain a second time just to be
      // killed (2026-10-05). The tick pulls every cycle, so nothing is lost by
      // standing aside. A fetch-failure streak means the transfer is bigger than
      // any fail-fast budget; only the tick's fetch carries the widened timeout,
      // so a pull here would be one more kill and one more corpse per turn end.
      if (syncInflight) {
        log.git.debug('gitPullWalnut skipped — a sync is in flight');
        return;
      }
      // Same for compaction, its boot-time crash recovery and git maintenance:
      // they hold this flag while they move main or repack, and a pull beside
      // them races them for index.lock and the refs.
      if (compactionInProgress) {
        log.git.debug('gitPullWalnut skipped — compaction or maintenance holds the repo');
        return;
      }
      if (guard.consecutiveNetworkFailures > 0) {
        log.git.debug('gitPullWalnut skipped — fetch failure streak, the sync tick owns recovery', {
          consecutiveNetworkFailures: guard.consecutiveNetworkFailures,
        });
        return;
      }
      // A rebase or merge in progress is a human's (or a crashed git's): not ours to move.
      if (isGitSurgeryInProgress()) return;
      const branch = await getBranchAsync();
      if (branch === 'HEAD') return;
      await clearStaleLock();
      // A fast-forward only (what `pull --ff-only` did), through the same apply
      // as the tick: the fetch here, the working tree moved by moveWorktree. A
      // divergence or a rewrite waits for the tick. gitSafeAsync applies the
      // credential-helper guard itself and swallows errors (best-effort).
      const before = await gitSafeAsync(`rev-parse --verify -q origin/${branch}`);
      if (await gitSafeAsync(`fetch origin ${branch}`, { timeout: PULL_TIMEOUT }) === null) {
        // A killed fetch leaves its partial tmp_pack behind; the age gate keeps
        // a transfer still running out of reach.
        sweepDeadFetchPacks(WALNUT_HOME);
        return;
      }
      await noteRewriteAcrossFetch(branch, before);
      const result = await integrateRemoteSafely(branch, { before, merge: false });
      // Same torn-worktree sentinel as the sync tick.
      if (result.pulled === 1) await verifyWorktreeAfterPull('gitPullWalnut fast-forward');
    } catch {
      // Best-effort — don't fail callers
    } finally {
      endSection();
    }
  })();
  try {
    await pullInflight;
  } finally {
    pullInflight = null;
  }
}

/**
 * Remove stale git lock files older than the threshold.
 * The lock file format varies by git version (binary index copy, sometimes with PID).
 * We use pure age-based removal (default 60s) since any normal git op finishes quickly.
 *
 * Covers BOTH lock families — a crashed git leaves either behind:
 *   - .git/index.lock             → blocks `add`/`commit`
 *   - .git/refs/**\/<name>.lock   → blocks `fetch`/`pull` ref updates
 * Only index.lock used to be cleaned, so a stale ref lock survived indefinitely:
 * one sat in refs/remotes/origin/main.lock for 2.5 days and failed every 30s sync
 * tick (246 failures), each retry re-running the blocking git chain.
 */
export async function clearStaleLock(maxAgeMs = 60_000): Promise<boolean> {
  const gitDir = path.join(WALNUT_HOME, '.git');
  let removed = false;
  // A lock made since our oldest live git started may be that git's (a long add):
  // never ours to sweep. One older than all of them is a dead process's.
  const ownSince = oldestOwnGitStart(WALNUT_HOME);

  // Async on purpose: this runs on every 30s tick on the server's event loop,
  // and the refs walk below was a synchronous readdir per directory. With one
  // directory per turn ref (refs/walnut/turns/<id>, 450 on a real repo) it held
  // the loop 3.3 to 7.1 s at a time on a loaded machine (stall profiles,
  // 2026-10-23 to 25).
  const removeIfStale = async (lockPath: string): Promise<void> => {
    try {
      const stat = await fs.promises.stat(lockPath);
      if (Date.now() - stat.mtimeMs <= maxAgeMs) return;
      // 2 s of slack: a file system's mtime can trail the clock we read.
      if (ownSince !== null && stat.mtimeMs >= ownSince - 2_000) return;
      await fs.promises.unlink(lockPath);
      removed = true;
      log.git.warn('git-sync removed stale lock', { lock: path.relative(gitDir, lockPath) });
    } catch {
      // Missing / unreadable / already gone — nothing to do
    }
  };

  // An apply in this process holds index.lock through long single steps (a
  // big blob, a refresh); its 1 s touch keeps it fresh, and this latch keeps a
  // stall of the loop from reading it as dead (git-sync-apply-journal.ts).
  if (!applyInFlight()) await removeIfStale(path.join(gitDir, 'index.lock'));

  // Top-level .git/*.lock beyond index.lock: a merge killed mid-run (e.g. by
  // execGitGroup's timeout during the 2026-08 hub CPU-starvation) leaves
  // AUTO_MERGE.lock / MERGE_HEAD.lock behind, and every later merge then fails
  // "cannot lock ref" FOREVER — observed as a merge-failure loop falling back
  // to `pull -X theirs` on every 30s tick for two days. Sweep them all; the
  // same mtime staleness guard keeps a live git's locks safe.
  try {
    for (const entry of await fs.promises.readdir(gitDir)) {
      if (entry !== 'index.lock' && entry.endsWith('.lock')) {
        await removeIfStale(path.join(gitDir, entry));
      }
    }
  } catch {
    // .git unreadable — nothing to do
  }

  // Walk .git/refs for *.lock, depth-bounded. The walk is the expensive part
  // (one readdir per directory), so the routine sweep does it at most every
  // REFS_LOCK_SWEEP_MS; a caller that just hit lock contention (maxAgeMs under
  // the default) always walks. In between, the two directories whose locks
  // stop sync (a branch ref: commit, merge, fetch) are still checked every time.
  const now = Date.now();
  if (maxAgeMs >= 60_000 && now - lastRefsLockSweepAt < REFS_LOCK_SWEEP_MS) {
    for (const dir of [path.join(gitDir, 'refs', 'heads'), path.join(gitDir, 'refs', 'remotes', 'origin')]) {
      try {
        for (const entry of await fs.promises.readdir(dir)) {
          if (entry.endsWith('.lock')) await removeIfStale(path.join(dir, entry));
        }
      } catch { /* no such dir */ }
    }
    return removed;
  }
  lastRefsLockSweepAt = now;
  const walkRefs = async (dir: string, depth: number): Promise<void> => {
    if (depth > 6) return;
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walkRefs(full, depth + 1);
      else if (entry.name.endsWith('.lock')) await removeIfStale(full);
    }
  };
  await walkRefs(path.join(gitDir, 'refs'), 0);

  return removed;
}

/** How often the routine stale-lock sweep walks .git/refs (see clearStaleLock). */
const REFS_LOCK_SWEEP_MS = 10 * 60_000;
let lastRefsLockSweepAt = 0;

/** Test hook: the next clearStaleLock() walks .git/refs again. */
export function resetRefsLockSweepForTest(): void {
  lastRefsLockSweepAt = 0;
}

/**
 * Check whether an error is a git lock contention error.
 * Matches both lock families git can block on:
 *   - "Unable to create '...index.lock': File exists."          (add/commit)
 *   - "cannot lock ref 'refs/...': Unable to create '....lock'" (fetch/pull)
 * Matching only index.lock made every ref-lock failure look like a network error,
 * so the self-heal retry never fired.
 */
export function isLockContention(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  if (!msg.includes('.lock')) return false;
  return msg.includes('File exists') || msg.includes('cannot lock ref');
}

// ── Repo-size sentinel ───────────────────────────────────────────────────────
// Last line of defense for the 2026-07-25 starvation incident: every layer
// above (derived-file gitignores, history compaction, timeout reaping) can
// fail independently, and compaction in particular failed SILENTLY for months
// (ENOBUFS) while .git grew to 15GB. Whatever breaks next, this check makes
// sure a ballooning data repo surfaces as a warning long before it can take
// the machine down. Checked from the sync tick, at most once per interval.

/**
 * Warn when the data repo's .git exceeds this many bytes (3GB) on top of the
 * user's own files (USER_FILE_DIRS). The budget is for what Walnut itself puts
 * in git: history, its JSON stores, pinned backups, debris.
 */
const REPO_SIZE_WARN_BYTES = 3 * 1024 * 1024 * 1024;

/**
 * Where the user's own files live in the data repo: the photos, videos and
 * documents attached to notes and projects, in a NOTE_ATTACHMENT_DIR folder
 * under artifacts/ (the one tree) or notes/ (the vault of a data dir from
 * before it). Their bytes are the user's data, which no gc, compaction or
 * gitignore may shrink, so the sentinel adds them to its budget. Only those
 * folders count: a Walnut-written file elsewhere under artifacts/ (a session's
 * memory, a drawing, a stray download) still counts as growth. 2026-11-22: the
 * attachments held 3.1GB in HEAD alone (a 377MB video among them), so a flat
 * 3GB fired every 6 hours on a healthy repo whose history and Walnut data were
 * about 1.6GB. The cost: Walnut-made growth must now reach 3GB on its own, so a
 * 2GB backup branch stays quiet until maintenance ages it out (7 days).
 */
export const USER_FILE_DIRS = ['artifacts', 'notes'] as const;
const REPO_SIZE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6h

/**
 * The repo-size card's own recovery key. It used to share `git` with the
 * auto-commit card, whose recovery edge (commits failing, then healthy) says
 * nothing about size: a shrunk repo never retired its card, and a commit
 * hiccup retired it while the repo was still too large.
 */
export const REPO_SIZE_RECOVERY_KEY = 'git:repo-size';

let lastRepoSizeCheck = 0;

/** What one sentinel pass measured. `warning` is set only while `over`. */
export interface RepoSizeVerdict {
  /** Bytes of real pack files (pack-*.pack and their indexes) under objects/pack. */
  liveBytes: number;
  /** Bytes of tmp_pack_* transfer corpses still on disk after the age-gated sweep. */
  debrisBytes: number;
  /** Bytes of corpses this pass removed. */
  sweptBytes: number;
  over: boolean;
  warning: string | null;
  /** Bytes of the user's own files (USER_FILE_DIRS) in HEAD, added to the budget. 0 when not measured. */
  userBytes?: number;
}

function isTransferDebris(name: string): boolean {
  return name.startsWith('tmp_pack_') || name.startsWith('tmp_idx_');
}

/** du -sk equivalent for .git via pack files only — packs dominate (>95%) and
 * enumerating just objects/pack avoids walking hundreds of loose-object dirs.
 * Live packs and transfer corpses are summed apart: the corpses are not the
 * repo, and the fix for them (a sweep) is not the fix for a large repo. */
function measurePackDir(repoDir: string): { liveBytes: number; debrisBytes: number } {
  let liveBytes = 0;
  let debrisBytes = 0;
  const dir = path.join(repoDir, '.git', 'objects', 'pack');
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return { liveBytes, debrisBytes };
  }
  for (const e of entries) {
    if (!e.isFile()) continue;
    try {
      const size = fs.statSync(path.join(dir, e.name)).size;
      if (isTransferDebris(e.name)) debrisBytes += size;
      else liveBytes += size;
    } catch { /* raced with gc — skip */ }
  }
  return { liveBytes, debrisBytes };
}

const gbText = (bytes: number): string => `${(bytes / 1024 / 1024 / 1024).toFixed(1)}GB`;

/**
 * Periodic sentinel: measures the data repo and says whether it has grown past
 * the threshold. Returns null when throttled (one real pass per
 * REPO_SIZE_CHECK_INTERVAL_MS; callers can invoke it every tick). Dead transfer
 * corpses are swept first (age-gated) and never count as repo size: on
 * 2026-10-05 the cloud box reported 10.7GB of which 7.1GB was corpses of one
 * rewrite adoption, and the live repo was 3.6GB.
 */
export function checkRepoSize(repoDir = WALNUT_HOME): RepoSizeVerdict | null {
  const now = Date.now();
  if (now - lastRepoSizeCheck < REPO_SIZE_CHECK_INTERVAL_MS) return null;
  lastRepoSizeCheck = now;
  return measureRepoSize(repoDir, now);
}

/** One sentinel measurement, unthrottled (a re-measure after a gc uses it). */
export function measureRepoSize(repoDir = WALNUT_HOME, now = Date.now(), userBytes = 0): RepoSizeVerdict {
  const before = measurePackDir(repoDir);
  let sweptBytes = 0;
  let debrisBytes = before.debrisBytes;
  if (before.debrisBytes > 0 && sweepDeadFetchPacks(repoDir, now) > 0) {
    debrisBytes = measurePackDir(repoDir).debrisBytes;
    sweptBytes = before.debrisBytes - debrisBytes;
  }
  return judgeRepoSize({ liveBytes: before.liveBytes, debrisBytes, sweptBytes }, userBytes);
}

/**
 * Judge one measurement against the budget: REPO_SIZE_WARN_BYTES on top of the
 * user's own files. The sync tick measures without them (a stat of the pack dir);
 * the size is judged again with them before anything is raised (settleRepoSize).
 */
export function judgeRepoSize(
  m: Pick<RepoSizeVerdict, 'liveBytes' | 'debrisBytes' | 'sweptBytes'>,
  userBytes = 0,
): RepoSizeVerdict {
  const { liveBytes, debrisBytes, sweptBytes } = m;
  const over = liveBytes >= REPO_SIZE_WARN_BYTES + userBytes;
  if (!over) return { liveBytes, debrisBytes, sweptBytes, over, warning: null, userBytes };

  // Name the three things that have actually been behind this alert, in the
  // order they were found (2026-09-10): a compaction that ran fine but left
  // backup-* branches pinning the whole old chain, a large regenerable file
  // that .gitignore missed, and a killed gc's tmp_pack_* counted as pack bytes.
  // "compaction may be failing" sent the reader to the one layer that was OK.
  const debrisNote = debrisBytes > 0
    ? `; another ${gbText(debrisBytes)} of tmp_pack_* debris from a transfer still in flight is not counted`
    : '';
  const threshold = userBytes > 0
    ? `threshold 3GB plus the ${gbText(userBytes)} of files attached to your notes`
    : 'threshold 3GB';
  const warning = `data repo .git has grown to ${gbText(liveBytes)} of live packs (${threshold})${debrisNote}: `
    + 'check for backup-* branches pinning old history, large tracked files, or tmp_pack_* debris; see open-walnut logs -s git';
  return { liveBytes, debrisBytes, sweptBytes, over, warning, userBytes };
}

/** Whether a repo path is a file the user attached to a note (inside a NOTE_ATTACHMENT_DIR folder). */
export function isUserAttachmentPath(p: string): boolean {
  return p.split('/').slice(0, -1).includes(NOTE_ATTACHMENT_DIR);
}

/**
 * Bytes of the distinct attachment blobs in `git ls-tree -r -l -z` output. A file
 * kept twice (the same photo in two notes) is one blob, stored once, so it counts once.
 */
export function sumDistinctBlobBytes(lsTreeZ: string): number {
  const seen = new Set<string>();
  let total = 0;
  for (const rec of lsTreeZ.split('\0')) {
    // "<mode> blob <oid> <size>\t<path>"; a submodule (commit) or tree has no size.
    // The header holds no tab, so the first one starts the path (-z: never quoted).
    const tab = rec.indexOf('\t');
    if (tab < 0) continue;
    const [, type, oid, size] = rec.slice(0, tab).trim().split(/\s+/);
    if (type !== 'blob' || !oid || seen.has(oid) || !isUserAttachmentPath(rec.slice(tab + 1))) continue;
    const n = Number(size);
    if (!Number.isFinite(n)) continue;
    seen.add(oid);
    total += n;
  }
  return total;
}

/**
 * Bytes of the user's own files (attachments under USER_FILE_DIRS) in HEAD. A
 * child process (never a sync call on the event loop); 0 when git cannot answer,
 * which only makes the sentinel stricter, and says so in the log.
 */
export async function trackedUserFileBytes(repoDir = WALNUT_HOME): Promise<number> {
  try {
    const { code, stdout, stderr } = await execGitArgsStatus(
      ['ls-tree', '-r', '-l', '-z', 'HEAD', '--', ...USER_FILE_DIRS],
      { cwd: repoDir, timeout: 60_000 },
    );
    if (code !== 0) {
      log.git.warn('repo-size sentinel could not measure the user files; judging without them', { code, stderr: stderr.trim().slice(0, 300) });
      return 0;
    }
    return sumDistinctBlobBytes(stdout);
  } catch (err) {
    log.git.warn('repo-size sentinel could not measure the user files; judging without them', { error: String(err) });
    return 0;
  }
}

/**
 * Called after the worktree adopts a rewritten upstream. A no-merge-base fetch
 * cannot negotiate shared blobs, so the new chain arrives as a second full pack
 * beside the old one: 2026-10-12 the cloud box went from 2.1GB to 3.5GB of
 * "live" packs and stayed there 9 hours, until a restart let maintenance run.
 * git-maintenance registers here (it imports this module, not the reverse).
 */
let rewriteAdoptedListener: (() => void) | null = null;
export function setRewriteAdoptedListener(fn: (() => void) | null): void {
  rewriteAdoptedListener = fn;
}

/** Test hook: reset the sentinel's throttle window. */
export function resetRepoSizeCheckForTest(): void {
  lastRepoSizeCheck = 0;
}

/**
 * Commit all dirty changes with an auto-save message.
 * Returns true if a commit was made, false if working tree was clean.
 * Retries once on index.lock contention (common when multiple processes
 * run git ops against the same repo, e.g. orphaned server processes).
 */
export async function commitIfDirty(): Promise<boolean> {
  if (isSyncPaused()) return false;
  // Disk latch: a commit writes loose objects; on a critically-full disk it
  // dies mid-lock with ENOSPC (2026-08-12 cloud outage). Local edits stay on
  // disk and are committed as soon as the watermark clears.
  if (diskPullOnly) return false;
  // Surgery-in-progress guard: a rebase/merge/am leaves a transient tree that
  // `add -A` must never snapshot (2026-08-04 incident). Bail BEFORE clearing
  // locks — a live rebase's locks are not ours to sweep.
  if (isGitSurgeryInProgress()) {
    logSurgerySkip('commitIfDirty');
    return false;
  }
  // A pull is moving the tree (it holds the index), or one stopped part way and
  // is not undone yet: committing now would record the pulled content as ours.
  if (applyInFlight() || !(await recoverInterruptedPull()).commit) return false;
  await clearStaleLock();
  // -uall: see syncInner — collapsed `?? dir/` lines would hide a mass
  // resurrection from the circuit breaker.
  const status = await porcelainStatus();
  if (!status || status.trim().length === 0) {
    // Clean tree while in safe mode = the anomaly is gone (human repaired it).
    if (guard.safeMode) clearSyncSafeMode('worktree clean');
    return false;
  }

  const lines = status.split('\n').filter((l) => l.trim());

  // Mass-revert circuit breaker: this exact function committed the 2026-08-03
  // incident — `add -A` on a worktree frozen 8h behind upstream snapshotted a
  // 2200-file revert of the user's reorg. Refuse suspicious mass snapshots.
  const safety = await assessCommitSafety(lines);
  if (!safety.ok) return false;

  // Conflict-marker guard: this is THE path that committed marker text as the
  // live content of ui-prefs.json + a conversation file on 2026-08-22. Runs on
  // the status snapshot above (no extra git call), before anything is staged.
  await healConflictMarkeredJsonFromStatus(lines, 'commitIfDirty');

  // stageAllForCommit refuses (null) when a pull started (gitPullWalnut) or stopped since the check above.
  let stage: { deferred: PendingFile[]; cloudMode: boolean } | null;
  try {
    stage = await stageAllForCommit();
  } catch (err) {
    if (!isLockContention(err)) throw err;
    // Lock held by another process — wait briefly (async, loop keeps running) and retry once
    await new Promise((r) => setTimeout(r, 300));
    await clearStaleLock(5_000);
    stage = await stageAllForCommit();
  }
  if (!stage) return false;

  // Honest count: from what is ACTUALLY staged at commit time, not the
  // pre-add status snapshot. The incident commit reverted 2233 renames while
  // its message claimed "(1 files)" because the count predated the add.
  const staged = await gitSafeAsync('diff --cached --name-only');
  const stagedCount = (staged ?? '').split('\n').filter((l) => l.trim().length > 0).length;
  const stamp = () => new Date().toISOString().slice(0, 19).replace('T', ' ');
  let committed = false;
  if (stagedCount > 0) {
    await gitSafeAsync(`commit -m "auto-save ${stamp()} (${stagedCount} files)"`);
    committed = true;
  }
  // Large files go after the routine commit, so they can never hold it back.
  const large = await commitDeferredLargeFiles(stage.deferred, {
    cloudMode: stage.cloudMode,
    message: (count) => `auto-save ${stamp()} (${count} large files)`,
  });
  return committed || large > 0;
}

/**
 * Ensure ~/.open-walnut/ is a git repo. Initializes if needed.
 * Returns { available: true } if git works, or { available: false, error } if not.
 *
 * The server runs this at every boot, so every git call here is async: done with
 * execSync it held the event loop for up to 1.3 s on a new data home (2026-11-22,
 * a boot's stall profile: spawnSync 54%, all of it this function's git init,
 * identity and probes). initSync() stays the CLI's synchronous setup.
 */
export async function ensureRepo(): Promise<{ available: boolean; error?: string }> {
  if (!(await isGitAvailableAsync())) {
    return { available: false, error: 'git not found in PATH' };
  }
  // Asked fresh, never isRepoAsync's cache: a stale answer would init over a live repo.
  if (!isOwnRepoPrefix(await gitSafeAsync('rev-parse --show-prefix'))) {
    try {
      // Inside another repository: the data home gets its own, nested in it (see initSync).
      const outer = await gitSafeAsync('rev-parse --show-toplevel');
      if (outer) log.git.warn('git-sync: the data home sits inside another git repository; giving it a repository of its own', { dataHome: WALNUT_HOME, outer });
      try {
        await gitAsync('init');
        await gitAsync('checkout -b main');
      } finally {
        invalidateSyncProbeCache();
      }
      await ensureDataRepoConfigAsync();
      writeOrHealGitignore();
      // The first commit holds the .gitignore alone, as initSync's does.
      if ((await gitSafeAsync('log --oneline -1')) === null) {
        await gitAsync('add -- .gitignore');
        await gitSafeAsync('commit -m "open-walnut init"');
      }
    } catch (err) {
      return { available: false, error: `git init failed: ${err instanceof Error ? err.message : String(err)}` };
    }
  } else {
    try {
      await ensureDataRepoConfigAsync();
    } catch (err) {
      return {
        available: false,
        error: `git repo config setup failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
    // Pre-existing repo: self-heal the .gitignore so sensitive/machine-local
    // files added after the repo was initialized never enter the sync history
    // (ensureMachineLocalUntrackedAsync heals it first), and drop any that are
    // STILL tracked. Ignoring a tracked path does not
    // protect it: a merge carrying its deletion removes the local file.
    try { await ensureMachineLocalUntrackedAsync(true); } catch { /* best-effort */ }
    // That heal writes a missing .gitignore (ensureCriticalIgnores): with none, nothing may commit.
    if (!fs.existsSync(path.join(WALNUT_HOME, '.gitignore'))) return { available: false, error: 'the data repo has no .gitignore and it could not be written' };
  }
  return { available: true };
}

// ── Cheap last-sync getter for /api/v1/status ──
// Caches the last-commit timestamp for 30s so a polling mobile client never
// pays two execSync calls per status request.
let lastSyncCache: { value: string | null; at: number } | null = null;
const LAST_SYNC_CACHE_MS = 30_000;

/** ISO timestamp of the most recent sync commit, or null if no repo/commits. */
/**
 * Derive cloud-companion credentials from the data repo's cloud remote
 * (`https://walnut:<device-token>@<domain>/git/data`, see docs/reference/cloud-sync.md).
 * Zero-config source for the daemon bridge: if cloud sync works, the bridge
 * knows where to dial. Returns null when no cloud remote is configured.
 *
 * Remote name: setups that predate two-way auto-sync call it `cloud`; newer
 * ones renamed it `origin`. Try both, but only accept a URL that looks like
 * the companion's git endpoint (credentialed + /git/ path) — a plain GitHub
 * origin must never be mistaken for a bridge target.
 */
/**
 * The companion pairing in the data repo's remote, or null when there is none. `strict`
 * throws when git cannot answer (timed out, a lock) instead of reading that as "none": a
 * caller that acts on "no companion" takes it (tests/core/pairing-read-strict.test.ts).
 */
export function getCloudRemoteCredentials(options?: { strict?: boolean }): { domain: string; token: string; secure: boolean } | null {
  if (options?.strict) {
    if (!fs.existsSync(path.join(WALNUT_HOME, '.git'))) return null;
    const remotes = new Set(git('remote').split('\n'));
    for (const remote of ['cloud', 'origin']) {
      if (!remotes.has(remote)) continue;
      const parsed = parseCloudRemoteUrl(git(`remote get-url ${remote}`));
      if (parsed) return parsed;
    }
    return null;
  }
  for (const remote of ['cloud', 'origin']) {
    const parsed = parseCloudRemoteUrl(gitSafe(`remote get-url ${remote}`));
    if (parsed) return parsed;
  }
  return null;
}

/** A companion remote carries its device token as the URL password and serves /git/. */
export function parseCloudRemoteUrl(url: string | null | undefined): { domain: string; token: string; secure: boolean } | null {
  if (!url) return null;
  try {
    const u = new URL(url.trim());
    if (!u.password || !u.pathname.startsWith('/git/')) return null;
    return { domain: u.host, token: u.password, secure: u.protocol === 'https:' };
  } catch {
    return null;
  }
}

/**
 * Async twin of getCloudRemoteCredentials for callers on the server's event
 * loop (the cloud box host probe runs at boot and every few minutes; the sync
 * version would block every route for the length of two git spawns).
 *
 * A data home with no `.git` of its own has no remote, so it is unpaired, in strict
 * mode too: a fresh install has none until its first sync, and strict mode turned
 * that into `fatal: not a git repository` on every bridge config push (2026-11-01).
 * A failed git read in a repo that exists still rejects.
 */
export async function getCloudRemoteCredentialsAsync(options?: { strict?: boolean }): Promise<{ domain: string; token: string; secure: boolean } | null> {
  if (options?.strict && !(await fs.promises.stat(path.join(WALNUT_HOME, '.git')).then(() => true, () => false))) return null;
  const read = options?.strict ? gitAsync : gitSafeAsync;
  const names = await read('remote');
  const remotes = new Set(names?.split('\n'));
  for (const remote of ['cloud', 'origin']) {
    if (!remotes.has(remote)) continue;
    const parsed = parseCloudRemoteUrl(await read(`remote get-url ${remote}`));
    if (parsed) return parsed;
  }
  return null;
}

export function getLastSyncAt(): string | null {
  const now = Date.now();
  if (lastSyncCache && now - lastSyncCache.at < LAST_SYNC_CACHE_MS) {
    return lastSyncCache.value;
  }
  const value = isRepo() ? gitSafe('log -1 --format=%aI') : null;
  lastSyncCache = { value, at: now };
  return value;
}

/**
 * Async twin of getLastSyncAt, sharing the same 30s cache.
 *
 * `GET /api/v1/status` (polled by the phone) calls the SYNC version, which pays
 * two execSync spawns whenever the cache is cold — on the one event loop every
 * route shares. The handler is already async, so its call site becomes
 * `await getLastSyncAtAsync()`; that edit lives in src/web/routes/api-v1.ts and
 * is deliberately left to the caller. The sync version stays for the CLI
 * (src/commands/sync.ts), which has no event loop to protect.
 */
export async function getLastSyncAtAsync(): Promise<string | null> {
  const now = Date.now();
  if (lastSyncCache && now - lastSyncCache.at < LAST_SYNC_CACHE_MS) {
    return lastSyncCache.value;
  }
  const value = (await isRepoAsync()) ? await gitSafeAsync('log -1 --format=%aI') : null;
  lastSyncCache = { value, at: Date.now() };
  return value;
}

/** Test hook: drop the shared last-sync answer. */
export function resetLastSyncCacheForTest(): void {
  lastSyncCache = null;
}

export function getSyncStatus(): SyncStatus {
  if (!isRepo()) {
    return {
      initialized: false,
      remoteConfigured: false,
      lastSyncAt: null,
      pendingChanges: 0,
      branch: 'main',
      safeMode: guard.safeMode,
      diskPullOnly,
    };
  }

  const branch = getBranch();
  const remoteConfigured = hasRemote();

  // Count pending changes
  const status = gitSafe('status --porcelain') ?? '';
  const pendingChanges = status.length > 0
    ? status.split('\n').filter((l) => l.trim().length > 0).length
    : 0;

  // Get last commit date
  let lastSyncAt: string | null = null;
  const lastLog = gitSafe('log -1 --format=%aI');
  if (lastLog) {
    lastSyncAt = lastLog;
  }

  return {
    initialized: true,
    remoteConfigured,
    lastSyncAt,
    pendingChanges,
    branch,
    safeMode: guard.safeMode,
    diskPullOnly,
  };
}
