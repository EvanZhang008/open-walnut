/**
 * Session record self-heal (src/core/sessions/session-record-recovery.ts).
 *
 * Regression for inc-2026-08-10 "Untitled session": a session's sessions.sqlite
 * row was lost while its canonical JSONL survived under ~/.claude/projects.
 * Every metadata consumer 404'd (panel header → "Untitled session"; processNext
 * → "No active session found", stranding a queued message for 27 days) even
 * though /history rendered the full conversation from the JSONL.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createMockConstants } from '../helpers/mock-constants.js';
import { mockLocalDaemonReader } from '../helpers/mock-local-daemon-reader.js';

vi.mock('../../src/constants.js', () => createMockConstants());
vi.mock('../../src/core/daemon-file-reader.js', () => mockLocalDaemonReader());

import { CLAUDE_HOME, WALNUT_HOME } from '../../src/constants.js';
import {
  recoverSessionRecordFromJsonl,
  extractRecoveryEvidence,
  _resetSessionRecordRecoveryForTesting,
} from '../../src/core/sessions/session-record-recovery.js';
import {
  createSessionRecord,
  getSessionByClaudeId,
  _resetSessionTrackerForTesting,
} from '../../src/core/session-tracker.js';
import { closeDb as closeSessionDb } from '../../src/core/session-db.js';
import { encodeProjectPath } from '../../src/core/session-file-reader.js';

const CWD = '/Users/someone/workplace/myproj';

function jsonlLine(obj: Record<string, unknown>): string {
  return JSON.stringify(obj) + '\n';
}

/** A realistic canonical JSONL: user line carries cwd + timestamp; assistant replies. */
function sampleJsonl(opts?: { userText?: string; cwd?: string }): string {
  const userText = opts?.userText ?? 'Investigate whether the 2025 T1 was actually filed';
  const cwd = opts?.cwd ?? CWD;
  return (
    jsonlLine({
      type: 'user', uuid: 'u-1', timestamp: '2026-07-14T17:56:04.000Z', cwd,
      message: { role: 'user', content: userText },
    })
    + jsonlLine({
      type: 'assistant', uuid: 'a-1', timestamp: '2026-07-14T17:56:30.000Z',
      message: { role: 'assistant', id: 'msg_1', content: [{ type: 'text', text: 'On it.' }] },
    })
    + jsonlLine({
      type: 'user', uuid: 'u-2', timestamp: '2026-07-14T18:00:01.000Z', cwd,
      message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user]' }] },
    })
    // Padding so the file clears the MIN_JSONL_BYTES noise floor.
    + jsonlLine({
      type: 'assistant', uuid: 'a-2', timestamp: '2026-07-14T18:00:02.000Z',
      message: { role: 'assistant', id: 'msg_2', content: [{ type: 'text', text: 'x'.repeat(200) }] },
    })
  );
}

async function writeCanonicalJsonl(sessionId: string, content: string, cwd = CWD): Promise<string> {
  const dir = path.join(CLAUDE_HOME as string, 'projects', encodeProjectPath(cwd));
  await fsp.mkdir(dir, { recursive: true });
  const p = path.join(dir, `${sessionId}.jsonl`);
  await fsp.writeFile(p, content);
  return p;
}

beforeEach(async () => {
  closeSessionDb();
  _resetSessionTrackerForTesting();
  _resetSessionRecordRecoveryForTesting();
  await fsp.rm(WALNUT_HOME as string, { recursive: true, force: true });
  await fsp.rm(CLAUDE_HOME as string, { recursive: true, force: true });
  await fsp.mkdir(WALNUT_HOME as string, { recursive: true });
  await fsp.mkdir(CLAUDE_HOME as string, { recursive: true });
});

afterEach(async () => {
  closeSessionDb();
  _resetSessionTrackerForTesting();
  _resetSessionRecordRecoveryForTesting();
  await fsp.rm(WALNUT_HOME as string, { recursive: true, force: true }).catch(() => {});
  await fsp.rm(CLAUDE_HOME as string, { recursive: true, force: true }).catch(() => {});
});

describe('extractRecoveryEvidence', () => {
  it('pulls cwd, title text, timestamps, and message count from JSONL', () => {
    const ev = extractRecoveryEvidence(sampleJsonl());
    expect(ev.cwd).toBe(CWD);
    expect(ev.firstUserText).toContain('Investigate whether the 2025 T1');
    expect(ev.firstTimestamp).toBe('2026-07-14T17:56:04.000Z');
    expect(ev.lastTimestamp).toBe('2026-07-14T18:00:02.000Z');
    expect(ev.messageCount).toBe(4);
  });

  it('skips walnut-injected and isMeta user lines when deriving the title', () => {
    const content =
      jsonlLine({
        type: 'user', uuid: 'u-0', timestamp: '2026-07-14T17:55:00.000Z', cwd: CWD,
        subtype: 'walnut-injected',
        message: { role: 'user', content: 'synthetic dedup copy' },
      })
      + jsonlLine({
        type: 'user', uuid: 'u-0b', timestamp: '2026-07-14T17:55:30.000Z', cwd: CWD,
        isMeta: true,
        message: { role: 'user', content: 'skill dump the human never typed' },
      })
      + sampleJsonl();
    const ev = extractRecoveryEvidence(content);
    expect(ev.firstUserText).toContain('Investigate whether the 2025 T1');
  });
});

describe('recoverSessionRecordFromJsonl', () => {
  it('rebuilds a stopped record from a surviving canonical JSONL', async () => {
    const sid = '62c34a16-fdb2-4f3d-9acd-3acc8c049cdb';
    await writeCanonicalJsonl(sid, sampleJsonl());

    const record = await recoverSessionRecordFromJsonl(sid);
    expect(record).not.toBeNull();
    expect(record!.claudeSessionId).toBe(sid);
    expect(record!.process_status).toBe('stopped');
    expect(record!.cwd).toBe(CWD);
    expect(record!.title).toContain('Investigate whether the 2025 T1');
    // Activity window backdated to the transcript's own timestamps, not "now".
    expect(record!.startedAt).toBe('2026-07-14T17:56:04.000Z');
    expect(record!.lastActiveAt).toBe('2026-07-14T18:00:02.000Z');

    // Persisted — a fresh lookup now succeeds (the 404 chain is broken).
    const fetched = await getSessionByClaudeId(sid);
    expect(fetched).not.toBeNull();
    expect(fetched!.title).toBe(record!.title);
  });

  it('returns null (and negative-caches) when no JSONL exists', async () => {
    const first = await recoverSessionRecordFromJsonl('11111111-2222-3333-4444-555555555555');
    expect(first).toBeNull();
    // Second call rides the negative cache — still null, no throw.
    const second = await recoverSessionRecordFromJsonl('11111111-2222-3333-4444-555555555555');
    expect(second).toBeNull();
  });

  it('refuses a stub JSONL below the noise floor', async () => {
    const sid = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    await writeCanonicalJsonl(sid, jsonlLine({ type: 'queue-operation', op: 'enqueue' }));
    expect(await recoverSessionRecordFromJsonl(sid)).toBeNull();
    expect(await getSessionByClaudeId(sid)).toBeNull();
  });

  it('returns the existing record untouched when one already exists', async () => {
    const sid = 'ffffffff-1111-2222-3333-444444444444';
    await createSessionRecord(sid, 'task-x', 'proj-x', '/real/cwd', { title: 'Real title' });
    await writeCanonicalJsonl(sid, sampleJsonl({ userText: 'should not become the title' }));

    const record = await recoverSessionRecordFromJsonl(sid);
    expect(record!.title).toBe('Real title');
    expect(record!.taskId).toBe('task-x');
  });

  it('rejects malformed session ids without touching disk', async () => {
    expect(await recoverSessionRecordFromJsonl('../../etc/passwd')).toBeNull();
    expect(await recoverSessionRecordFromJsonl('a b c')).toBeNull();
    expect(await recoverSessionRecordFromJsonl('x')).toBeNull();
  });

  it('dedups concurrent recovery calls into one record', async () => {
    const sid = '99999999-8888-7777-6666-555555555555';
    await writeCanonicalJsonl(sid, sampleJsonl());
    const [a, b, c] = await Promise.all([
      recoverSessionRecordFromJsonl(sid),
      recoverSessionRecordFromJsonl(sid),
      recoverSessionRecordFromJsonl(sid),
    ]);
    expect(a).not.toBeNull();
    // All calls resolve to the same persisted identity (no duplicate-insert throw).
    expect(b!.claudeSessionId).toBe(sid);
    expect(c!.claudeSessionId).toBe(sid);
  });
});

describe('destructive-op audit trail + rename queue migration', () => {
  it('renameSessionId writes a durable audit line', async () => {
    const { renameSessionId } = await import('../../src/core/session-tracker.js');
    await createSessionRecord('audit-old-id-000000', 'task-a', 'proj-a', '/cwd', { title: 'Audit me' });
    await renameSessionId('audit-old-id-000000', 'audit-new-id-000000');

    // audit append is fire-and-forget — give the event loop a beat
    await new Promise((r) => setTimeout(r, 50));
    const auditPath = path.join(WALNUT_HOME as string, 'session-audit.jsonl');
    const lines = (await fsp.readFile(auditPath, 'utf-8')).trim().split('\n').map((l) => JSON.parse(l));
    const entry = lines.find((l) => l.op === 'rename' && l.sessionId === 'audit-old-id-000000');
    expect(entry).toBeDefined();
    expect(entry.renamedTo).toBe('audit-new-id-000000');
    expect(entry.reason).toBe('resume-id-changed');
    expect(entry.record.title).toBe('Audit me');
  });

  it('deleteSessionRecords writes audit lines naming the caller', async () => {
    const { deleteSessionRecords } = await import('../../src/core/session-tracker.js');
    await createSessionRecord('audit-del-id-000000', 'task-b', 'proj-b', '/cwd', { title: 'Delete me' });
    const removed = await deleteSessionRecords(new Set(['audit-del-id-000000']), 'test-caller');
    expect(removed).toBe(1);

    await new Promise((r) => setTimeout(r, 50));
    const auditPath = path.join(WALNUT_HOME as string, 'session-audit.jsonl');
    const lines = (await fsp.readFile(auditPath, 'utf-8')).trim().split('\n').map((l) => JSON.parse(l));
    const entry = lines.find((l) => l.op === 'delete' && l.sessionId === 'audit-del-id-000000');
    expect(entry).toBeDefined();
    expect(entry.reason).toBe('test-caller');
    expect(entry.record.title).toBe('Delete me');
  });
});

describe('GET /api/sessions/:sessionId self-heal (route integration)', () => {
  it('returns 200 with a recovered record instead of 404 when the JSONL survives', async () => {
    const express = (await import('express')).default;
    const request = (await import('supertest')).default;
    const { sessionsRouter } = await import('../../src/web/routes/sessions.js');
    const { errorHandler } = await import('../../src/web/middleware/error-handler.js');
    const { bus } = await import('../../src/core/event-bus.js');
    // Router-only fixture — a prior startServer() in this worker must not
    // let its runner react to this test's bus traffic.
    bus.unsubscribe('session-runner');

    const sid = '62c34a16-fdb2-4f3d-9acd-3acc8c049cdb';
    await writeCanonicalJsonl(sid, sampleJsonl());

    const app = express();
    app.use(express.json());
    app.use('/api/sessions', sessionsRouter);
    app.use(errorHandler);

    const res = await request(app).get(`/api/sessions/${sid}`);
    expect(res.status).toBe(200);
    expect(res.body.session.claudeSessionId).toBe(sid);
    expect(res.body.session.title).toContain('Investigate whether the 2025 T1');
    expect(res.body.session.process_status).toBe('stopped');
  });

  it('still 404s a session with no transcript anywhere', async () => {
    const express = (await import('express')).default;
    const request = (await import('supertest')).default;
    const { sessionsRouter } = await import('../../src/web/routes/sessions.js');
    const { errorHandler } = await import('../../src/web/middleware/error-handler.js');
    const { bus } = await import('../../src/core/event-bus.js');
    bus.unsubscribe('session-runner');

    const app = express();
    app.use(express.json());
    app.use('/api/sessions', sessionsRouter);
    app.use(errorHandler);

    const res = await request(app).get('/api/sessions/deadbeef-dead-beef-dead-beefdeadbeef');
    expect(res.status).toBe(404);
  });
});
