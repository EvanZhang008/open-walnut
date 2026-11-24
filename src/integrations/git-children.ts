/**
 * The git children of this server, and a leader switch's stop of them (quietGitWriters). Every git the server
 * runs under the home goes through a spawner that calls refuseGitInQuiet before it starts and trackOwnGit once it
 * runs (git-sync.ts execGitGroup, execGitArgsRaw and git; git-bundle-client.ts runGit); the source ratchet
 * tests/core/leader/switch/switch-stop-writers-ratchet.test.ts pins every other git child of src/.
 *
 * Leaf module: node's, the process-group kill and the deadline helper only.
 */
import path from 'node:path';
import type { ChildProcess } from 'node:child_process';
import { safeKillProcessGroup } from '../core/process-group-kill.js';
import { withDeadline } from '../lib/with-deadline.js';

/** How long a TERM'd git group gets before its KILL. */
const KILL_GRACE_MS = 3_000;

/**
 * Git children of THIS process, per repo folder: when each started, whether it may hold a
 * lock there, and how its process group is ended. A long add holds .git/index.lock for its
 * whole run and its mtime is its start, so the age test in clearStaleLock cannot tell it from
 * a dead process's: while one of ours that may hold a lock runs there, clearStaleLock leaves
 * the locks alone (git-sync-large-files.ts made adds of several minutes legitimate). A leader
 * switch's stop ends them all (quietGitWriters).
 */
interface LiveGit { startedAt: number; holdsLock: boolean; end: (signal: NodeJS.Signals) => void; closed: Promise<void>; done: boolean }
const liveGitChildren = new Map<string, Set<LiveGit>>();

export function trackOwnGit(cwd: string, child: ChildProcess, holdsLock = true): void {
  const key = path.resolve(cwd);
  let release!: () => void;
  const entry: LiveGit = {
    startedAt: Date.now(), holdsLock, done: false,
    end: (signal) => { safeKillProcessGroup(child.pid, signal); },
    closed: new Promise<void>((resolve) => { release = resolve; }),
  };
  const live = liveGitChildren.get(key) ?? new Set();
  live.add(entry);
  liveGitChildren.set(key, live);
  const done = (): void => {
    entry.done = true;
    live.delete(entry);
    if (live.size === 0 && liveGitChildren.get(key) === live) liveGitChildren.delete(key);
    release();
  };
  child.once('close', done);
  child.once('error', done);
}

/**
 * When the oldest git child of this process that may hold a lock in `repoDir`
 * started, or null when none runs. A lock older than that cannot be ours.
 */
export function oldestOwnGitStart(repoDir: string): number | null {
  const live = [...(liveGitChildren.get(path.resolve(repoDir)) ?? [])].filter((e) => e.holdsLock);
  if (live.length === 0) return null;
  return Math.min(...live.map((e) => e.startedAt));
}

/** Folders where no git of this process starts any more: a leader switch's stop (quietGitWriters). */
const quietRoots = new Set<string>();

function insideQuiet(cwd: string): string | null {
  const dir = path.resolve(cwd);
  for (const root of quietRoots) if (dir === root || dir.startsWith(root + path.sep)) return root;
  return null;
}

/** A git asked for in a folder of a switch stop: refused before it starts. */
export class GitQuiet extends Error {
  constructor(root: string) {
    super(`no git starts in ${root} any more: this server is in its leader switch stop`);
    this.name = 'GitQuiet';
  }
}

export function refuseGitInQuiet(cwd: string): void {
  const root = insideQuiet(cwd);
  if (root) throw new GitQuiet(root);
}

/** Whether git is stopped in `dir` (it is under a folder quietGitWriters stopped). */
export function gitQuietAt(dir: string): boolean {
  return insideQuiet(dir) !== null;
}

/**
 * A leader switch's stop (src/core/leader/switch/final-stop.ts): from now on no git of this
 * process starts in `root` or below it, and the ones running there end, so the final batch
 * finds the data repo still. A child that holds no lock (a `hash-object -w` of the large-file
 * lane, a read) is ended at once: what it wrote is a loose object the next leader's own
 * auto-commit writes again. One that may hold a lock (an add, a commit, a gc) is let finish
 * for `budgetMs` (a routine add is bounded by its byte budget), and ended after it: the lock
 * it leaves is older than any git of the next leader, whose clearStaleLock removes it.
 * Synchronous up to its first await: the refusal of new git holds from the call on.
 */
export async function quietGitWriters(root: string, o: { budgetMs: number; graceMs?: number }): Promise<{ ended: number; finished: number; killed: number }> {
  const key = path.resolve(root);
  quietRoots.add(key);
  const live = [...liveGitChildren.entries()]
    .filter(([dir]) => dir === key || dir.startsWith(key + path.sep))
    .flatMap(([, set]) => [...set]);
  const grace = o.graceMs ?? KILL_GRACE_MS;
  const endAll = async (list: LiveGit[]): Promise<void> => {
    for (const g of list) g.end('SIGTERM');
    const hard = setTimeout(() => { for (const g of list) g.end('SIGKILL'); }, grace);
    hard.unref?.();
    await Promise.all(list.map((g) => g.closed));
    clearTimeout(hard);
  };
  const readers = live.filter((g) => !g.holdsLock);
  const holders = live.filter((g) => g.holdsLock);
  const endedNow = endAll(readers);
  await withDeadline(Promise.all(holders.map((g) => g.closed)).then(() => undefined), Math.max(0, o.budgetMs), () => undefined);
  const late = holders.filter((g) => !g.done);
  await Promise.all([endedNow, endAll(late)]);
  return { ended: readers.length, finished: holders.length - late.length, killed: late.length };
}

/** The next server in this process (tests start several): git runs in `root` again. */
export function endGitQuiet(root: string): void {
  quietRoots.delete(path.resolve(root));
}
