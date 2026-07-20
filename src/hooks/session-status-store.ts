import Database from 'better-sqlite3';

function ensureStatusColumns(
  db: InstanceType<typeof Database>,
  now: string,
): void {
  const columns = db.pragma('table_info(sessions)') as Array<{ name: string }>;
  const names = new Set(columns.map((column) => column.name));
  if (!names.has('status_revision')) {
    db.exec('ALTER TABLE sessions ADD COLUMN status_revision INTEGER NOT NULL DEFAULT 1');
  }
  if (!names.has('status_updated_at')) {
    db.exec('ALTER TABLE sessions ADD COLUMN status_updated_at TEXT');
  }
  db.prepare(`
    UPDATE sessions
    SET status_revision = 1
    WHERE status_revision IS NULL OR status_revision < 1
  `).run();
  db.prepare(`
    UPDATE sessions
    SET status_updated_at = COALESCE(
      NULLIF(status_updated_at, ''),
      NULLIF(last_status_change, ''),
      NULLIF(last_active_at, ''),
      NULLIF(started_at, ''),
      ?
    )
    WHERE status_updated_at IS NULL OR status_updated_at = ''
  `).run(now);
}

/**
 * Direct SQLite write used by the standalone on-stop hook.
 * Returns true only when the canonical status projection changed.
 */
export function markSessionStoppedInSqlite(
  dbPath: string,
  sessionId: string,
  now = new Date().toISOString(),
): boolean {
  const db = new Database(dbPath);
  try {
    db.pragma('journal_mode = WAL');
    db.pragma('busy_timeout = 5000');
    return db.transaction(() => {
      ensureStatusColumns(db, now);
      const result = db.prepare(`
        UPDATE sessions SET
          process_status = 'stopped',
          last_status_change = ?,
          last_active_at = ?,
          activity = NULL,
          status_revision = status_revision + 1,
          status_updated_at = ?
        WHERE claude_session_id = ?
          AND (process_status IS NULL OR process_status <> 'error')
          AND (process_status IS NULL OR process_status <> 'stopped' OR activity IS NOT NULL)
      `).run(now, now, now, sessionId);
      return result.changes === 1;
    })();
  } finally {
    try { db.close(); } catch { /* ignore */ }
  }
}
