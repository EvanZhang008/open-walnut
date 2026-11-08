/**
 * git-diff-core — the host-side git comparison algorithm, shared verbatim by:
 *   - the LOCAL path (run in-process by the Walnut server for `__local__` sessions)
 *   - the REMOTE daemon (`git.diff` / `git.refs` RPC handlers in
 *     daemon-standalone.ts / daemon-source.ts), which runs ON the remote host
 *     where the repo lives.
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
 * How each twin gets it: the server and daemon-standalone.ts import
 * computeGitDiff / listGitRefs (thin typed wrappers below); daemon-source.ts
 * inlines `createGitDiffCore.toString()` through `__CREATE_GIT_DIFF__`. So the
 * factory body references NOTHING at module scope: every helper lives inside
 * it, and it carries no backticks.
 *
 * Bases (what `before` is read from):
 *   - 'uncommitted' → HEAD                         (working tree vs last commit)
 *   - 'previous'    → HEAD~1                       (latest commit + uncommitted)
 *   - 'remote'      → @{upstream} (or origin/<branch>)
 *   - 'branch'      → merge-base of HEAD and a ref (opts.ref, or the repo's
 *                     default branch when absent): everything this branch
 *                     changes, uncommitted work included, as a pull request shows it
 *   - 'commit'      → ONE commit (opts.commit) against its first parent; `after`
 *                     is the commit's own content, never the working tree
 */

export type GitDiffBase = 'uncommitted' | 'previous' | 'remote' | 'branch' | 'commit';

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
  /** namesOnly lists: the working-tree blob id of the file ('' when unknown), so
   *  a reader can tell the file changed since it last looked without content. */
  sig?: string;
  /** namesOnly lists: a modified file whose every change is whitespace ('git diff -w' finds nothing). */
  wsOnly?: boolean;
  /** An added file git does not track yet (it is in the working tree only). */
  untracked?: boolean;
  /** namesOnly lists: lines added and removed ('git diff --numstat'; absent for a binary file). */
  additions?: number;
  deletions?: number;
}

/** What a 'branch' or 'commit' comparison resolved to, for the UI to name it. */
export interface GitCompareInfo {
  base: 'branch' | 'commit';
  /** branch: the ref compared against (e.g. 'origin/main'). */
  ref?: string;
  /** branch: true when `ref` was the repo's default branch, picked automatically. */
  isDefault?: boolean;
  /** The commit `before` is read from (branch: the merge-base; commit: its parent, '' for a root commit). */
  baseSha: string;
  /** commit: the commit itself. */
  commit?: GitCommitSummary;
}

export interface GitCommitSummary {
  sha: string;
  /** First parent ('' for a root commit). */
  parent: string;
  parents: number;
  author: string;
  /** Committer time, unix seconds. */
  time: number;
  subject: string;
}

export interface GitDiffResult {
  /** Absolute repo root (the diff is whole-repo, scoped to the cwd's repo). */
  repoRoot: string;
  files: GitDiffFile[];
  /** Set for the 'branch' and 'commit' bases. */
  compare?: GitCompareInfo;
  /** The requested ref or commit does not exist in this repo (files is empty). */
  missing?: 'ref' | 'commit';
}

export interface GitRefEntry {
  /** Short name: 'main', 'origin/main'. */
  name: string;
  kind: 'local' | 'remote';
  sha: string;
  /** Committer time of the tip, unix seconds. */
  time: number;
}

export interface GitRefsResult {
  repoRoot: string;
  /** Current branch, or '' when HEAD is detached. */
  current: string;
  head: string;
  /** The default branch 'branch' compares against without a ref ('' when none was found). */
  defaultRef: string;
  /** Local and remote branches, most recently committed first (capped). */
  refs: GitRefEntry[];
  /** The newest commits reachable from HEAD (capped at 100). */
  commits: Array<GitCommitSummary & { onBranch: boolean }>;
}

export interface GitDiffOptions {
  /** Only materialize before/after for these repo-relative paths (a rename
   *  matches on either side). The scope=session caller knows exactly which
   *  files it will show — without this it paid a `git show` for EVERY changed
   *  file in the repo and then threw most away (observed: 683 serial spawns
   *  ≈ 10.7s to display 16 files). */
  paths?: string[];
  /** 'branch': the ref to compare against (default: the repo's default branch). */
  ref?: string;
  /** 'commit': the commit to show. */
  commit?: string;
  /** List the files only (before/after left ''), each with a `sig`. */
  namesOnly?: boolean;
}

/** Injected command runner. Returns the captured streams + exit code; must NOT
 *  throw on a non-zero exit (git uses non-zero for "absent path" etc.). */
export type ExecFn = (argv: string[], cwd: string) => Promise<{ stdout: string; stderr: string; code: number }>;
/** Injected working-tree reader. Returns '' when the file is missing/unreadable. */
export type ReadTextFn = (absPath: string) => Promise<string>;

/** One `git diff --name-status` entry. */
export interface NameStatus {
  status: GitDiffFile['status'];
  relPath: string;
  /** Not in git at all yet (ls-files --others): shown as added. */
  untracked?: boolean;
  /** For renames/copies, the original path (so `before` reads the right blob). */
  oldRelPath?: string;
}

/** The revisions a base compares: `from` → `to` (absent `to` = working tree). */
interface ResolvedRevs { from: string; to?: string; compare?: GitCompareInfo; missing?: 'ref' | 'commit' }

/** Thrown when git can't satisfy the requested base (e.g. HEAD~1 on a single
 *  commit, or no upstream). The caller maps this to a user-facing 502. */
export class GitDiffError extends Error {}

/**
 * The algorithm, as one self-contained factory (see the header for why: the
 * source twin inlines its text). Errors it means for the user are thrown as
 * Error with 'gitDiff: true'; the wrappers below turn them into GitDiffError.
 */
export function createGitDiffCore(exec: ExecFn, readText: ReadTextFn) {
  const SHA_RE = /^[0-9a-f]{7,64}$/i;
  /** Untracked files a names-only list counts lines of (one git process each). */
  const UNTRACKED_COUNT_MAX = 100;
  const MAX_REFS = 500;
  const MAX_COMMITS = 100;
  const HASH_BATCH = 100;

  function fail(msg: string): never {
    const e = new Error(msg) as Error & { gitDiff?: boolean };
    e.gitDiff = true;
    throw e;
  }

  /** A ref name a caller may pass. It lands in git argv (never a shell), so the
   *  guard is against option injection ('-x'), revision syntax that is not a
   *  ref ('a..b', 'x@{1}', 'x^', 'x:path') and control characters. */
  function validRef(ref: unknown): ref is string {
    if (typeof ref !== 'string' || ref.length === 0 || ref.length > 250) return false;
    if (ref[0] === '-' || ref.indexOf('..') >= 0 || ref.indexOf('@{') >= 0) return false;
    return !/[\s~^:?*[\\\x00-\x1f\x7f]/.test(ref);
  }

  /** posix join (repoRoot + relPath); both sides use forward slashes on the hosts
   *  we target. Avoids a node:path dependency so the factory stays self-contained. */
  function joinPosix(a: string, b: string): string {
    if (!a) return b;
    return a.endsWith('/') ? a + b : a + '/' + b;
  }

  async function verifyCommit(rev: string, root: string): Promise<string> {
    const r = await exec(['git', 'rev-parse', '--verify', '--quiet', rev + '^{commit}'], root);
    return r.code === 0 ? r.stdout.trim() : '';
  }

  /** An origin that is a path on this machine (a clone of another checkout): its HEAD is
   *  whatever branch that checkout had out, not a default anyone chose. */
  function isLocalRemote(url: string): boolean {
    return url.charAt(0) === '/' || url.charAt(0) === '.' || url.charAt(0) === '~' || url.indexOf('file:') === 0 || /^[A-Za-z]:[\\/]/.test(url);
  }

  /** The default branch. Candidates: origin/HEAD (not a local origin's: that is whatever
   *  branch the other checkout had out), then main and master on each remote, origin first,
   *  then the local ones. The one HEAD left most recently wins (fewest commits since the
   *  merge-base), earlier candidates on a tie: a remote's HEAD can name an old work branch,
   *  and a remote the clone no longer fetches keeps a main days behind (2026-11-09: a task's
   *  clone had origin/HEAD on another task's branch and a stale origin/main, while it
   *  tracked a second remote's main). The current branch and its own remote copies are never
   *  candidates, except a network origin's HEAD naming it: then this IS the default branch. */
  async function defaultBranch(root: string): Promise<string> {
    const sym = await exec(['git', 'symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'], root);
    const originHead = sym.code === 0 ? sym.stdout.trim() : '';
    const url = await exec(['git', 'config', '--get', 'remote.origin.url'], root);
    const local = url.code === 0 && isLocalRemote(url.stdout.trim());
    const br = await exec(['git', 'rev-parse', '--abbrev-ref', 'HEAD'], root);
    const current = br.code === 0 && br.stdout.trim() !== 'HEAD' ? br.stdout.trim() : '';
    const up = current ? await exec(['git', 'rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'], root) : null;
    const upstream = up && up.code === 0 ? up.stdout.trim() : '';
    // Every remote's main and master, read from the refs themselves: a clone can hold another
    // remote's branches (fetched with its own refspec) without that remote being configured.
    const fer = await exec(['git', 'for-each-ref', '--format=%(refname)', 'refs/remotes/*/main', 'refs/remotes/*/master'], root);
    const remoteMains = fer.code === 0 ? fer.stdout.split('\n').map((r) => r.trim().slice(13)).filter((r) => r.split('/').length === 2) : [];
    const originFirst = (n: string): number => (n.indexOf('origin/') === 0 ? 0 : 1);
    remoteMains.sort((a, b) => originFirst(a) - originFirst(b) || (a < b ? -1 : a > b ? 1 : 0));
    const ownCopy = (name: string): boolean => {
      if (!current) return false;
      if (name === current || name === upstream) return true;
      return name.length > current.length + 1 && name.slice(-(current.length + 1)) === '/' + current;
    };
    if (originHead && !local && ownCopy(originHead)) return originHead;
    const names: string[] = [];
    if (originHead && !local) names.push(originHead);
    for (const r of remoteMains.slice(0, 12)) names.push(r);
    names.push('main', 'master');
    let best = '';
    let bestDist = -1;
    const seen: Record<string, boolean> = {};
    for (const name of names) {
      if (seen[name] || ownCopy(name)) continue;
      seen[name] = true;
      const full = (name === 'main' || name === 'master' ? 'refs/heads/' : 'refs/remotes/') + name;
      const tip = await verifyCommit(full, root);
      if (!tip) continue;
      const mb = await exec(['git', 'merge-base', 'HEAD', tip], root);
      if (mb.code !== 0 || !mb.stdout.trim()) continue;
      const count = await exec(['git', 'rev-list', '--count', mb.stdout.trim() + '..HEAD'], root);
      const dist = count.code === 0 ? Number(count.stdout.trim()) : NaN;
      if (!isFinite(dist)) continue;
      if (bestDist < 0 || dist < bestDist) { best = name; bestDist = dist; }
    }
    return best || originHead;
  }

  function parseCommitLine(line: string): GitCommitSummary | null {
    const f = line.split('\x1f');
    if (f.length < 5 || !f[0]) return null;
    const parents = f[1] ? f[1].split(' ').filter(Boolean) : [];
    return {
      sha: f[0], parent: parents[0] || '', parents: parents.length,
      author: f[2] || '', time: Number(f[3]) || 0, subject: f.slice(4).join('\x1f'),
    };
  }
  const COMMIT_FORMAT = '--format=%H%x1f%P%x1f%an%x1f%ct%x1f%s';

  /** The revisions a base compares: 'from' → 'to' (absent 'to' = working tree). */
  async function resolveRevs(base: GitDiffBase, root: string, opts: GitDiffOptions): Promise<ResolvedRevs> {
    if (base === 'uncommitted') return { from: 'HEAD' };
    // HEAD~1 → working tree: the latest commit + uncommitted, vs the one before.
    if (base === 'previous') return { from: 'HEAD~1' };
    if (base === 'remote') {
      // Prefer the configured upstream; fall back to origin/<branch>.
      const up = await exec(['git', 'rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'], root);
      if (up.code === 0 && up.stdout.trim()) return { from: up.stdout.trim() };
      const br = await exec(['git', 'rev-parse', '--abbrev-ref', 'HEAD'], root);
      const branch = br.stdout.trim();
      if (branch && branch !== 'HEAD' && await verifyCommit('refs/remotes/origin/' + branch, root)) return { from: 'origin/' + branch };
      // Never pushed (or detached): everything since it left the default branch is unpushed.
      const def = await defaultBranch(root);
      const tip = def ? await verifyCommit((def.indexOf('/') >= 0 ? 'refs/remotes/' : 'refs/heads/') + def, root) : '';
      const mb = tip ? await exec(['git', 'merge-base', 'HEAD', tip], root) : null;
      const from = mb && mb.code === 0 ? mb.stdout.trim() : '';
      if (!from) fail('This branch has no upstream and no default branch to measure it against, so there is nothing to call "not yet pushed".');
      return { from };
    }
    if (base === 'branch') {
      let ref = opts.ref;
      const isDefault = ref === undefined || ref === '';
      if (isDefault) {
        ref = await defaultBranch(root);
        if (!ref) fail('No default branch found (no origin/HEAD, main or master). Pick a branch to compare with.');
      } else if (!validRef(ref)) {
        fail('Not a branch name: ' + String(ref));
      }
      // A branch, never a same-named tag: git's own lookup order puts tags first.
      let tip = '';
      for (const full of isDefault ? [ref as string] : ['refs/heads/' + ref, 'refs/remotes/' + ref, ref as string]) {
        tip = await verifyCommit(full, root);
        if (tip) break;
      }
      if (!tip) return { from: '', missing: 'ref' };
      const mb = await exec(['git', 'merge-base', 'HEAD', tip], root);
      const baseSha = mb.code === 0 ? mb.stdout.trim() : '';
      if (!baseSha) fail('HEAD and ' + ref + ' share no history.');
      return { from: baseSha, compare: { base: 'branch', ref: ref as string, isDefault, baseSha } };
    }
    // 'commit'
    const want = opts.commit;
    if (typeof want !== 'string' || !SHA_RE.test(want)) fail('Not a commit id: ' + String(want));
    const sha = await verifyCommit(want as string, root);
    if (!sha) return { from: '', missing: 'commit' };
    const info = await exec(['git', 'log', '-1', COMMIT_FORMAT, sha], root);
    const commit = info.code === 0 ? parseCommitLine(info.stdout.replace(/\n+$/, '')) : null;
    if (!commit) fail('Could not read commit ' + sha);
    let from = (commit as GitCommitSummary).parent;
    if (!from) {
      // A root commit: compare against the empty tree (its id depends on the hash algorithm).
      const empty = await exec(['git', 'hash-object', '-t', 'tree', '/dev/null'], root);
      from = empty.stdout.trim();
      if (empty.code !== 0 || !from) fail('Could not compute the empty tree');
    }
    return { from, to: sha, compare: { base: 'commit', baseSha: (commit as GitCommitSummary).parent, commit: commit as GitCommitSummary } };
  }

  /** Parse 'git diff --name-status -z <rev>' output into typed entries. */
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

  /** Working-tree blob ids for 'rels', one git run per batch ('' when unknown). */
  async function worktreeSigs(root: string, rels: string[]): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    for (let s = 0; s < rels.length; s += HASH_BATCH) {
      const batch = rels.slice(s, s + HASH_BATCH);
      // --no-filters: the raw file (an LFS or other clean filter would run per file otherwise).
      const r = await exec(['git', 'hash-object', '--no-filters', '--'].concat(batch), root);
      const ids = r.code === 0 ? r.stdout.split('\n').filter(Boolean) : [];
      if (ids.length === batch.length) {
        for (let k = 0; k < batch.length; k++) out.set(batch[k]!, ids[k]!);
        continue;
      }
      // One unreadable path (a directory, a vanished file) fails the batch: one by one.
      for (const rel of batch) {
        const one = await exec(['git', 'hash-object', '--no-filters', '--', rel], root);
        out.set(rel, one.code === 0 ? one.stdout.trim() : '');
      }
    }
    return out;
  }

  /**
   * Compute a whole-repo git diff for 'cwd''s repository against 'base'.
   * Returns null when cwd isn't a git repo; throws (gitDiff) when the base
   * can't be resolved, and answers 'missing' when the asked ref or commit is
   * not in this repo.
   */
  async function diff(base: GitDiffBase, cwd: string, opts?: GitDiffOptions): Promise<GitDiffResult | null> {
    const o = opts || {};
    // Repo root anchors all relPaths + blob reads.
    const rootRes = await exec(['git', 'rev-parse', '--show-toplevel'], cwd);
    if (rootRes.code !== 0 || !rootRes.stdout.trim()) return null; // not a git repo
    const repoRoot = rootRes.stdout.trim();

    const revs = await resolveRevs(base, repoRoot, o);
    if (revs.missing) return { repoRoot, files: [], missing: revs.missing };

    // Whole-repo changed-file list vs the base.
    const nsArgs = ['git', 'diff', '--name-status', '-z', revs.from];
    if (revs.to) nsArgs.push(revs.to);
    const ns = await exec(nsArgs, repoRoot);
    if (ns.code !== 0) {
      // e.g. HEAD~1 missing (shallow/single commit), or unknown upstream rev.
      fail(ns.stderr.trim() || 'git diff against ' + revs.from + ' failed');
    }
    let entries = parseNameStatusZ(ns.stdout);

    // Untracked files are "not committed" too, but 'git diff' never reports them.
    // Include them read-only ('ls-files --others', NO index mutation) so the
    // "local has random files" case actually shows them. They render as 'added'.
    // A commit is a fixed snapshot: the working tree has no part in it.
    if (!revs.to) {
      const tracked = new Set(entries.map((e) => e.relPath));
      // Narrowed to the asked paths when there are few (one file of a lazy list).
      const lsArgs = ['git', 'ls-files', '--others', '--exclude-standard', '-z'];
      if (o.paths && o.paths.length > 0 && o.paths.length <= 50) lsArgs.push('--', ...o.paths.map((p) => ':(literal)' + p));
      const others = await exec(lsArgs, repoRoot);
      if (others.code === 0) {
        for (const rel of others.stdout.split('\0')) {
          if (rel && !tracked.has(rel)) {
            entries.push({ status: 'added', relPath: rel, untracked: true });
            tracked.add(rel);
          }
        }
      }
    }
    if (o.paths) {
      const want = new Set(o.paths);
      entries = entries.filter((e) => want.has(e.relPath) || (e.oldRelPath !== undefined && want.has(e.oldRelPath)));
    }
    const done = (files: GitDiffFile[]): GitDiffResult => {
      files.sort((a, b) => a.relPath.localeCompare(b.relPath));
      const res: GitDiffResult = { repoRoot, files };
      if (revs.compare) res.compare = revs.compare;
      return res;
    };
    if (entries.length === 0) return done([]);

    if (o.namesOnly) {
      // The working tree changes under a reader; a commit never does.
      const sigs = revs.to ? null : await worktreeSigs(repoRoot, entries.filter((e) => e.status !== 'deleted').map((e) => e.relPath));
      // Which modified files keep a change once whitespace is ignored: one more
      // run, no content. --numstat honours -w (--name-only does not): a file
      // whose every change is whitespace is left out of it.
      const wsArgs = ['git', 'diff', '-w', '--numstat', '-z', revs.from];
      if (revs.to) wsArgs.push(revs.to);
      // The line counts a names-only list shows: --numstat without -w, so they
      // match a diff of the content, with renames found as the list above found
      // them; a line's trailing CR is not a change (the list's counts and the
      // phone's diff both read CRLF and LF lines alike).
      const countArgs = ['git', 'diff', '--numstat', '--ignore-cr-at-eol', '-z', revs.from];
      if (revs.to) countArgs.push(revs.to);
      const [ws, counted] = await Promise.all([
        entries.some((e) => e.status === 'modified') ? exec(wsArgs, repoRoot) : Promise.resolve(null),
        exec(countArgs, repoRoot),
      ]);
      const counts = new Map<string, { additions: number; deletions: number }>();
      // Every path the count run names, a binary one ('-') included.
      const countedPaths = new Set<string>();
      if (counted.code === 0) {
        const parts = counted.stdout.split('\0');
        for (let k = 0; k < parts.length; k++) {
          const m = /^([0-9-]+)\t([0-9-]+)\t([\s\S]*)$/.exec(parts[k]!.replace(/^\n/, ''));
          if (!m) continue;
          let rel = m[3]!;
          if (!rel) { rel = parts[k + 2] || ''; k += 2; }
          countedPaths.add(rel);
          // A binary file prints '-' for both.
          if (m[1] !== '-' && m[2] !== '-') counts.set(rel, { additions: Number(m[1]), deletions: Number(m[2]) });
        }
      }
      // git diff never reports an untracked file: count each against nothing
      // ('--no-index', which also says '-' for a binary one). A process per
      // file, so only the first UNTRACKED_COUNT_MAX of them, a few at a time.
      const untracked = entries.filter((e) => e.untracked).slice(0, UNTRACKED_COUNT_MAX);
      for (let k = 0; k < untracked.length; k += 8) {
        await Promise.all(untracked.slice(k, k + 8).map(async (e) => {
          const r = await exec(['git', 'diff', '--no-index', '--numstat', '--ignore-cr-at-eol', '-z', '--', '/dev/null', e.relPath], repoRoot);
          // --no-index exits 1 when the two differ.
          if (r.code !== 0 && r.code !== 1) return;
          const m = /^([0-9-]+)\t([0-9-]+)\t/.exec(r.stdout.replace(/^\n/, ''));
          if (m && m[1] !== '-' && m[2] !== '-') counts.set(e.relPath, { additions: Number(m[1]), deletions: Number(m[2]) });
        }));
      }
      let realChange: Set<string> | null = null;
      if (ws && ws.code === 0) {
        realChange = new Set();
        const parts = ws.stdout.split('\0');
        for (let k = 0; k < parts.length; k++) {
          const m = /^[0-9-]+\t[0-9-]+\t([\s\S]*)$/.exec(parts[k]!.replace(/^\n/, ''));
          if (!m) continue;
          // A rename prints an empty path, then the old and the new one.
          if (m[1]) realChange.add(m[1]);
          else { realChange.add(parts[k + 2] || ''); k += 2; }
        }
      }
      return done(entries.map((e) => {
        const f: GitDiffFile = { relPath: e.relPath, before: '', after: '', status: e.status, sig: sigs ? (sigs.get(e.relPath) || '') : '' };
        if (e.oldRelPath !== undefined) f.oldRelPath = e.oldRelPath;
        if (e.untracked) f.untracked = true;
        if (realChange && e.status === 'modified' && !realChange.has(e.relPath)) f.wsOnly = true;
        const n = counts.get(e.relPath);
        if (n) { f.additions = n.additions; f.deletions = n.deletions; }
        // Modified, yet no line left once CRs are set aside: only line endings
        // changed, which the diff of its content counts as nothing too.
        else if (counted.code === 0 && e.status === 'modified' && !countedPaths.has(e.relPath)) { f.additions = 0; f.deletions = 0; }
        return f;
      }));
    }

    // before = blob at the base rev ('git show <rev>:<path>'); after = working
    // tree content (or the commit's blob). Host-local but each 'git show' is a
    // process spawn — a serial loop over a big repo took ~15ms × N. Small
    // parallel pool instead.
    const files: GitDiffFile[] = new Array(entries.length);
    let next = 0;
    const worker = async (): Promise<void> => {
      while (next < entries.length) {
        const i = next++;
        const e = entries[i]!;
        const beforePath = e.oldRelPath ?? e.relPath;
        let before = '';
        if (e.status !== 'added') {
          const show = await exec(['git', 'show', revs.from + ':' + beforePath], repoRoot);
          before = show.code === 0 ? show.stdout : ''; // non-zero = absent at base
        }
        let after = '';
        if (e.status !== 'deleted') {
          if (revs.to) {
            const show = await exec(['git', 'show', revs.to + ':' + e.relPath], repoRoot);
            after = show.code === 0 ? show.stdout : '';
          } else {
            after = await readText(joinPosix(repoRoot, e.relPath));
          }
        }
        files[i] = { relPath: e.relPath, before, after, status: e.status, oldRelPath: e.oldRelPath };
        if (e.untracked) files[i]!.untracked = true;
      }
    };
    const pool = Math.min(8, entries.length);
    const workers: Promise<void>[] = [];
    for (let w = 0; w < pool; w++) workers.push(worker());
    await Promise.all(workers);
    return done(files);
  }

  /** Branches and recent commits of 'cwd''s repository, for a compare picker. */
  async function refs(cwd: string): Promise<GitRefsResult | null> {
    const rootRes = await exec(['git', 'rev-parse', '--show-toplevel'], cwd);
    if (rootRes.code !== 0 || !rootRes.stdout.trim()) return null;
    const repoRoot = rootRes.stdout.trim();
    const br = await exec(['git', 'rev-parse', '--abbrev-ref', 'HEAD'], repoRoot);
    const current = br.code === 0 && br.stdout.trim() !== 'HEAD' ? br.stdout.trim() : '';
    const head = await verifyCommit('HEAD', repoRoot);
    const defaultRef = await defaultBranch(repoRoot);

    const list: GitRefEntry[] = [];
    const fer = await exec(['git', 'for-each-ref', '--sort=-committerdate', '--count=' + (MAX_REFS + 20),
      '--format=%(refname)%1f%(objectname)%1f%(committerdate:unix)', 'refs/heads', 'refs/remotes'], repoRoot);
    if (fer.code === 0) {
      for (const line of fer.stdout.split('\n')) {
        const f = line.split('\x1f');
        const refname = f[0] || '';
        let kind: GitRefEntry['kind'];
        let name: string;
        if (refname.indexOf('refs/heads/') === 0) { kind = 'local'; name = refname.slice(11); }
        else if (refname.indexOf('refs/remotes/') === 0) { kind = 'remote'; name = refname.slice(13); }
        else continue;
        // origin/HEAD is an alias of a branch already listed.
        if (kind === 'remote' && /\/HEAD$/.test(name)) continue;
        if (!validRef(name)) continue;
        list.push({ name, kind, sha: f[1] || '', time: Number(f[2]) || 0 });
        if (list.length >= MAX_REFS) break;
      }
    }

    const commits: GitRefsResult['commits'] = [];
    if (head) {
      const lg = await exec(['git', 'log', '-n', String(MAX_COMMITS), COMMIT_FORMAT, 'HEAD'], repoRoot);
      // Commits this branch adds over the default branch (marked in the list).
      const ahead = new Set<string>();
      if (defaultRef) {
        const tip = await verifyCommit(defaultRef, repoRoot);
        if (tip) {
          const rl = await exec(['git', 'rev-list', '-n', String(MAX_COMMITS), tip + '..HEAD'], repoRoot);
          if (rl.code === 0) for (const s of rl.stdout.split('\n')) if (s) ahead.add(s.trim());
        }
      }
      if (lg.code === 0) {
        for (const line of lg.stdout.split('\n')) {
          const c = parseCommitLine(line);
          if (c) commits.push(Object.assign(c, { onBranch: ahead.has(c.sha) }));
        }
      }
    }
    return { repoRoot, current, head, defaultRef, refs: list, commits };
  }

  return { diff, refs, validRef, parseNameStatusZ };
}

/** A caller-supplied ref name that is safe to hand to git (see createGitDiffCore). */
export function isValidGitRef(ref: unknown): ref is string {
  return createGitDiffCore(async () => ({ stdout: '', stderr: '', code: 1 }), async () => '').validRef(ref);
}

/** A caller-supplied commit id (abbreviated or full). */
export function isValidGitCommit(sha: unknown): sha is string {
  return typeof sha === 'string' && /^[0-9a-f]{7,64}$/i.test(sha);
}

function rethrow(err: unknown): never {
  if (err && typeof err === 'object' && (err as { gitDiff?: boolean }).gitDiff) {
    throw new GitDiffError((err as Error).message);
  }
  throw err;
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
  opts?: GitDiffOptions,
): Promise<GitDiffResult | null> {
  try {
    return await createGitDiffCore(exec, readText).diff(base, cwd, opts);
  } catch (err) {
    return rethrow(err);
  }
}

/** Branches and recent commits of `cwd`'s repository (null: not a git repo). */
export async function listGitRefs(cwd: string, exec: ExecFn): Promise<GitRefsResult | null> {
  try {
    return await createGitDiffCore(exec, async () => '').refs(cwd);
  } catch (err) {
    return rethrow(err);
  }
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
