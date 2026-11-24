/**
 * Move the data repo's working tree from HEAD to a pull's target commit without
 * a store ever holding something no writer wrote.
 *
 * The live server reads and writes the JSON stores in this working tree while a
 * pull runs. Letting git check the target out (`pull`, `merge`, `rebase`,
 * `reset --hard`) writes each file in place, so for a moment a reader can find
 * it missing, half written, holding conflict markers, or holding the other
 * side's older version; and a file the app wrote since the last auto-commit can
 * be overwritten. Here, for the paths that differ between HEAD and the target:
 *
 *  1. Plan every path first (git-sync-apply-plan.ts). A file must still be HEAD's blob (or absent where
 *     HEAD has none), or already the target's. An untracked file or directory in
 *     the way is cleared only when every file in it is ignored (as git does), and
 *     a machine-local file (config.yaml, secrets/, ...) is never replaced or
 *     removed. Anything else is a write since the last commit: nothing is written
 *     and the pull is deferred (the next tick commits that write and pulls again).
 *  2. Write each new version to a temp file, back up every file the apply
 *     replaces or removes, and journal every step (git-sync-apply-journal.ts).
 *  3. Re-check every path, the lock and the branch, synchronously, right before
 *     the first change; then each step re-checks its path right before its
 *     rename or unlink (a rename is atomic: a reader sees the old file or the new
 *     one, never a part). A path that changes part way rolls the whole apply back.
 *  4. Move the branch with a compare-and-swap (refused: rolled back too) and
 *     refresh the index without touching the tree.
 *
 * `.git/index.lock` is held throughout, so no `git add` or commit can snapshot a
 * half-applied tree, and a process that dies part way leaves the journal for the
 * next tick to undo before any commit. A repo whose checkout converts content (a
 * filter, eol, an ident attribute, autocrlf) or a case-only rename is handed back
 * as `needs-git`: only git itself can write those correctly.
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { must, type GitStatusRunner } from './git-sync-rewrite-carry.js';
import { closeWrites, openWrites } from '../utils/write-gate.js';
import {
  IndexLock, NOT_THERE, backUp, clearApplyDir, errCode, markIndexStale, refreshIndex, resetApplyDir,
  rollBack, stampOf, stateIs, tempName, writeDrainMsNow, writeJournal, type Op, type PathState, type RollbackResult,
} from './git-sync-apply-journal.js';
import { heldAfterStates, recoverHeld } from './git-sync-apply-recovery.js';
import {
  RacedError, conversionReason, inspect, kindOf, planApply, readChanges, unsafePath, type Change, type Seen,
} from './git-sync-apply-plan.js';

export { applyInFlight, setWriteDrainForTest } from './git-sync-apply-journal.js';
export { applyPending, recoverInterruptedApply, type HeldPull, type RecoveryReport } from './git-sync-apply-recovery.js';

export type GitRawRunner = (
  args: string[], opts?: { input?: string; stdoutFd?: number; timeout?: number },
) => Promise<{ code: number; stdout: Buffer; stderr: string }>;

export interface ApplyGit { run: GitStatusRunner; raw: GitRawRunner }

export interface ApplyRequest {
  repoDir: string;
  branch: string;
  oldHead: string;
  target: string;
  /** Machine-local paths (config.yaml, secrets/, ...): one on disk is never replaced or removed by a pull. */
  isMachineLocal?: (file: string) => boolean;
}

export type ApplyOutcome =
  | {
    status: 'applied';
    changed: number;
    /** Ignored local files the pull replaced or cleared out of its way, as git would. */
    overwroteIgnored: string[];
    /** Machine-local files kept as they are where the target has another version. */
    keptLocal: string[];
    /** The branch moved but the index could not follow: `git reset -q` runs on the next tick. */
    indexStale: boolean;
  }
  /**
   * The branch did not move, and the tree holds nothing of the target. `dirty`: a
   * path held a write newer than the last commit, or something untracked stood in
   * the way (nothing was written). `raced`: a path changed during the apply, and
   * every path the apply had changed was put back (`rollback`). `locked`: another
   * git holds the index. `moved`: the branch moved meanwhile. `busy`: the app's
   * renames under way did not finish in time (write-gate.ts), or an interrupted
   * apply could not be settled yet.
   */
  | { status: 'deferred'; reason: 'dirty' | 'raced' | 'locked' | 'moved' | 'busy'; files: string[]; rollback?: RollbackResult }
  | { status: 'needs-git'; reason: string };

/** Blobs up to this size travel in one `cat-file --batch`; larger ones stream straight to their temp file. */
const BATCH_BLOB_MAX = 8 * 1024 * 1024;
const BATCH_BYTES_MAX = 64 * 1024 * 1024;
/** Steps run between two yields to the event loop. */
const YIELD_EVERY = 100;

/** The permission bits a written file gets: the existing file's kept, new files private. */
function fileMode(c: Change, s: Seen): number {
  const exec = c.to?.mode === '100755';
  if (s.kind !== 'file') return exec ? 0o700 : 0o600;
  const bits = Number(s.stat.mode & 0o7777n);
  if (exec) return bits & 0o111 ? bits : bits | 0o100;
  // 100755 -> 100644 in the tree: git takes the exec bits off; otherwise the file keeps its own bits.
  return c.from?.mode === '100755' ? bits & ~0o111 : bits;
}

/** The nearest directory at or above `rel` that exists as a real directory now (a temp file waits there). */
async function nearestRealDir(repoDir: string, rel: string): Promise<string> {
  for (let dir = rel; dir !== '.' && dir !== ''; dir = path.posix.dirname(dir)) {
    const parts = dir.split('/');
    let ok = true;
    for (let i = 1; ok && i <= parts.length; i++) {
      ok = await fsp.lstat(path.join(repoDir, ...parts.slice(0, i))).then((s) => s.isDirectory(), () => false);
    }
    if (ok) return dir;
  }
  return '.';
}

/**
 * Every new version into a temp file beside (or above) its path, batch by
 * batch: a batch's blobs are written out and dropped before the next is read.
 * Returns path -> its temp and the temp's state.
 */
async function prepare(
  git: ApplyGit, repoDir: string, writes: Change[], seen: Map<string, Seen>, temps: Set<string>,
): Promise<Map<string, { temp: string; after: PathState }>> {
  const out = new Map<string, { temp: string; after: PathState }>();
  const byOid = new Map<string, Change[]>();
  for (const c of writes) {
    const same = byOid.get(c.to!.oid);
    if (same) same.push(c); else byOid.set(c.to!.oid, [c]);
  }
  if (byOid.size === 0) return out;
  const sizes = new Map<string, number>();
  const check = (await must(git.run, ['cat-file', '--batch-check'], { input: `${[...byOid.keys()].join('\n')}\n` })).split('\n');
  for (const line of check) {
    const [oid, type, size] = line.split(' ');
    if (!oid) continue;
    if (type !== 'blob') throw new Error(`target object ${oid} is ${type ?? 'missing'}, not a blob`);
    sizes.set(oid, Number(size));
  }

  const writeTemp = async (c: Change, body: Buffer | null): Promise<void> => {
    const to = c.to!;
    const temp = path.join(repoDir, await nearestRealDir(repoDir, path.posix.dirname(c.path)), tempName());
    temps.add(temp);
    if (kindOf(to.mode) === 'link') {
      await fsp.symlink(body ?? Buffer.alloc(0), temp);
    } else {
      const mode = fileMode(c, seen.get(c.path)!);
      const handle = await fsp.open(temp, 'wx', mode);
      try {
        if (body) {
          await handle.writeFile(body);
        } else {
          const r = await git.raw(['cat-file', 'blob', to.oid], { stdoutFd: handle.fd, timeout: 10 * 60_000 });
          if (r.code !== 0) throw new Error(`git cat-file blob ${to.oid} failed: ${r.stderr.trim().slice(0, 300)}`);
        }
        if ((await handle.stat()).size !== sizes.get(to.oid)) throw new Error(`short write of ${c.path}`);
      } finally {
        await handle.close();
      }
      await fsp.chmod(temp, mode);
    }
    const st = await fsp.lstat(temp, { bigint: true });
    out.set(c.path, { temp, after: { kind: kindOf(to.mode) === 'link' ? 'link' : 'file', ...stampOf(st) } });
  };

  const small = [...byOid.keys()].filter((oid) => (sizes.get(oid) ?? 0) <= BATCH_BLOB_MAX);
  for (let i = 0; i < small.length;) {
    const batch: string[] = [];
    for (let bytes = 0; i < small.length && (batch.length === 0 || bytes + sizes.get(small[i])! <= BATCH_BYTES_MAX); i++) {
      bytes += sizes.get(small[i])!;
      batch.push(small[i]);
    }
    const r = await git.raw(['cat-file', '--batch'], { input: `${batch.join('\n')}\n` });
    if (r.code !== 0) throw new Error(`git cat-file --batch failed (${r.code}): ${r.stderr.trim().slice(0, 300)}`);
    for (let off = 0; off < r.stdout.length;) {
      const nl = r.stdout.indexOf(10, off);
      const [oid, , size] = r.stdout.toString('utf-8', off, nl).split(' ');
      const body = r.stdout.subarray(nl + 1, nl + 1 + Number(size));
      for (const c of byOid.get(oid) ?? []) await writeTemp(c, body);
      off = nl + 1 + Number(size) + 1;
    }
  }
  for (const oid of byOid.keys()) {
    if ((sizes.get(oid) ?? 0) > BATCH_BLOB_MAX) for (const c of byOid.get(oid)!) await writeTemp(c, null);
  }
  return out;
}

/** The branch's commit read straight from the ref files (no spawn, so no await): null when it cannot tell. */
function branchOidSync(gitDir: string, branch: string): string | null {
  try {
    const head = fs.readFileSync(path.join(gitDir, 'HEAD'), 'utf-8').trim();
    if (head !== `ref: refs/heads/${branch}`) return head;
    if (fs.existsSync(path.join(gitDir, 'reftable'))) return null;
    try {
      return fs.readFileSync(path.join(gitDir, 'refs', 'heads', ...branch.split('/')), 'utf-8').trim();
    } catch (error) {
      if (!NOT_THERE.has(errCode(error))) return null;
    }
    const line = fs.readFileSync(path.join(gitDir, 'packed-refs'), 'utf-8').split('\n').find((l) => l.endsWith(` refs/heads/${branch}`));
    return line ? line.split(' ')[0] : '';
  } catch {
    return null;
  }
}

/** Remove the directories the unlinks left empty, as git does, up to the repo root. */
function pruneEmptyDirsSync(repoDir: string, ops: Op[]): void {
  for (const op of ops) {
    if (op.do !== 'unlink') continue;
    for (let dir = path.posix.dirname(op.path); dir !== '.' && dir !== ''; dir = path.posix.dirname(dir)) {
      try { fs.rmdirSync(path.join(repoDir, dir)); } catch { break; }
    }
  }
}

/**
 * Thrown by the test hook: the apply stops as a killed process would (no
 * rollback; journal and lock stay). The hook is asked with -1 right before the
 * app's writes are paused, before each step, and with the step count once the
 * branch moved.
 */
export class ApplyInterruptedForTest extends Error {}
let interruptForTest: ((step: number) => boolean) | null = null;
export function setApplyInterruptForTest(fn: ((step: number) => boolean) | null): void {
  interruptForTest = fn;
}

/**
 * Move the working tree of `repoDir` from `oldHead` to `target` and its branch
 * with it (see the header). Throws only on a git or filesystem failure; the
 * branch has not moved then, and the tree is as it was (or, when even the
 * rollback failed, the journal stays for the next tick's recovery).
 */
export async function applyTargetToWorktree(git: ApplyGit, req: ApplyRequest): Promise<ApplyOutcome> {
  const gitDir = path.join(req.repoDir, '.git');
  const lock = await IndexLock.acquire(gitDir);
  if (!lock) return { status: 'deferred', reason: 'locked', files: [] };
  let outcome: ApplyOutcome;
  try {
    outcome = await applyHeld(git, req, gitDir, lock);
  } catch (error) {
    if (error instanceof ApplyInterruptedForTest) lock.abandonForTest();
    throw error;
  } finally {
    await lock.release();
  }
  if (outcome.status === 'applied' && outcome.indexStale) {
    const reset = await git.run(['reset', '-q']).catch(() => null);
    if (reset?.code === 0) outcome.indexStale = false;
    else await markIndexStale(gitDir, req.target);
  }
  return outcome;
}

async function applyHeld(git: ApplyGit, req: ApplyRequest, gitDir: string, lock: IndexLock): Promise<ApplyOutcome> {
  const { repoDir, branch, oldHead, target } = req;
  const at = (rel: string): string => path.join(repoDir, rel);
  // An apply that died left its journal: undo (or finish) it first, and the caller's
  // plan is then stale. One that cannot be settled is held aside (commits wait, pulls go on).
  const earlier = await recoverHeld(git.run, repoDir, gitDir, lock);
  if (earlier.outcome === 'busy') return { status: 'deferred', reason: 'busy', files: [] };
  if (earlier.outcome === 'recovered') return { status: 'deferred', reason: 'moved', files: [] };
  if ((await must(git.run, ['rev-parse', 'HEAD'])).trim() !== oldHead) return { status: 'deferred', reason: 'moved', files: [] };
  const changes = (await readChanges(git.run, oldHead, target))
    // A submodule's own checkout is not this repo's to write; the index still records it.
    .filter((c) => kindOf((c.to ?? c.from)!.mode) !== 'gitlink' && kindOf((c.from ?? c.to)!.mode) !== 'gitlink');
  const unsafe = changes.find((c) => unsafePath(c.path));
  if (unsafe) throw new Error(`refusing to write an unsafe path from the pull: ${JSON.stringify(unsafe.path)}`);
  const needsGit = await conversionReason(git.run, changes);
  if (needsGit) return { status: 'needs-git', reason: needsGit };

  let seen: Map<string, Seen>;
  try {
    seen = await inspect(git.run, repoDir, changes, oldHead.length);
  } catch (error) {
    if (error instanceof RacedError) return { status: 'deferred', reason: 'dirty', files: [error.file] };
    throw error;
  }
  const heldAfter = await heldAfterStates(gitDir);
  const heldPulled = (p: string): boolean => {
    const state = heldAfter.get(p);
    return state !== undefined && state.kind !== 'dir' && stateIs(at(p), state);
  };
  const plan = await planApply(git.run, repoDir, changes, seen, req.isMachineLocal ?? (() => false), heldPulled);
  if (plan.blocked.length > 0) return { status: 'deferred', reason: 'dirty', files: plan.blocked };

  const temps = new Set<string>();
  let keepJournal = false;
  let mutating = false;
  let gateClosed = false;
  let killed = false; // the test hook's stand-in for a dead process: no cleanup at all
  const undo = async (reason: 'raced' | 'moved' | 'locked', files: string[]): Promise<ApplyOutcome> => {
    // The gate opens after the rename loop (an update-ref spawn can take seconds on a
    // loaded machine); a rollback after it closes it again. A write that landed in
    // between is the app's newest and the rollback leaves it (it decides by state).
    if (!gateClosed) {
      if (!(await closeWrites(writeDrainMsNow()))) {
        keepJournal = true; // the next tick's recovery rolls back, before any commit
        return { status: 'deferred', reason: 'busy', files };
      }
      gateClosed = true;
    }
    const rollback = await rollBack(repoDir, gitDir, plan.ops);
    keepJournal = rollback.failed.length > 0; // the next tick's recovery tries again before any commit
    return { status: 'deferred', reason, files, rollback };
  };
  try {
    await resetApplyDir(gitDir);
    const written = await prepare(git, repoDir, plan.writes, seen, temps);
    let backups = 0;
    for (const op of plan.ops) {
      if (op.do === 'write') {
        const w = written.get(op.path)!;
        op.temp = path.relative(repoDir, w.temp);
        op.after = w.after;
      }
      if (op.before.kind === 'file') {
        op.before.backup = `b${backups++}`;
        await backUp(gitDir, at(op.path), op.before.backup);
      }
    }
    await writeJournal(gitDir, { version: 1, branch, oldHead, target, startedAt: Date.now(), ops: plan.ops });

    // The app's own writes pause from here to the end of the rename loop: a rename it
    // already handed to the thread pool lands first, so the checks below see it, and
    // none lands between a check and its step (write-gate.ts).
    if (interruptForTest?.(-1)) throw new ApplyInterruptedForTest('interrupted before the writes closed');
    if (!(await closeWrites(writeDrainMsNow()))) return { status: 'deferred', reason: 'busy', files: [] };
    gateClosed = true;

    // Last look, synchronous from here to the first change: the lock, the branch,
    // and every path as planned (a path below an earlier step's is that step's to check).
    if (!lock.owned()) return { status: 'deferred', reason: 'locked', files: [] };
    const head = branchOidSync(gitDir, branch);
    if (head !== null && head !== oldHead) return { status: 'deferred', reason: 'moved', files: [] };
    const planned = new Set<string>();
    for (const op of plan.ops) {
      let below = false;
      for (let d = path.posix.dirname(op.path); !below && d !== '.'; d = path.posix.dirname(d)) below = planned.has(d);
      if (!below && !planned.has(op.path) && !stateIs(at(op.path), op.before)) {
        return { status: 'deferred', reason: 'dirty', files: [op.path] };
      }
      planned.add(op.path);
    }

    // The tree moves here. Each check and its step run back to back (no await
    // between): the window a writer could slip into is microseconds.
    mutating = true;
    for (let i = 0; i < plan.ops.length; i++) {
      if (interruptForTest?.(i)) throw new ApplyInterruptedForTest(`interrupted before step ${i}`);
      const op = plan.ops[i];
      const abs = at(op.path);
      if (!stateIs(abs, op.before)) return await undo('raced', [op.path]);
      try {
        if (op.do === 'unlink') fs.unlinkSync(abs);
        else if (op.do === 'rmdir') fs.rmdirSync(abs);
        else if (op.do === 'mkdir') fs.mkdirSync(abs);
        else { fs.renameSync(at(op.temp!), abs); temps.delete(at(op.temp!)); }
      } catch (error) {
        // Something appeared in a directory being cleared, or where a directory goes.
        if (['ENOTEMPTY', 'EEXIST', 'ENOTDIR', 'EISDIR', 'ENOENT'].includes(errCode(error))) return await undo('raced', [op.path]);
        throw error;
      }
      if ((i + 1) % YIELD_EVERY === 0) {
        await new Promise((r) => setImmediate(r));
        if (!lock.owned()) return await undo('locked', []);
      }
    }
    pruneEmptyDirsSync(repoDir, plan.ops);
    openWrites();
    gateClosed = false;

    const moved = await git.run(['update-ref', '-m', 'git-sync: pull', `refs/heads/${branch}`, target, oldHead]).catch(() => null);
    if (!moved || moved.code !== 0) {
      // A timed-out update-ref may still have landed: read the branch before undoing anything.
      const now = await git.run(['rev-parse', '--verify', '-q', `refs/heads/${branch}`]).catch(() => null);
      if (!now) { keepJournal = true; throw new Error('could not read the branch after its update-ref failed'); }
      if (now.code !== 0 || now.stdout.trim() !== target) return await undo('moved', []);
    }
    if (interruptForTest?.(plan.ops.length)) throw new ApplyInterruptedForTest('interrupted after the branch moved');
    const indexed = await refreshIndex(git.run, gitDir, target, lock);
    return {
      status: 'applied',
      changed: plan.ops.filter((o) => o.do === 'write' || o.do === 'unlink').length,
      overwroteIgnored: plan.overwroteIgnored,
      keptLocal: plan.keptLocal,
      indexStale: !indexed,
    };
  } catch (error) {
    if (error instanceof ApplyInterruptedForTest) { keepJournal = true; killed = true; }
    else if (mutating && !keepJournal) {
      if (!gateClosed) gateClosed = await closeWrites(writeDrainMsNow());
      // Without the gate the next tick's recovery rolls back instead, before any commit.
      keepJournal = !gateClosed || (await rollBack(repoDir, gitDir, plan.ops)).failed.length > 0;
    }
    throw error;
  } finally {
    if (gateClosed) openWrites();
    if (!killed) for (const tmp of temps) await fsp.rm(tmp, { force: true }).catch(() => undefined);
    if (!keepJournal) await clearApplyDir(gitDir).catch(() => undefined);
  }
}
