import { afterEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { markSessionStoppedInSqlite } from '../../src/hooks/session-status-store.js';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('on-stop session status SQL', () => {
  it('migrates old schema, increments once, and is stable when repeated', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-on-stop-status-'));
    tempDirs.push(dir);
    const dbPath = path.join(dir, 'sessions.sqlite');
    const db = new Database(dbPath);
    db.exec(`
      CREATE TABLE sessions (
        claude_session_id TEXT PRIMARY KEY,
        process_status TEXT,
        activity TEXT,
        last_status_change TEXT,
        started_at TEXT,
        last_active_at TEXT
      )
    `);
    db.prepare(`
      INSERT INTO sessions (
        claude_session_id, process_status, activity,
        last_status_change, started_at, last_active_at
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      'hook-session',
      'running',
      'processing',
      '2026-07-19T10:00:00.000Z',
      '2026-07-19T09:00:00.000Z',
      '2026-07-19T10:00:00.000Z',
    );
    db.close();

    expect(markSessionStoppedInSqlite(
      dbPath,
      'hook-session',
      '2026-07-19T11:00:00.000Z',
    )).toBe(true);
    expect(markSessionStoppedInSqlite(
      dbPath,
      'hook-session',
      '2026-07-19T12:00:00.000Z',
    )).toBe(false);

    const reopened = new Database(dbPath, { readonly: true });
    const row = reopened.prepare(`
      SELECT process_status, activity, status_revision, status_updated_at
      FROM sessions WHERE claude_session_id = ?
    `).get('hook-session') as Record<string, unknown>;
    reopened.close();
    expect(row).toEqual({
      process_status: 'stopped',
      activity: null,
      status_revision: 2,
      status_updated_at: '2026-07-19T11:00:00.000Z',
    });
  });

  it('does not downgrade an existing error', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'walnut-on-stop-error-'));
    tempDirs.push(dir);
    const dbPath = path.join(dir, 'sessions.sqlite');
    const db = new Database(dbPath);
    db.exec(`
      CREATE TABLE sessions (
        claude_session_id TEXT PRIMARY KEY,
        process_status TEXT,
        activity TEXT,
        last_status_change TEXT,
        started_at TEXT,
        last_active_at TEXT,
        status_revision INTEGER NOT NULL DEFAULT 1,
        status_updated_at TEXT
      )
    `);
    db.prepare(`
      INSERT INTO sessions (
        claude_session_id, process_status, activity,
        last_status_change, started_at, last_active_at,
        status_revision, status_updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'hook-error',
      'error',
      null,
      '2026-07-19T10:00:00.000Z',
      '2026-07-19T09:00:00.000Z',
      '2026-07-19T10:00:00.000Z',
      4,
      '2026-07-19T10:00:00.000Z',
    );
    db.close();

    expect(markSessionStoppedInSqlite(dbPath, 'hook-error')).toBe(false);
    const reopened = new Database(dbPath, { readonly: true });
    const row = reopened.prepare(`
      SELECT process_status, status_revision FROM sessions
      WHERE claude_session_id = ?
    `).get('hook-error');
    reopened.close();
    expect(row).toEqual({ process_status: 'error', status_revision: 4 });
  });
});
