/**
 * A diverged pull, computed in git's object store only.
 *
 * The pull used to join the two sides IN THE LIVE WORKING TREE: `pull --rebase`
 * checked the hub's version out and then replayed the local commits, and
 * `git merge` wrote conflict markers into the store files before the per-file
 * LWW put clean content back. The server reads those files the whole time:
 * 2026-11-24 08:39, for a few seconds host-exec-grants.json held markers and
 * three tasks' host_exec reads were refused, and the web layer "self-healed" a
 * marker-filled board from HEAD in the middle of the merge.
 *
 * Here nothing touches the working tree or the index. The result is a commit
 * (the pull's target); git-sync-apply.ts moves the working tree to it.
 *
 *  1. Replay: the local first-parent commits after the merge base go onto the
 *     remote head one by one (replayCommits, the same loop the rewrite carry
 *     uses). All clean: linear history, the shape a rebase gave.
 *  2. A step conflicts: one three-way `merge-tree` of HEAD and the remote, each
 *     conflicted path taken whole from the newer side (chooseLww), or merged
 *     record by record for a store that registered one (git-sync-records.ts),
 *     committed with both parents, so the losing version stays in history.
 */

import {
  contentClock, must, removalLine, replayCommits, writeTreeEntries, type GitStatusRunner,
} from './git-sync-rewrite-carry.js';
import { mergeRecords } from './git-sync-records.js';

/**
 * Beyond this many local commits the pull merges instead of replaying: a replay
 * is three git spawns per commit and a deferred apply computes it again on the
 * next tick, while a merge is one `merge-tree` whatever the count.
 */
export const DIVERGED_REPLAY_MAX = 50;

let writeTreeProbe: boolean | null = null;
let writeTreeOverride: boolean | null = null;

/**
 * Whether this git computes merges in the object store (`merge-tree --write-tree`,
 * git 2.38); an older git keeps the legacy pull. Read from `git --version` once
 * per process; a version it cannot parse is probed, and only a clear answer is
 * kept (a probe that timed out on a loaded machine asks again next time).
 */
export async function mergeTreeWriteTreeSupported(run: GitStatusRunner): Promise<boolean> {
  if (writeTreeOverride !== null) return writeTreeOverride;
  if (writeTreeProbe !== null) return writeTreeProbe;
  try {
    const version = /git version (\d+)\.(\d+)/.exec((await run(['--version'])).stdout);
    if (version) {
      const [major, minor] = [Number(version[1]), Number(version[2])];
      return (writeTreeProbe = major > 2 || (major === 2 && minor >= 38));
    }
    const probe = await run(['merge-tree', '--write-tree', 'HEAD', 'HEAD']);
    if (probe.code === 0) return (writeTreeProbe = true);
    if (probe.code === 129) return (writeTreeProbe = false); // usage error: the option does not exist
  } catch {
    // timed out: not an answer
  }
  return false;
}

/** Test hook: pretend git has (true) or lacks (false) `merge-tree --write-tree`; null probes again. */
export function setMergeTreeWriteTreeForTest(value: boolean | null): void {
  writeTreeOverride = value;
  writeTreeProbe = null;
}

export type LwwSide = 'local' | 'remote';
/** What decided a conflicted path: the store's own clock, commit time, or a record merge of both sides. */
export type LwwClock = 'content' | 'commit' | 'records';

/**
 * Which side of a conflicted path is the newer write. The store's own
 * `lastUpdated` (JSON only) decides first: commit time is the phase of each
 * box's 30 s auto-save tick, not data freshness (2026-08-23: a replica's empty
 * store committed 14 s after the primary's copy holding the user's message won
 * on commit time). Then the newest commit touching the path on each side; a tie
 * goes to the remote (deterministic; the companion-box-pulls-the-Mac case).
 * `mine` and `theirs` are `"<mode> <oid>"`, absent for a side that deleted it.
 */
export async function chooseLww(
  run: GitStatusRunner, file: string, mine: string | undefined, theirs: string | undefined,
  localHead: string, remoteHead: string,
): Promise<{ side: LwwSide; clock: LwwClock }> {
  if (file.endsWith('.json')) {
    const [a, b] = await Promise.all([contentClock(run, mine), contentClock(run, theirs)]);
    if (a !== null && b !== null && a !== b) return { side: a > b ? 'local' : 'remote', clock: 'content' };
  }
  const touched = async (ref: string): Promise<number> =>
    Number((await run(['--literal-pathspecs', 'log', '-1', '--format=%ct', ref, '--', file])).stdout.trim() || '0');
  const [localAt, remoteAt] = await Promise.all([touched(localHead), touched(remoteHead)]);
  return { side: localAt > remoteAt ? 'local' : 'remote', clock: 'commit' };
}

/**
 * Conflicted entries as `merge-tree -z` (after its tree line) and `ls-files -u -z`
 * print them, `<mode> <oid> <stage>\t<path>`: path -> stage -> `"<mode> <oid>"`.
 * Stops at the first field of another shape (merge-tree's message section).
 */
export function parseConflictStages(fields: string[]): Map<string, Map<number, string>> {
  const out = new Map<string, Map<number, string>>();
  for (const field of fields) {
    if (!field) continue;
    const m = /^(\d{6}) ([0-9a-f]+) ([123])\t([\s\S]+)$/.exec(field);
    if (!m) break;
    const stages = out.get(m[4]) ?? new Map<number, string>();
    stages.set(Number(m[3]), `${m[1]} ${m[2]}`);
    out.set(m[4], stages);
  }
  return out;
}

/** The LWW merge commit's message: one line per conflicted file and the side kept (or both, merged). */
export function lwwMergeMessage(localWins: string[], remoteWins: string[], merged: string[] = []): string {
  const detail = [
    ...localWins.map((f) => `local  wins: ${f}`),
    ...remoteWins.map((f) => `remote wins: ${f}`),
    ...merged.map((f) => `records merged: ${f}`),
  ].join('\n');
  return `merge: LWW conflict resolution (${localWins.length + remoteWins.length + merged.length} files)\n\n${detail}\n\n`
    + 'Losing versions remain in history: git log --all --full-history -- <file>\n';
}

export interface DivergedResult {
  /** The commit the working tree should move to. */
  head: string;
  kind: 'replay' | 'merge';
  /** Local commits replayed onto the remote (replay only). */
  replayed: number;
  /** Conflicted paths in git's order, and the side LWW kept for each (merge only). */
  files: string[];
  localWins: string[];
  remoteWins: string[];
  /** Conflicted stores merged record by record (git-sync-records.ts): both sides kept. */
  merged: string[];
  clocks: Record<string, LwwClock>;
  fileLevel: boolean;
}

/**
 * The target of a pull whose two sides both moved since their merge base.
 * `remoteName` only words a clean merge's message (`origin/main`).
 */
export async function resolveDivergence(
  run: GitStatusRunner, localHead: string, remoteHead: string, remoteName: string, indexFile: string,
): Promise<DivergedResult> {
  const result: DivergedResult = {
    head: remoteHead, kind: 'replay', replayed: 0, files: [], localWins: [], remoteWins: [], merged: [], clocks: {}, fileLevel: false,
  };
  const base = (await must(run, ['merge-base', localHead, remoteHead])).trim();
  const steps = (await must(run, ['log', '--first-parent', '--reverse', '--format=%H %P', `${base}..${localHead}`]))
    .split('\n').map((line) => line.trim().split(' ')).filter(([commit]) => commit)
    .map(([commit, parent]) => ({ commit, base: parent ?? '' }));

  if (steps.length > 0 && steps.length <= DIVERGED_REPLAY_MAX && steps.every((s) => s.base)) {
    const replay = await replayCommits(run, steps, remoteHead, { indexFile });
    result.fileLevel = replay.fileLevel;
    if (!replay.stoppedAt) {
      // Every local change already upstream: the target is the remote head itself.
      result.head = replay.built > 0 ? replay.head : remoteHead;
      result.replayed = replay.built;
      return result;
    }
  }

  result.kind = 'merge';
  const merge = await run(['merge-tree', '--write-tree', '-z', '--no-messages', localHead, remoteHead]);
  if (merge.code !== 0 && merge.code !== 1) {
    throw new Error(`git merge-tree failed (${merge.code}): ${(merge.stderr || merge.stdout).trim().slice(0, 400)}`);
  }
  const [treeField, ...rest] = merge.stdout.split('\0');
  let tree = treeField.trim();
  let message = `Merge remote-tracking branch '${remoteName}'\n`;
  if (merge.code === 1) {
    const lines: string[] = [];
    for (const [file, stages] of parseConflictStages(rest)) {
      const mine = stages.get(2);
      const theirs = stages.get(3);
      const records = await mergeRecords(run, file, mine, theirs);
      if (records) {
        lines.push(`${records}\t${file}`);
        result.files.push(file);
        result.merged.push(file);
        result.clocks[file] = 'records';
        continue;
      }
      const { side, clock } = await chooseLww(run, file, mine, theirs, localHead, remoteHead);
      const kept = side === 'local' ? mine : theirs;
      // The newer side deleted the file: the deletion stands.
      lines.push(kept ? `${kept}\t${file}` : removalLine(file, tree.length));
      result.files.push(file);
      (side === 'local' ? result.localWins : result.remoteWins).push(file);
      result.clocks[file] = clock;
    }
    tree = await writeTreeEntries(run, tree, lines, indexFile);
    message = lwwMergeMessage(result.localWins, result.remoteWins, result.merged);
  }
  // Parent 1 = local, parent 2 = remote: the losing side of every file survives under one of them.
  result.head = (await must(run, ['commit-tree', tree, '-p', localHead, '-p', remoteHead, '-F', '-'], { input: message })).trim();
  return result;
}
