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
}

/** A group of changed files sharing a repo root. */
export interface SessionRepoGroup {
  repoRoot: string;
  label: string;
  kind: 'cwd' | 'other' | 'submodule';
  files: SessionFileChange[];
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
 * The git modes show the real working tree (random uncommitted files included).
 */
export type SessionDiffBase = 'session' | 'uncommitted' | 'previous' | 'remote';

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
    /** light: strip before/after (per-file diffs load lazily). swr: serve the
     *  last cached result instantly (stale:true) while recomputing. */
    light?: boolean; swr?: boolean },
): Promise<SessionChangesResult> {
  const params: Record<string, string> = {};
  if (opts?.refresh) params.refresh = '1';
  if (opts?.base && opts.base !== 'session') params.base = opts.base;
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
  opts?: { signal?: AbortSignal },
): Promise<{ sessionId: string; repoRoot: string; file: SessionFileChange }> {
  return apiGet<{ sessionId: string; repoRoot: string; file: SessionFileChange }>(
    `/api/sessions/${sessionId}/changes/file`,
    { path: filePath },
    { signal: opts?.signal, timeoutMs: 60_000 },
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
