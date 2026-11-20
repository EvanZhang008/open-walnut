/**
 * A session write waits for another connection's write lock with the event loop free.
 *
 * On the Mac (2026-11-20) a one-row session INSERT that costs 0.03 ms took 0.3 to
 * 2.5 s in the server, 33 times in 3 hours, with the loop thread almost off the
 * CPU: Apple's SQLite blocks the calling thread in the kernel for as long as
 * another connection holds the write lock (busy_timeout), so every request and
 * timer of the server waited with it. session-db's transactionWhenFree takes the
 * lock without that wait and tries again on a timer; session-tracker's write
 * sections all go through it.
 *
 * Real stores against a temp WALNUT_HOME; the lock holder is a real second process.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createMockConstants } from '../helpers/mock-constants.js';

vi.mock('../../src/constants.js', () => createMockConstants('walnut-session-write-lock-wait'));

import { WALNUT_HOME } from '../../src/constants.js';
import { createSessionRecord, getSessionByClaudeId, updateSessionRecord, _resetSessionTrackerForTesting } from '../../src/core/session-tracker.js';
import * as sessionDb from '../../src/core/session-db.js';

const SID = '22222222-2222-4222-8222-222222222222';

/** Another process takes the store's write lock and keeps it until `release()`; resolves once it holds it. */
async function holdWriteLock(): Promise<{ release: () => Promise<void> }> {
  const holder = spawn(process.execPath, ['-e', `
    const { Database } = require('bun:sqlite')
    const db = new Database(${JSON.stringify(sessionDb.SESSION_DB_PATH)})
    db.exec('PRAGMA busy_timeout = 5000')
    db.exec('BEGIN IMMEDIATE'); db.exec("UPDATE sessions SET title = title WHERE claude_session_id = 'none'")
    console.log('locked')
    process.stdin.once('data', () => { db.exec('COMMIT'); db.close(); process.exit(0) })
  `], { stdio: ['pipe', 'pipe', 'inherit'] });
  await new Promise<void>((resolve, reject) => {
    holder.stdout!.on('data', (d) => { if (String(d).includes('locked')) resolve(); });
    holder.once('exit', (code) => reject(new Error(`the lock holder exited with code ${code} before it held the lock`)));
  });
  const exited = new Promise<void>((resolve) => holder.once('exit', () => resolve()));
  return { release: async () => { holder.stdin!.end('go\n'); await exited; } };
}

/** The longest the loop went without a turn while `work` ran (ms). */
async function longestLoopGap<T>(work: () => Promise<T>): Promise<{ value: T; gapMs: number }> {
  let last = performance.now();
  let gapMs = 0;
  const ticker = setInterval(() => {
    const now = performance.now();
    gapMs = Math.max(gapMs, now - last);
    last = now;
  }, 5);
  try {
    const value = await work();
    gapMs = Math.max(gapMs, performance.now() - last);
    return { value, gapMs };
  } finally {
    clearInterval(ticker);
  }
}

beforeEach(async () => {
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true });
  await fsp.mkdir(WALNUT_HOME, { recursive: true });
  sessionDb.closeDb();
  _resetSessionTrackerForTesting();
  sessionDb._setSessionLockBudgetForTesting(null);
});

afterEach(async () => {
  sessionDb._setSessionLockBudgetForTesting(null);
  sessionDb.closeDb();
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true, maxRetries: 3 }).catch(() => {});
});

describe('session writes and another connection\'s write lock', () => {
  it('keeps the loop turning while a session write waits for the lock, then writes it', async () => {
    await createSessionRecord(SID, '', 'proj', undefined, { title: 'before' });
    const holder = await holdWriteLock();
    const retriesBefore = sessionDb.sessionLockWaitStats().retries;
    const { gapMs } = await longestLoopGap(async () => {
      const write = updateSessionRecord(SID, { title: 'after' });
      // The write is refused the lock several times while the loop keeps turning, then the holder lets go.
      await vi.waitFor(() => expect(sessionDb.sessionLockWaitStats().retries - retriesBefore).toBeGreaterThanOrEqual(5), { timeout: 10_000 });
      await holder.release();
      return write;
    });
    // The old blocking wait held the loop for the whole lock budget (5 s): a bound far under it survives load.
    expect(gapMs).toBeLessThan(1_000);
    expect((await getSessionByClaudeId(SID))?.title).toBe('after');
    expect(sessionDb.sessionLockWaitStats().waits).toBeGreaterThanOrEqual(1);
  });

  it('gives up with SQLITE_BUSY past its budget, writes nothing, and the next write goes through', async () => {
    await createSessionRecord(SID, '', 'proj', undefined, { title: 'before' });
    sessionDb._setSessionLockBudgetForTesting(150);
    const holder = await holdWriteLock();
    const { value: err, gapMs } = await longestLoopGap(() => updateSessionRecord(SID, { title: 'lost' }).then(() => null, (e: unknown) => e));
    expect((err as { code?: string } | null)?.code).toBe('SQLITE_BUSY');
    expect(gapMs).toBeLessThan(1_000);
    expect(sessionDb.sessionLockWaitStats().gaveUp).toBeGreaterThanOrEqual(1);
    await holder.release();
    expect((await getSessionByClaudeId(SID))?.title).toBe('before');
    sessionDb._setSessionLockBudgetForTesting(null);
    await updateSessionRecord(SID, { title: 'after' });
    expect((await getSessionByClaudeId(SID))?.title).toBe('after');
  });

  it('rolls back a section that throws, and leaves the connection out of any transaction', async () => {
    await createSessionRecord(SID, '', 'proj', undefined, { title: 'before' });
    await expect(Promise.resolve().then(() => sessionDb.transactionWhenFree((db) => {
      db.prepare('UPDATE sessions SET title = ? WHERE claude_session_id = ?').run('half', SID);
      throw new Error('boom');
    }))).rejects.toThrow('boom');
    expect(sessionDb.getDb()!.inTransaction).toBe(false);
    _resetSessionTrackerForTesting();
    expect((await getSessionByClaudeId(SID))?.title).toBe('before');
  });

  // The class: a new write section in session-tracker that used the blocking transaction would hold the loop again.
  it('session-tracker takes no blocking transaction from session-db', () => {
    const src = fs.readFileSync(path.join(__dirname, '../../src/core/session-tracker.ts'), 'utf-8');
    const imports = /import\s*\{([^}]*)\}\s*from\s*'\.\/session-db\.js'/.exec(src)?.[1] ?? '';
    expect(imports.split(',').map((s) => s.trim().split(/\s+as\s+/)[0])).not.toContain('transaction');
    expect(src).not.toMatch(/\.transaction\(/);
  });
});
