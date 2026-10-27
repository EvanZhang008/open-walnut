/**
 * E2E: a routine aimed at the main agent reaches the CURRENT Main task's
 * session, never the home chat's taskless lane session.
 *
 * Real server, real WebSocket, real cron execution, real delivery path
 * (routines/main-target.ts → the session executor → quickStartSession / the
 * message queue). The 'session-runner' bus subscriber is replaced by a recorder,
 * so nothing here can spawn a CLI: the assertion is WHERE the server sends.
 *
 * 2026-10-27: "Main daily reflection" ran in Main AND in the old home chat lane
 * session (no task, no longer Main); earlier one-off routines ran only there.
 *
 * All test cron jobs are cleaned up in afterAll.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import type { Server as HttpServer } from 'node:http';
import { WebSocket } from 'ws';
import { createMockConstants } from '../helpers/mock-constants.js';

vi.mock('../../src/constants.js', () => createMockConstants('walnut-e2e-cron-agent'));

import { WALNUT_HOME } from '../../src/constants.js';
import { startServer, stopServer } from '../../src/web/server.js';
import * as chatHistory from '../../src/core/chat-history.js';
import { bus, EventNames, type BusEvent } from '../../src/core/event-bus.js';
import type { SessionStartEvent, SessionSendEvent } from '../../src/core/event-types.js';
import { markProcessing, removeProcessed } from '../../src/core/session-message-queue.js';

// ── Helpers ──

let server: HttpServer;
let port: number;
const createdJobIds: string[] = [];

function apiUrl(path: string): string {
  return `http://localhost:${port}${path}`;
}

function wsUrl(): string {
  return `ws://localhost:${port}/ws`;
}

function connectWs(): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl());
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
  });
}

/**
 * Collect WS messages matching any of the given event names.
 * Resolves when either the expected count is reached or the timeout fires.
 */
function collectWsMessagesByName(
  ws: WebSocket,
  names: string[],
  maxCount: number,
  timeoutMs = 30000,
): Promise<Array<Record<string, unknown>>> {
  return new Promise((resolve) => {
    const matched: Array<Record<string, unknown>> = [];
    const timer = setTimeout(() => {
      ws.off('message', handler);
      resolve(matched);
    }, timeoutMs);
    const handler = (data: any) => {
      const msg = JSON.parse(data.toString());
      if (names.includes(msg.name as string)) {
        matched.push(msg);
      }
      if (matched.length >= maxCount) {
        clearTimeout(timer);
        ws.off('message', handler);
        resolve(matched);
      }
    };
    ws.on('message', handler);
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Drains left in flight; awaited before teardown so no message stays 'pending'
 *  (a pending message is what a reconnect would cold-`--resume` into a spawn). */
const inFlightDrains = new Set<Promise<void>>();

function drainQueue(sessionId: string): void {
  const p = (async () => {
    try {
      const batch = await markProcessing(sessionId);
      if (batch.length > 0) await removeProcessed(sessionId, batch.map((m) => m.id));
    } catch { /* the store may be torn down between tests */ }
  })();
  inFlightDrains.add(p);
  void p.finally(() => inFlightDrains.delete(p));
}

/** Every start and send the server asked the session runner for. */
const asked: Array<{ kind: 'start' | 'send'; sessionId?: string; taskId?: string; message: string }> = [];

/**
 * Recording session-runner, registered by NAME after startServer, which displaces
 * the real subscriber. A send's queue row is drained so no message stays pending
 * (a pending one is what a reconnect would cold-resume into a spawn).
 */
function installRecorder(): void {
  bus.subscribe('session-runner', (event: BusEvent) => {
    if (event.name === EventNames.SESSION_START) {
      const d = event.data as SessionStartEvent;
      asked.push({ kind: 'start', sessionId: d.preassignedSessionId, taskId: d.taskId, message: d.message });
    } else if (event.name === EventNames.SESSION_SEND) {
      const d = event.data as SessionSendEvent;
      asked.push({ kind: 'send', sessionId: d.sessionId, taskId: d.taskId, message: d.message });
      drainQueue(d.sessionId);
    }
  });
}

async function createJob(body: Record<string, unknown>): Promise<string> {
  const res = await fetch(apiUrl('/api/cron'), {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ schedule: { kind: 'every', everyMs: 3600000 }, sessionTarget: 'main', ...body }),
  });
  expect(res.status).toBe(201);
  const { job } = (await res.json()) as { job: { id: string } };
  createdJobIds.push(job.id);
  return job.id;
}

async function runJob(id: string): Promise<{ lastStatus?: string; lastError?: string }> {
  const res = await fetch(apiUrl(`/api/cron/${id}/run`), { method: 'POST' });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { result: { ok: boolean; ran: boolean } };
  expect(body.result).toMatchObject({ ok: true, ran: true });
  const got = await fetch(apiUrl(`/api/cron/${id}`));
  return ((await got.json()) as { job: { state: { lastStatus?: string; lastError?: string } } }).job.state;
}

async function waitFor<T>(fn: () => T | undefined, ms = 5000): Promise<T> {
  const until = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v !== undefined) return v;
    if (Date.now() > until) throw new Error('timed out');
    await delay(25);
  }
}

// ── Setup / Teardown ──

let mainConvId: string;
let mainTaskId: string;
/** The home chat's lane session: taskless, what used to receive these routines. */
const laneSid = randomUUID();

beforeAll(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true });
  await fs.mkdir(WALNUT_HOME, { recursive: true });
  server = await startServer({ port: 0, dev: true });
  installRecorder();
  const addr = server.address();
  port = typeof addr === 'object' && addr ? addr.port : 0;
  const { getMainConversationId } = await import('../../src/core/conversations.js');
  mainConvId = await getMainConversationId('general');
  const { createSessionRecord } = await import('../../src/core/session-tracker.js');
  const { personalAiLaneKey } = await import('../../src/core/sessions/personal-ai-lane.js');
  await createSessionRecord(laneSid, '', '', WALNUT_HOME, {
    lane: personalAiLaneKey('general', mainConvId), initialProcessStatus: 'idle',
  });
  const { ensureMainTask } = await import('../../src/core/org/org-store.js');
  mainTaskId = (await ensureMainTask()).id;
});

beforeEach(() => { asked.length = 0; });

afterAll(async () => {
  for (const id of createdJobIds) {
    try {
      await fetch(apiUrl(`/api/cron/${id}`), { method: 'DELETE' });
    } catch {
      // ignore cleanup errors
    }
  }
  await Promise.allSettled([...inFlightDrains]);
  await stopServer();
  bus.clear();
  await fs.rm(WALNUT_HOME, { recursive: true, force: true });
});

// ── Tests ──

describe('a routine aimed at the main agent', () => {
  it('reaches the Main task\'s conversation as a scheduled message, and never the home chat lane', async () => {
    const id = await createJob({ name: 'Main daily reflection', wakeMode: 'now', payload: { kind: 'systemEvent', text: 'Write the daily reflection.' } });
    const ws = await connectWs();
    const toast = collectWsMessagesByName(ws, ['cron:notification'], 1, 10000);
    const state = await runJob(id);
    expect(state.lastStatus).toBe('ok');
    const hit = await waitFor(() => asked.find((a) => a.taskId === mainTaskId));
    expect(hit.kind).toBe('start');
    expect(hit.message).toContain('Write the daily reflection.');
    // The scheduled envelope: the session can tell a routine from a person.
    expect(hit.message).toContain('<walnut-message');
    expect(hit.message).toContain('Main daily reflection');
    expect(asked.some((a) => a.sessionId === laneSid)).toBe(false);
    // The toast still tells the user; the home chat history is not written.
    expect((await toast).length).toBe(1);
    ws.close();
    const display = await chatHistory.getDisplayHistory('general', mainConvId);
    expect(display.some((m) => typeof m.content === 'string' && m.content.includes('Write the daily reflection.'))).toBe(false);
  });

  it('a second run continues the same conversation on the Main task', async () => {
    const id = await createJob({ name: 'Main check-in', wakeMode: 'now', payload: { kind: 'systemEvent', text: 'Check in.' } });
    await runJob(id);
    const first = await waitFor(() => asked.find((a) => a.taskId === mainTaskId));
    const firstSid = first.sessionId;
    asked.length = 0;
    await runJob(id);
    const second = await waitFor(() => asked.find((a) => a.taskId === mainTaskId || a.sessionId === firstSid));
    expect(second.kind).toBe('send');
    expect(second.sessionId).toBe(firstSid);
    expect(asked.some((a) => a.sessionId === laneSid)).toBe(false);
  });

  it('next-cycle routines also go to the Main task (there is no taskless chat to wait in)', async () => {
    const id = await createJob({ name: 'Queued note', wakeMode: 'next-cycle', payload: { kind: 'systemEvent', text: 'Queued notification test.' } });
    await runJob(id);
    const hit = await waitFor(() => asked.find((a) => a.message.includes('Queued notification test.')));
    expect(hit.taskId === mainTaskId || hit.kind === 'send').toBe(true);
    expect(asked.some((a) => a.sessionId === laneSid)).toBe(false);
  });

  it('follows the CURRENT Main: a new Main receives the next run, the old one does not', async () => {
    const { updateTaskRaw, addTask } = await import('../../src/core/task-manager.js');
    await updateTaskRaw(mainTaskId, { org_role: undefined });
    const { task: next } = await addTask({ title: 'Main', project: 'Ask Walnut', source: 'local', walnut_agent: true, org_role: 'main' });
    try {
      const id = await createJob({ name: 'Main after handover', wakeMode: 'now', payload: { kind: 'systemEvent', text: 'Hello, new Main.' } });
      await runJob(id);
      const hit = await waitFor(() => asked.find((a) => a.message.includes('Hello, new Main.')));
      expect(hit.taskId).toBe(next.id);
      expect(asked.some((a) => a.taskId === mainTaskId)).toBe(false);
    } finally {
      await updateTaskRaw(next.id, { org_role: undefined });
      await updateTaskRaw(mainTaskId, { org_role: 'main' });
    }
  });
});
