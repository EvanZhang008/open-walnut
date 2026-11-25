/**
 * Temp files git writes into the data repo's worktree, and the copies a killed git leaves behind.
 *
 * A merge driver runs on three temp copies of the file git writes into the current directory
 * (`.merge_file_XXXXXX`, ll-merge.c). When the merge is stopped (a timeout's SIGTERM or SIGKILL),
 * git leaves all three: 2026-11-24 a personal merge driver timed out 251 times inside git-sync's
 * merge-tree, left 777 of them (3.2 GiB, each a whole copy of a store) at the data repo's root,
 * and the next auto-save committed them, so every host synced them and the history kept them.
 *
 * Two parts: the ignore line keeps a new leftover out of every commit, and the sweep untracks and
 * removes the ones an older install already committed or left on disk. Only names git itself
 * makes are matched, only at the root (git-sync runs git there), and only an hour after git
 * wrote them, so a merge still running (a person's own, too) keeps its files.
 */
import fsp from 'node:fs/promises';
import path from 'node:path';

/** The .gitignore lines for git's worktree temp names (GITIGNORE_CONTENT and the self-heal). */
export const GIT_TEMP_IGNORE_LINES = ['/.merge_file_*'];

/** Exactly the names git makes: mks_tempfile's six-character suffix. */
const GIT_TEMP_NAME = /^\.merge_file_[A-Za-z0-9]{6}$/;

/** Older than any git-sync command (30 s timeouts) and any merge a person still sits in. */
export const GIT_TEMP_STALE_MS = 60 * 60_000;

/**
 * At most this many tracked leftovers are untracked per sweep. Each staged deletion stays dirty
 * until the tick's commit, and a tick that cannot commit (disk pull-only, a refused stage) and
 * pulls would count them toward the torn-worktree check (300 rows at least): 849 at once could
 * hold sync in safe mode. A batch per tick clears 849 in about five minutes.
 */
export const GIT_TEMP_UNTRACK_PER_SWEEP = 100;

export function isGitTempLeftoverName(name: string): boolean {
  return GIT_TEMP_NAME.test(name);
}

export interface GitTempSweep { removed: string[]; untracked: string[]; bytes: number }

/**
 * Untrack and delete git's stale temp files at `root`. `git` runs one git command line in the
 * repo and answers null on failure; a file whose untrack failed stays on disk, so the next tick
 * tries again and the index never points at a deleted file.
 */
export async function sweepGitTempLeftovers(
  root: string,
  git: (args: string) => Promise<string | null>,
  now = Date.now(),
): Promise<GitTempSweep> {
  let names: string[];
  try {
    names = (await fsp.readdir(root)).filter(isGitTempLeftoverName);
  } catch {
    return { removed: [], untracked: [], bytes: 0 };
  }
  const stale: { name: string; size: number }[] = [];
  for (const name of names) {
    try {
      const st = await fsp.lstat(path.join(root, name));
      if (st.isFile() && now - st.mtimeMs >= GIT_TEMP_STALE_MS) stale.push({ name, size: st.size });
    } catch { /* gone meanwhile */ }
  }
  const sweep: GitTempSweep = { removed: [], untracked: [], bytes: 0 };
  if (stale.length === 0) return sweep;

  const listed = await git('ls-files -z');
  // Unknown which are tracked: delete nothing, so the index never points at a deleted file.
  if (listed === null) return sweep;
  const tracked = new Set(listed.split('\0').filter(isGitTempLeftoverName));
  const untrackOk = new Set<string>();
  const batch = stale.map((s) => s.name).filter((name) => tracked.has(name)).slice(0, GIT_TEMP_UNTRACK_PER_SWEEP);
  // --cached: the index only; the file goes below, once git no longer tracks it.
  if (batch.length > 0 && await git(`rm --cached --quiet -f --ignore-unmatch -- ${batch.join(' ')}`) !== null) {
    for (const name of batch) untrackOk.add(name);
  }
  sweep.untracked = [...untrackOk];
  for (const { name, size } of stale) {
    if (tracked.has(name) && !untrackOk.has(name)) continue;
    try {
      await fsp.unlink(path.join(root, name));
      sweep.removed.push(name);
      sweep.bytes += size;
    } catch { /* gone meanwhile */ }
  }
  return sweep;
}
