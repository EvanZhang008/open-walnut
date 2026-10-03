import { apiGet, apiPost } from './client';

/**
 * Per-turn snapshots of a session's working tree (server: routes/session-turns.ts,
 * daemon: providers/turn-snapshot-core.ts) and the rewind guard.
 */

export type TurnSnapshotKind = 'start' | 'turn' | 'pre-restore' | 'restored';

export interface TurnSnapshotFile {
  path: string;
  status: 'added' | 'modified' | 'deleted';
  additions: number | null;
  deletions: number | null;
}

export interface TurnSnapshot {
  n: number;
  sha: string;
  at: number;
  kind: TurnSnapshotKind;
  capture: 'full' | 'tracked-only';
  untrackedSkipped?: number;
  files: TurnSnapshotFile[];
  filesTotal: number;
  base: 'previous' | 'head' | 'empty';
  restoredFrom?: number;
}

export interface TurnSnapshotSkip {
  at: number;
  reason: string;
  detail?: string;
}

export interface SessionTurns {
  supported: boolean;
  reason?: 'no_cwd' | 'no_daemon' | 'daemon_upgrade';
  enabled?: boolean;
  repoRoot?: string | null;
  snapshots?: TurnSnapshot[];
  skipped?: TurnSnapshotSkip[];
  lastTurnEndAt?: number | null;
  host?: string;
  cwd?: string;
}

export interface TurnFileDiff {
  path: string;
  filePath: string;
  before: string;
  after: string;
  status: 'added' | 'modified' | 'deleted';
  binary?: boolean;
  tooLarge?: boolean;
  fromN: number | null;
  toN: number | null;
}

export interface TurnRestoreResult {
  n: number;
  write: string[];
  delete: string[];
  keep: string[];
  dryRun: boolean;
  backupN: number | null;
  afterN: number | null;
}

export interface RewindGuardWriter {
  sid: string;
  title?: string;
  consistent: boolean;
}

export interface RewindGuardFile {
  path: string;
  rel: string | null;
  exists: boolean;
  writers: RewindGuardWriter[];
  conflict: boolean;
}

export interface RewindGuardResult {
  checked: boolean;
  repoRoot: string | null;
  partial: boolean;
  files: RewindGuardFile[];
  conflicts: RewindGuardFile[];
}

export function fetchSessionTurns(sessionId: string, opts?: { signal?: AbortSignal }): Promise<SessionTurns> {
  return apiGet<SessionTurns>(`/api/sessions/${encodeURIComponent(sessionId)}/turns`, undefined, {
    signal: opts?.signal, timeoutMs: 25_000,
  });
}

export function fetchTurnFileDiff(
  sessionId: string, n: number, path: string, against: 'previous' | 'worktree' = 'previous',
): Promise<TurnFileDiff> {
  return apiGet<TurnFileDiff>(`/api/sessions/${encodeURIComponent(sessionId)}/turns/${n}/diff`, { path, against }, { timeoutMs: 25_000 });
}

export function restoreTurn(
  sessionId: string, n: number, opts: { paths?: string[]; dryRun?: boolean } = {},
): Promise<TurnRestoreResult> {
  return apiPost<TurnRestoreResult>(`/api/sessions/${encodeURIComponent(sessionId)}/turns/${n}/restore`, {
    ...(opts.paths ? { paths: opts.paths } : {}),
    ...(opts.dryRun ? { dry_run: true } : {}),
  }, { timeoutMs: 80_000 });
}

/** Never rejects: a guard that cannot answer leaves the rewind dialog as it was. */
export async function fetchRewindGuard(sessionId: string, files: string[]): Promise<RewindGuardResult | null> {
  try {
    const res = await apiPost<{ guard: RewindGuardResult | null }>(
      `/api/sessions/${encodeURIComponent(sessionId)}/rewind/guard`, { files }, { timeoutMs: 15_000 },
    );
    return res.guard && res.guard.checked ? res.guard : null;
  } catch {
    return null;
  }
}
