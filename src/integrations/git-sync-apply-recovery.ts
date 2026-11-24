/**
 * What a later tick does with the journal an apply left behind (a process
 * killed part way, a rollback that failed), before anything commits.
 *
 * The decision is made from the branch's TREE, never its commit id, because a
 * commit can move the branch to the same tree under a new id (a compaction
 * rewriting main):
 *
 *  - the branch holds the target's tree: the apply had finished its writes and
 *    moved the branch; only the index refresh is left. Finished.
 *  - the branch holds the old head's tree: nothing recorded the half-applied
 *    tree. Every path is put back (git-sync-apply-journal.ts rollBack).
 *  - anything else: someone committed meanwhile (a person's `git commit -a`
 *    after removing the lock, review of 2026-11-24). Putting files back would
 *    make the next auto-save commit a revert of that commit, so no file is
 *    touched: the journal is HELD (`.git/walnut-apply-held/<id>`), auto-commits
 *    stop, pulls go on, and an error tells the user.
 *
 * A rollback that fails, or a journal that cannot be read, is held the same
 * way. While a pull is held (review of 2026-11-24, round 3: holding every
 * commit back could stop sync for good):
 *
 *  - auto-commits go on for every path but the held ones: the paths whose disk
 *    still holds bytes the apply wrote that HEAD lacks (git-sync.ts unstages
 *    them after `add -A`), so the user's other edits keep syncing;
 *  - a later pull may replace a held path (its bytes are pulled content, never
 *    the user's), so a hub that changed the file again is no reason to defer;
 *  - a held path settles when its disk no longer holds those bytes (a pull
 *    replaced them, or the app rewrote the file: that is its newest write) or
 *    HEAD has them; the journal is released when every path has settled.
 *
 * An unreadable journal names no paths, so it holds every commit back and is
 * never released by itself: a person removes it.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { closeWrites, openWrites } from '../utils/write-gate.js';
import type { GitStatusRunner } from './git-sync-rewrite-carry.js';
import {
  DEAD_APPLY_LOCK_MS, IndexLock, applyDir, applyInFlight, clearApplyDir, journalPath, markIndexStale, readJournal,
  refreshIndex, removeTemps, rollBack, staleIndexPath, stateIs, writeDrainMsNow, type Journal, type Op, type PathState, type RollbackResult,
} from './git-sync-apply-journal.js';

const heldRoot = (gitDir: string): string => path.join(gitDir, 'walnut-apply-held');
const exists = (p: string): Promise<boolean> => fsp.access(p).then(() => true, () => false);

export type HoldReason = 'branch-moved' | 'rollback-failed' | 'unreadable';

export interface HeldPull {
  id: string;
  reason: HoldReason;
  branch?: string;
  oldHead?: string;
  target?: string;
  /** Paths still holding what the apply wrote that HEAD lacks: auto-commits leave them out. */
  waiting: string[];
}

export interface RecoveryReport {
  /**
   * `clean`: nothing to do. `recovered`: an interrupted apply was finished or
   * undone, or a held one released. `held`: auto-commits wait (pulls go on).
   * `busy`: an apply holds the repo now, or the app's writes did not settle.
   * `failed`: git or the disk did not answer; auto-commits wait.
   */
  outcome: 'clean' | 'recovered' | 'held' | 'busy' | 'failed';
  /** The interrupted apply had moved the branch: only its index refresh was finished. */
  finished?: boolean;
  rollback?: RollbackResult;
  /** The journal this call held, and why. */
  heldNow?: { reason: HoldReason; branch?: string; oldHead?: string; target?: string };
  held?: HeldPull[];
  released?: string[];
  error?: string;
}

/** Move the journal aside, untouched but for its temps: `.git/walnut-apply-held/<id>`. */
async function hold(repoDir: string, gitDir: string, journal: Journal | null, reason: HoldReason): Promise<void> {
  if (journal) removeTemps(repoDir, journal.ops);
  await fsp.writeFile(path.join(applyDir(gitDir), 'held-reason'), reason, { mode: 0o600 });
  await fsp.mkdir(heldRoot(gitDir), { recursive: true, mode: 0o700 });
  const id = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
  await fsp.rename(applyDir(gitDir), path.join(heldRoot(gitDir), id));
}

/**
 * Recover the journal an earlier apply left, with the index lock held. `busy`
 * when the app's renames did not settle in time (nothing was touched).
 */
export async function recoverHeld(run: GitStatusRunner, repoDir: string, gitDir: string, lock: IndexLock): Promise<RecoveryReport> {
  const journal = await readJournal(applyDir(gitDir));
  if (journal === null) { await clearApplyDir(gitDir); return { outcome: 'clean' }; }
  if (journal === 'unreadable') {
    await hold(repoDir, gitDir, null, 'unreadable');
    return { outcome: 'held', heldNow: { reason: 'unreadable' } };
  }
  const where = { branch: journal.branch, oldHead: journal.oldHead, target: journal.target };
  const treeOf = async (rev: string): Promise<string | null> => {
    const r = await run(['rev-parse', '--verify', '-q', `${rev}^{tree}`]);
    if (r.code === 0) return r.stdout.trim();
    if (r.code === 1) return null;
    throw new Error(`git rev-parse ${rev} exited ${r.code}: ${r.stderr.trim().slice(0, 300)}`);
  };
  const branchRef = `refs/heads/${journal.branch}`;
  const [branchTree, targetTree, oldTree] = await Promise.all([treeOf(branchRef), treeOf(journal.target), treeOf(journal.oldHead)]);

  if (branchTree !== null && branchTree === targetTree) {
    const at = (await run(['rev-parse', '--verify', '-q', branchRef])).stdout.trim();
    if (!(await refreshIndex(run, gitDir, at, lock))) await markIndexStale(gitDir, at);
    removeTemps(repoDir, journal.ops);
    await clearApplyDir(gitDir);
    return { outcome: 'recovered', finished: true };
  }
  if (branchTree !== null && branchTree === oldTree) {
    if (!(await closeWrites(writeDrainMsNow()))) return { outcome: 'busy' };
    let rollback: RollbackResult;
    try {
      rollback = await rollBack(repoDir, gitDir, journal.ops);
    } finally {
      openWrites();
    }
    if (rollback.failed.length === 0) {
      await clearApplyDir(gitDir);
      return { outcome: 'recovered', finished: false, rollback };
    }
    await hold(repoDir, gitDir, journal, 'rollback-failed');
    return { outcome: 'held', rollback, heldNow: { reason: 'rollback-failed', ...where } };
  }
  await hold(repoDir, gitDir, journal, 'branch-moved');
  return { outcome: 'held', heldNow: { reason: 'branch-moved', ...where } };
}

/** The paths that hold bytes the apply wrote (or a removal it made) that HEAD lacks. */
async function bytesHeadLacks(run: GitStatusRunner, repoDir: string, ops: Op[]): Promise<string[]> {
  const suspects: Array<{ path: string; oid: string | null }> = [];
  for (const op of ops) {
    const abs = path.join(repoDir, op.path);
    if (op.do === 'write' && op.oid && op.after.kind !== 'absent' && stateIs(abs, op.after)) suspects.push({ path: op.path, oid: op.oid });
    else if (op.do === 'unlink' && stateIs(abs, { kind: 'absent' })) suspects.push({ path: op.path, oid: null });
  }
  if (suspects.length === 0) return [];
  const r = await run(['cat-file', '--batch-check'], { input: suspects.map((s) => `HEAD:${s.path}\n`).join('') });
  if (r.code !== 0) throw new Error(`git cat-file --batch-check exited ${r.code}: ${r.stderr.trim().slice(0, 300)}`);
  const lines = r.stdout.split('\n');
  return suspects.filter((s, i) => {
    const line = lines[i] ?? '';
    const inHead = line.endsWith(' missing') ? null : line.split(' ')[0];
    return inHead !== s.oid;
  }).map((s) => s.path);
}

/** Every held journal: released (removed) when nothing of it is left that HEAD lacks. */
async function settleHeld(run: GitStatusRunner, repoDir: string, gitDir: string): Promise<{ held: HeldPull[]; released: string[] }> {
  let ids: string[];
  try {
    ids = (await fsp.readdir(heldRoot(gitDir))).sort();
  } catch {
    return { held: [], released: [] };
  }
  const held: HeldPull[] = [];
  const released: string[] = [];
  for (const id of ids) {
    const dir = path.join(heldRoot(gitDir), id);
    const reason = (await fsp.readFile(path.join(dir, 'held-reason'), 'utf-8').catch(() => 'unreadable')) as HoldReason;
    const journal = await readJournal(dir).catch(() => 'unreadable' as const);
    if (journal === null || journal === 'unreadable') {
      held.push({ id, reason: 'unreadable', waiting: [path.relative(repoDir, journalPath(dir))] });
      continue;
    }
    const waiting = await bytesHeadLacks(run, repoDir, journal.ops);
    if (waiting.length === 0) {
      await fsp.rm(dir, { recursive: true, force: true });
      released.push(id);
    } else {
      held.push({ id, reason, branch: journal.branch, oldHead: journal.oldHead, target: journal.target, waiting });
    }
  }
  if (held.length === 0) await fsp.rm(heldRoot(gitDir), { recursive: true, force: true });
  return { held, released };
}

/**
 * Before any commit: finish or undo an apply that stopped without cleaning up,
 * repair an index an apply could not refresh, and settle held journals. Cheap
 * when there is nothing to do (three file checks).
 */
export async function recoverInterruptedApply(run: GitStatusRunner, repoDir: string): Promise<RecoveryReport> {
  const gitDir = path.join(repoDir, '.git');
  const [hasJournal, hasStale, hasHeld] = await Promise.all([
    exists(journalPath(applyDir(gitDir))), exists(staleIndexPath(gitDir)), exists(heldRoot(gitDir)),
  ]);
  if (!hasJournal && !hasStale && !hasHeld) return { outcome: 'clean' };
  if (applyInFlight()) return { outcome: 'busy' };
  let report: RecoveryReport = { outcome: 'clean' };
  try {
    if (hasJournal) {
      const lock = await IndexLock.acquire(gitDir, { takeDeadAfterMs: DEAD_APPLY_LOCK_MS });
      if (!lock) return { outcome: 'busy' };
      try {
        report = await recoverHeld(run, repoDir, gitDir, lock);
      } finally {
        await lock.release();
      }
      if (report.outcome === 'busy') return report;
    }
    if (await exists(staleIndexPath(gitDir))) {
      const reset = await run(['reset', '-q']);
      if (reset.code !== 0) return { ...report, outcome: 'failed', error: `git reset -q exited ${reset.code}: ${reset.stderr.trim().slice(0, 300)}` };
      await fsp.rm(staleIndexPath(gitDir), { force: true });
    }
    const { held, released } = await settleHeld(run, repoDir, gitDir);
    if (held.length > 0) return { ...report, outcome: 'held', held, released };
    return { ...report, outcome: 'recovered', released };
  } catch (error) {
    return { ...report, outcome: 'failed', error: (error instanceof Error ? error.message : String(error)).slice(0, 400) };
  }
}

/** The held journals' ids, sorted (sync: a readdir). */
export function heldIdsSync(repoDir: string): string[] {
  try {
    return fs.readdirSync(heldRoot(path.join(repoDir, '.git'))).sort();
  } catch {
    return [];
  }
}

/**
 * Right before staging (no await between this and the `git add`): an apply holds
 * the repo, or one stopped and is not settled yet. The tick's recovery ran long
 * before; a pull from gitPullWalnut can start and stop in between. `knownHeld`:
 * the held journals whose paths the caller leaves out of the commit; any other
 * held journal counts as pending (all of them when it is not given).
 */
export function applyPending(repoDir: string, knownHeld?: readonly string[]): boolean {
  const gitDir = path.join(repoDir, '.git');
  // Sync on purpose: a few stats, and an await here is the window this closes.
  if (applyInFlight() || fs.existsSync(journalPath(applyDir(gitDir)))) return true;
  const held = heldIdsSync(repoDir);
  return knownHeld ? held.join('\n') !== [...knownHeld].sort().join('\n') : held.length > 0;
}

/**
 * What each held journal last wrote at each path (its `after` state), the newest
 * journal winning: a pull may replace a path still in that state (git-sync-apply-plan.ts).
 */
export async function heldAfterStates(gitDir: string): Promise<Map<string, PathState>> {
  const states = new Map<string, PathState>();
  let ids: string[];
  try {
    ids = (await fsp.readdir(heldRoot(gitDir))).sort();
  } catch {
    return states;
  }
  for (const id of ids) {
    const journal = await readJournal(path.join(heldRoot(gitDir), id)).catch(() => null);
    if (!journal || journal === 'unreadable') continue;
    for (const op of journal.ops) if (op.do === 'write' || op.do === 'unlink') states.set(op.path, op.after);
  }
  return states;
}
