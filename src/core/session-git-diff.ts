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
import { getConfig } from './config-manager.js';
import { getDaemonConnection } from '../providers/daemon-connection.js';
import {
  computeGitDiff,
  GitDiffError,
  type GitDiffBase,
  type GitDiffResult,
  type ExecFn,
  type ReadTextFn,
} from '../providers/git-diff-core.js';
import { computeSessionChanges, isExcludedPath, type SessionChangesResult, type SessionFileChange, type SessionRepoGroup } from './session-changes.js';
import { log } from '../logging/index.js';

const execFileAsync = promisify(execFile);
const GIT_TIMEOUT_MS = 25_000;
const MAX_BUFFER = 64 * 1024 * 1024;

export type { GitDiffBase } from '../providers/git-diff-core.js';

/** Which files to show within the repos the session touched. */
export type GitDiffScope = 'session' | 'all';

// ── Local primitives (run git in-process for __local__ sessions) ──

const localExec: ExecFn = async (argv, cwd) => {
  try {
    const { stdout, stderr } = await execFileAsync(argv[0]!, argv.slice(1), {
      cwd, timeout: GIT_TIMEOUT_MS, maxBuffer: MAX_BUFFER, encoding: 'utf-8',
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
): Promise<GitDiffResult | null> {
  if (host) {
    // Remote: the daemon runs the SAME core on the host (no per-file SSH hops).
    const config = await getConfig();
    const hostDef = config.hosts?.[host];
    if (!hostDef) throw new Error(`Unknown host: ${host}`);
    const hostname = hostDef.hostname ?? (hostDef as Record<string, unknown>).ssh as string;
    if (!hostname) throw new Error(`Host ${host} missing hostname`);
    const conn = await getDaemonConnection(host, { hostname, user: hostDef.user, port: hostDef.port });

    const res = await conn.send('git.diff', { base, cwd: repoRoot });
    if (!res.ok) {
      const msg = typeof res.error === 'string' ? res.error : 'git.diff failed';
      log.session.debug('session-git-diff: remote git.diff failed', { sessionId, base, repoRoot, msg });
      throw new GitDiffError(msg);
    }
    return res.repoRoot ? { repoRoot: res.repoRoot as string, files: res.files as GitDiffResult['files'] } : null;
  }

  // Local: run the shared core in-process.
  return computeGitDiff(base, repoRoot, localExec, localReadText);
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
 *     file a concurrent process dirtied in the same repo shows too).
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
  opts?: { noCache?: boolean },
): Promise<SessionChangesResult> {
  // The session's own edits define WHICH repos we diff (and, for scope=session,
  // which files). No edits → nothing to show, regardless of base.
  const edits = await computeSessionChanges(sessionId, cwd, host, outputFile, opts);
  if (edits.groups.length === 0) {
    return { sessionId, groups: [], fileCount: 0, anyPartial: false };
  }

  const outGroups: SessionRepoGroup[] = [];
  for (const editGroup of edits.groups) {
    // Diff THIS touched repo against the base (anchored on its own root).
    const gitResult = await runGitDiffForRepo(base, editGroup.repoRoot, host, sessionId);
    if (!gitResult || gitResult.files.length === 0) continue;

    // Drop agent memory / bookkeeping in BOTH scopes — identical to the JSONL
    // engine's filter. For scope=session the intersect below already excludes them
    // (the edit set is pre-filtered), but scope=all takes git's raw file list, so
    // without this an agent's MEMORY.md / notes would re-appear under "All in repo"
    // (e.g. the git-synced ~/.open-walnut memory store). One filter, both paths.
    let gitFiles = gitResult.files.filter((f) => !isExcludedPath(path.posix.join(gitResult.repoRoot, f.relPath)));
    if (gitFiles.length === 0) continue;
    if (scope === 'session') {
      const editedRel = new Set(editGroup.files.map((f) => f.relPath));
      gitFiles = gitFiles.filter((f) => editedRel.has(f.relPath));
      if (gitFiles.length === 0) continue;
    }

    const files: SessionFileChange[] = gitFiles.map((f) => ({
      filePath: path.posix.join(gitResult.repoRoot, f.relPath),
      relPath: f.relPath,
      before: f.before,
      after: f.after,
      status: f.status,
      ...(f.oldRelPath ? { oldRelPath: f.oldRelPath } : {}),
      ops: 1,
      partial: false,
    }));
    // Preserve the JSONL engine's repo label/kind (handles cwd/submodule/other).
    outGroups.push({ repoRoot: gitResult.repoRoot, label: editGroup.label, kind: editGroup.kind, files });
  }

  const fileCount = outGroups.reduce((n, g) => n + g.files.length, 0);
  return { sessionId, groups: outGroups, fileCount, anyPartial: false };
}
