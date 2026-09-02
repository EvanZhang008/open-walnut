import { apiGet } from './client';

/** Who produced a Walnut snapshot. Mirrors SnapshotWriter in src/core/file-history.ts. */
export type FileHistoryWriter = 'baseline' | 'user' | 'live' | 'merge' | 'agent';

export interface FileHistoryEntry {
  id: string;
  hash: string;
  size: number;
  /** Epoch ms. */
  at: number;
  writer: FileHistoryWriter;
}

export interface FileHistoryCommit {
  sha: string;
  /** Epoch ms (the server converts git's seconds). */
  at: number;
  author: string;
  subject: string;
}

/** Why git contributed nothing. Only 'daemon_needs_upgrade' is worth telling the user. */
export type FileHistoryGitReason = 'timeout' | 'daemon_needs_upgrade' | 'not_a_repo' | 'error';

export interface FileHistoryGit {
  available: boolean;
  repoRoot?: string;
  commits?: FileHistoryCommit[];
  reason?: FileHistoryGitReason;
}

export interface FileHistoryResponse {
  /** Walnut's own snapshots, oldest FIRST (the panel sorts for display). */
  entries: FileHistoryEntry[];
  git: FileHistoryGit;
}

export interface FileHistoryVersion {
  content: string;
  /** Snapshot lookups only. */
  hash?: string;
  at?: number;
  writer?: FileHistoryWriter;
  /** Git lookups only. */
  sha?: string;
}

/**
 * History for ONE file: Walnut's snapshots always, git commits when the file is
 * in a repo the host can reach. The git half is best-effort by contract — the
 * server answers degraded (`git.available:false` + a reason) rather than late.
 */
export function fetchFileHistory(path: string, host?: string): Promise<FileHistoryResponse> {
  return apiGet<FileHistoryResponse>('/api/file-history', {
    path,
    ...(host ? { host } : {}),
  });
}

/** One version's text, addressed either by snapshot id or by git sha. */
export function fetchFileHistoryVersion(
  path: string,
  host: string | undefined,
  which: { id: string } | { sha: string },
): Promise<FileHistoryVersion> {
  return apiGet<FileHistoryVersion>('/api/file-history/version', {
    path,
    ...(host ? { host } : {}),
    ...which,
  });
}
