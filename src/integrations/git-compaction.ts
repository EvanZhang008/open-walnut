/**
 * Git history tiered compaction for Walnut's git-sync.
 *
 * git-sync auto-commits every 30s, causing .git/ to balloon over time.
 * This module compacts old history using a tiered strategy:
 *   - < 7 days:  keep every commit
 *   - 7–30 days: keep 1 per day (last commit of the day)
 *   - > 30 days: keep 1 per week (last commit of the ISO week)
 *
 * Safety: backup branch created before any mutation, atomic swap via
 * git update-ref, state journal for crash recovery.
 */

import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { WALNUT_HOME } from '../constants.js';
import { git, gitSafe, setCompactionInProgress, clearStaleLock } from './git-sync.js';
import { pushViaBundle } from './git-bundle-client.js';
import { log } from '../logging/index.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CompactionResult {
  skipped?: boolean;
  before: number;
  after: number;
  error?: string;
}

interface Commit {
  hash: string;
  date: string;   // ISO-8601
  subject: string;
}

interface CompactionState {
  phase: 'building' | 'verified' | 'swapped' | 'cleaning';
  backup: string;
  startedAt: string;
}

// ---------------------------------------------------------------------------
// State journal — crash recovery
// ---------------------------------------------------------------------------

function statePath(repoDir: string): string {
  return path.join(repoDir, '.git', 'compaction-state.json');
}

function writeState(repoDir: string, state: CompactionState): void {
  fs.writeFileSync(statePath(repoDir), JSON.stringify(state), 'utf-8');
}

function readState(repoDir: string): CompactionState | null {
  try {
    return JSON.parse(fs.readFileSync(statePath(repoDir), 'utf-8'));
  } catch {
    return null;
  }
}

function removeState(repoDir: string): void {
  try { fs.unlinkSync(statePath(repoDir)); } catch {}
}

// ---------------------------------------------------------------------------
// ISO week helper
// ---------------------------------------------------------------------------

function isoWeek(dateStr: string): string {
  const d = new Date(dateStr);
  // Algorithm: https://en.wikipedia.org/wiki/ISO_week_date
  const jan4 = new Date(d.getFullYear(), 0, 4);
  const dayOfYear = Math.floor((d.getTime() - new Date(d.getFullYear(), 0, 1).getTime()) / 86400000) + 1;
  const dayOfWeek = d.getDay() || 7; // Mon=1 .. Sun=7
  const weekNum = Math.floor((dayOfYear - dayOfWeek + 10) / 7);
  if (weekNum < 1) {
    // Last week of previous year
    return `${d.getFullYear() - 1}-W52`;
  }
  return `${d.getFullYear()}-W${String(weekNum).padStart(2, '0')}`;
}

// ---------------------------------------------------------------------------
// Tiered commit selection
// ---------------------------------------------------------------------------

export function selectCommits(
  commits: Commit[],
  config: { recentDays: number; dailyDays: number },
): Commit[] {
  const now = Date.now();
  const DAY = 86_400_000;
  const recent: Commit[] = [];

  // Maps keep insertion order — since commits are chronological,
  // later (newer) commits overwrite earlier ones, so the last value per key
  // is the last commit of that day/week.
  const dailyBuckets = new Map<string, Commit>();
  const weeklyBuckets = new Map<string, Commit>();

  for (const c of commits) {
    const ageDays = (now - new Date(c.date).getTime()) / DAY;

    if (ageDays < config.recentDays) {
      recent.push(c);
    } else if (ageDays < config.dailyDays) {
      dailyBuckets.set(c.date.slice(0, 10), c);
    } else {
      weeklyBuckets.set(isoWeek(c.date), c);
    }
  }

  // Merge: weekly (oldest) → daily → recent (newest) — all chronological
  return [
    ...weeklyBuckets.values(),
    ...dailyBuckets.values(),
    ...recent,
  ];
}

// ---------------------------------------------------------------------------
// Parse git log output
// ---------------------------------------------------------------------------

function parseGitLog(raw: string): Commit[] {
  if (!raw.trim()) return [];
  return raw.split('\n').map((line) => {
    // Format: <hash> <ISO-date> <subject...>
    const spaceIdx1 = line.indexOf(' ');
    const spaceIdx2 = line.indexOf(' ', spaceIdx1 + 1);
    return {
      hash: line.slice(0, spaceIdx1),
      date: line.slice(spaceIdx1 + 1, spaceIdx2),
      subject: line.slice(spaceIdx2 + 1),
    };
  });
}

// ---------------------------------------------------------------------------
// Paged commit collection
// ---------------------------------------------------------------------------

/** Commits per `git log` page. ~100B/line → 5k ≈ 0.5MB, half of execSync's 1MB maxBuffer. */
const LOG_PAGE_SIZE = 5_000;

/**
 * Collect every commit on HEAD, oldest first, in fixed-size pages so no single
 * child-process read can hit execSync's maxBuffer regardless of repo size.
 * Pages walk backwards from HEAD (`--skip`), then the whole list is reversed —
 * `--reverse --max-count` would return the OLDEST N instead of paging.
 */
export function collectCommitsPaged(repoDir: string): Commit[] {
  const opts = { cwd: repoDir };
  const pages: Commit[][] = [];

  for (let skip = 0; ; skip += LOG_PAGE_SIZE) {
    const raw = git(
      `log --format="%H %aI %s" --max-count=${LOG_PAGE_SIZE} --skip=${skip}`,
      opts,
    );
    const page = parseGitLog(raw);
    if (page.length === 0) break;
    pages.push(page);
    if (page.length < LOG_PAGE_SIZE) break;
  }

  // Pages are newest→oldest and each page is newest-first — flatten then flip.
  return pages.flat().reverse();
}

// ---------------------------------------------------------------------------
// Core compaction
// ---------------------------------------------------------------------------

/**
 * Run tiered history compaction on a git repo.
 * @param repoDir - path to the git working directory (defaults to WALNUT_HOME)
 */
export async function compactGitHistory(repoDir = WALNUT_HOME): Promise<CompactionResult> {
  const opts = { cwd: repoDir };

  // 0. Ensure we're on main and working tree is clean
  const branch = gitSafe('rev-parse --abbrev-ref HEAD', opts);
  if (branch !== 'main') {
    git('checkout main', opts);
  }

  // 0b. Remote coordination (cloud hub). Compaction REWRITES main, so with a
  // remote configured the new chain must be force-pushed — otherwise the next
  // sync tick hits non-fast-forward, pull --rebase finds no merge base with
  // the rewritten chain, and sync wedges permanently while every retry
  // re-packs gigabytes (the exact CPU-storm this module exists to prevent).
  // Preconditions before we may safely rewrite:
  //   - remote reachable (else abort — compact only when we can also push)
  //   - origin/main is an ANCESTOR of local main (else the cloud box has
  //     commits we don't — force-pushing would DESTROY them; let the normal
  //     sync merge them in and compact on a later run)
  // Both deferrals are NORMAL (offline laptop / sync lag), not failures —
  // plain `skipped` without `error`, or the daily attempt would fire a false
  // "Compaction Failing" alert every time the Mac is offline. If the remote
  // stays unreachable long-term the repo-size sentinel (3GB) still alerts.
  const hasRemote = (gitSafe('remote', opts) ?? '').length > 0;
  let remoteHeadBeforeRewrite: string | null = null;
  if (hasRemote) {
    if (gitSafe('fetch origin main', opts) === null) {
      log.git.warn('compaction deferred: remote unreachable (rewriting without pushing would wedge sync)');
      return { skipped: true, before: 0, after: 0 };
    }
    remoteHeadBeforeRewrite = gitSafe('rev-parse origin/main', opts);
    if (remoteHeadBeforeRewrite
        && gitSafe(`merge-base --is-ancestor ${remoteHeadBeforeRewrite} main`, opts) === null) {
      log.git.warn('compaction deferred: origin/main has commits not merged locally — sync must catch up first');
      return { skipped: true, before: 0, after: 0 };
    }
  }

  // 1. Collect all commits (oldest first).
  // Paged: one `git log` over the whole history blew execSync's 1MB default
  // maxBuffer once the repo passed ~10k commits (ENOBUFS) — which silently
  // disabled compaction on exactly the repos that needed it most. At 30s
  // auto-commits that's ~3.5 days of history; the 2026-07-25 incident repo had
  // 161k commits and had never compacted once.
  const commits = collectCommitsPaged(repoDir);

  if (commits.length < 50) {
    return { skipped: true, before: commits.length, after: commits.length };
  }

  // 2. Select commits to keep
  const selected = selectCommits(commits, { recentDays: 7, dailyDays: 30 });

  if (selected.length >= commits.length * 0.9) {
    // Less than 10% reduction — not worth it
    return { skipped: true, before: commits.length, after: selected.length };
  }

  // 3. Create backup branch
  const backupName = `backup-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}`;
  gitSafe(`branch -D ${backupName}`, opts); // remove old backup with same name
  git(`branch ${backupName}`, opts);
  writeState(repoDir, { phase: 'building', backup: backupName, startedAt: new Date().toISOString() });

  try {
    // 4. Build the compacted chain with `commit-tree` — NO working-tree I/O.
    // The old implementation materialized every kept commit via
    // `rm -rf . && checkout <hash> -- . && add -A && commit`: four child
    // processes plus a full working-tree rewrite PER COMMIT. On the real data
    // repo (2.5GB tree, ~20k commits inside the keep-everything window) that
    // is 10+ hours — compaction could never finish even without ENOBUFS.
    // `commit-tree` snapshots each kept commit's EXISTING tree object into a
    // new parent chain directly in the object DB: O(1) per commit, and the
    // resulting trees are byte-identical by construction.
    let parent = '';
    let newHead = '';
    for (const commit of selected) {
      const safeSubject = commit.subject.replace(/"/g, '\\"');
      const message = commit === selected[0] && selected.length < commits.length
        ? `compacted: ${safeSubject}`
        : safeSubject;

      newHead = git(
        `commit-tree ${commit.hash}^{tree}${parent ? ` -p ${parent}` : ''} -m "${message}"`,
        {
          ...opts,
          env: {
            GIT_AUTHOR_DATE: commit.date,
            GIT_COMMITTER_DATE: commit.date,
          },
        },
      );
      parent = newHead;
    }
    git(`update-ref refs/heads/compaction-wip ${newHead}`, opts);

    // 5. Verify: final tree of compaction-wip must match main exactly.
    // Tree-hash equality — the strongest possible check, and it works without
    // touching the working tree (there is no checkout to compare anymore).
    writeState(repoDir, { phase: 'verified', backup: backupName, startedAt: new Date().toISOString() });
    const wipTree = gitSafe('rev-parse compaction-wip^{tree}', opts);
    const mainTree = gitSafe('rev-parse main^{tree}', opts);
    if (!wipTree || wipTree !== mainTree) {
      // MISMATCH — abort (main was never touched)
      gitSafe('update-ref -d refs/heads/compaction-wip', opts);
      removeState(repoDir);
      return { before: commits.length, after: commits.length, error: 'verification failed: trees differ' };
    }

    // 6. Atomic swap: point main at compaction-wip HEAD
    git(`update-ref refs/heads/main ${newHead}`, opts);
    // The working tree still matches (same tree hash) — refresh the index so
    // a subsequent `status` doesn't report phantom changes.
    gitSafe('reset --mixed HEAD', opts);
    gitSafe('update-ref -d refs/heads/compaction-wip', opts);
    writeState(repoDir, { phase: 'swapped', backup: backupName, startedAt: new Date().toISOString() });

    // 7. Push the rewritten chain to the hub. force-with-lease pinned to the
    // pre-rewrite remote head: if the cloud box pushed anything between our
    // fetch (step 0b) and now, the lease fails instead of destroying it — the
    // next sync tick merges those commits and a later compaction run retries.
    // Skipping the push entirely is NOT an option once main is rewritten
    // (non-fast-forward would wedge every subsequent sync), which is why step
    // 0b refuses to start when the remote is unreachable.
    if (hasRemote) {
      const lease = remoteHeadBeforeRewrite
        ? `--force-with-lease=refs/heads/main:${remoteHeadBeforeRewrite}`
        : '--force-with-lease';
      // 120s: pushing the compacted history is one big pack; the default 30s
      // LOCAL_TIMEOUT is calibrated for local ops, not a full-history upload.
      if (gitSafe(`push ${lease} origin main`, { ...opts, timeout: 120_000 }) === null) {
        // The compacted history is one huge pack (full rewritten chain), and
        // large sustained pushes are exactly what endpoint-security TLS
        // filters kill mid-stream (2026-08-22: reproducible "bad record mac"
        // past ~25MB while the hub itself was healthy). Before rolling back —
        // which re-runs this doomed push every day and strands a quarantine
        // dir on the hub per attempt — deliver the same ref update through
        // the chunked bundle channel, which those filters can't touch.
        log.git.warn('compaction: push failed — attempting chunked bundle delivery');
        const remoteUrl = gitSafe('remote get-url origin', opts);
        const bundled = remoteUrl
          ? await pushViaBundle({
              repoDir,
              branch: 'main',
              remoteUrl,
              // Same lease semantics as the push: the hub must still be at
              // the pre-rewrite head or the CAS fails and we roll back.
              oldValue: remoteHeadBeforeRewrite ?? '',
              // No basis: the rewritten chain shares no ancestry with what
              // the hub has, so the bundle must be self-contained.
            })
          : { ok: false as const, bytes: 0, chunks: 0, error: 'no origin url' };
        if (!bundled.ok) {
          // leaseKept says whether the hub still holds the chunks we did land:
          // if the NEXT run builds the identical bundle (nothing new committed
          // meanwhile) it resumes from there instead of chunk 1. When new
          // commits land the bundle differs and the lease is simply ignored,
          // which is why within-run sweeps — not this — are what makes a
          // 200-chunk delivery converge.
          log.git.warn('compaction: bundle delivery also failed — restoring pre-compaction main so sync stays consistent with the hub', {
            error: bundled.error,
            chunks: bundled.chunks,
            chunksSent: bundled.chunksSent,
            sweeps: bundled.sweeps,
            resumedFromSeq: bundled.resumedFromSeq,
            leaseKept: bundled.leaseKept,
          });
          git(`update-ref refs/heads/main ${backupName}`, opts);
          gitSafe('reset --mixed HEAD', opts);
          removeState(repoDir);
          return { before: commits.length, after: commits.length, error: `push of compacted history failed (${bundled.error ?? 'lease lost or network'}) — rolled back, will retry next run` };
        }
        log.git.info('compaction: rewritten history delivered via bundle channel', {
          bytes: bundled.bytes, chunks: bundled.chunks,
          chunksSent: bundled.chunksSent, sweeps: bundled.sweeps, resumedFromSeq: bundled.resumedFromSeq,
        });
        // The hub ref moved but our remote-tracking ref doesn't know yet —
        // sync's next fetch would otherwise see a surprise. Update it now.
        gitSafe('fetch origin main', opts);
      }
    }

    // 8. Cleanup (non-fatal)
    writeState(repoDir, { phase: 'cleaning', backup: backupName, startedAt: new Date().toISOString() });
    try {
      git('reflog expire --expire=now --all', opts);
      git('gc --prune=now', opts);
    } catch {
      // gc failure is non-fatal
    }

    // 9. Delete old backup branches (keep latest 2)
    deleteOldBackups(repoDir, 2);

    removeState(repoDir);
    return { before: commits.length, after: selected.length };

  } catch (err) {
    // Any failure: restore main from backup
    const currentBranch = gitSafe('rev-parse --abbrev-ref HEAD', opts);
    if (currentBranch !== 'main') {
      gitSafe('checkout main', opts);
    }
    // If main is gone (shouldn't happen since we use update-ref), restore from backup
    const mainExists = gitSafe('rev-parse --verify main', opts);
    if (!mainExists) {
      gitSafe(`branch main ${backupName}`, opts);
      gitSafe('checkout main', opts);
    }
    gitSafe('branch -D compaction-wip', opts);
    removeState(repoDir);
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Cleanup old backup branches
// ---------------------------------------------------------------------------

function deleteOldBackups(repoDir: string, keepCount: number): void {
  const opts = { cwd: repoDir };
  const branches = gitSafe('branch --list backup-*', opts);
  if (!branches) return;

  const backupBranches = branches
    .split('\n')
    .map((b) => b.trim())
    .filter((b) => b.startsWith('backup-'))
    .sort(); // chronological since names are date-based

  // Delete all but the latest `keepCount`
  const toDelete = backupBranches.slice(0, -keepCount);
  for (const b of toDelete) {
    gitSafe(`branch -D ${b}`, opts);
  }
}

// ---------------------------------------------------------------------------
// Crash recovery — call on startup
// ---------------------------------------------------------------------------

export function recoverFromCrashedCompaction(repoDir = WALNUT_HOME): void {
  const state = readState(repoDir);
  if (!state) return;

  const opts = { cwd: repoDir };

  try {
    switch (state.phase) {
      case 'building':
      case 'verified':
        // main is untouched — just clean up temp branch
        gitSafe('checkout main', opts);
        gitSafe('branch -D compaction-wip', opts);
        break;
      case 'swapped':
      case 'cleaning':
        // swap succeeded — just need gc cleanup
        gitSafe('checkout main', opts);
        gitSafe('branch -D compaction-wip', opts);
        gitSafe('reflog expire --expire=now --all', opts);
        gitSafe('gc --prune=now', opts);
        break;
    }
  } catch {
    // Recovery itself should never throw
  }

  removeState(repoDir);
}

// ---------------------------------------------------------------------------
// Scheduled compaction — check if due
// ---------------------------------------------------------------------------

const LAST_COMPACTION_FILE = '.last-compaction';
const COMPACTION_INTERVAL_DAYS = 7;

export function isCompactionDue(repoDir = WALNUT_HOME): boolean {
  const filePath = path.join(repoDir, LAST_COMPACTION_FILE);
  try {
    const content = fs.readFileSync(filePath, 'utf-8').trim();
    const lastDate = new Date(content);
    const daysSince = (Date.now() - lastDate.getTime()) / 86_400_000;
    return daysSince >= COMPACTION_INTERVAL_DAYS;
  } catch {
    // File doesn't exist — never compacted
    return true;
  }
}

export function markCompactionDone(repoDir = WALNUT_HOME): void {
  fs.writeFileSync(
    path.join(repoDir, LAST_COMPACTION_FILE),
    new Date().toISOString(),
    'utf-8',
  );
}

/**
 * Run compaction if due, with full safety (lock coordination with git-sync).
 */
export async function runScheduledCompaction(repoDir = WALNUT_HOME): Promise<CompactionResult | null> {
  if (!isCompactionDue(repoDir)) return null;

  setCompactionInProgress(true);
  try {
    clearStaleLock();
    const result = await compactGitHistory(repoDir);
    if (!result.skipped && !result.error) {
      markCompactionDone(repoDir);
    }
    return result;
  } finally {
    setCompactionInProgress(false);
  }
}
