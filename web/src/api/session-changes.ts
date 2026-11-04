import { apiGet } from './client';

/** A single file the session changed, with reconstructed before/after content.
 *  Mirrors SessionFileChange in src/core/session-changes.ts. */
export interface SessionFileChange {
  filePath: string;
  relPath: string;
  before: string;
  after: string;
  status: 'added' | 'modified' | 'deleted' | 'renamed';
  /** For a rename (mv/git mv), the repo-relative ORIGINAL path. */
  oldRelPath?: string;
  ops: number;
  partial: boolean;
  /** Names-only git lists (branch / commit bases): the working-tree blob id,
   *  so a Viewed mark can tell the file changed without its content. */
  sig?: string;
  /** Names-only git lists: every change in this (modified) file is whitespace. */
  wsOnly?: boolean;
  /** Git bases: an added file git does not track yet. */
  untracked?: boolean;
}

/** One commit, as git-diff-core.ts reports it. */
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

/** What a 'branch' or 'commit' comparison resolved to (mirrors GitCompareInfo). */
export interface GitCompareInfo {
  base: 'branch' | 'commit';
  ref?: string;
  isDefault?: boolean;
  /** The commit `before` is read from (branch: the merge-base; commit: its parent). */
  baseSha: string;
  commit?: GitCommitSummary;
}

/** A group of changed files sharing a repo root. */
export interface SessionRepoGroup {
  repoRoot: string;
  label: string;
  kind: 'cwd' | 'other' | 'submodule';
  files: SessionFileChange[];
  /** Branch / commit bases: what this repo's comparison resolved to. */
  compare?: GitCompareInfo;
}

export interface SessionChangesResult {
  sessionId: string;
  groups: SessionRepoGroup[];
  fileCount: number;
  anyPartial: boolean;
  /** SWR markers: served from cache/disk, possibly outdated, recompute running. */
  stale?: boolean;
  refreshing?: boolean;
  /** True when before/after content is absent (light list — fetch per-file diffs
   *  via fetchSessionFileChange). */
  light?: boolean;
}

/**
 * Comparison base for the Changed view.
 *  - 'session'     → this session's OWN edits, derived from its JSONL (default;
 *                    the only mode that can attribute concurrent edits).
 *  - 'uncommitted' → whole-repo `git diff HEAD` (working tree vs last commit).
 *  - 'previous'    → whole-repo `git diff HEAD~1` (incl. latest commit, vs the one before).
 *  - 'remote'      → whole-repo `git diff @{upstream}` (unpushed vs the remote).
 *  - 'branch'      → the working tree vs the merge-base with a ref (the repo's
 *                    default branch when none): everything the branch changes.
 *  - 'commit'      → one commit vs its first parent.
 * The git modes show the real working tree (random uncommitted files included).
 */
export type SessionDiffBase = 'session' | 'uncommitted' | 'previous' | 'remote' | 'branch' | 'commit';

/** A full comparison: the base plus the ref or commit it needs. */
export interface SessionDiffCompare {
  base: SessionDiffBase;
  /** base 'branch': the ref (absent = the repo's default branch). */
  ref?: string;
  /** base 'commit': the commit id. */
  commit?: string;
}

/** Branch and commit bases list every file of the branch or commit, names only;
 *  each file's diff loads on selection. */
export function isWholeRepoBase(base: SessionDiffBase): boolean {
  return base === 'branch' || base === 'commit';
}

/** The query keys a comparison adds (base 'session' adds none). */
function compareParams(c: SessionDiffCompare): Record<string, string> {
  const params: Record<string, string> = {};
  if (c.base !== 'session') params.base = c.base;
  if (c.base === 'branch' && c.ref) params.ref = c.ref;
  if (c.base === 'commit' && c.commit) params.commit = c.commit;
  return params;
}

/**
 * Which files to show in a git base mode:
 *  - 'all'     → every changed file in the repo (default).
 *  - 'session' → only files THIS session edited (intersect git diff with the
 *                session's JSONL). Ignored when base is 'session'.
 */
export type SessionDiffScope = 'all' | 'session';

/**
 * Fetch the files a session changed. Default base ('session') is JSONL-derived
 * before/after (no git). Git bases run `git diff` on the repos the session
 * touched (via the daemon for remote sessions), scoped by `scope`:
 *   - 'session' (server default) → only the files this session edited.
 *   - 'all'                      → every change in those touched repos.
 * We send scope=all explicitly (the server defaults to session); sending nothing
 * would mean "session". Remote sessions can take longer, so allow a generous
 * timeout. `refresh` bypasses the server mtime cache.
 */
export async function fetchSessionChanges(
  sessionId: string,
  opts?: { refresh?: boolean; base?: SessionDiffBase; scope?: SessionDiffScope; signal?: AbortSignal;
    /** base 'branch' / 'commit': the ref or commit (see SessionDiffCompare). */
    ref?: string; commit?: string;
    /** light: strip before/after (per-file diffs load lazily). swr: serve the
     *  last cached result instantly (stale:true) while recomputing. */
    light?: boolean; swr?: boolean },
): Promise<SessionChangesResult> {
  const params: Record<string, string> = opts?.base
    ? compareParams({ base: opts.base, ref: opts.ref, commit: opts.commit })
    : {};
  if (opts?.refresh) params.refresh = '1';
  if (opts?.scope === 'all') params.scope = 'all';
  if (opts?.light) params.light = '1';
  if (opts?.swr) params.swr = '1';
  return apiGet<SessionChangesResult>(
    `/api/sessions/${sessionId}/changes`,
    Object.keys(params).length ? params : undefined,
    { signal: opts?.signal, timeoutMs: 60_000 },
  );
}

/** One file's full change record (before/after included) — the lazy-diff pair
 *  of a light list fetch. Server-side this is a cache read after the list
 *  compute finishes. */
export async function fetchSessionFileChange(
  sessionId: string,
  filePath: string,
  opts?: { signal?: AbortSignal;
    /** A branch / commit comparison: that file's diff from git, in the group
     *  rooted at `repoRoot` (the list answer's root for the file). */
    compare?: SessionDiffCompare; repoRoot?: string },
): Promise<{ sessionId: string; repoRoot: string; file: SessionFileChange }> {
  const params: Record<string, string> = { path: filePath };
  if (opts?.compare && isWholeRepoBase(opts.compare.base)) {
    Object.assign(params, compareParams(opts.compare));
    if (opts.repoRoot) params.repo = opts.repoRoot;
  }
  return apiGet<{ sessionId: string; repoRoot: string; file: SessionFileChange }>(
    `/api/sessions/${sessionId}/changes/file`,
    params,
    { signal: opts?.signal, timeoutMs: 60_000 },
  );
}

/** One branch of the session's repo, for the compare picker. */
export interface GitRefEntry {
  name: string;
  kind: 'local' | 'remote';
  sha: string;
  time: number;
}

/** Branches and recent commits of the session's main repo (repoRoot null: no git repo). */
export interface SessionGitRefs {
  repoRoot: string | null;
  /** Current branch ('' when HEAD is detached). */
  current: string;
  head: string;
  /** The default branch 'branch' compares with when no ref is picked ('' when none). */
  defaultRef: string;
  refs: GitRefEntry[];
  /** Newest 100 commits from HEAD; onBranch = not on the default branch. */
  commits: Array<GitCommitSummary & { onBranch: boolean }>;
}

/** The compare picker's lists. A remote host answers through its daemon. */
export async function fetchSessionGitRefs(
  sessionId: string,
  opts?: { signal?: AbortSignal },
): Promise<SessionGitRefs> {
  return apiGet<SessionGitRefs>(
    `/api/sessions/${sessionId}/changes/refs`,
    undefined,
    { signal: opts?.signal, timeoutMs: 45_000 },
  );
}

/** AI summary of one changed file (Changed tab's ✦ strip).
 *  Mirrors the server's DiffSummaryResult DTO 1:1 — keep in sync. */
export interface FileChangeSummary {
  filePath: string;
  relPath: string;
  /** Short prose (may contain `backtick` identifiers) — complexity-scaled. */
  summary: string;
  model: string;
  /** True when served from the content-hash cache (no model call). */
  cached: boolean;
  hash: string;
}

/**
 * Fetch the AI summary for one changed file. Server is cache-first; a cold
 * call asks the session's own CLI via a hidden side question (a few seconds),
 * so the timeout is generous and callers show a skeleton meanwhile. 45s = the
 * route's own 40s overall deadline + margin; while pending this holds one of
 * the browser's 6 fetch slots, which is safe only because callers abort on
 * unmount/file-switch.
 */
export async function fetchFileChangeSummary(
  sessionId: string,
  filePath: string,
  opts?: { signal?: AbortSignal },
): Promise<FileChangeSummary> {
  return apiGet<FileChangeSummary>(
    `/api/sessions/${sessionId}/changes/summary`,
    // Browser locale rides along so the summary matches the user's language
    // (server-side config agent.language overrides it when set).
    { path: filePath, lang: navigator.language || 'en' },
    { signal: opts?.signal, timeoutMs: 45_000 },
  );
}

/** One critical file from the changeset triage (Changed tab's tree stars). */
export interface ChangesTriageEntry {
  filePath: string;
  relPath: string;
  reason: string;
  summary?: string;
}

export interface ChangesTriageResult {
  critical: ChangesTriageEntry[];
  cached: boolean;
  hash: string;
}

/**
 * Ask the session which changed files are critical. Server-cached by changeset
 * shape; a cold call is one hidden side question (seconds). The server also
 * pre-seeds those files' summaries, so starred files open with an instant ✦.
 */
export async function fetchChangesTriage(
  sessionId: string,
  opts?: { signal?: AbortSignal },
): Promise<ChangesTriageResult> {
  return apiGet<ChangesTriageResult>(
    `/api/sessions/${sessionId}/changes/triage`,
    { lang: navigator.language || 'en' },
    { signal: opts?.signal, timeoutMs: 45_000 },
  );
}

/**
 * Lightweight changed-files fetch for quick-access lists (Files tab): same
 * compute/cache as the full call but before/after are stripped server-side
 * (?light=1) — only paths, repo roots and statuses come back.
 */
export async function fetchSessionChangedPaths(
  sessionId: string,
  opts?: { signal?: AbortSignal },
): Promise<SessionChangesResult> {
  return apiGet<SessionChangesResult>(
    `/api/sessions/${sessionId}/changes`,
    { light: '1' },
    { signal: opts?.signal, timeoutMs: 60_000 },
  );
}
