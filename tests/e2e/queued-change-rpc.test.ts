/**
 * E2E: `session:delete-queued` and `session:edit-queued` against the real server
 * answer what happened to the row (src/core/sessions/queued-change.ts) instead of
 * throwing, so the console never shows a red toast for a row that was taken or
 * is gone (2026-11-09: "RPC handler error for "session:delete-queued": Message not
 * deletable (already processing or not found)").
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'node:fs/promises';
import type { Server as HttpServer } from 'node:http';
import { WebSocket } from 'ws';
import { createMockConstants } from '../helpers/mock-constants.js';

vi.mock('../../src/constants.js', () => createMockConstants('walnut-e2e-queued-change-rpc'));

import { WALNUT_HOME } from '../../src/constants.js';
import { startServer, stopServer } from '../../src/web/server.js';
import { createSessionRecord } from '../../src/core/session-tracker.js';
import { enqueueMessage, getQueue, markProcessing } from '../../src/core/session-message-queue.js';

let server: HttpServer;
let port: number;

function connectWs(): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${port}/ws`);
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
    setTimeout(() => reject(new Error('ws connect timeout')), 5000);
  });
}

function rpc(ws: WebSocket, method: string, payload: unknown): Promise<{ ok: boolean; payload?: Record<string, unknown>; error?: string }> {
  return new Promise((resolve, reject) => {
    const id = `t-${Math.random().toString(36).slice(2)}`;
    const timer = setTimeout(() => reject(new Error(`rpc ${method} timed out`)), 15_000);
    const onMessage = (raw: Buffer | string) => {
      const frame = JSON.parse(raw.toString()) as { type: string; id?: string; ok?: boolean; payload?: unknown; error?: string };
      if (frame.type !== 'res' || frame.id !== id) return;
      clearTimeout(timer);
      ws.off('message', onMessage);
      resolve({ ok: !!frame.ok, payload: frame.payload as Record<string, unknown>, error: frame.error });
    };
    ws.on('message', onMessage);
    ws.send(JSON.stringify({ type: 'req', id, method, payload }));
  });
}

beforeAll(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true });
  await fs.mkdir(WALNUT_HOME, { recursive: true });
  server = await startServer({ port: 0, dev: true });
  const addr = server.address();
  port = typeof addr === 'object' && addr ? addr.port : 0;
}, 30_000);

afterAll(async () => {
  await stopServer();
}, 15_000);

describe('queued-message RPCs answer a state', () => {
  it('delete: a waiting row is deleted; a taken row answers taken; a missing one answers gone', async () => {
    const sid = 'queued-change-rpc-s1';
    await createSessionRecord(sid, `task-${sid}`, '', WALNUT_HOME);
    const ws = await connectWs();
    try {
      const waiting = await enqueueMessage(sid, 'delete me');
      const del = await rpc(ws, 'session:delete-queued', { sessionId: sid, messageId: waiting.id });
      expect(del).toMatchObject({ ok: true, payload: { ok: true } });
      expect((await getQueue(sid)).some((m) => m.id === waiting.id)).toBe(false);

      const taken = await enqueueMessage(sid, 'already on its way');
      await markProcessing(sid);
      expect((await getQueue(sid)).find((m) => m.id === taken.id)?.status).toBe('processing');
      const late = await rpc(ws, 'session:delete-queued', { sessionId: sid, messageId: taken.id });
      expect(late.ok).toBe(true);
      expect(late.error).toBeUndefined();
      expect(late.payload).toEqual({ ok: false, outcome: 'taken' });
      // Nothing deleted: the row is still on its way.
      expect((await getQueue(sid)).some((m) => m.id === taken.id)).toBe(true);

      const gone = await rpc(ws, 'session:delete-queued', { sessionId: sid, messageId: 'qm-never-there' });
      expect(gone).toMatchObject({ ok: true, payload: { ok: false, outcome: 'gone' } });

      const edit = await rpc(ws, 'session:edit-queued', { sessionId: sid, messageId: taken.id, text: 'new words' });
      expect(edit).toMatchObject({ ok: true, payload: { ok: false, outcome: 'taken' } });
      expect((await getQueue(sid)).find((m) => m.id === taken.id)?.message).toContain('already on its way');
    } finally {
      ws.close();
    }
  });

  it('a malformed request still fails as before', async () => {
    const ws = await connectWs();
    try {
      const bad = await rpc(ws, 'session:delete-queued', { sessionId: 'x' });
      expect(bad.ok).toBe(false);
      expect(bad.error).toMatch(/requires sessionId and messageId/);
    } finally {
      ws.close();
    }
  });
});
