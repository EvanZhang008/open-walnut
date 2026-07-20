/**
 * Tests for SessionReaper — periodic auto-archive + cleanup of terminal
 * environment session records (triage / hook / cron / embedded subagent).
 *
 * Covered behavior (see src/core/session-reaper.ts):
 *   - Reaps environment sessions in a terminal state (stopped/error) older than
 *     the 30-day retention: archives the record to sessions-archive-{YYYY-MM}.jsonl,
 *     moves the stream file aside, and removes the row from the store.
 *   - Leaves alone: non-environment (interactive) sessions, recent terminal
 *     sessions (within retention), and non-terminal (running/idle) sessions.
 *   - rotateArchives deletes archive JSONL + stream files older than 180 days.
 *
 * Mirrors the mock + DB-reset conventions in session-tracker.test.ts.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createMockConstants } from '../helpers/mock-constants.js';

vi.mock('../../src/constants.js', () => createMockConstants());
vi.mock('../../src/utils/process.js', () => ({
  isProcessAlive: () => true,
  isProcessAliveAsync: async () => true,
}));
vi.mock('../../src/utils/session-liveness.js', () => ({
  isSessionProcessAlive: async (s: { process_status?: string; host?: string; pid?: number | null }) => {
    if (s.process_status === 'stopped' || s.process_status === 'error') return false;
    if (s.host) return true;
    return s.pid != null;
  },
}));
vi.mock('../../src/providers/daemon-connection.js', () => ({
  isDaemonConnected: () => true,
  getDaemonDisconnectedSince: () => null,
}));

import {
  createSessionRecord,
  updateSessionRecord,
  listSessions,
  _resetSessionTrackerForTesting,
} from '../../src/core/session-tracker.js';
import { closeDb } from '../../src/core/session-db.js';
import { SessionReaper } from '../../src/core/session-reaper.js';
import { WALNUT_HOME, SESSION_STREAMS_DIR } from '../../src/constants.js';
import { bus, EventNames } from '../../src/core/event-bus.js';

// Mirror the path derivation in session-reaper.ts so assertions read the same
// files the reaper writes.
const ARCHIVE_DIR = path.join(path.dirname(SESSION_STREAMS_DIR), 'archive');
const ARCHIVE_STREAMS_DIR = path.join(ARCHIVE_DIR, 'streams');

const DAY_MS = 24 * 3600 * 1000;
const isoDaysAgo = (n: number) => new Date(Date.now() - n * DAY_MS).toISOString();
const archiveMonth = (iso: string) => {
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
};

let tmpDir: string;

beforeEach(async () => {
  tmpDir = WALNUT_HOME;
  closeDb();
  _resetSessionTrackerForTesting();
  await fsp.rm(tmpDir, { recursive: true, force: true });
  await fsp.mkdir(tmpDir, { recursive: true });
});

afterEach(async () => {
  bus.unsubscribe('session-reaper-deletion-test');
  closeDb();
  _resetSessionTrackerForTesting();
  for (let i = 0; i < 3; i++) {
    try {
      await fsp.rm(tmpDir, { recursive: true, force: true });
      break;
    } catch {
      await new Promise(r => setTimeout(r, 50));
    }
  }
});

/**
 * Seed a terminal environment session whose age is `ageDays` old (via
 * last_status_change, which sessionTimestamp() prefers).
 */
async function seedTerminalEnvSession(
  id: string,
  opts: {
    ageDays: number;
    process_status?: 'stopped' | 'error';
    type?: 'triage' | 'hook' | 'cron' | 'subagent';
    provider?: 'embedded';
  },
): Promise<void> {
  await createSessionRecord(id, `task-${id}`, 'proj', undefined, {
    type: opts.type ?? 'triage',
    ...(opts.provider ? { provider: opts.provider } : {}),
  });
  await updateSessionRecord(id, {
    process_status: opts.process_status ?? 'stopped',
    last_status_change: isoDaysAgo(opts.ageDays),
  });
}

describe('SessionReaper — reaps terminal environment sessions past retention', () => {
  it('emits deleted session IDs so QMD can remove reaped documents', async () => {
    await seedTerminalEnvSession('triage-qmd-cleanup', { ageDays: 31 });
    const deletedBatches: string[][] = [];
    bus.subscribe(
      'session-reaper-deletion-test',
      (event) => {
        if (event.name === EventNames.SESSION_DELETED) {
          deletedBatches.push(
            (event.data as { sessionIds: string[] }).sessionIds,
          );
        }
      },
      { global: true, interest: [EventNames.SESSION_DELETED] },
    );

    await new SessionReaper().reap();

    expect(deletedBatches).toEqual([['triage-qmd-cleanup']]);
  });

  it('archives + removes a stopped triage session older than 30 days', async () => {
    await seedTerminalEnvSession('triage-old', { ageDays: 31 });

    const reaper = new SessionReaper();
    const result = await reaper.reap();

    expect(result.reaped).toBe(1);

    // Row removed from the live store.
    const remaining = await listSessions();
    expect(remaining.find(s => s.claudeSessionId === 'triage-old')).toBeUndefined();

    // Record appended to the month-bucketed archive with a reaped_at stamp.
    const month = archiveMonth(isoDaysAgo(31));
    const archiveFile = path.join(ARCHIVE_DIR, `sessions-archive-${month}.jsonl`);
    const content = await fsp.readFile(archiveFile, 'utf-8');
    const lines = content.trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
    const archived = lines.find(r => r.claudeSessionId === 'triage-old');
    expect(archived).toBeDefined();
    expect(archived.reaped_at).toBeTypeOf('string');
    expect(archived.process_status).toBe('stopped');
  });

  it('reaps an error-state embedded subagent session', async () => {
    await seedTerminalEnvSession('subagent-old', {
      ageDays: 45,
      process_status: 'error',
      type: 'subagent',
      provider: 'embedded',
    });

    const reaper = new SessionReaper();
    const result = await reaper.reap();

    expect(result.reaped).toBe(1);
    const remaining = await listSessions();
    expect(remaining.find(s => s.claudeSessionId === 'subagent-old')).toBeUndefined();
  });

  it('moves the conversation stream file into archive/streams/', async () => {
    await seedTerminalEnvSession('triage-stream', { ageDays: 40 });

    // Place a stream file where the reaper expects it.
    await fsp.mkdir(SESSION_STREAMS_DIR, { recursive: true });
    const streamSrc = path.join(SESSION_STREAMS_DIR, 'embedded-triage-stream.jsonl');
    await fsp.writeFile(streamSrc, '{"type":"system"}\n', 'utf-8');

    const reaper = new SessionReaper();
    await reaper.reap();

    // Source gone, destination present.
    await expect(fsp.access(streamSrc)).rejects.toBeTruthy();
    const streamDst = path.join(ARCHIVE_STREAMS_DIR, 'embedded-triage-stream.jsonl');
    const moved = await fsp.readFile(streamDst, 'utf-8');
    expect(moved).toContain('"type":"system"');
  });
});

describe('SessionReaper — leaves non-eligible sessions untouched', () => {
  it('does not reap interactive (non-environment) sessions even when old + terminal', async () => {
    await createSessionRecord('interactive-old', 'task-i', 'proj', undefined, {
      type: 'interactive',
    });
    await updateSessionRecord('interactive-old', {
      process_status: 'stopped',
      last_status_change: isoDaysAgo(90),
    });

    const reaper = new SessionReaper();
    const result = await reaper.reap();

    expect(result.reaped).toBe(0);
    const remaining = await listSessions();
    expect(remaining.find(s => s.claudeSessionId === 'interactive-old')).toBeDefined();
  });

  it('does not reap a recent terminal environment session (within retention)', async () => {
    await seedTerminalEnvSession('triage-recent', { ageDays: 5 });

    const reaper = new SessionReaper();
    const result = await reaper.reap();

    expect(result.reaped).toBe(0);
    const remaining = await listSessions();
    expect(remaining.find(s => s.claudeSessionId === 'triage-recent')).toBeDefined();
  });

  it('does not reap a non-terminal (idle) environment session even when old', async () => {
    await createSessionRecord('triage-idle-old', 'task-idle', 'proj', undefined, {
      type: 'triage',
    });
    await updateSessionRecord('triage-idle-old', {
      process_status: 'idle',
      last_status_change: isoDaysAgo(120),
    });

    const reaper = new SessionReaper();
    const result = await reaper.reap();

    expect(result.reaped).toBe(0);
    const remaining = await listSessions();
    expect(remaining.find(s => s.claudeSessionId === 'triage-idle-old')).toBeDefined();
  });

  it('reaps nothing on an empty store', async () => {
    const reaper = new SessionReaper();
    const result = await reaper.reap();
    expect(result.reaped).toBe(0);
  });
});

describe('SessionReaper — rotateArchives drops archives older than 180 days', () => {
  it('deletes a stale monthly archive JSONL and stale archived stream files', async () => {
    await fsp.mkdir(ARCHIVE_DIR, { recursive: true });
    await fsp.mkdir(ARCHIVE_STREAMS_DIR, { recursive: true });

    // Stale archive bucket (Jan 2020) — well past the 180-day TTL.
    const staleArchive = path.join(ARCHIVE_DIR, 'sessions-archive-2020-01.jsonl');
    await fsp.writeFile(staleArchive, '{"claudeSessionId":"ancient"}\n', 'utf-8');

    // A current-month archive bucket should survive.
    const freshMonth = archiveMonth(isoDaysAgo(0));
    const freshArchive = path.join(ARCHIVE_DIR, `sessions-archive-${freshMonth}.jsonl`);
    await fsp.writeFile(freshArchive, '{"claudeSessionId":"recent"}\n', 'utf-8');

    // Stale archived stream file (old mtime) vs. a fresh one.
    const staleStream = path.join(ARCHIVE_STREAMS_DIR, 'embedded-ancient.jsonl');
    await fsp.writeFile(staleStream, '{}\n', 'utf-8');
    const oldMs = Date.now() - 200 * DAY_MS;
    await fsp.utimes(staleStream, oldMs / 1000, oldMs / 1000);

    const freshStream = path.join(ARCHIVE_STREAMS_DIR, 'embedded-fresh.jsonl');
    await fsp.writeFile(freshStream, '{}\n', 'utf-8');

    const reaper = new SessionReaper();
    const result = await reaper.reap();

    expect(result.rotated).toBeGreaterThanOrEqual(2);
    await expect(fsp.access(staleArchive)).rejects.toBeTruthy();
    await expect(fsp.access(staleStream)).rejects.toBeTruthy();
    // Fresh artifacts untouched.
    await expect(fsp.access(freshArchive)).resolves.toBeUndefined();
    await expect(fsp.access(freshStream)).resolves.toBeUndefined();
  });
});
