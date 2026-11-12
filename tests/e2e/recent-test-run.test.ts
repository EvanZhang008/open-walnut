/**
 * A test run never writes the person's Recent (2026-11-11: an acceptance run in an automated
 * WebKit window sent messages to a task over the WebSocket, and that task went to the top of the
 * user's real Recent). Every way a test run creates or sends: the HTTP header on a create and
 * on a quick start, and the label a test-run window puts on its WebSocket sends.
 */
import { beforeAll, afterAll, it, expect, vi } from 'vitest';
import fs from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { createMockConstants } from '../helpers/mock-constants.js';
vi.mock('../../src/constants.js', () => createMockConstants('walnut-recent-test-run'));
import { WALNUT_HOME } from '../../src/constants.js';
import { startServer, stopServer } from '../../src/web/server.js';
import { _getRpcMethodForTesting } from '../../src/web/ws/handler.js';
import { createSessionRecord, updateSessionRecord } from '../../src/core/session-tracker.js';
import { withSendTestRun } from '../../web/src/api/test-run.js';

let base = '';
const key = 'walnut-todo-recent-opened';
const recentIds = async (): Promise<string[]> => {
  const v = (await (await fetch(`${base}/api/ui-prefs?key=${key}`)).json()).prefs[key]?.v ?? '[]';
  return (JSON.parse(v) as Array<{ id: string }>).map((e) => e.id);
};

beforeAll(async () => {
  // A throwaway server makes no test objects unless told to (core/test-run.ts).
  process.env.WALNUT_TEST_RUN_MARK = '1';
  const server = await startServer({ port: 0 });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}, 60_000);
afterAll(async () => {
  await stopServer();
  delete process.env.WALNUT_TEST_RUN_MARK;
  await fs.rm(WALNUT_HOME, { recursive: true, force: true });
});

it('a test run creates and sends without touching Recent; the person still does', async () => {
  const make = async (title: string, testRun?: string) => {
    const res = await fetch(`${base}/api/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(testRun ? { 'x-walnut-test-run': testRun } : {}) },
      body: JSON.stringify({ title, project: 'Recent' }),
    });
    expect(res.status).toBe(201);
    return (await res.json()).task.id as string;
  };
  const person = await make('Made by the person');
  const probe = await make('Made by a test run', 'recent-probe');
  expect(await recentIds()).toEqual([person]);

  const sid = '66666666-7777-4888-9999-000000000011';
  await createSessionRecord(sid, probe, 'Recent', WALNUT_HOME);
  await updateSessionRecord(sid, { process_status: 'stopped' });
  const send = _getRpcMethodForTesting('session:send')!;
  // The label a test-run window adds to every send (web/src/api/ws.ts).
  expect(withSendTestRun({ sessionId: sid, message: 'x' }, 'recent-probe')).toMatchObject({ testRun: 'recent-probe' });
  expect(withSendTestRun({ sessionId: sid, message: 'x' }, null)).not.toHaveProperty('testRun');
  await send(withSendTestRun({ sessionId: sid, message: 'Reply with exactly one word: ready' }, 'recent-probe'));
  // The capture runs in the background: give a wrong touch time to land before judging.
  await new Promise((r) => setTimeout(r, 750));
  expect(await recentIds()).toEqual([person]);

  // The same send from a person's window counts at once.
  await send({ sessionId: sid, message: 'My own question' });
  await vi.waitFor(async () => expect(await recentIds()).toEqual([probe, person]));
}, 60_000);
