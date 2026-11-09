import { getDb as getSessionDb, sessionToRow, SESSION_COLUMNS } from '../../src/core/session-db.js';
import { getDb as getTaskDb, rowToTask, taskToRow } from '../../src/core/task-db.js';
import { _dropSessionStoreCacheForTesting, createSessionRecord, getSessionByClaudeId } from '../../src/core/session-tracker.js';
import { _dropTaskStoreCacheForTesting } from '../../src/core/task-manager.js';
import type { SessionRecord, Task } from '../../src/core/types.js';

// Fault injection only: represent historical rows that the current write boundary refuses.
export async function seedLegacySession(sid: string, taskId: string, project: string, cwd?: string,
  extra?: NonNullable<Parameters<typeof createSessionRecord>[4]> & Pick<Partial<SessionRecord>, 'legacyTaskId'>): Promise<SessionRecord> {
  if (await getSessionByClaudeId(sid)) throw new Error(`Fixture session already exists: ${sid}`);
  const db = getSessionDb();
  if (!db) throw new Error('Fixture session store is unavailable');
  const now = new Date().toISOString();
  const { initialProcessStatus, initialStatusReason, ...fields } = extra ?? {};
  const record: SessionRecord = {
    claudeSessionId: sid, taskId, project, cwd, mode: 'default', type: 'interactive',
    process_status: initialProcessStatus ?? 'stopped', status_reason: initialStatusReason,
    startedAt: now, lastActiveAt: now, last_status_change: now, messageCount: 1,
    statusRevision: 1, statusUpdatedAt: now, ...fields,
  };
  const cols = [...SESSION_COLUMNS, 'payload'];
  const row = sessionToRow(record);
  const bound = Object.fromEntries(cols.map((col) => [col, row[col] === undefined ? null : row[col]]));
  db.transaction(() => {
    db.prepare(`INSERT INTO sessions (${cols.join(', ')}) VALUES (${cols.map((col) => '@' + col).join(', ')})`).run(bound);
  })();
  _dropSessionStoreCacheForTesting();
  return record;
}

export function patchLegacyTask(id: string, patch: Partial<Task>): void {
  const db = getTaskDb();
  if (!db) throw new Error('Fixture task store is unavailable');
  db.transaction(() => {
    const row = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    if (!row) throw new Error(`Fixture task not found: ${id}`);
    const fields = taskToRow(patch);
    if ('payload' in fields) fields.payload = taskToRow({ ...rowToTask(row), ...patch }).payload ?? null;
    const cols = Object.keys(fields).filter((col) => col !== 'id');
    if (!cols.length) return;
    db.prepare(`UPDATE tasks SET ${cols.map((col) => `${col} = @${col}`).join(', ')} WHERE id = @id`).run({ ...fields, id });
  })();
  _dropTaskStoreCacheForTesting();
}
