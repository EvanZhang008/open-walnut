import { apiGet } from './client';

/** One repository's glanceable state. Mirrors GitRepoStatus in src/providers/git-diff-core.ts. */
export interface GitRepoStatus {
  repoRoot: string;
  /** null = detached HEAD. */
  branch: string | null;
  head: string | null;
  upstream: string | null;
  /** Commits not pushed; null = unknown (no remote, detached). */
  ahead: number | null;
  behind: number | null;
  files: number;
  untracked: number;
  conflicted: number;
  insertions: number;
  deletions: number;
  linesPartial?: boolean;
}

/** A session's git glance. Mirrors SessionGitGlance in src/core/session-git-status.ts. */
export interface SessionGitGlance {
  sessionId: string;
  repos: GitRepoStatus[];
  /** Files the session's Changed tab lists; null = not computed yet. */
  changedFiles: number | null;
  checkedAt: string;
  unavailable?: 'host_offline' | 'daemon_needs_upgrade' | 'error';
}

export async function fetchSessionGitGlances(
  ids: string[],
  opts: { refresh?: boolean; maxAgeSec?: number; signal?: AbortSignal } = {},
): Promise<Record<string, SessionGitGlance | null>> {
  const res = await apiGet<{ glances: Record<string, SessionGitGlance | null> }>(
    '/api/sessions/git-status',
    { ids: ids.join(','), ...(opts.refresh ? { refresh: '1' } : {}), ...(opts.maxAgeSec ? { maxAge: String(opts.maxAgeSec) } : {}) },
    { signal: opts.signal, priority: 'low', timeoutMs: 20_000 },
  );
  return res.glances ?? {};
}
