/**
 * Large-file lane for the data repo's auto-commit.
 *
 * `git add` hashes, compresses and writes every new or changed byte while it holds
 * the index lock, and the auto-commit used to give it a flat 30 s. Measured under
 * load (2026-11-24): new incompressible data stages at about 15 MB/s, and a tracked
 * file over git's big-file threshold (512 MiB) is compressed again every time it is
 * touched. So about 0.5 GB of new tracked data (a video attachment under artifacts/
 * or notes/), or one touched big file, made every `add -A` time out. A killed add
 * commits nothing, writes no index and keeps no progress, so the next tick started
 * over and timed out again: every other change in the data folder stopped syncing
 * with it (a rehearsal: 57 kills in a row, each leaving a 100+ MB temp object).
 *
 * The rule here: no amount of pending data can stop or hold the batch.
 *  - Every add's timeout is scaled to the bytes it has to hash (addTimeoutFor).
 *  - When the pending bytes are over ROUTINE_ADD_BYTE_BUDGET, the routine add takes
 *    the smallest files up to the budget and that commit goes out at once.
 *  - The rest are written into the object store in the BACKGROUND, outside the
 *    index lock and outside the tick (`hash-object -w --stdin-paths`, in batches of
 *    at most the budget, so a kill keeps every finished batch). A later tick stages
 *    the files whose objects exist and whose stat has not moved since: that add only
 *    hashes (the object is there, so nothing is compressed or written), with git's
 *    big-file threshold raised so a file over 512 MiB is not streamed into a pack
 *    again. A file that fails backs off with a doubled timeout and holds no other.
 *
 * Planning is pure and the git runner is passed in, so the tests drive it on a real
 * repo without the server.
 */
import fs from 'node:fs';
import path from 'node:path';

/** Base timeout of a local git call (the flat one every add used to get). */
export const ADD_BASE_TIMEOUT_MS = 30_000;

/**
 * Lowest rate an add is assumed to stage at: about a quarter of the 15 MB/s
 * measured for incompressible data on a loaded dev box.
 */
export const ADD_FLOOR_BYTES_PER_SEC = 4 * 1024 * 1024;

/** Bytes the routine add may take in one tick (about 32 s at the floor), and a pre-hash batch's cap. */
export const ROUTINE_ADD_BYTE_BUDGET = 128 * 1024 * 1024;

/**
 * core.bigFileThreshold for the add that stages pre-hashed files: high enough that git
 * hashes the file and finds its object instead of streaming it into a new pack.
 * Windows' git keeps it in a 32-bit long.
 */
export const STAGE_BIG_FILE_THRESHOLD = process.platform === 'win32' ? '2047m' : '1024g';

const MAX_BACKOFF_MS = 6 * 60 * 60_000;
const FIRST_BACKOFF_MS = 10 * 60_000;
/** A failed file's timeout doubles per failure, up to this many doublings. */
const MAX_TIMEOUT_DOUBLINGS = 3;

const knobs = {
  baseTimeoutMs: ADD_BASE_TIMEOUT_MS,
  floorBytesPerSec: ADD_FLOOR_BYTES_PER_SEC,
  routineBudget: ROUTINE_ADD_BYTE_BUDGET,
};

/** Test hook: shrink the budgets so a test can use small files. `null` restores them and forgets all state. */
export function setLargeFileLaneForTest(over: Partial<typeof knobs> | null): void {
  knobs.baseTimeoutMs = over?.baseTimeoutMs ?? ADD_BASE_TIMEOUT_MS;
  knobs.floorBytesPerSec = over?.floorBytesPerSec ?? ADD_FLOOR_BYTES_PER_SEC;
  knobs.routineBudget = over?.routineBudget ?? ROUTINE_ADD_BYTE_BUDGET;
  if (over === null) {
    laneFailures.clear();
    prehashed.clear();
  }
}

/** The timeout for an add that hashes `bytes`: the base plus the bytes at the floor rate. */
export function addTimeoutFor(bytes: number): number {
  const extra = Math.ceil((Math.max(0, bytes) / knobs.floorBytesPerSec) * 1000);
  return knobs.baseTimeoutMs + extra;
}

/** A path git would stage, and the bytes it would hash (0 for a deletion, a folder or a link). */
export interface PendingFile {
  path: string;
  bytes: number;
  /** In the index already (listed by diff-files): a missing one is a deletion, not an error. */
  tracked: boolean;
}

export type GitRunner = (args: string[], opts: { timeout: number; input?: string; holdsNoLock?: boolean }) => Promise<string>;

/**
 * What an `add -A` would stage, without hashing anything: tracked paths whose stat
 * changed (`diff-files` compares stat data only; a deletion is listed too) and
 * untracked paths that are not ignored. `skip` drops paths the caller never stages
 * (a replica's never-author list). Sizes from lstat; a path gone by now counts 0.
 */
export async function listPendingFiles(
  git: GitRunner,
  root: string,
  skip: (file: string) => boolean = () => false,
  opts: { untracked?: boolean } = {},
): Promise<PendingFile[]> {
  const [changed, untracked] = await Promise.all([
    git(['diff-files', '--name-only', '-z'], { timeout: knobs.baseTimeoutMs, holdsNoLock: true }),
    opts.untracked === false
      ? Promise.resolve('')
      : git(['ls-files', '-o', '--exclude-standard', '-z'], { timeout: knobs.baseTimeoutMs, holdsNoLock: true }),
  ]);
  const trackedSet = new Set(changed.split('\0').filter(Boolean));
  const names = [...new Set([...trackedSet, ...untracked.split('\0').filter(Boolean)])]
    .filter((file) => !skip(file));
  const out: PendingFile[] = [];
  for (let i = 0; i < names.length; i += 64) {
    const chunk = names.slice(i, i + 64);
    const stats = await Promise.all(chunk.map((file) => lstatFile(root, file)));
    chunk.forEach((file, index) => out.push({ path: file, bytes: stats[index]?.size ?? 0, tracked: trackedSet.has(file) }));
  }
  return out;
}

/** A regular file's lstat, or null (gone, a folder, a link). */
async function lstatFile(root: string, file: string): Promise<fs.Stats | null> {
  const stat = await fs.promises.lstat(path.join(root, file)).catch(() => null);
  return stat?.isFile() ? stat : null;
}

export interface StagePlan {
  /** Staged by the routine add, committed at once. */
  routine: PendingFile[];
  /** Over the budget: pre-hashed in the background, staged by a later tick, smallest first. */
  deferred: PendingFile[];
  routineBytes: number;
}

/**
 * Split the pending files: smallest first into the routine add until the budget is
 * spent; everything from the first file that does not fit is deferred. Pure.
 */
export function planStage(files: PendingFile[], budget = knobs.routineBudget): StagePlan {
  const sorted = [...files].sort((a, b) => a.bytes - b.bytes || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const routine: PendingFile[] = [];
  let routineBytes = 0;
  let i = 0;
  for (; i < sorted.length; i++) {
    if (routineBytes + sorted[i].bytes > budget) break;
    routineBytes += sorted[i].bytes;
    routine.push(sorted[i]);
  }
  return { routine, deferred: sorted.slice(i), routineBytes };
}

/**
 * The pathspecs (for `add -A --pathspec-from-file=- --pathspec-file-nul`) of the
 * routine add when some files are deferred: the whole tree minus the deferred ones,
 * or only the routine ones, whichever list is shorter (git matches every path
 * against every pathspec). `treeExcludes` are the caller's own exclusions of the
 * whole-tree form (a replica's never-author paths); the routine list never holds
 * those paths. Null when there is nothing to stage.
 */
export function routinePathspecs(plan: StagePlan, treeExcludes: string[]): string[] | null {
  if (plan.deferred.length <= plan.routine.length) {
    return ['.', ...treeExcludes, ...plan.deferred.map((f) => `:(exclude,literal)${f.path}`)];
  }
  if (plan.routine.length === 0) return null;
  return plan.routine.map((f) => `:(literal)${f.path}`);
}

const NO_MATCH = /did not match any files/;

/**
 * `add -A` of exactly these files (literal pathspecs on stdin). An untracked file
 * removed since it was listed (an atomic write's temp, renamed away) makes git refuse
 * the whole list ("did not match any files"): such files are dropped and the add runs
 * once more. Tracked paths stay in, missing or not: that is a deletion.
 */
export async function addListed(
  git: GitRunner,
  root: string,
  files: PendingFile[],
  opts: { timeout: number; config?: string[] },
): Promise<PendingFile[]> {
  const run = async (list: PendingFile[]): Promise<void> => {
    if (list.length === 0) return;
    await git([...(opts.config ?? []), 'add', '-A', '--pathspec-from-file=-', '--pathspec-file-nul'], {
      timeout: opts.timeout,
      input: list.map((f) => `:(literal)${f.path}`).join('\0'),
    });
  };
  try {
    await run(files);
    return files;
  } catch (error) {
    if (!NO_MATCH.test(error instanceof Error ? error.message : String(error))) throw error;
    const present = await presentOrTracked(root, files);
    await run(present);
    return present;
  }
}

async function presentOrTracked(root: string, files: PendingFile[]): Promise<PendingFile[]> {
  const keep = await Promise.all(files.map(async (f) => f.tracked
    || (await fs.promises.lstat(path.join(root, f.path)).then(() => true, () => false))));
  return files.filter((_, i) => keep[i]);
}

interface LaneFailure {
  bytes: number;
  failures: number;
  nextTryAt: number;
  lastError: string;
}

interface Prehashed {
  bytes: number;
  mtimeMs: number;
  ctimeMs: number;
  /** The object hash-object wrote: checked to still exist before staging (a gc may prune it). */
  oid: string;
}

/** Per path: files whose pre-hash failed, for backoff. In memory: a restart retries at once. */
const laneFailures = new Map<string, LaneFailure>();
/** Per path: files whose object is in the store, with the stat it was hashed at. */
const prehashed = new Map<string, Prehashed>();
let prehashJob: Promise<void> | null = null;

/** Test and status read: the lane's failed files. */
export function largeLaneFailures(): ReadonlyMap<string, Readonly<LaneFailure>> {
  return laneFailures;
}

/** Test read: the background pre-hash still running, if any. */
export function prehashInFlight(): Promise<void> | null {
  return prehashJob;
}

/** The oids of these that the object store no longer has (`cat-file --batch-check`, no lock). */
async function missingObjects(git: GitRunner, oids: string[]): Promise<Set<string>> {
  if (oids.length === 0) return new Set();
  try {
    const out = await git(['cat-file', '--batch-check'], { timeout: knobs.baseTimeoutMs, input: oids.join('\n') + '\n', holdsNoLock: true });
    return new Set(out.split('\n').filter((l) => / missing$/.test(l.trim())).map((l) => l.trim().split(' ')[0]));
  } catch {
    return new Set();
  }
}

function sameStat(record: Prehashed | undefined, stat: fs.Stats | null): boolean {
  return !!record && !!stat && record.bytes === stat.size && record.mtimeMs === stat.mtimeMs && record.ctimeMs === stat.ctimeMs;
}

/** Batches of at most the budget, smallest first; a file over the budget is a batch alone. */
export function batchByBytes(files: PendingFile[], budget = knobs.routineBudget): PendingFile[][] {
  const batches: PendingFile[][] = [];
  let current: PendingFile[] = [];
  let bytes = 0;
  for (const f of files) {
    if (current.length > 0 && bytes + f.bytes > budget) {
      batches.push(current);
      current = [];
      bytes = 0;
    }
    current.push(f);
    bytes += f.bytes;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

function recordFailure(file: PendingFile, error: unknown, now: number): { path: string; bytes: number; failures: number; error: string } {
  const prior = laneFailures.get(file.path);
  const failures = (prior && prior.bytes === file.bytes ? prior.failures : 0) + 1;
  const message = (error instanceof Error ? error.message : String(error)).slice(0, 300);
  laneFailures.set(file.path, {
    bytes: file.bytes,
    failures,
    nextTryAt: now + Math.min(FIRST_BACKOFF_MS * 2 ** (failures - 1), MAX_BACKOFF_MS),
    lastError: message,
  });
  return { path: file.path, bytes: file.bytes, failures, error: message };
}

export interface LaneResult {
  /** Staged now: their objects were written in the background earlier. */
  staged: string[];
  /** Waiting for their background write (or its backoff); a later tick takes them. */
  left: string[];
  failed: Array<{ path: string; bytes: number; failures: number; error: string }>;
  /** A background write started on this call. */
  started: boolean;
}

/**
 * One tick of the lane: stage the deferred files that are written already and have
 * not changed since (an add that only hashes), then start the background write of the
 * rest when none runs. Never throws for a file: a failing one backs off.
 */
export async function runLargeFileLane(
  git: GitRunner,
  root: string,
  deferred: PendingFile[],
  opts: {
    now?: () => number;
    onFailure?: (failure: LaneResult['failed'][number]) => void;
    /** Checked before each background batch: sync paused, compaction running, server stopping. */
    shouldStop?: () => boolean;
  } = {},
): Promise<LaneResult> {
  const now = opts.now ?? Date.now;
  const result: LaneResult = { staged: [], left: [], failed: [], started: false };
  let ready: PendingFile[] = [];
  const todo: PendingFile[] = [];
  for (const file of deferred) {
    const stat = await lstatFile(root, file.path);
    // A name with a line break cannot go through --stdin-paths: staged directly (rare).
    if (sameStat(prehashed.get(file.path), stat) || /[\r\n]/.test(file.path)) ready.push(file);
    else {
      prehashed.delete(file.path);
      todo.push(file);
    }
  }
  // An object a gc pruned since (compaction's --prune=now, or a staging that slipped
  // past the weekly gc's hour) would make the stage add write it in the tick: back to
  // the background instead.
  const gone = await missingObjects(git, ready.map((f) => prehashed.get(f.path)?.oid).filter((o): o is string => !!o));
  if (gone.size > 0) {
    ready = ready.filter((f) => {
      const oid = prehashed.get(f.path)?.oid;
      if (!oid || !gone.has(oid)) return true;
      prehashed.delete(f.path);
      todo.push(f);
      return false;
    });
  }
  const stage = async (files: PendingFile[]): Promise<void> => {
    const added = await addListed(git, root, files, {
      timeout: addTimeoutFor(files.reduce((sum, f) => sum + f.bytes, 0)),
      config: ['-c', `core.bigFileThreshold=${STAGE_BIG_FILE_THRESHOLD}`],
    });
    for (const f of added) {
      result.staged.push(f.path);
      prehashed.delete(f.path);
      laneFailures.delete(f.path);
    }
  };
  if (ready.length > 0) {
    try {
      await stage(ready);
    } catch (error) {
      // One bad path (ignored, unreadable or a folder by now) fails the whole list:
      // each file alone, so only that one backs off.
      for (const f of ready.length > 1 ? ready : []) {
        try {
          await stage([f]);
        } catch (single) {
          prehashed.delete(f.path);
          const failure = recordFailure(f, single, now());
          result.failed.push(failure);
          opts.onFailure?.(failure);
        }
      }
      if (ready.length === 1) {
        prehashed.delete(ready[0].path);
        const failure = recordFailure(ready[0], error, now());
        result.failed.push(failure);
        opts.onFailure?.(failure);
      }
    }
  }
  const due = todo.filter((f) => {
    const failure = laneFailures.get(f.path);
    if (failure && failure.bytes !== f.bytes) laneFailures.delete(f.path);
    return (laneFailures.get(f.path)?.nextTryAt ?? 0) <= now();
  });
  result.left = todo.map((f) => f.path);
  if (due.length > 0 && !prehashJob) {
    result.started = true;
    prehashJob = prehashInBackground(git, root, due, now, opts.onFailure, opts.shouldStop).finally(() => { prehashJob = null; });
  }
  // Paths no longer pending (committed, deleted, ignored now) drop their records.
  const pending = new Set(deferred.map((f) => f.path));
  for (const key of laneFailures.keys()) if (!pending.has(key)) laneFailures.delete(key);
  for (const key of prehashed.keys()) if (!pending.has(key)) prehashed.delete(key);
  return result;
}

/**
 * Write the objects of these files, batch by batch, holding no lock. The stat is
 * read before and after each file's write; a file that moved meanwhile is not
 * recorded (the next tick lists it again). A batch that fails is tried file by file,
 * so one bad file costs only itself.
 */
async function prehashInBackground(
  git: GitRunner,
  root: string,
  files: PendingFile[],
  now: () => number,
  onFailure?: (failure: LaneResult['failed'][number]) => void,
  shouldStop: () => boolean = () => false,
): Promise<void> {
  const hashBatch = async (batch: PendingFile[]): Promise<void> => {
    const before = await Promise.all(batch.map((f) => lstatFile(root, f.path)));
    const present = batch.filter((_, i) => before[i]);
    if (present.length === 0) return;
    const doublings = Math.min(Math.max(...present.map((f) => laneFailures.get(f.path)?.failures ?? 0)), MAX_TIMEOUT_DOUBLINGS);
    const bytes = present.reduce((sum, f) => sum + (before[batch.indexOf(f)]?.size ?? f.bytes), 0);
    const out = await git(['hash-object', '-w', '--stdin-paths'], {
      timeout: addTimeoutFor(bytes) * 2 ** doublings,
      input: present.map((f) => f.path).join('\n') + '\n',
      holdsNoLock: true,
    });
    const oids = out.split('\n').map((l) => l.trim());
    for (const [index, f] of present.entries()) {
      const pre = before[batch.indexOf(f)];
      const post = await lstatFile(root, f.path);
      const oid = oids[index];
      if (!oid || !pre || !post || pre.size !== post.size || pre.mtimeMs !== post.mtimeMs || pre.ctimeMs !== post.ctimeMs) continue;
      prehashed.set(f.path, { bytes: post.size, mtimeMs: post.mtimeMs, ctimeMs: post.ctimeMs, oid });
      laneFailures.delete(f.path);
    }
  };
  for (const batch of batchByBytes(files)) {
    if (shouldStop()) return;
    try {
      await hashBatch(batch);
    } catch (error) {
      if (batch.length === 1) {
        const failure = recordFailure(batch[0], error, now());
        onFailure?.(failure);
        continue;
      }
      for (const f of batch) {
        try {
          await hashBatch([f]);
        } catch (single) {
          const failure = recordFailure(f, single, now());
          onFailure?.(failure);
        }
      }
    }
  }
}
