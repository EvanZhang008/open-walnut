import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import type { Server as HttpServer } from 'node:http';
import { WebSocket } from 'ws';
import { createMockConstants } from '../helpers/mock-constants.js';

vi.mock('../../src/constants.js', () =>
  createMockConstants('walnut-session-status-pipeline'));

import { WALNUT_HOME } from '../../src/constants.js';
import { createSessionRecord } from '../../src/core/session-tracker.js';
import { startServer, stopServer } from '../../src/web/server.js';
import {
  SessionStatusStore,
  type SessionStatusSnapshot,
} from '../../web/src/stores/session-status-store.js';

interface WsEventFrame {
  type: 'event';
  name: string;
  data: Record<string, unknown>;
  seq: number;
}

let server: HttpServer;
let port = 0;

function apiUrl(path: string): string {
  return `http://localhost:${port}${path}`;
}

function connectWs(): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${port}/ws`);
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });
}

function waitForStatusEvent(
  ws: WebSocket,
  sessionId: string,
): Promise<WsEventFrame> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('Timed out waiting for session status event')),
      5_000,
    );
    const handler = (raw: WebSocket.RawData) => {
      const frame = JSON.parse(raw.toString()) as WsEventFrame;
      if (frame.type !== 'event'
        || frame.name !== 'session:status-changed'
        || frame.data.sessionId !== sessionId) {
        return;
      }
      clearTimeout(timer);
      ws.off('message', handler);
      resolve(frame);
    };
    ws.on('message', handler);
  });
}

beforeAll(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true });
  await fs.mkdir(WALNUT_HOME, { recursive: true });
  server = await startServer({ port: 0, dev: true });
  const address = server.address();
  port = typeof address === 'object' && address ? address.port : 0;
}, 30_000);

afterAll(async () => {
  await stopServer();
  await fs.rm(WALNUT_HOME, { recursive: true, force: true });
});

describe('versioned session status server-to-store pipeline', () => {
  it('serializes one exact snapshot and rejects delayed REST state', async () => {
    const sessionId = 'status-pipeline-session';
    await createSessionRecord(
      sessionId,
      'status-pipeline-task',
      'Walnut',
      undefined,
      { initialProcessStatus: 'stopped', engine: 'codex' },
    );

    const baselineResponse = await fetch(
      apiUrl(`/api/sessions/status?ids=${sessionId}`),
    );
    expect(baselineResponse.status).toBe(200);
    const baselineBody = await baselineResponse.json() as {
      statuses: Record<string, SessionStatusSnapshot>;
    };
    const baseline = baselineBody.statuses[sessionId];
    expect(baseline.statusRevision).toBe(1);

    const ws = await connectWs();
    const eventPromise = waitForStatusEvent(ws, sessionId);
    const patchResponse = await fetch(apiUrl(`/api/sessions/${sessionId}`), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ archived: true }),
    });
    expect(patchResponse.status).toBe(200);

    const frame = await eventPromise;
    ws.close();
    const expectedStatus: SessionStatusSnapshot = {
      ...baseline,
      archived: true,
      statusRevision: baseline.statusRevision + 1,
      statusUpdatedAt: expect.any(String) as unknown as string,
    };
    expect(frame.data.status).toEqual(expectedStatus);
    expect(frame.data).toEqual({
      ...expectedStatus,
      status: expectedStatus,
    });

    const serialized = JSON.parse(JSON.stringify(frame.data)) as Record<string, unknown>;
    const store = new SessionStatusStore();
    expect(store.applyVersioned(baseline, 'rest:session')).toBe('accepted');
    expect(store.ingestStatusEvent(serialized)).toBe('accepted');
    expect(store.getStatus(sessionId)).toMatchObject({
      archived: true,
      statusRevision: baseline.statusRevision + 1,
    });
    expect(store.applyVersioned(baseline, 'rest:session-list')).toBe('rejected-stale');
    expect(store.getStatus(sessionId)).toMatchObject({
      archived: true,
      statusRevision: baseline.statusRevision + 1,
    });
  });
});
