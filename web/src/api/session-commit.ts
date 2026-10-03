import { apiGet, apiPost } from './client';

/** Who wrote a hunk / a file, as the session host's daemon attributes it.
 *  Mirrors HunkOwner / FileOwner in src/providers/git-attribution-core.ts. */
export type HunkOwner = 'mine' | 'other' | 'unknown' | 'mixed';
export type FileOwner = 'mine' | 'mixed' | 'other' | 'unknown';

/** One hunk of a file's diff against HEAD (zero-context lines + 3 lines around). */
export interface CommitHunk {
  id: string;
  oldStart: number;
  oldLines: string[];
  newStart: number;
  newLines: string[];
  seq: number;
  owner: HunkOwner;
  before: string[];
  after: string[];
}

export interface CommitPlanFile {
  path: string;
  status: 'added' | 'modified' | 'deleted';
  /** 'text' files come split into hunks; every other kind is offered whole. */
  kind: 'text' | 'binary' | 'large' | 'symlink' | 'filtered' | 'deleted' | 'unread';
  owner: FileOwner;
  reason?: string;
  /** The session's transcript records an edit to this file. */
  session: boolean;
  hunks?: CommitHunk[];
  added?: number;
  removed?: number;
}

export interface CommitRemote { remote: string; ref: string; url: string }

export interface CommitPlanRepo {
  repoRoot: string;
  label: string;
  branch: string | null;
  headSha: string | null;
  blocked?: { code: string; message: string };
  files: CommitPlanFile[];
  omitted?: number;
  upstream: CommitRemote | null;
  pushTarget: CommitRemote | null;
  ahead: number | null;
  behind: number | null;
  pr: { available: boolean; reason?: string };
}

export interface CommitPlan {
  sessionId: string;
  host: string | null;
  /** False when the daemon could not read this session's edits (nothing preselected). */
  attributed: boolean;
  repos: CommitPlanRepo[];
}

export type CommitAction = 'commit' | 'push' | 'pr';

export interface CommitJob {
  id: string;
  sessionId: string;
  action: CommitAction;
  host: string | null;
  repoRoot: string;
  state: 'running' | 'succeeded' | 'failed';
  step: string;
  output: string;
  startedAt: number;
  updatedAt: number;
  finishedAt?: number;
  result?: Record<string, unknown>;
  error?: { code: string; message: string };
}

export interface CommitSelection { path: string; mode: 'hunks' | 'whole'; hunks?: CommitHunk[] }

export function fetchCommitPlan(sessionId: string): Promise<CommitPlan> {
  return apiGet<CommitPlan>(`/api/sessions/${encodeURIComponent(sessionId)}/commit/plan`, undefined, { timeoutMs: 100_000 });
}

export async function startCommitJob(sessionId: string, body: Record<string, unknown> & { action: CommitAction; repoRoot: string }): Promise<CommitJob> {
  const res = await apiPost<{ job: CommitJob }>(`/api/sessions/${encodeURIComponent(sessionId)}/commit/jobs`, body, { timeoutMs: 20_000 });
  return res.job;
}

export async function fetchCommitJob(sessionId: string, jobId: string): Promise<CommitJob> {
  const res = await apiGet<{ job: CommitJob }>(`/api/sessions/${encodeURIComponent(sessionId)}/commit/jobs/${encodeURIComponent(jobId)}`, undefined, { timeoutMs: 10_000 });
  return res.job;
}

export async function fetchCommitJobs(sessionId: string): Promise<CommitJob[]> {
  const res = await apiGet<{ jobs: CommitJob[] }>(`/api/sessions/${encodeURIComponent(sessionId)}/commit/jobs`, undefined, { timeoutMs: 10_000 });
  return res.jobs;
}

export async function suggestCommitMessage(sessionId: string, diff: string, files: string[]): Promise<string> {
  const res = await apiPost<{ message: string }>(`/api/sessions/${encodeURIComponent(sessionId)}/commit/suggest`, { diff, files }, { timeoutMs: 80_000 });
  return res.message;
}
