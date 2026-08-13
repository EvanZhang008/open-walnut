/**
 * git-diff-core — the host-side git comparison algorithm, shared verbatim by:
 *   - the LOCAL path (run in-process by the Walnut server for `__local__` sessions)
 *   - the REMOTE daemon (`git.diff` RPC handler in daemon-standalone.ts /
 *     daemon-source.ts), which runs ON the remote host where the repo lives.
 *
 * The whole point of running this on the host (in-process or in the daemon) is
 * that git and the files are local to it — so there are NO per-file network
 * round trips. Earlier this logic lived server-side and reached over SSH per
 * file (2 hops × N files), which hung remote sessions; running it host-side
 * collapses that to plain local exec/read calls regardless of file count.
 *
 * It's parameterized by two primitives so the same code runs in both worlds:
 *   - exec(argv, cwd)   → run a command, capture {stdout,stderr,code}
 *   - readText(absPath) → read a working-tree file as UTF-8 ('' if unreadable)
 *
 * Output is the GitDiffResult contract below — the server maps it 1:1 onto the
 * SessionChangesResult shape the frontend already renders. Keep this file
 * dependency-free (only the injected primitives) so daemon-source.ts can inline
 * an equivalent without imports.
 */

export type GitDiffBase = 'uncommitted' | 'previous' | 'remote';

export interface GitDiffFile {
  /** Path relative to the repo root. */
  relPath: string;
  /** Content at the comparison base ('' for added files). */
  before: string;
  /** Current working-tree content ('' for deleted files). */
  after: string;
  status: 'added' | 'modified' | 'deleted' | 'renamed';
  /** For a rename/copy, the repo-relative ORIGINAL path (git R/C entries). */
  oldRelPath?: string;
}

export interface GitDiffResult {
  /** Absolute repo root (the diff is whole-repo, scoped to the cwd's repo). */
  repoRoot: string;
  files: GitDiffFile[];
}

/** Injected command runner. Returns the captured streams + exit code; must NOT
 *  throw on a non-zero exit (git uses non-zero for "absent path" etc.). */
export type ExecFn = (argv: string[], cwd: string) => Promise<{ stdout: string; stderr: string; code: number }>;
/** Injected working-tree reader. Returns '' when the file is missing/unreadable. */
export type ReadTextFn = (absPath: string) => Promise<string>;

/** Thrown when git can't satisfy the requested base (e.g. HEAD~1 on a single
 *  commit, or no upstream). The caller maps this to a user-facing 502. */
export class GitDiffError extends Error {}

interface NameStatus {
  status: GitDiffFile['status'];
  relPath: string;
  /** For renames/copies, the original path (so `before` reads the right blob). */
  oldRelPath?: string;
}

/** posix join (repoRoot + relPath); both sides use forward slashes on the hosts
 *  we target. Avoids a node:path dependency so daemon-source can inline this. */
function joinPosix(a: string, b: string): string {
  if (!a) return b;
  return a.endsWith('/') ? a + b : a + '/' + b;
}

/** Resolve the git revision the diff compares against, for a base mode. */
async function resolveBaseRev(base: GitDiffBase, exec: ExecFn, repoRoot: string): Promise<string> {
  switch (base) {
    case 'uncommitted':
      return 'HEAD';
    case 'previous':
      // HEAD~1 → working tree: the latest commit + uncommitted, vs the one before.
      return 'HEAD~1';
    case 'remote': {
      // Prefer the configured upstream; fall back to origin/<branch>.
      const up = await exec(['git', 'rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'], repoRoot);
      if (up.code === 0 && up.stdout.trim()) return up.stdout.trim();
      const br = await exec(['git', 'rev-parse', '--abbrev-ref', 'HEAD'], repoRoot);
      const branch = br.stdout.trim();
      if (branch && branch !== 'HEAD') return `origin/${branch}`;
      return 'origin/HEAD';
    }
  }
}

/** Parse `git diff --name-status -z <rev>` output into typed entries. */
function parseNameStatusZ(out: string): NameStatus[] {
  const entries: NameStatus[] = [];
  const parts = out.split('\0');
  let i = 0;
  while (i < parts.length) {
    const code = parts[i];
    if (!code) { i++; continue; }
    const letter = code[0];
    if (letter === 'R' || letter === 'C') {
      // Rename/copy: code, oldPath, newPath. Surface as 'renamed' so the UI shows
      // the move (a pure rename has identical before/after content otherwise).
      const oldRel = parts[i + 1];
      const newRel = parts[i + 2];
      i += 3;
      if (!newRel) continue;
      entries.push({ status: 'renamed', relPath: newRel, oldRelPath: oldRel });
    } else {
      const rel = parts[i + 1];
      i += 2;
      if (!rel) continue;
      const status: GitDiffFile['status'] =
        letter === 'A' ? 'added' : letter === 'D' ? 'deleted' : 'modified';
      entries.push({ status, relPath: rel });
    }
  }
  return entries;
}

/**
 * Compute a whole-repo git diff for `cwd`'s repository against `base`.
 * Runs entirely host-local via the injected primitives — no network per file.
 * Returns null when cwd isn't a git repo; throws GitDiffError when the base
 * can't be resolved (so the caller can surface a clear message).
 */
export async function computeGitDiff(
  base: GitDiffBase,
  cwd: string,
  exec: ExecFn,
  readText: ReadTextFn,
  opts?: {
    /** Only materialize before/after for these repo-relative paths (a rename
     *  matches on either side). The scope=session caller knows exactly which
     *  files it will show — without this it paid a `git show` for EVERY changed
     *  file in the repo and then threw most away (observed: 683 serial spawns
     *  ≈ 10.7s to display 16 files). */
    paths?: string[];
  },
): Promise<GitDiffResult | null> {
  // Repo root anchors all relPaths + blob reads.
  const rootRes = await exec(['git', 'rev-parse', '--show-toplevel'], cwd);
  if (rootRes.code !== 0 || !rootRes.stdout.trim()) return null; // not a git repo
  const repoRoot = rootRes.stdout.trim();

  const baseRev = await resolveBaseRev(base, exec, repoRoot);

  // Whole-repo changed-file list vs the base.
  const ns = await exec(['git', 'diff', '--name-status', '-z', baseRev], repoRoot);
  if (ns.code !== 0) {
    // e.g. HEAD~1 missing (shallow/single commit), or unknown upstream rev.
    throw new GitDiffError(ns.stderr.trim() || `git diff against ${baseRev} failed`);
  }
  let entries = parseNameStatusZ(ns.stdout);

  // Untracked files are "not committed" too, but `git diff` never reports them.
  // Include them read-only (`ls-files --others`, NO index mutation) so the
  // "local has random files" case actually shows them. They render as 'added'.
  const tracked = new Set(entries.map((e) => e.relPath));
  const others = await exec(['git', 'ls-files', '--others', '--exclude-standard', '-z'], repoRoot);
  if (others.code === 0) {
    for (const rel of others.stdout.split('\0')) {
      if (rel && !tracked.has(rel)) {
        entries.push({ status: 'added', relPath: rel });
        tracked.add(rel);
      }
    }
  }
  if (opts?.paths) {
    const want = new Set(opts.paths);
    entries = entries.filter((e) => want.has(e.relPath) || (e.oldRelPath !== undefined && want.has(e.oldRelPath)));
  }
  if (entries.length === 0) return { repoRoot, files: [] };

  // before = blob at the base rev (`git show <rev>:<path>`); after = working
  // tree content. Host-local but each `git show` is a process spawn — a serial
  // loop over a big repo took ~15ms × N. Small parallel pool instead.
  const files: GitDiffFile[] = new Array(entries.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < entries.length) {
      const i = next++;
      const e = entries[i]!;
      const beforePath = e.oldRelPath ?? e.relPath;
      let before = '';
      if (e.status !== 'added') {
        const show = await exec(['git', 'show', `${baseRev}:${beforePath}`], repoRoot);
        before = show.code === 0 ? show.stdout : ''; // non-zero = absent at base
      }
      const after = e.status === 'deleted' ? '' : await readText(joinPosix(repoRoot, e.relPath));
      files[i] = { relPath: e.relPath, before, after, status: e.status, oldRelPath: e.oldRelPath };
    }
  };
  const pool = Math.min(8, entries.length);
  const workers: Promise<void>[] = [];
  for (let w = 0; w < pool; w++) workers.push(worker());
  await Promise.all(workers);

  files.sort((a, b) => a.relPath.localeCompare(b.relPath));
  return { repoRoot, files };
}
