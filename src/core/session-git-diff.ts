/**
 * Session Git Diff — compare what THIS session changed against a git base, and
 * return the same {groups,files,before/after} shape the JSONL engine produces so
 * the frontend renders identically regardless of source.
 *
 * This complements session-changes.ts (which replays the session's OWN edits from
 * JSONL, reconstructing before/after without git). Here the user picks a git
 * comparison BASE — the baseline that `before` is read from:
 *
 *   - 'uncommitted'  → `git diff HEAD`     (working tree vs last commit)
 *   - 'previous'     → `git diff HEAD~1`   (latest commit + uncommitted, vs the
 *                       commit before — the "compare to the one before" case)
 *   - 'remote'       → `git diff @{upstream}` (unpushed vs the remote branch;
 *                       falls back to origin/<branch> when no upstream)
 *
 * ## Repo universe = what the session TOUCHED, never the cwd wholesale
 * The repos we diff are exactly the repos the session actually edited files in —
 * discovered by the JSONL engine (which walks up from each edited file to its
 * `.git`, so it correctly spans multiple repos / submodules / a repo that isn't
 * the cwd). We do NOT diff "whatever repo the cwd happens to sit in": a session
 * that edited nothing returns EMPTY in every base/scope, and a session that
 * edited files in repo B but launched from repo A shows B, not A. Anchoring on
 * cwd was wrong — it surfaced unrelated repo changes the session never made.
 *
 *   - scope 'session' (default) → only the files this session edited, with the
 *     chosen base's before/after. "It doesn't matter which mode — it's the files
 *     we actually changed; the mode only changes the baseline."
 *   - scope 'all'               → every change in the TOUCHED repos (e.g. a
 *     concurrent process also dirtied a sibling file in the same repo). Still
 *     never includes untouched repos.
 *
 * ## Where the git work runs (important)
 * The algorithm lives in `git-diff-core.ts` and ALWAYS runs ON THE HOST that
 * owns the repo, so git + the files are local to it and there are no per-file
 * network round trips:
 *   - LOCAL session (`__local__`): run the core in-process via node child_process.
 *   - REMOTE session: call the daemon's `git.diff` RPC per touched repo — the
 *     daemon runs the SAME core on the remote machine and returns the full result.
 * We do NOT shell out over SSH here (an earlier version did, 2 hops × N files,
 * which hung remote diffs). All remote work goes through the daemon RPC, like
 * every other remote operation (fs.read/ls/find/stat).
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { link } from './hosts/link.js';
import {
  computeGitDiff,
  listGitRefs,
  GitDiffError,
  type GitDiffBase,
  type GitDiffResult,
  type GitDiffOptions,
  type GitCompareInfo,
  type GitRefsResult,
  type ExecFn,
  type ReadTextFn,
} from '../providers/git-diff-core.js';
import { computeSessionChanges, isExcludedPath, type SessionChangesResult, type SessionFileChange, type SessionRepoGroup } from './session-changes.js';
import { log } from '../logging/index.js';
import { gitChildEnv } from '../lib/git-env.js';

const execFileAsync = promisify(execFile);
const GIT_TIMEOUT_MS = 25_000;
const MAX_BUFFER = 64 * 1024 * 1024;

export type { GitDiffBase } from '../providers/git-diff-core.js';

/** Which files to show within the repos the session touched. */
export type GitDiffScope = 'session' | 'all';

// ── Local primitives (run git in-process for __local__ sessions) ──

const localExec: ExecFn = async (argv, cwd) => {
  try {
    // The repo the cwd names (no inherited GIT_DIR), no optional index lock: these are reads.
    const { stdout, stderr } = await execFileAsync(argv[0]!, argv.slice(1), {
      cwd, timeout: GIT_TIMEOUT_MS, maxBuffer: MAX_BUFFER, encoding: 'utf-8',
      env: gitChildEnv({ GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' }),
    });
    return { stdout, stderr, code: 0 };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; code?: number; message?: string };
    return {
      stdout: typeof e.stdout === 'string' ? e.stdout : '',
      stderr: typeof e.stderr === 'string' ? e.stderr : (e.message ?? ''),
      code: typeof e.code === 'number' ? e.code : 1,
    };
  }
};

const localReadText: ReadTextFn = async (absPath) => {
  try { return await fsp.readFile(absPath, 'utf-8'); } catch { return ''; }
};

/** The daemon capability behind the 'branch' / 'commit' bases, light git lists and git.refs. */
export const GIT_COMPARE_CAPABILITY = 'git-compare-v1';

/** The bases that compare a whole branch or one commit (every file, not only the session's). */
export function isWholeRepoBase(base: GitDiffBase): boolean {
  return base === 'branch' || base === 'commit';
}

/** The ref/commit/names-only knobs a git comparison carries beyond its base. */
export interface GitCompareOpts { ref?: string; commit?: string; namesOnly?: boolean }

/** A daemon link that speaks the compare protocol, or a GitDiffError saying it needs an update. */
async function compareLink(host: string, needsCompare: boolean) {
  // The link resolves the host (an unknown one throws `Unknown host: <alias>`).
  const conn = await link(host);
  if (needsCompare && conn.capabilitiesKnown && !conn.hasCapability(GIT_COMPARE_CAPABILITY)) {
    throw new GitDiffError(`The Walnut daemon on ${host} needs an update for this comparison. It updates itself the next time a session there gets a message.`);
  }
  return conn;
}

/**
 * Run the git-diff core against ONE repo root, local in-process or via the
 * daemon RPC for a remote host. Returns null when that path isn't a git repo;
 * throws GitDiffError when the base can't be resolved (e.g. HEAD~1 missing).
 */
async function runGitDiffForRepo(
  base: GitDiffBase,
  repoRoot: string,
  host: string | undefined,
  sessionId: string,
  paths?: string[],
  compare?: GitCompareOpts,
): Promise<GitDiffResult | null> {
  const opts: GitDiffOptions = {
    ...(paths ? { paths } : {}),
    ...(compare?.ref ? { ref: compare.ref } : {}),
    ...(compare?.commit ? { commit: compare.commit } : {}),
    ...(compare?.namesOnly ? { namesOnly: true } : {}),
  };
  if (host) {
    // Remote: the daemon runs the SAME core on the host (no per-file SSH hops).
    const conn = await compareLink(host, isWholeRepoBase(base) || !!compare?.namesOnly);
    // `paths` narrows the blob materialization to the files we'll show (old
    // daemons ignore the extra key — full result, same correctness).
    const res = await conn.send('git.diff', { base, cwd: repoRoot, ...opts });
    if (!res.ok) {
      const msg = typeof res.error === 'string' ? res.error : 'git.diff failed';
      log.session.debug('session-git-diff: remote git.diff failed', { sessionId, base, repoRoot, msg });
      throw new GitDiffError(msg);
    }
    if (!res.repoRoot) return null;
    return {
      repoRoot: res.repoRoot as string,
      files: res.files as GitDiffResult['files'],
      ...(res.compare ? { compare: res.compare as GitCompareInfo } : {}),
      ...(res.missing === 'ref' || res.missing === 'commit' ? { missing: res.missing } : {}),
    };
  }

  // Local: run the shared core in-process.
  return computeGitDiff(base, repoRoot, localExec, localReadText, opts);
}

/** A repo group of a git comparison: which base it resolved to rides along. */
export type GitSessionRepoGroup = SessionRepoGroup & { compare?: GitCompareInfo };

/** The repos a comparison reads: the ones the session edited, else (for the
 *  whole-repo bases) the repo the session works in. */
async function comparisonRepos(
  sessionId: string,
  base: GitDiffBase,
  cwd: string | undefined,
  host: string | undefined,
  outputFile: string | undefined,
  opts?: { noCache?: boolean },
): Promise<SessionRepoGroup[]> {
  const edits = await computeSessionChanges(sessionId, cwd, host, outputFile, opts);
  if (edits.groups.length > 0 || !isWholeRepoBase(base) || !cwd) return edits.groups;
  // A session that edited nothing still works on a branch: "this branch vs main"
  // and "this commit" are questions about that repo, not about the session's edits.
  return [{ repoRoot: cwd, label: path.posix.basename(cwd) || cwd, kind: 'cwd', files: [] }];
}

/**
 * Compute a git-based diff for the repos THIS session actually edited, against
 * the chosen base. The repo universe + scope come from the session's own edits
 * (JSONL), never from the cwd: a session that edited nothing returns empty in
 * every base/scope, and only repos it touched are diffed.
 *
 *   - scope 'session' (default) → only the files this session edited, but with
 *     the git base's before/after (the JSONL diff narrowed to git's baseline).
 *   - scope 'all'               → every change in each touched repo (so a sibling
 *     file a concurrent process also dirtied in the same repo shows too).
 *
 * The whole-repo bases ('branch', 'commit') always show every file (that is
 * what a branch or a commit IS), and fall back to the session's cwd repo when
 * the session edited nothing. A repo without the asked ref or commit is left
 * out; when no repo has it, that is an error.
 *
 * Throws GitDiffError when git can't satisfy the base for a touched repo (e.g.
 * HEAD~1 on a single-commit repo) so the route can surface a 502.
 */
export async function computeSessionGitDiff(
  sessionId: string,
  base: GitDiffBase,
  cwd: string | undefined,
  host: string | undefined,
  scope: GitDiffScope = 'session',
  outputFile?: string,
  opts?: { noCache?: boolean } & GitCompareOpts,
): Promise<SessionChangesResult & { groups: GitSessionRepoGroup[] }> {
  const wholeRepo = isWholeRepoBase(base);
  const effScope: GitDiffScope = wholeRepo ? 'all' : scope;
  // The session's own edits define WHICH repos we diff (and, for scope=session,
  // which files). No edits → nothing to show, regardless of base.
  const repos = await comparisonRepos(sessionId, base, cwd, host, outputFile, opts);
  if (repos.length === 0) {
    return { sessionId, groups: [], fileCount: 0, anyPartial: false };
  }
  const compare: GitCompareOpts = { ref: opts?.ref, commit: opts?.commit, namesOnly: wholeRepo && opts?.namesOnly === true };

  // Touched repos diff CONCURRENTLY (each is an independent host-local run);
  // scope=session also narrows blob materialization to the session's own files
  // (a whole-repo materialization was 683 `git show` spawns to display 16 files).
  const gitResults = await Promise.all(repos.map((editGroup) =>
    runGitDiffForRepo(
      base, editGroup.repoRoot, host, sessionId,
      effScope === 'session' ? editGroup.files.map((f) => f.relPath) : undefined,
      compare,
    )));

  if (wholeRepo && gitResults.length > 0 && gitResults.every((r) => !r || r.missing)) {
    const what = base === 'commit' ? `commit ${opts?.commit ?? ''}` : `branch ${opts?.ref ?? ''}`;
    if (gitResults.some((r) => r?.missing)) throw new GitDiffError(`No repository this session works in has ${what.trim()}.`);
  }

  const outGroups: GitSessionRepoGroup[] = [];
  for (let gi = 0; gi < repos.length; gi++) {
    const editGroup = repos[gi]!;
    const gitResult = gitResults[gi];
    if (!gitResult || gitResult.missing || gitResult.files.length === 0) {
      // A whole-repo comparison with nothing in it still says what it compared.
      if (wholeRepo && gitResult && !gitResult.missing && gitResult.compare) {
        outGroups.push({ repoRoot: gitResult.repoRoot, label: editGroup.label, kind: editGroup.kind, files: [], compare: gitResult.compare });
      }
      continue;
    }

    // Drop agent memory / bookkeeping in BOTH scopes — identical to the JSONL
    // engine's filter. For scope=session the intersect below already excludes them
    // (the edit set is pre-filtered), but scope=all takes git's raw file list, so
    // without this an agent's MEMORY.md / notes would re-appear under "All in repo"
    // (e.g. the git-synced ~/.open-walnut memory store). One filter, both paths.
    let gitFiles = gitResult.files.filter((f) => !isExcludedPath(path.posix.join(gitResult.repoRoot, f.relPath)));
    if (effScope === 'session') {
      const editedRel = new Set(editGroup.files.map((f) => f.relPath));
      gitFiles = gitFiles.filter((f) => editedRel.has(f.relPath));
    }
    if (gitFiles.length === 0 && !(wholeRepo && gitResult.compare)) continue;

    const files: Array<SessionFileChange & { sig?: string; wsOnly?: boolean; untracked?: boolean }> = gitFiles.map((f) => ({
      filePath: path.posix.join(gitResult.repoRoot, f.relPath),
      relPath: f.relPath,
      before: f.before,
      after: f.after,
      status: f.status,
      ...(f.oldRelPath ? { oldRelPath: f.oldRelPath } : {}),
      ...(f.sig !== undefined ? { sig: f.sig } : {}),
      ...(f.wsOnly ? { wsOnly: true } : {}),
      ...(f.untracked ? { untracked: true } : {}),
      ops: 1,
      partial: false,
    }));
    // Preserve the JSONL engine's repo label/kind (handles cwd/submodule/other).
    outGroups.push({
      repoRoot: gitResult.repoRoot, label: editGroup.label, kind: editGroup.kind, files,
      ...(gitResult.compare ? { compare: gitResult.compare } : {}),
    });
  }

  const fileCount = outGroups.reduce((n, g) => n + g.files.length, 0);
  return {
    sessionId, groups: outGroups, fileCount, anyPartial: false,
    ...(compare.namesOnly ? { light: true } : {}),
  };
}

/**
 * ONE file of a whole-repo comparison, with before/after: the lazy per-file
 * pair of a names-only list (the 'branch' and 'commit' bases ship light).
 * `filePath` must sit in a repo the comparison reads; null when that file is
 * not part of the comparison.
 */
export async function computeSessionGitFile(
  sessionId: string,
  base: GitDiffBase,
  cwd: string | undefined,
  host: string | undefined,
  outputFile: string | undefined,
  filePath: string,
  compare: GitCompareOpts & {
    /** The group's repo root from the list answer: git's own top level, which
     *  can differ from the session's paths (a symlinked home, a session working
     *  in a repo's subfolder). Trusted only when git reports that same top
     *  level for one of the comparison's repos. */
    repoRoot?: string;
  },
): Promise<{ repoRoot: string; file: SessionFileChange } | null> {
  if (isExcludedPath(filePath)) return null;
  const repos = await comparisonRepos(sessionId, base, cwd, host, outputFile);
  const withSlash = (p: string) => (p.endsWith('/') ? p : p + '/');
  const roots = repos.map((g) => g.repoRoot);
  const opts = { ref: compare.ref, commit: compare.commit };
  const pick = (res: GitDiffResult | null, rel: string) =>
    res && !res.missing ? (res.files.find((x) => x.relPath === rel) ?? res.files.find((x) => x.oldRelPath === rel)) : undefined;

  let res: GitDiffResult | null = null;
  let f: ReturnType<typeof pick>;
  const hint = compare.repoRoot;
  if (hint && filePath.startsWith(withSlash(hint))) {
    // The list's own root: the repo whose git top level it is. Repos whose
    // path relates to it go first (usually the only one).
    const rel = filePath.slice(withSlash(hint).length);
    const related = (r: string) => withSlash(r).startsWith(withSlash(hint)) || withSlash(hint).startsWith(withSlash(r));
    for (const r of [...roots.filter(related), ...roots.filter((r) => !related(r))]) {
      const got = await runGitDiffForRepo(base, r, host, sessionId, [rel], opts);
      if (got && got.repoRoot === hint) { res = got; f = pick(got, rel); break; }
    }
  } else {
    // The deepest repo holding the file (a submodule beats its parent).
    const owner = roots
      .filter((r) => filePath.startsWith(withSlash(r)))
      .sort((a, b) => b.length - a.length)[0];
    if (!owner) return null;
    const rel = filePath.slice(withSlash(owner).length);
    if (!rel) return null;
    res = await runGitDiffForRepo(base, owner, host, sessionId, [rel], opts);
    f = pick(res, rel);
  }
  if (!res || !f) return null;
  return {
    repoRoot: res.repoRoot,
    file: {
      filePath: path.posix.join(res.repoRoot, f.relPath), relPath: f.relPath, before: f.before, after: f.after,
      status: f.status, ...(f.oldRelPath ? { oldRelPath: f.oldRelPath } : {}), ops: 1, partial: false,
    },
  };
}

/**
 * Branches and recent commits for the Changed tab's compare picker, from the
 * session's main repo: the cwd's repo when the session edited it, else the
 * first repo it edited, else its cwd. Null when none of those is a git repo.
 */
export async function listSessionGitRefs(
  sessionId: string,
  cwd: string | undefined,
  host: string | undefined,
  outputFile?: string,
): Promise<GitRefsResult | null> {
  const repos = await comparisonRepos(sessionId, 'branch', cwd, host, outputFile);
  const main = repos.find((g) => g.kind === 'cwd') ?? repos[0];
  if (!main) return null;
  if (host) {
    const conn = await compareLink(host, true);
    const res = await conn.send('git.refs', { cwd: main.repoRoot });
    if (!res.ok) throw new GitDiffError(typeof res.error === 'string' ? res.error : 'git.refs failed');
    return res.repoRoot ? (res as unknown as GitRefsResult) : null;
  }
  return listGitRefs(main.repoRoot, localExec);
}
