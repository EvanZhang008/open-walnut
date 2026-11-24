/**
 * Large tracked data never stops the data repo's auto-commit (2026-11-24).
 *
 * The auto-commit's `add -A` had a flat 30 s. About 0.5 GB of new tracked data
 * (a video under artifacts/) or one touched file over 512 MiB took it past that,
 * and a killed add commits nothing and keeps no progress: every tick timed out
 * again and every other change stopped syncing with it (a rehearsal: 57 kills in a
 * row). On the Mac, 15 `git add -A` timeouts in three days (2026-11-21 to 23).
 *
 * The fix (src/integrations/git-sync-large-files.ts): every add's timeout scales
 * with the bytes it hashes; over the routine budget the smallest files commit first
 * and the rest are staged one at a time, each on its own, so one file that fails
 * holds nothing else back. A real git repo in an isolated WALNUT_HOME, driven
 * through the real entry point (commitIfDirty); budgets shrunk so files stay small.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { createMockConstants } from '../helpers/mock-constants.js';

vi.mock('../../src/constants.js', () => createMockConstants('walnut-large-files-git'));

import { clearStaleLock, commitIfDirty, execGitArgsGroup, initSync } from '../../src/integrations/git-sync.js';
import {
  ADD_BASE_TIMEOUT_MS,
  ADD_FLOOR_BYTES_PER_SEC,
  addTimeoutFor,
  largeLaneFailures,
  STAGE_BIG_FILE_THRESHOLD,
  addListed,
  batchByBytes,
  planStage,
  prehashInFlight,
  routinePathspecs,
  runLargeFileLane,
  setLargeFileLaneForTest,
  type GitRunner,
} from '../../src/integrations/git-sync-large-files.js';
import { WALNUT_HOME } from '../../src/constants.js';

const KB = 1024;

function gitOut(args: string): string {
  return execSync(`git ${args}`, { cwd: WALNUT_HOME, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
}

function write(rel: string, content: string | Buffer): void {
  const full = path.join(WALNUT_HOME, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

/** Files of each commit since `base`, oldest first. */
function commitsSince(base: string): Array<{ subject: string; files: string[] }> {
  const ids = gitOut(`rev-list --reverse ${base}..HEAD`).split('\n').filter(Boolean);
  return ids.map((id) => ({
    subject: gitOut(`log -1 --format=%s ${id}`),
    files: gitOut(`show --format= --name-only ${id}`).split('\n').filter(Boolean).sort(),
  }));
}

const realGit: GitRunner = async (args, opts) =>
  execSync(['git', ...args.map((a) => `'${a.replace(/'/g, "'\\''")}'`)].join(' '), { cwd: WALNUT_HOME, encoding: 'utf-8', input: opts.input, stdio: ['pipe', 'pipe', 'pipe'] }).trim();

const canDenyRead = typeof process.getuid === 'function' && process.getuid() !== 0;

beforeEach(async () => {
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true });
  await fsp.mkdir(WALNUT_HOME, { recursive: true });
  initSync();
  write('seed.txt', 'seed\n');
  gitOut('add -A');
  gitOut('commit -q -m seed');
  setLargeFileLaneForTest({ routineBudget: 64 * KB });
});

afterEach(async () => {
  setLargeFileLaneForTest(null);
  vi.restoreAllMocks();
  await fsp.chmod(path.join(WALNUT_HOME, 'artifacts', 'video.bin'), 0o644).catch(() => undefined);
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true });
});

describe('the plan', () => {
  it('scales an add timeout with the bytes it hashes', () => {
    setLargeFileLaneForTest(null);
    expect(addTimeoutFor(0)).toBe(ADD_BASE_TIMEOUT_MS);
    // 1 GiB at the 4 MiB/s floor: 256 s more than the base.
    expect(addTimeoutFor(1024 * 1024 * 1024)).toBe(ADD_BASE_TIMEOUT_MS + (1024 / 4) * 1000);
    expect(ADD_FLOOR_BYTES_PER_SEC).toBeLessThan(15 * 1000 * 1000);
  });

  it('takes the smallest files up to the budget and defers the rest, largest last', () => {
    const plan = planStage([
      { path: 'big', bytes: 900, tracked: false },
      { path: 'gone', bytes: 0, tracked: false },
      { path: 'a', bytes: 10, tracked: false },
      { path: 'mid', bytes: 95, tracked: false },
      { path: 'b', bytes: 20, tracked: false },
    ], 100);
    expect(plan.routine.map((f) => f.path)).toEqual(['gone', 'a', 'b']);
    expect(plan.deferred.map((f) => f.path)).toEqual(['mid', 'big']);
    expect(plan.routineBytes).toBe(30);
  });

  it('names the shorter pathspec list: the whole tree minus the deferred, or only the routine files', () => {
    const few = planStage([{ path: 'a', bytes: 1, tracked: false }, { path: 'b', bytes: 1, tracked: false }, { path: 'v*.bin', bytes: 500, tracked: false }], 10);
    expect(routinePathspecs(few, [':(exclude)human-inbox'])).toEqual(['.', ':(exclude)human-inbox', ':(exclude,literal)v*.bin']);
    const many = planStage([{ path: 'a', bytes: 1, tracked: false }, { path: 'x', bytes: 50, tracked: false }, { path: 'y', bytes: 60, tracked: false }], 10);
    expect(routinePathspecs(many, [':(exclude)human-inbox'])).toEqual([':(literal)a']);
    expect(routinePathspecs(planStage([{ path: 'x', bytes: 50, tracked: false }], 10), [])).toBeNull();
  });
});

describe('the large-file lane', () => {
  /** A fake git: records calls; hash-object fails for the paths in `failing`. */
  /** A fake git: records calls; hash-object fails for `failing` paths, cat-file reports `pruned` oids missing. */
  function fakeGit(failing: Set<string>, pruned = new Set<string>()) {
    const calls: Array<{ args: string[]; timeout: number; input?: string; holdsNoLock?: boolean }> = [];
    const lines = (input?: string) => (input ?? '').split('\n').filter(Boolean);
    const git: GitRunner = async (args, opts) => {
      if (args[0] === 'cat-file') return lines(opts.input).map((oid) => (pruned.has(oid) ? `${oid} missing` : `${oid} blob 1`)).join('\n');
      calls.push({ args, ...opts });
      if (args[0] === 'hash-object') {
        if (lines(opts.input).some((p) => failing.has(p))) throw new Error('git timed out after 1ms (process group killed)');
        return lines(opts.input).map((p) => `oid-of-${p}`).join('\n');
      }
      return '';
    };
    return { git, calls };
  }

  it('writes objects in the background, holding no lock, then stages them with an add that only hashes', async () => {
    write('clip.mp4', Buffer.alloc(100 * KB, 1));
    write('doc.pdf', Buffer.alloc(200 * KB, 2));
    const deferred = [{ path: 'clip.mp4', bytes: 100 * KB, tracked: false }, { path: 'doc.pdf', bytes: 200 * KB, tracked: false }];
    const { git, calls } = fakeGit(new Set());

    const first = await runLargeFileLane(git, WALNUT_HOME, deferred);
    expect(first.staged).toEqual([]);
    expect(first.started).toBe(true);
    await prehashInFlight();
    const hashes = calls.filter((c) => c.args[0] === 'hash-object');
    // Batches of at most the budget (64 KB here): each file over it is a batch alone.
    expect(hashes.map((c) => c.input)).toEqual(['clip.mp4\n', 'doc.pdf\n']);
    expect(hashes.every((c) => c.holdsNoLock)).toBe(true);

    calls.length = 0;
    const second = await runLargeFileLane(git, WALNUT_HOME, deferred);
    expect(second.staged).toEqual(['clip.mp4', 'doc.pdf']);
    expect(calls).toHaveLength(1);
    expect(calls[0].args.slice(0, 3)).toEqual(['-c', `core.bigFileThreshold=${STAGE_BIG_FILE_THRESHOLD}`, 'add']);
    expect(calls[0].input).toBe(':(literal)clip.mp4\0:(literal)doc.pdf');
  });

  it('writes an object a gc pruned again in the background instead of in the tick', async () => {
    write('clip.mp4', Buffer.alloc(100 * KB, 1));
    const deferred = [{ path: 'clip.mp4', bytes: 100 * KB, tracked: false }];
    const pruned = new Set<string>();
    const { git, calls } = fakeGit(new Set(), pruned);
    await runLargeFileLane(git, WALNUT_HOME, deferred);
    await prehashInFlight();
    pruned.add('oid-of-clip.mp4');
    calls.length = 0;
    const next = await runLargeFileLane(git, WALNUT_HOME, deferred);
    expect(next.staged).toEqual([]);
    expect(next.started).toBe(true);
    await prehashInFlight();
    expect(calls.map((c) => c.args[0])).toEqual(['hash-object']);
  });

  it('stops writing in the background when sync pauses', async () => {
    setLargeFileLaneForTest({ routineBudget: 1 });
    write('a.bin', 'aa');
    write('b.bin', 'bb');
    const { git, calls } = fakeGit(new Set());
    let paused = false;
    const original = git;
    const pausing: GitRunner = async (args, opts) => { const out = await original(args, opts); paused = true; return out; };
    await runLargeFileLane(pausing, WALNUT_HOME, [{ path: 'a.bin', bytes: 2, tracked: false }, { path: 'b.bin', bytes: 2, tracked: false }], { shouldStop: () => paused });
    await prehashInFlight();
    expect(calls.map((c) => c.input)).toEqual(['a.bin\n']);
  });

  it('one file that fails the stage add backs off alone; the others are staged', async () => {
    write('clip.mp4', Buffer.alloc(100 * KB, 1));
    write('bad.mov', Buffer.alloc(100 * KB, 2));
    const deferred = [{ path: 'bad.mov', bytes: 100 * KB, tracked: false }, { path: 'clip.mp4', bytes: 100 * KB, tracked: false }];
    const { git: base } = fakeGit(new Set());
    await runLargeFileLane(base, WALNUT_HOME, deferred);
    await prehashInFlight();
    const git: GitRunner = async (args, opts) => {
      if (args.includes('add') && (opts.input ?? '').includes('bad.mov')) throw new Error("git exited 1: The following paths are ignored: bad.mov");
      return base(args, opts);
    };
    const result = await runLargeFileLane(git, WALNUT_HOME, deferred);
    expect(result.staged).toEqual(['clip.mp4']);
    expect(result.failed.map((f) => f.path)).toEqual(['bad.mov']);
  });

  it('writes a file that changed after its object was written again, never stages the stale one', async () => {
    write('clip.mp4', Buffer.alloc(100 * KB, 1));
    const deferred = [{ path: 'clip.mp4', bytes: 100 * KB, tracked: false }];
    const { git, calls } = fakeGit(new Set());
    await runLargeFileLane(git, WALNUT_HOME, deferred);
    await prehashInFlight();
    fs.appendFileSync(path.join(WALNUT_HOME, 'clip.mp4'), 'x');
    calls.length = 0;
    const next = await runLargeFileLane(git, WALNUT_HOME, [{ ...deferred[0], bytes: 100 * KB + 1 }]);
    expect(next.staged).toEqual([]);
    expect(next.started).toBe(true);
    await prehashInFlight();
    expect(calls.map((c) => c.args[0])).toEqual(['hash-object']);
  });

  it('backs a failed file off with a doubled timeout next time, and the others still go', async () => {
    write('clip.mp4', Buffer.alloc(100 * KB, 1));
    write('huge.mov', Buffer.alloc(100 * KB, 2));
    const deferred = [{ path: 'clip.mp4', bytes: 100 * KB, tracked: false }, { path: 'huge.mov', bytes: 100 * KB, tracked: false }];
    setLargeFileLaneForTest({ routineBudget: 1024 * KB });
    const { git, calls } = fakeGit(new Set(['huge.mov']));
    let clock = 1_000_000;
    const now = () => clock;

    await runLargeFileLane(git, WALNUT_HOME, deferred, { now });
    await prehashInFlight();
    // One batch of both failed, then each alone: clip.mp4 is written, huge.mov backs off.
    expect(calls.map((c) => c.input)).toEqual(['clip.mp4\nhuge.mov\n', 'clip.mp4\n', 'huge.mov\n']);
    expect(largeLaneFailures().get('huge.mov')?.failures).toBe(1);
    const firstTimeout = calls[2].timeout;
    expect(firstTimeout).toBe(addTimeoutFor(100 * KB));

    calls.length = 0;
    const inBackoff = await runLargeFileLane(git, WALNUT_HOME, deferred, { now });
    expect(inBackoff.staged).toEqual(['clip.mp4']);
    expect(inBackoff.started).toBe(false);
    expect(inBackoff.left).toEqual(['huge.mov']);
    await prehashInFlight();

    clock += 11 * 60_000;
    calls.length = 0;
    await runLargeFileLane(git, WALNUT_HOME, [deferred[1]], { now });
    await prehashInFlight();
    expect(calls).toEqual([expect.objectContaining({ args: ['hash-object', '-w', '--stdin-paths'], timeout: firstTimeout * 2 })]);
  });

  it('batches by bytes: small files share a batch, a file over the budget is alone', () => {
    const f = (p: string, bytes: number) => ({ path: p, bytes, tracked: false });
    expect(batchByBytes([f('a', 10), f('b', 20), f('c', 80), f('d', 500)], 100).map((b) => b.map((x) => x.path)))
      .toEqual([['a', 'b'], ['c'], ['d']]);
  });

  it('a named add drops an untracked file removed since the listing and stages the rest', async () => {
    write('a.txt', 'a\n');
    const staged = await addListed(realGit, WALNUT_HOME, [
      { path: 'a.txt', bytes: 2, tracked: false },
      { path: 'gone.tmp', bytes: 2, tracked: false },
      { path: 'seed.txt', bytes: 0, tracked: true },
    ], { timeout: 30_000 });
    expect(staged.map((f) => f.path)).toEqual(['a.txt', 'seed.txt']);
    expect(gitOut('diff --cached --name-only')).toBe('a.txt');
  });
});

/** Run ticks until the tree is clean (at most `max`), letting the background lane finish between them. */
async function ticksUntilClean(max = 4): Promise<number> {
  for (let tick = 1; tick <= max; tick++) {
    await commitIfDirty();
    await prehashInFlight();
    if (gitOut('status --porcelain') === '') return tick;
  }
  return -1;
}

describe('commitIfDirty on a real repo', () => {
  it('commits the small changes at once and the large file once its object is written', async () => {
    const base = gitOut('rev-parse HEAD');
    write('tasks/a.json', '{"a":1}\n');
    write('notes/today.md', 'hello\n');
    write('artifacts/video.bin', Buffer.alloc(512 * KB, 7));

    expect(await commitIfDirty()).toBe(true);
    expect(commitsSince(base).map((c) => c.files)).toEqual([['notes/today.md', 'tasks/a.json']]);
    await prehashInFlight();
    expect(await ticksUntilClean()).toBe(1);

    const commits = commitsSince(base);
    expect(commits).toHaveLength(2);
    expect(commits[1].files).toEqual(['artifacts/video.bin']);
    expect(commits[1].subject).toMatch(/\(1 large files\)$/);
  });

  it('keeps the whole tree in one commit when it is under the budget (the add it always was)', async () => {
    const base = gitOut('rev-parse HEAD');
    write('tasks/a.json', '{"a":1}\n');
    write('artifacts/small.bin', Buffer.alloc(8 * KB, 1));
    expect(await commitIfDirty()).toBe(true);
    const commits = commitsSince(base);
    expect(commits).toHaveLength(1);
    expect(commits[0].files).toEqual(['artifacts/small.bin', 'tasks/a.json']);
  });

  it('stages only the named small files when the large ones outnumber them', async () => {
    const base = gitOut('rev-parse HEAD');
    write('tasks/a.json', '{"a":1}\n');
    for (let i = 0; i < 3; i++) write(`artifacts/photo-${i}.bin`, Buffer.alloc(100 * KB, i + 1));
    expect(await commitIfDirty()).toBe(true);
    expect(commitsSince(base).map((c) => c.files)).toEqual([['tasks/a.json']]);
    await prehashInFlight();
    expect(await ticksUntilClean()).toBe(1);
    expect(commitsSince(base)[1].files).toEqual(['artifacts/photo-0.bin', 'artifacts/photo-1.bin', 'artifacts/photo-2.bin']);
  });

  it.skipIf(!canDenyRead)('a large file git cannot write leaves every other change committed, tick after tick', async () => {
    const base = gitOut('rev-parse HEAD');
    write('artifacts/video.bin', Buffer.alloc(512 * KB, 7));
    // A file git cannot read fails, as one too big for its timeout does: before the
    // lane, that failed the whole `add -A` and nothing at all was committed.
    await fsp.chmod(path.join(WALNUT_HOME, 'artifacts', 'video.bin'), 0o000);
    write('tasks/a.json', '{"a":1}\n');

    expect(await commitIfDirty()).toBe(true);
    await prehashInFlight();
    expect(commitsSince(base).flatMap((c) => c.files)).toEqual(['tasks/a.json']);
    expect(largeLaneFailures().get('artifacts/video.bin')?.failures).toBe(1);

    // The next tick: a new small change still goes out; the failed file waits out its backoff.
    write('tasks/b.json', '{"b":2}\n');
    expect(await commitIfDirty()).toBe(true);
    await prehashInFlight();
    expect(commitsSince(base).flatMap((c) => c.files)).toEqual(['tasks/a.json', 'tasks/b.json']);

    // Readable again and changed (new data, no backoff): committed within the next ticks.
    await fsp.chmod(path.join(WALNUT_HOME, 'artifacts', 'video.bin'), 0o644);
    fs.appendFileSync(path.join(WALNUT_HOME, 'artifacts', 'video.bin'), 'more');
    expect(await ticksUntilClean()).toBeGreaterThan(0);
    expect(commitsSince(base).flatMap((c) => c.files)).toContain('artifacts/video.bin');
  });

  it('stages an edit of a large tracked file through the lane, and its deletion in the routine commit', async () => {
    write('artifacts/old.bin', Buffer.alloc(300 * KB, 1));
    write('artifacts/keep.bin', Buffer.alloc(300 * KB, 2));
    gitOut('add -A');
    gitOut('commit -q -m big');
    const base = gitOut('rev-parse HEAD');
    fs.rmSync(path.join(WALNUT_HOME, 'artifacts', 'old.bin'));
    write('artifacts/keep.bin', Buffer.alloc(300 * KB, 3));
    expect(await ticksUntilClean()).toBe(2);
    expect(commitsSince(base).map((c) => c.files)).toEqual([['artifacts/old.bin'], ['artifacts/keep.bin']]);
  });

  it('a touched large file with the same bytes commits nothing and reads clean after', async () => {
    write('artifacts/keep.bin', Buffer.alloc(300 * KB, 2));
    gitOut('add -A');
    gitOut('commit -q -m big');
    const base = gitOut('rev-parse HEAD');
    const later = new Date(Date.now() + 5_000);
    fs.utimesSync(path.join(WALNUT_HOME, 'artifacts', 'keep.bin'), later, later);
    expect(await ticksUntilClean()).toBeGreaterThan(0);
    expect(commitsSince(base)).toEqual([]);
  });
});

describe('a long add keeps its index lock', () => {
  it('clearStaleLock keeps a lock made while a git of this server runs, and clears older ones and later', async () => {
    const lock = path.join(WALNUT_HOME, '.git', 'index.lock');
    const refLock = path.join(WALNUT_HOME, '.git', 'packed-refs.lock');
    // A dead process's lock, from before the live git started: cleared even now.
    fs.writeFileSync(refLock, '');
    const old = new Date(Date.now() - 10 * 60_000);
    fs.utimesSync(refLock, old, old);
    // Stands in for an add that has held index.lock for minutes (tracked from its spawn on).
    const running = execGitArgsGroup(['-c', 'alias.hold=!sleep 3', 'hold'], { cwd: WALNUT_HOME, timeout: 30_000 });
    fs.writeFileSync(lock, '');
    expect(await clearStaleLock(0)).toBe(true);
    expect(fs.existsSync(refLock)).toBe(false);
    expect(fs.existsSync(lock)).toBe(true);
    await running;
    // A command that takes no lock (the background object writes) does not hold it back.
    const lockless = execGitArgsGroup(['-c', 'alias.hold=!sleep 2', 'hold'], { cwd: WALNUT_HOME, timeout: 30_000, holdsNoLock: true });
    expect(await clearStaleLock(0)).toBe(true);
    expect(fs.existsSync(lock)).toBe(false);
    await lockless;
  });
});
