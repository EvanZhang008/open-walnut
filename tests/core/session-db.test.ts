/**
 * Tests for session-db.ts (SQLite foundation for sessions), session-db-migration.ts
 * (one-shot JSON→SQLite), and the session-tracker write paths that sit on top.
 *
 * Mirrors tests/core/task-db.test.ts exactly. Each test runs against a real
 * on-disk SQLite file under a tmp WALNUT_HOME (see createMockConstants) — no
 * mocking of better-sqlite3. The module-level singleton in session-db.ts is
 * torn down between tests via closeDb() so SESSION_DB_PATH (computed at import
 * time) keeps pointing at a freshly wiped directory.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import Database from 'better-sqlite3';
import { createMockConstants } from '../helpers/mock-constants.js';

vi.mock('../../src/constants.js', () => createMockConstants('walnut-session-db'));
// session-tracker pulls in session-liveness; mock it so it doesn't try to
// probe real processes in createSessionRecord tests.
vi.mock('../../src/utils/session-liveness.js', () => ({
  isSessionProcessAlive: async () => true,
}));

import {
  getDb,
  closeDb,
  transaction,
  rowToSession,
  sessionToRow,
  SESSION_COLUMNS,
} from '../../src/core/session-db.js';
import { runSessionMigrationIfNeeded } from '../../src/core/session-db-migration.js';
import { _resetSessionTrackerForTesting } from '../../src/core/session-tracker.js';
import { WALNUT_HOME, SESSIONS_FILE } from '../../src/constants.js';
import { SESSION_DB_PATH } from '../../src/core/session-db.js';
import type { SessionRecord } from '../../src/core/types.js';

async function resetAll(): Promise<void> {
  closeDb();
  _resetSessionTrackerForTesting();
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true });
  await fsp.mkdir(WALNUT_HOME, { recursive: true });
}

beforeEach(async () => {
  await resetAll();
});

afterEach(async () => {
  closeDb();
  _resetSessionTrackerForTesting();
  for (let i = 0; i < 3; i++) {
    try {
      await fsp.rm(WALNUT_HOME, { recursive: true, force: true });
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 50));
    }
  }
});

// ── 1. Schema idempotency ──────────────────────────────────────────────────

describe('session-db: schema idempotency', () => {
  it('getDb() twice returns the same handle and schema is stable', () => {
    const db1 = getDb();
    expect(db1).not.toBeNull();
    const tablesBefore = db1!
      .prepare("SELECT name FROM sqlite_master WHERE type IN ('table','index') ORDER BY name")
      .all() as { name: string }[];

    const db2 = getDb();
    expect(db2).toBe(db1);

    const tablesAfter = db1!
      .prepare("SELECT name FROM sqlite_master WHERE type IN ('table','index') ORDER BY name")
      .all() as { name: string }[];

    expect(tablesAfter).toEqual(tablesBefore);
    expect(tablesBefore.some((t) => t.name === 'sessions')).toBe(true);
  });

  it('re-opening after closeDb() still produces a valid schema', () => {
    const db1 = getDb();
    expect(db1).not.toBeNull();
    db1!
      .prepare('INSERT INTO sessions (claude_session_id, task_id, project) VALUES (?, ?, ?)')
      .run('s1', 't1', 'p1');
    closeDb();

    const db2 = getDb();
    expect(db2).not.toBeNull();
    const row = db2!
      .prepare('SELECT claude_session_id, task_id FROM sessions WHERE claude_session_id = ?')
      .get('s1') as { claude_session_id: string; task_id: string } | undefined;
    expect(row?.task_id).toBe('t1');
  });

  it('adds and backfills versioned status columns on an existing database', () => {
    const initial = getDb()!;
    initial.prepare(`
      INSERT INTO sessions (
        claude_session_id, task_id, project, process_status, mode,
        last_status_change, started_at, last_active_at, message_count
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'legacy-status-row',
      'task-legacy',
      'project-legacy',
      'idle',
      'default',
      '2026-07-18T12:00:00.000Z',
      '2026-07-18T10:00:00.000Z',
      '2026-07-18T11:00:00.000Z',
      1,
    );
    closeDb();

    const legacy = new Database(SESSION_DB_PATH);
    legacy.exec('ALTER TABLE sessions DROP COLUMN status_revision');
    legacy.exec('ALTER TABLE sessions DROP COLUMN status_updated_at');
    legacy.close();

    const migrated = getDb()!;
    const columns = migrated.pragma('table_info(sessions)') as Array<{ name: string }>;
    expect(columns.map((column) => column.name)).toEqual(expect.arrayContaining([
      'status_revision',
      'status_updated_at',
    ]));
    const row = migrated.prepare(`
      SELECT status_revision, status_updated_at
      FROM sessions
      WHERE claude_session_id = ?
    `).get('legacy-status-row') as {
      status_revision: number;
      status_updated_at: string;
    };
    expect(row).toEqual({
      status_revision: 1,
      status_updated_at: '2026-07-18T12:00:00.000Z',
    });
  });
});

// ── 2. CRUD round-trip ─────────────────────────────────────────────────────

describe('session-db: rowToSession / sessionToRow round trip', () => {
  it('preserves explicit columns, boolean coercion, and payload spill', () => {
    const db = getDb()!;
    const insertCols = [...SESSION_COLUMNS, 'payload'];
    const insertSql =
      'INSERT INTO sessions (' + insertCols.join(', ') + ') VALUES (' +
      insertCols.map((c) => '@' + c).join(', ') + ')';

    const original: SessionRecord = {
      claudeSessionId: 'round-1',
      taskId: 'task-1',
      project: 'walnut',
      process_status: 'running',
      mode: 'default',
      provider: 'cli',
      type: 'interactive',
      activity: 'thinking',
      last_status_change: '2026-01-02T00:00:00Z',
      startedAt: '2026-01-01T00:00:00Z',
      lastActiveAt: '2026-01-02T00:00:00Z',
      messageCount: 3,
      cwd: '/tmp/work',
      host: 'clouddev',
      title: 'A session',
      description: 'desc',
      pid: 12345,
      outputFile: '/tmp/out.jsonl',
      planFile: '/tmp/plan.md',
      planCompleted: true,
      fromPlanSessionId: 'plan-1',
      forkedFromSessionId: 'fork-1',
      human_note: 'note',
      model: 'claude-opus-4-7',
      cliModel: 'opus',
      archived: false,
      archive_reason: undefined,
      planContent: 'do X',
      errorMessage: undefined,
      status_reason: 'turn_completed',
      status_changed_by: 'session-runner',
      statusRevision: 7,
      statusUpdatedAt: '2026-01-02T00:00:01Z',
      // Non-column fields that must spill into payload:
      status_history: [
        {
          timestamp: '2026-01-01T00:00:00Z',
          process_status: 'running',
          reason: 'session_started',
          changed_by: 'session-runner',
        },
      ],
      pendingPermission: {
        requestId: 'req-1',
        toolName: 'Bash',
        receivedAt: '2026-01-02T00:00:00Z',
      },
    };

    const row = sessionToRow(original);
    // boolean column coerced to integer
    expect(row.plan_completed).toBe(1);
    expect(row.archived).toBe(0);
    // payload contains the non-column fields
    expect(row.payload).toBeTruthy();
    const decoded = JSON.parse(row.payload as string);
    expect(decoded.status_history).toHaveLength(1);
    expect(decoded.pendingPermission?.requestId).toBe('req-1');

    const bound: Record<string, unknown> = {};
    for (const col of insertCols) bound[col] = row[col] === undefined ? null : row[col];
    db.prepare(insertSql).run(bound);

    const fetched = db
      .prepare('SELECT * FROM sessions WHERE claude_session_id = ?')
      .get('round-1') as Record<string, unknown>;
    const session = rowToSession(fetched);

    expect(session.claudeSessionId).toBe('round-1');
    expect(session.taskId).toBe('task-1');
    expect(session.project).toBe('walnut');
    expect(session.process_status).toBe('running');
    expect(session.mode).toBe('default');
    expect(session.provider).toBe('cli');
    expect(session.type).toBe('interactive');
    expect(session.pid).toBe(12345);
    expect(session.messageCount).toBe(3);
    // Boolean round-trip — stored as 1/0, read back as true/false
    expect(session.planCompleted).toBe(true);
    // archived was false → not spilled as true
    expect(session.archived === true).toBe(false);
    // Payload fields merged back
    expect(session.status_history).toHaveLength(1);
    expect(session.status_history?.[0]?.reason).toBe('session_started');
    expect(session.pendingPermission?.requestId).toBe('req-1');
    expect(session.statusRevision).toBe(7);
    expect(session.statusUpdatedAt).toBe('2026-01-02T00:00:01Z');
  });

  it('hostname is runtime-only — never persisted to row or payload', () => {
    const row = sessionToRow({
      claudeSessionId: 's1',
      taskId: 't1',
      project: 'p1',
      process_status: 'running',
      mode: 'default',
      startedAt: '2026-01-01T00:00:00Z',
      lastActiveAt: '2026-01-01T00:00:00Z',
      messageCount: 0,
      hostname: 'full-host.example.com',
    });
    // No dedicated column and no payload spill for hostname.
    expect(row.hostname).toBeUndefined();
    expect(row.payload).toBeUndefined();
  });
});

// ── 3. Bulk atomicity ──────────────────────────────────────────────────────

describe('session-db: transaction atomicity', () => {
  it('inserts 100 sessions inside a single transaction', () => {
    const db = getDb()!;
    const insertCols = [...SESSION_COLUMNS, 'payload'];
    const insertSql =
      'INSERT INTO sessions (' + insertCols.join(', ') + ') VALUES (' +
      insertCols.map((c) => '@' + c).join(', ') + ')';

    transaction((h) => {
      const stmt = h.prepare(insertSql);
      for (let i = 0; i < 100; i++) {
        const session: SessionRecord = {
          claudeSessionId: `bulk-${i}`,
          taskId: `t-${i}`,
          project: 'walnut',
          process_status: 'stopped',
          mode: 'default',
          startedAt: '2026-01-01T00:00:00Z',
          lastActiveAt: '2026-01-01T00:00:00Z',
          messageCount: 0,
        };
        const partial = sessionToRow(session);
        const bound: Record<string, unknown> = {};
        for (const col of insertCols) bound[col] = partial[col] === undefined ? null : partial[col];
        stmt.run(bound);
      }
    });

    const count = db.prepare('SELECT COUNT(*) AS n FROM sessions').get() as { n: number };
    expect(count.n).toBe(100);
  });

  it('rolls back entire transaction on mid-loop PK violation (no partial writes)', () => {
    const db = getDb()!;
    db.prepare(
      'INSERT INTO sessions (claude_session_id, task_id, project) VALUES (?, ?, ?)',
    ).run('existing', 't-pre', 'p-pre');

    expect(() =>
      transaction((h) => {
        // Good row first.
        h.prepare(
          'INSERT INTO sessions (claude_session_id, task_id, project) VALUES (?, ?, ?)',
        ).run('new-1', 't-new', 'p-new');
        // PK violation on the pre-existing row → whole tx rolls back.
        h.prepare(
          'INSERT INTO sessions (claude_session_id, task_id, project) VALUES (?, ?, ?)',
        ).run('existing', 't-dup', 'p-dup');
      }),
    ).toThrow();

    // 'new-1' must NOT be present — the transaction was rolled back.
    const newRow = db
      .prepare('SELECT claude_session_id FROM sessions WHERE claude_session_id = ?')
      .get('new-1');
    expect(newRow).toBeUndefined();
    // Existing row survives untouched.
    const existingRow = db
      .prepare('SELECT task_id FROM sessions WHERE claude_session_id = ?')
      .get('existing') as { task_id: string };
    expect(existingRow.task_id).toBe('t-pre');
  });
});

// ── 4. Migration idempotency ───────────────────────────────────────────────

describe('session-db migration: idempotency', () => {
  it('runSessionMigrationIfNeeded is a no-op on a second call (row count stable, no re-copy)', async () => {
    closeDb();

    const fakeSessions: SessionRecord[] = Array.from({ length: 5 }, (_, i) => ({
      claudeSessionId: `mig-${i}`,
      taskId: `task-${i}`,
      project: 'walnut',
      process_status: 'stopped',
      mode: 'default',
      type: 'interactive',
      startedAt: '2026-01-01T00:00:00Z',
      lastActiveAt: '2026-01-01T00:00:00Z',
      messageCount: 0,
    }));
    await fsp.writeFile(
      SESSIONS_FILE,
      JSON.stringify({ version: 2, sessions: fakeSessions }),
      'utf-8',
    );

    const first = await runSessionMigrationIfNeeded();
    expect(first.migrated).toBe(true);
    expect(first.count).toBe(5);

    const backupPath = path.join(
      path.dirname(SESSIONS_FILE),
      'sessions.json.migrated-from-json.backup',
    );
    expect(fs.existsSync(backupPath)).toBe(true);

    // Mutate backup to detect any re-copy (a no-op run must NOT overwrite it).
    fs.writeFileSync(backupPath, 'TOUCHED', 'utf-8');

    const second = await runSessionMigrationIfNeeded();
    expect(second.migrated).toBe(false);
    expect(second.count).toBe(5);

    expect(fs.readFileSync(backupPath, 'utf-8')).toBe('TOUCHED');
  });
});

// ── 5. Migration correctness ───────────────────────────────────────────────

describe('session-db migration: correctness', () => {
  it('migrates sessions with all SessionRecord fields surviving the round-trip', async () => {
    closeDb();

    const fakeSessions: SessionRecord[] = [
      {
        claudeSessionId: 'corr-1',
        taskId: 't1',
        project: 'walnut',
        process_status: 'idle',
        mode: 'plan',
        provider: 'cli',
        type: 'interactive',
        activity: 'typing',
        last_status_change: '2026-01-02T00:00:00Z',
        startedAt: '2026-01-01T00:00:00Z',
        lastActiveAt: '2026-01-02T00:00:00Z',
        messageCount: 7,
        cwd: '/tmp/x',
        host: 'clouddev',
        title: 'Migrated',
        description: 'd',
        pid: 999,
        outputFile: '/tmp/out.jsonl',
        planFile: '/tmp/plan.md',
        planCompleted: true,
        fromPlanSessionId: 'fp-1',
        forkedFromSessionId: 'fk-1',
        human_note: 'hn',
        cliModel: 'opus[1m]',
        model: 'claude-opus-4-7',
        archived: true,
        archive_reason: 'plan_executed',
        status_reason: 'turn_completed',
        status_changed_by: 'session-runner',
        status_history: [
          {
            timestamp: '2026-01-01T00:00:00Z',
            process_status: 'running',
            reason: 'session_started',
            changed_by: 'session-runner',
          },
        ],
      },
    ];

    await fsp.writeFile(
      SESSIONS_FILE,
      JSON.stringify({ version: 2, sessions: fakeSessions }),
      'utf-8',
    );

    const result = await runSessionMigrationIfNeeded();
    expect(result.migrated).toBe(true);
    expect(result.count).toBe(1);

    const db = getDb()!;
    const rows = db.prepare('SELECT * FROM sessions').all() as Record<string, any>[];
    expect(rows).toHaveLength(1);
    const session = rowToSession(rows[0]);

    expect(session.claudeSessionId).toBe('corr-1');
    expect(session.taskId).toBe('t1');
    expect(session.process_status).toBe('idle');
    expect(session.mode).toBe('plan');
    expect(session.provider).toBe('cli');
    expect(session.type).toBe('interactive');
    expect(session.messageCount).toBe(7);
    expect(session.pid).toBe(999);
    expect(session.host).toBe('clouddev');
    expect(session.planCompleted).toBe(true);
    expect(session.archived).toBe(true);
    expect(session.archive_reason).toBe('plan_executed');
    expect(session.cliModel).toBe('opus[1m]');
    expect(session.status_history).toHaveLength(1);
    expect(session.status_history?.[0]?.reason).toBe('session_started');
  });

  it('applies legacy fixups: legacy `status` → `process_status`, strips work_status, absorbed → archived', async () => {
    closeDb();

    // Seed a pre-migration shape that only readStoreJson legacy path would normally fix up.
    const legacy: Record<string, unknown>[] = [
      {
        claudeSessionId: 'leg-1',
        taskId: 't1',
        project: 'p',
        status: 'active',
        work_status: 'idle',
        absorbed: true,
        startedAt: '2026-01-01T00:00:00Z',
        lastActiveAt: '2026-01-02T00:00:00Z',
        messageCount: 1,
        provider: 'embedded',
        title: 'Turn Complete Triage: blah',
      },
    ];
    await fsp.writeFile(
      SESSIONS_FILE,
      JSON.stringify({ version: 2, sessions: legacy }),
      'utf-8',
    );

    const result = await runSessionMigrationIfNeeded();
    expect(result.migrated).toBe(true);
    expect(result.count).toBe(1);

    const db = getDb()!;
    const row = db.prepare('SELECT * FROM sessions').get() as Record<string, any>;
    const session = rowToSession(row);

    // legacy `status` field stripped; process_status populated
    expect((session as unknown as Record<string, unknown>).status).toBeUndefined();
    expect(session.process_status).toBe('stopped');
    // work_status dropped
    expect((session as unknown as Record<string, unknown>).work_status).toBeUndefined();
    // absorbed → archived + reason
    expect(session.archived).toBe(true);
    expect(session.archive_reason).toBe('plan_executed');
    // type inferred from triage title prefix
    expect(session.type).toBe('triage');
  });
});
