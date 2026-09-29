/**
 * REGRESSION (2026-09-28): a LOCAL session's history must survive a local
 * daemon that stops answering.
 *
 * Incident chain: the daemon's event loop was starved (a synchronous `ps` per
 * adopted CLI per second), so every JSONL read through it failed with "Local
 * daemon started … but not responding to hello". The local read swallowed that
 * failure and returned "no transcript", so the turn-end delta
 * (`?since=1924&anchorMsgId=…`) was answered with an authoritative EMPTY full
 * rebuild and the panel dropped to just the live turn ("all my past
 * conversation is gone"). A failed read must be a failure: the delta 502s (the
 * client keeps its view) and a full fetch serves the last good parse as stale.
 *
 * Runs the REAL session-history + route; only the daemon transport is faked.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createMockConstants } from '../../helpers/mock-constants.js';

vi.mock('../../../src/constants.js', () => createMockConstants());

const transport = vi.hoisted(() => ({ down: false, statError: null as string | null, calls: [] as string[] }));
const DOWN_ERROR = 'Local daemon started (port 56202) but not responding to hello';

vi.mock('../../../src/core/daemon-file-reader.js', async () => {
  const { mockLocalDaemonReader } = await import('../../helpers/mock-local-daemon-reader.js');
  const Base = mockLocalDaemonReader().DaemonFileReader;
  // Every instance method fails while the daemon is "down", like the real
  // reader does when ensureRunning() throws.
  class FlakyLocalReader extends Base {
    constructor(host: string) {
      super(host);
      return new Proxy(this, {
        get(target, prop, receiver) {
          const value = Reflect.get(target, prop, receiver);
          if (typeof value !== 'function') return value;
          return (...args: unknown[]) => {
            transport.calls.push(String(prop));
            if (transport.down) return Promise.reject(new Error(DOWN_ERROR));
            if (prop === 'stat' && transport.statError) return Promise.reject(new Error(transport.statError));
            return (value as (...a: unknown[]) => unknown).apply(target, args);
          };
        },
      });
    }
  }
  return { DaemonFileReader: FlakyLocalReader };
});

import express from 'express';
import request from 'supertest';
import { sessionsRouter } from '../../../src/web/routes/sessions.js';
import { errorHandler } from '../../../src/web/middleware/error-handler.js';
import { HANDLED_FAILURE_HEADER } from '../../../src/web/middleware/handled-failure.js';
import { createSessionRecord, updateSessionRecord } from '../../../src/core/session-tracker.js';
import { encodeProjectPath } from '../../../src/core/session-file-reader.js';
import { CLAUDE_HOME, WALNUT_HOME } from '../../../src/constants.js';

const SID = 'local-daemon-down-sid';
const CWD = '/work/acme';

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/sessions', sessionsRouter);
  app.use(errorHandler);
  return app;
}

function exchange(i: number): string[] {
  const t = new Date(Date.UTC(2026, 8, 28, 12, 0, i)).toISOString();
  return [
    JSON.stringify({ type: 'user', uuid: `u-${i}`, parentUuid: i === 0 ? null : `a-${i - 1}`, timestamp: t, cwd: CWD,
      message: { role: 'user', content: `question ${i}` } }),
    JSON.stringify({ type: 'assistant', uuid: `a-${i}`, parentUuid: `u-${i}`, timestamp: t,
      message: { id: `msg_${i}`, role: 'assistant', content: [{ type: 'text', text: `answer ${i}` }] } }),
  ];
}

const jsonlPath = () => path.join(CLAUDE_HOME, 'projects', encodeProjectPath(CWD), `${SID}.jsonl`);

async function writeTranscript(exchanges: number): Promise<void> {
  await fs.mkdir(path.dirname(jsonlPath()), { recursive: true });
  const lines = Array.from({ length: exchanges }, (_, i) => exchange(i)).flat();
  await fs.writeFile(jsonlPath(), lines.join('\n') + '\n');
}

beforeEach(async () => {
  transport.down = false;
  transport.statError = null;
  transport.calls.length = 0;
  await fs.rm(WALNUT_HOME, { recursive: true, force: true });
  await fs.rm(CLAUDE_HOME, { recursive: true, force: true });
  await createSessionRecord(SID, 'task-local', 'proj');
  await updateSessionRecord(SID, { cwd: CWD } as never);
});

afterEach(async () => {
  transport.down = false;
  await fs.rm(WALNUT_HOME, { recursive: true, force: true });
  await fs.rm(CLAUDE_HOME, { recursive: true, force: true });
});

describe('local session history while the local daemon is not answering', () => {
  it('a turn-end delta fails instead of rebuilding the timeline to empty; a full fetch serves the last good parse', async () => {
    const app = createApp();
    await writeTranscript(3);
    const healthy = await request(app).get(`/api/sessions/${SID}/history`);
    expect(healthy.status).toBe(200);
    const held = healthy.body.messages as Array<{ text?: string; msgId?: string }>;
    expect(held.map((m) => m.text)).toEqual(['question 0', 'answer 0', 'question 1', 'answer 1', 'question 2', 'answer 2']);
    const anchor = [...held].reverse().find((m) => m.msgId)?.msgId;
    expect(anchor).toBeTruthy();

    // The next turn lands on disk while the daemon is starved.
    await writeTranscript(4);
    transport.down = true;

    transport.calls.length = 0;
    const delta = await request(app).get(`/api/sessions/${SID}/history`)
      .query({ tail: '400', since: String(healthy.body.cursor), anchorMsgId: anchor, anchorTail: '0' });
    // Before the fix: 200 { messages: [], total: 0, delta: false } — the wipe.
    expect(delta.status).toBe(502);
    expect(delta.body.messages).toBeUndefined();
    expect(delta.body.error).toBe('Local daemon not answering');
    // Answered in place (the client's stale banner), so no red incident card.
    expect(delta.headers[HANDLED_FAILURE_HEADER]).toBe('1');
    // The stat went unanswered, so no second daemon wait follows it: against a
    // frozen daemon each would cost 30s and together they outran the client.
    expect(transport.calls).toEqual(['stat']);

    const full = await request(app).get(`/api/sessions/${SID}/history`).query({ tail: '400' });
    expect(full.status).toBe(200);
    expect(full.body.stale).toBe(true);
    expect(full.body.staleReason).toBe('Local daemon not answering');
    expect(full.body.messages.map((m: { text?: string }) => m.text)).toEqual(held.map((m) => m.text));

    // Phase 1 is a preview only: it stays an empty 200, never a 500.
    const p1 = await request(app).get(`/api/sessions/${SID}/history`).query({ source: 'streams', tail: '400' });
    expect(p1.status).toBe(200);
    expect(p1.body.messages).toEqual([]);

    // Daemon answers again: the new turn arrives, nothing stale.
    transport.down = false;
    const recovered = await request(app).get(`/api/sessions/${SID}/history`).query({ tail: '400' });
    expect(recovered.status).toBe(200);
    expect(recovered.body.stale).toBeUndefined();
    expect(recovered.body.messages.at(-1).text).toBe('answer 3');
    expect(recovered.body.messages).toHaveLength(8);
  });

  it('a stat the daemon ANSWERED with an error still gets the full read', async () => {
    const app = createApp();
    await writeTranscript(2);
    transport.statError = 'fs.stat failed: EACCES';
    const res = await request(app).get(`/api/sessions/${SID}/history`).query({ tail: '400' });
    expect(res.status).toBe(200);
    expect(res.body.stale).toBeUndefined();
    expect(res.body.messages.map((m: { text?: string }) => m.text)).toEqual(['question 0', 'answer 0', 'question 1', 'answer 1']);
    expect(transport.calls).toContain('readFile');
  });

  it('a transcript that genuinely does not exist is still "no history", not an error', async () => {
    const app = createApp();
    const res = await request(app).get(`/api/sessions/${SID}/history`).query({ since: '0' });
    expect(res.status).toBe(200);
    expect(res.body.messages).toEqual([]);
  });
});
