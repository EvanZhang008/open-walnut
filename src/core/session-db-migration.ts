/**
 * session-db-migration.ts — one-shot migration from sessions.json → sessions.sqlite.
 *
 * Mirrors task-db-migration.ts. Called once at startup when the SQLite session
 * store is empty and a legacy sessions.json exists. Reads the JSON blob,
 * INSERTs every session row in a single transaction, then drops a backup copy
 * next to the original.
 *
 * Idempotency: bails out cheaply on every subsequent call by checking the
 * `sessions` row count. Safe to invoke from module init.
 */

import fs from 'node:fs';
import path from 'node:path';
import { SESSIONS_FILE } from '../constants.js';
import { log } from '../logging/index.js';
import { readJsonFile } from '../utils/fs.js';
import { getDb, sessionToRow, SESSION_COLUMNS, transaction } from './session-db.js';
import type { SessionRecord } from './types.js';

/**
 * Apply legacy record fixups to pre-migration JSON snapshots before they land
 * in SQLite. Production sessions.json has usually been re-written post-fixup
 * already, but legacy snapshots (or pre-migration JSON seeded by tests) still
 * carry the old shape — apply these fixups so SQLite never stores a
 * pre-migration row.
 *
 * Fixups:
 *   1. legacy `status` → `process_status` (any value maps to 'stopped';
 *      reconciler later re-derives the real runtime state).
 *   2. drop legacy `work_status` field.
 *   3. legacy `absorbed` → `archived` + archive_reason='plan_executed'.
 *   4. infer missing `type` from provider / title-prefix heuristic.
 *
 * The "auto-archive stopped/error environment sessions" pass is NOT run here;
 * it's an ongoing per-read idempotent cleanup, not a one-shot schema migration.
 */
function applyLegacyFixups(session: SessionRecord): SessionRecord {
  if (!session || typeof session !== 'object') return session;
  const out = { ...session } as Record<string, any>;

  if ('status' in out && !('process_status' in out)) {
    delete out.status;
    out.process_status = 'stopped';
    if (!('mode' in out)) out.mode = 'default';
    if (!('last_status_change' in out)) out.last_status_change = out.lastActiveAt;
  }

  if ('work_status' in out) {
    delete out.work_status;
  }

  if (out.absorbed) {
    out.archived = true;
    if (!out.archive_reason) out.archive_reason = 'plan_executed';
    delete out.absorbed;
  }

  if (!out.type) {
    if (out.provider === 'embedded') {
      const prefix = typeof out.title === 'string' ? out.title.split(':')[0]?.trim() ?? '' : '';
      const triageNames = new Set([
        'Turn Complete Triage (onTurnComplete)',
        'Message Send Triage (onMessageSend)',
        'Session Triage',
        'Turn Complete Triage',
        'Message Send Triage',
      ]);
      const triageAgents = new Set(['turn-complete-triage', 'message-send-triage']);
      out.type = (triageAgents.has(prefix) || triageNames.has(prefix)) ? 'triage' : 'subagent';
    } else {
      out.type = 'interactive';
    }
  }

  const statusTimestamp = out.statusUpdatedAt
    || out.last_status_change
    || out.lastActiveAt
    || out.startedAt
    || new Date().toISOString();
  out.statusRevision = Number.isInteger(out.statusRevision) && out.statusRevision > 0
    ? out.statusRevision
    : 1;
  out.statusUpdatedAt = statusTimestamp;

  return out as SessionRecord;
}

export interface SessionMigrationResult {
  /** true only on the run that actually copied rows in. Subsequent runs return false. */
  migrated: boolean;
  /** Row count in the `sessions` table on return. On a no-op this is the
   *  pre-existing count (possibly 0). */
  count: number;
}

interface SessionStoreV2 {
  version: number;
  sessions: SessionRecord[];
}

/**
 * Run the one-shot JSON→SQLite migration if needed.
 *
 * Returns `{migrated: false, count: N}` in two cases:
 *   1. `sessions` table already has rows — idempotent no-op.
 *   2. sessions.json doesn't exist — fresh install, nothing to import.
 *
 * Returns `{migrated: true, count: N}` after a successful import.
 */
export async function runSessionMigrationIfNeeded(): Promise<SessionMigrationResult> {
  const db = getDb();
  if (!db) {
    return { migrated: false, count: 0 };
  }

  const existing = db.prepare('SELECT COUNT(*) AS n FROM sessions').get() as { n: number };
  if (existing.n > 0) {
    return { migrated: false, count: existing.n };
  }

  if (!fs.existsSync(SESSIONS_FILE)) {
    return { migrated: false, count: 0 };
  }

  // readJsonFile throws on corrupt content — let that propagate so a bad
  // sessions.json aborts startup instead of silently creating an empty DB.
  const store = await readJsonFile<SessionStoreV2>(SESSIONS_FILE, { version: 2, sessions: [] });
  const rawSessions: SessionRecord[] = Array.isArray(store.sessions) ? store.sessions : [];
  const sessions: SessionRecord[] = rawSessions.map(applyLegacyFixups);

  // Build the prepared INSERT from SESSION_COLUMNS so the column list here and
  // the one in session-db.ts can never drift. `payload` is appended explicitly
  // because it's the spillover column (not in SESSION_COLUMNS).
  const insertCols = [...SESSION_COLUMNS, 'payload'];
  const insertSql =
    'INSERT INTO sessions (' + insertCols.join(', ') + ') ' +
    'VALUES (' + insertCols.map((c) => '@' + c).join(', ') + ')';

  transaction((h) => {
    const stmt = h.prepare(insertSql);
    for (const session of sessions) {
      if (!session || typeof session !== 'object' || typeof session.claudeSessionId !== 'string') {
        log.session.warn('session-db migration: skipping malformed session', {
          sample: String((session as { claudeSessionId?: unknown })?.claudeSessionId ?? '<no id>'),
        });
        continue;
      }
      const partial = sessionToRow(session);
      const bound: Record<string, unknown> = {};
      for (const col of insertCols) {
        bound[col] = partial[col] === undefined ? null : partial[col];
      }
      try {
        stmt.run(bound);
      } catch (err) {
        // One bad row shouldn't abort the whole migration. The pristine
        // sessions.json plus the backup below are still available for manual
        // recovery.
        log.session.warn('session-db migration: failed to insert session, skipping', {
          claudeSessionId: session.claudeSessionId,
          err: String(err),
        });
      }
    }
  });

  const after = db.prepare('SELECT COUNT(*) AS n FROM sessions').get() as { n: number };
  const count = after.n;

  // Copy the source blob aside so operators / future migrations have a
  // known-good snapshot. Non-fatal on failure — the JSON itself is untouched.
  const backupPath = path.join(path.dirname(SESSIONS_FILE), 'sessions.json.migrated-from-json.backup');
  try {
    fs.copyFileSync(SESSIONS_FILE, backupPath);
  } catch (err) {
    log.session.warn('session-db migration: backup copy failed (non-fatal)', {
      path: backupPath,
      err: String(err),
    });
  }

  log.session.info('session-db: migrated sessions from sessions.json', { count });

  return { migrated: true, count };
}
