/**
 * Referential-integrity detector for the session↔task join. READ-ONLY: it counts
 * and logs, it never repairs.
 *
 * Why log-only. Two separate bugs corrupt this join, and each has its own owner:
 *
 *   1. Orphaned `sessions.task_id` — a session pointing at a deleted task is
 *      INVISIBLE on every task surface, because `enrichTasksWithSessionStatus`
 *      (src/web/routes/tasks.ts) joins `sessions.task_id -> task` at read time
 *      and a dead id simply never matches. Root cause (task deletion not
 *      clearing the column) is fixed by `unlinkSessionsFromTasks()` in
 *      session-tracker.ts. Historical rows are repaired by
 *      `scripts/repair-orphan-session-links.mjs`, which needs a human to
 *      classify each one — auto-repair here would have to guess.
 *
 *   2. Duplicate remote ids — two or more task rows carrying the SAME external
 *      sync id. That is what CREATES orphans in the first place: the twins are
 *      the same remote item, one gets deleted, and whichever sessions hung off
 *      the loser are stranded. Deduping requires deciding which row is canonical
 *      and merging note/summary/sessions, so it is emphatically not a boot-time
 *      action.
 *
 * A 2026-08-20 sweep found 254 orphaned sessions and 69 duplicate remote-id
 * groups (141 task rows) that had accumulated silently over ~6 months across at
 * least 5 separate bulk-insert bursts. Detection exists so the next occurrence
 * shows up in the logs within a day instead of after another six months.
 */
import { log } from '../logging/index.js';

export interface SessionIntegrityReport {
  /** Sessions whose `task_id` names a task that no longer exists. */
  orphanedSessions: number;
  /** A few orphaned session ids, for grepping. Full list: run the repair script. */
  orphanSample: string[];
  /** Distinct external sync ids owned by more than one task row. */
  duplicateRemoteIdGroups: number;
  /** Task rows involved in those groups (always >= 2 per group). */
  duplicateTaskRows: number;
  /** A few `<provider>:<remoteId>` keys from the duplicate groups. */
  duplicateSample: string[];
}

/** How many ids to include per sample. Enough to grep with, small enough to log. */
const SAMPLE_SIZE = 5;

/**
 * Fields a sync plugin may use for its remote key, mirroring the
 * `idx_tasks_ext_*` expression indexes in task-db.ts.
 */
const REMOTE_KEY_FIELDS = ['id', 'short_id', 'issue_key'] as const;

/**
 * Extract `<provider>:<remoteId>` from a task's parsed `ext`.
 *
 * Provider keys are read off the object rather than matched against a fixed
 * list, so this covers any installed sync plugin, including ones added later.
 */
export function extractRemoteKey(ext: unknown): string | null {
  if (!ext || typeof ext !== 'object' || Array.isArray(ext)) return null;
  for (const [provider, value] of Object.entries(ext as Record<string, unknown>)) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    const v = value as Record<string, unknown>;
    for (const field of REMOTE_KEY_FIELDS) {
      const candidate = v[field];
      if (typeof candidate === 'string' && candidate) return `${provider}:${candidate}`;
    }
  }
  return null;
}

/**
 * Pure counting core, separated from the store reads so it is directly testable
 * with plain fixtures (no DB, no server).
 */
export function computeIntegrityReport(
  sessions: Array<{ claudeSessionId: string; taskId?: string | null }>,
  tasks: Array<{ id: string; ext?: unknown }>,
): SessionIntegrityReport {
  const liveTaskIds = new Set(tasks.map((t) => t.id));

  const orphanSample: string[] = [];
  let orphanedSessions = 0;
  for (const s of sessions) {
    // Empty string is the "no task" marker in places, so treat it as unset
    // rather than as a pointer at a task named ''.
    if (!s.taskId) continue;
    if (liveTaskIds.has(s.taskId)) continue;
    orphanedSessions++;
    if (orphanSample.length < SAMPLE_SIZE) orphanSample.push(s.claudeSessionId);
  }

  const byRemoteKey = new Map<string, string[]>();
  for (const t of tasks) {
    const key = extractRemoteKey(t.ext);
    if (!key) continue;
    const list = byRemoteKey.get(key);
    if (list) list.push(t.id);
    else byRemoteKey.set(key, [t.id]);
  }
  let duplicateRemoteIdGroups = 0;
  let duplicateTaskRows = 0;
  const duplicateSample: string[] = [];
  for (const [key, ids] of byRemoteKey) {
    if (ids.length < 2) continue;
    duplicateRemoteIdGroups++;
    duplicateTaskRows += ids.length;
    if (duplicateSample.length < SAMPLE_SIZE) duplicateSample.push(key);
  }

  return {
    orphanedSessions,
    orphanSample,
    duplicateRemoteIdGroups,
    duplicateTaskRows,
    duplicateSample,
  };
}

/**
 * Read both stores, count, and log a warning when either problem is present.
 * Returns the report so a caller (or a test) can assert on it.
 *
 * Uses `listTasksSlim({ minimal: false })` rather than the full task read: it
 * still carries `ext` (needed for the duplicate check) but skips the note and
 * conversation_log columns, which are the expensive ones. Both reads ride the
 * stores' existing `PRAGMA data_version`-guarded caches, so on a warm server
 * this is close to free.
 */
export async function checkSessionTaskIntegrity(): Promise<SessionIntegrityReport> {
  const [{ listSessions }, { listTasksSlim }] = await Promise.all([
    import('./session-tracker.js'),
    import('./task-manager.js'),
  ]);
  const [sessions, tasks] = await Promise.all([listSessions(), listTasksSlim()]);

  const report = computeIntegrityReport(
    sessions.map((s) => ({ claudeSessionId: s.claudeSessionId, taskId: s.taskId })),
    tasks.map((t) => ({ id: t.id, ext: t.ext })),
  );

  if (report.orphanedSessions > 0 || report.duplicateRemoteIdGroups > 0) {
    log.session.warn('session↔task integrity problems detected', {
      orphanedSessions: report.orphanedSessions,
      orphanSample: report.orphanSample,
      duplicateRemoteIdGroups: report.duplicateRemoteIdGroups,
      duplicateTaskRows: report.duplicateTaskRows,
      duplicateSample: report.duplicateSample,
      remedy: 'node scripts/repair-orphan-session-links.mjs (dry-run first)',
    });
  } else {
    log.session.debug('session↔task integrity clean', {
      sessions: sessions.length, tasks: tasks.length,
    });
  }

  return report;
}
