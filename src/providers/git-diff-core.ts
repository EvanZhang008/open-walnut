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

// ── Glanceable git state (capability 'git-status-v1') ──
//
// What a session row shows without opening the session: the branch, how many
// paths are changed in the working tree, the +/- lines of those changes, and
// the commits not pushed yet. ONE small read per repository, host-side like the
// diff above (daemon `git.status`, or in-process for `__local__`).
//
// Read-only and lock-free: every git call passes --no-optional-locks, so a
// glance never takes index.lock under an agent's own `git commit`.
//
// Self-contained factory: daemon-source.ts inlines `createGitStatus.toString()`
// through `__CREATE_GIT_STATUS__`, so nothing at module scope is referenced and
// the body carries no backticks.

export interface GitRepoStatus {
  /** Absolute repo root (`git rev-parse --show-toplevel`). */
  repoRoot: string;
  /** Current branch; null when HEAD is detached. */
  branch: string | null;
  /** Short HEAD sha; null before the first commit. */
  head: string | null;
  /** Upstream ref (e.g. origin/main); null when the branch tracks none. */
  upstream: string | null;
  /** Commits on HEAD not on the upstream (or, with no upstream, on no remote).
   *  null = unknown (a repo with no remote at all, or a detached HEAD). */
  ahead: number | null;
  /** Commits on the upstream not on HEAD; null without an upstream. */
  behind: number | null;
  /** Changed paths: staged, unstaged, untracked and conflicted (ignored files never). */
  files: number;
  untracked: number;
  conflicted: number;
  /** Lines added / removed across tracked changes (vs HEAD) and untracked text files. */
  insertions: number;
  deletions: number;
  /** True when some untracked files were too many or too big to count. */
  linesPartial?: boolean;
}

export interface GitStatusDeps {
  exec: ExecFn;
  /** Reads an untracked file's text when it is at most maxBytes; null when it
   *  is unreadable or not a regular file. */
  readText?: (absPath: string, maxBytes: number) => Promise<{ text: string } | { tooBig: true } | null>;
  /** Stop starting new repos after this long (default 12 s, under the server's RPC timeout). */
  deadlineMs?: number;
}

export function createGitStatus(deps: GitStatusDeps) {
  var UNTRACKED_COUNT_MAX = 200;
  var UNTRACKED_BYTES_BUDGET = 512 * 1024;
  var DEADLINE_MS = deps.deadlineMs || 12000;

  function git(args: string[], cwd: string) {
    return deps.exec(['git', '--no-optional-locks', '-c', 'core.quotePath=false'].concat(args), cwd);
  }

  function countLines(text: string): number {
    if (!text) return 0;
    var n = 0;
    for (var i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) n++;
    return text.charCodeAt(text.length - 1) === 10 ? n : n + 1;
  }

  function sumNumstat(out: string): { add: number; del: number } {
    var add = 0;
    var del = 0;
    var parts = out.split('\u0000');
    for (var i = 0; i < parts.length; i++) {
      var m = /^(\d+|-)\t(\d+|-)\t/.exec(parts[i]);
      if (!m) continue;
      if (m[1] !== '-') add += Number(m[1]);
      if (m[2] !== '-') del += Number(m[2]);
    }
    return { add: add, del: del };
  }

  async function one(top: string): Promise<GitRepoStatus> {
    var st = await git(['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=all'], top);
    if (st.code !== 0) throw new Error('git status failed: ' + (st.stderr || '').trim().slice(0, 200));
    var out: GitRepoStatus = {
      repoRoot: top, branch: null, head: null, upstream: null, ahead: null, behind: null,
      files: 0, untracked: 0, conflicted: 0, insertions: 0, deletions: 0,
    };
    var untrackedPaths: string[] = [];
    var recs = st.stdout.split('\u0000');
    for (var i = 0; i < recs.length; i++) {
      var r = recs[i];
      if (!r) continue;
      if (r.indexOf('# branch.oid ') === 0) {
        var oid = r.slice(13);
        out.head = oid === '(initial)' ? null : oid.slice(0, 9);
      } else if (r.indexOf('# branch.head ') === 0) {
        var h = r.slice(14);
        out.branch = h === '(detached)' ? null : h;
      } else if (r.indexOf('# branch.upstream ') === 0) {
        out.upstream = r.slice(18);
      } else if (r.indexOf('# branch.ab ') === 0) {
        var ab = /^\+(\d+) -(\d+)$/.exec(r.slice(12));
        if (ab) { out.ahead = Number(ab[1]); out.behind = Number(ab[2]); }
      } else if (r.charAt(0) === '1') {
        out.files++;
      } else if (r.charAt(0) === '2') {
        out.files++;
        i++; // a rename record carries its original path as the next field
      } else if (r.charAt(0) === 'u') {
        out.files++;
        out.conflicted++;
      } else if (r.charAt(0) === '?') {
        out.files++;
        out.untracked++;
        untrackedPaths.push(r.slice(2));
      }
    }

    // Tracked lines: the working tree against HEAD (or the empty tree before the
    // first commit), staged and unstaged together. diff-index, not `git diff`:
    // the porcelain diff refreshes the index and so takes index.lock even under
    // --no-optional-locks; the plumbing one only reads it.
    if (out.files > out.untracked) {
      var base = out.head ? 'HEAD' : null;
      if (!base) {
        var empty = await git(['hash-object', '-t', 'tree', '/dev/null'], top);
        if (empty.code === 0 && empty.stdout.trim()) base = empty.stdout.trim();
      }
      if (base) {
        var d = await git(['diff-index', '--numstat', '-z', '--no-renames', base], top);
        if (d.code === 0) { var s = sumNumstat(d.stdout); out.insertions += s.add; out.deletions += s.del; }
      }
    }

    // Untracked text files count as added lines, as the Changed tab shows them,
    // within a byte budget per repo: past it the count says it is partial.
    if (untrackedPaths.length) {
      if (!deps.readText || untrackedPaths.length > UNTRACKED_COUNT_MAX) out.linesPartial = true;
      if (deps.readText) {
        var take = untrackedPaths.slice(0, UNTRACKED_COUNT_MAX);
        var budget = UNTRACKED_BYTES_BUDGET;
        for (var k = 0; k < take.length; k++) {
          if (budget <= 0) { out.linesPartial = true; break; }
          var abs = top.charAt(top.length - 1) === '/' ? top + take[k] : top + '/' + take[k];
          var got = await deps.readText(abs, budget);
          if (!got) continue;
          if ('tooBig' in got) { out.linesPartial = true; continue; }
          budget -= got.text.length;
          if (got.text.indexOf('\u0000') !== -1) continue; // binary: no lines
          out.insertions += countLines(got.text);
        }
      }
    }

    // No upstream (a new branch), or one whose remote branch is gone: the
    // commits no remote has are the unpushed ones.
    if (out.ahead === null && out.branch && out.head) {
      var remotes = await git(['remote'], top);
      if (remotes.code === 0 && remotes.stdout.trim()) {
        var cnt = await git(['rev-list', '--count', 'HEAD', '--not', '--remotes'], top);
        if (cnt.code === 0 && /^\d+$/.test(cnt.stdout.trim())) out.ahead = Number(cnt.stdout.trim());
      }
    }
    return out;
  }

  /** The state of every repository the given directories sit in (deduped; a
   *  directory in no repository, or one that no longer exists, is skipped). */
  async function status(dirs: string[]): Promise<GitRepoStatus[]> {
    var seen: Record<string, boolean> = {};
    var results: GitRepoStatus[] = [];
    var started = Date.now();
    for (var i = 0; i < dirs.length && i < 16; i++) {
      // Past the deadline the caller has given up: answer what is read so far.
      if (Date.now() - started > DEADLINE_MS) break;
      var top = await git(['rev-parse', '--show-toplevel'], dirs[i]).catch(function () { return { stdout: '', stderr: '', code: 1 }; });
      var root = top.code === 0 ? top.stdout.trim() : '';
      if (!root || seen[root]) continue;
      seen[root] = true;
      // One unreadable repo (a broken index, a timeout) never hides the others.
      try { results.push(await one(root)); } catch (_) { /* skipped */ }
    }
    return results;
  }

  return { status: status };
}
