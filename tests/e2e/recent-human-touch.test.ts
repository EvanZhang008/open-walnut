import { beforeAll, afterAll, it, expect, vi } from 'vitest';
import fs from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { createMockConstants } from '../helpers/mock-constants.js';
vi.mock('../../src/constants.js', () => createMockConstants('walnut-recent-human'));
import { WALNUT_HOME } from '../../src/constants.js';
import { startServer, stopServer } from '../../src/web/server.js';
import { createSessionRecord, updateSessionRecord } from '../../src/core/session-tracker.js';
import { enqueueMessage, sendMessageToSession } from '../../src/core/session-message-queue.js';
let base = '';
beforeAll(async () => { const server = await startServer({ port: 0 }); base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; }, 30_000);
afterAll(async () => { await stopServer(); await fs.rm(WALNUT_HOME, { recursive: true, force: true }); });
const key = 'walnut-todo-recent-opened';
const recent = async () => (await (await fetch(`${base}/api/ui-prefs?key=${key}`)).json()).prefs[key]?.v ?? '[]';
it('real creates and accepted messages count only when sent by the person', async () => {
  const make = async (title: string, automation: boolean) => {
    const res = await fetch(`${base}/api/tasks`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(automation ? { 'x-walnut-caller-kind': 'automation' } : {}) }, body: JSON.stringify({ title, project: 'Recent' }) });
    expect(res.status).toBe(201); return (await res.json()).task.id as string;
  };
  const human = await make('Created by a person', false);
  const agent = await make('Created by an agent', true);
  expect(JSON.parse(await recent()).map((e: { id: string }) => e.id)).toEqual([human]);
  const sid = '66666666-7777-4888-9999-000000000003';
  await createSessionRecord(sid, agent, 'Recent', WALNUT_HOME);
  await updateSessionRecord(sid, { process_status: 'stopped' });
  const before = await recent();
  await sendMessageToSession(sid, 'Background progress', { source: 'api-agent', taskId: agent });
  expect(await recent()).toBe(before);
  await sendMessageToSession(sid, 'My own question', { source: 'ui', taskId: agent });
  await vi.waitFor(async () => expect(JSON.parse(await recent()).map((e: { id: string }) => e.id)).toEqual([agent, human]));
  const touched = await recent();
  await sendMessageToSession(sid, '<walnut-message kind="peer-note" from="Agent">\nAgent forwarded note\n</walnut-message>', { source: 'ui', taskId: agent });
  // A queue writer still attributes the original, before hint-tag escaping.
  await enqueueMessage(sid, 'Escaped agent note', { sentBy: 'person', recentText: '<walnut-message kind="peer-note" from="Agent">\nAgent note\n</walnut-message>' });
  // The capture runs in the background: give a wrong touch time to land before judging.
  await new Promise((r) => setTimeout(r, 750));
  expect(await recent()).toBe(touched);
  await fetch(`${base}/api/tasks/${human}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json', 'x-walnut-caller-kind': 'automation' }, body: JSON.stringify({ summary: 'Background update' }) });
  await sendMessageToSession(sid, 'Another agent reply', { source: 'peer-message', taskId: agent });
  expect(await recent()).toBe(touched);
  // Words the person typed after a carried note still count.
  await sendMessageToSession(sid, '<walnut-message kind="peer-note" from="Agent">\nCarried note\n</walnut-message>\n\nMy reply to it', { source: 'ui', taskId: agent });
  await vi.waitFor(async () => expect(await recent()).not.toBe(touched));
  expect(JSON.parse(await recent())[0].id).toBe(agent);
}, 30_000);
