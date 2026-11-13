import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Server } from 'node:http';
import { createMockConstants } from '../helpers/mock-constants.js';

vi.mock('../../src/constants.js', () => createMockConstants('first-message-source-e2e'));
import { WALNUT_HOME } from '../../src/constants.js';
import { sessionRunner } from '../../src/providers/claude-code-session.js';
import { startServer, stopServer } from '../../src/web/server.js';
import { createMockDaemon, type MockDaemon } from '../helpers/mock-daemon.js';
import { transcriptSentBy } from '../../src/core/sessions/transcript-sent-by.js';
import { parseHinted } from '../../src/core/hints/hint-format.js';

let server: Server;
let port: number;
let daemon: MockDaemon;
async function req(route: string, body: unknown, headers: Record<string, string> = {}) {
  const response = await fetch(`http://127.0.0.1:${port}${route}`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() as Record<string, any> };
}
async function delivered(words: string): Promise<string> {
  await vi.waitFor(() => {
    expect(daemon.getCommandHistoryFor('start').some(c => String(c.payload.message).includes(words))).toBe(true);
  }, { timeout: 20_000 });
  return String(daemon.getCommandHistoryFor('start').find(c => String(c.payload.message).includes(words))!.payload.message);
}
beforeAll(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true });
  daemon = await createMockDaemon();
  sessionRunner.setCliCommand(path.resolve(import.meta.dirname, '../providers/mock-claude.mjs'));
  sessionRunner.setTestDaemonUrl(`ws://127.0.0.1:${daemon.port}`);
  server = await startServer({ port: 0, dev: true });
  const address = server.address();
  port = typeof address === 'object' && address ? address.port : 0;
}, 120_000);
afterAll(async () => {
  sessionRunner.setTestDaemonUrl(undefined);
  await stopServer();
  await daemon?.stop();
  await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {});
});

describe('real launch routes carry the first-message author to the daemon', () => {
  it('task create followed by an automation start preserves the import name', async () => {
    const created = await req('/api/v1/tasks', { title: 'Imported alert', local: true });
    expect(created.status).toBeLessThan(300);
    const task = created.body.task;
    const words = 'Investigate this ticket. Keep the approval separate.';
    const started = await req(`/api/v1/tasks/${task.id}/start`, { cwd: WALNUT_HOME, message: words, expect_reply: false }, {
      'x-walnut-caller-kind': 'automation', 'x-walnut-sender': 'ticket-import',
    });
    expect(started.status, JSON.stringify(started.body)).toBeLessThan(300);
    const text = parseHinted(await delivered(words)).text;
    expect(transcriptSentBy({ role: 'user', text })).toBe('agent');
    expect(text).toContain('automation: ticket-import');
  }, 60_000);

  it('a quick-start caller session names its task in the new first message', async () => {
    const parent = await req('/api/sessions/quick-start', { cwd: WALNUT_HOME, message: 'First-message source owner.' });
    expect(parent.status, JSON.stringify(parent.body)).toBe(200);
    const words = 'Carry the long handoff: ' + 'line with data '.repeat(300) + '\u4f60\u597d';
    const child = await req('/api/sessions/quick-start', { cwd: WALNUT_HOME, message: words }, {
      'x-walnut-caller-sid': parent.body.sessionId,
    });
    expect(child.status, JSON.stringify(child.body)).toBe(200);
    const text = parseHinted(await delivered('Carry the long handoff:')).text;
    expect(transcriptSentBy({ role: 'user', text })).toBe('agent');
    expect(text).toContain(`from-task="${parent.body.taskId}"`);
    expect(text).toContain(`from-session="${parent.body.sessionId}"`);
    expect(text).toContain('\u4f60\u597d');
  }, 90_000);

  it.each([false, true])('a forwarded long first message stays agent after spill (ask=%s)', async (walnutAgent) => {
    const { frameStartText } = await import('../../src/core/sessions/send-frame.js');
    const original = frameStartText('Forwarded import context. ' + 'Long imported ticket detail. '.repeat(1800), { source: 'automation:ticket-import' });
    const started = await req('/api/sessions/quick-start', { cwd: WALNUT_HOME, message: original, walnutAgent });
    expect(started.status, JSON.stringify(started.body)).toBe(200);
    const ownStart = () => daemon.getCommandHistoryFor('start').find(c => (c.payload.sid ?? c.payload.sessionId) === started.body.sessionId);
    await vi.waitFor(() => expect(ownStart()).toBeDefined(), { timeout: 20_000 });
    const text = parseHinted(String(ownStart()!.payload.message)).text;
    expect(transcriptSentBy({ role: 'user', text }), text).toBe('agent');
  }, 90_000);

  it('a person-typed quick start stays a person at the same daemon boundary', async () => {
    const words = 'These are my own typed words.';
    const started = await req('/api/sessions/quick-start', { cwd: WALNUT_HOME, message: words });
    expect(started.status, JSON.stringify(started.body)).toBe(200);
    expect(transcriptSentBy({ role: 'user', text: parseHinted(await delivered(words)).text })).toBe('person');
  }, 60_000);
});
