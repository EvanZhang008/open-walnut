import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createMockConstants } from '../helpers/mock-constants.js';

vi.mock('../../src/constants.js', () => createMockConstants('walnut-external-import', { IS_EPHEMERAL: true }));
vi.mock('../../src/providers/local-daemon.js', () => ({
  localDaemon: { ensureRunning: async () => {}, stopIfIsolated: async () => {}, port: 0 },
}));

import { WALNUT_HOME } from '../../src/constants.js';
import { startServer, stopServer } from '../../src/web/server.js';
import * as daemonConnections from '../../src/providers/daemon-connection.js';
import { scanExternalSessions } from '../../src/providers/external-session-scan-core.js';
import { getSessionByClaudeId } from '../../src/core/session-tracker.js';
import { getTask } from '../../src/core/task-manager.js';
import { bus, EventNames } from '../../src/core/event-bus.js';
import { closeDb as closeTaskDb } from '../../src/core/task-db.js';
import { closeDb as closeSessionDb } from '../../src/core/session-db.js';

let base: string;
const stamp = '2026-08-10T10:00:00.000Z';

async function api(url: string, method = 'GET', body?: unknown) {
  const response = await fetch(base + url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  expect(response.ok).toBe(true);
  return response.json();
}

async function transcript(id: string, cwd: string, text: string) {
  const file = path.join(WALNUT_HOME, '.claude/projects/fixture', `${id}.jsonl`);
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, [
    { type: 'user', uuid: `${id}-user`, sessionId: id, entrypoint: 'cli', cwd, timestamp: stamp, message: { role: 'user', content: text } },
    { type: 'assistant', uuid: `${id}-assistant`, parentUuid: `${id}-user`, timestamp: stamp, message: { role: 'assistant', content: [{ type: 'text', text: 'OK' }] } },
  ].map(line => JSON.stringify(line)).join('\n') + '\n');
  return file;
}

beforeAll(async () => {
  vi.stubEnv('HOME', WALNUT_HOME);
  vi.stubEnv('USERPROFILE', WALNUT_HOME);
  vi.stubEnv('WALNUT_DISABLE_SEARCH', '1');
  vi.stubEnv('WALNUT_DISABLE_BACKGROUND_AI', '1');
  vi.stubEnv('WALNUT_EXTERNAL_SESSION_IMPORT', '0');
  await fsp.mkdir(WALNUT_HOME, { recursive: true });
  const server = await startServer({ port: 0, dev: true });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing isolated server port');
  base = `http://127.0.0.1:${address.port}`;
  vi.spyOn(daemonConnections, 'getConnectedDaemonConnection').mockImplementation(host => host !== '__local__' ? null : ({
    hasCapability: (cap: string) => ['external-scan-v1', 'external-scan-filter-v1'].includes(cap),
    send: async (command: string, options: Parameters<typeof scanExternalSessions>[0]) => {
      expect(command).toBe('sessions.discoverExternal');
      return { ok: true, ...scanExternalSessions({ ...options, homeDir: WALNUT_HOME }) };
    },
  } as unknown as ReturnType<typeof daemonConnections.getConnectedDaemonConnection>));
});

afterAll(async () => {
  await stopServer();
  vi.restoreAllMocks();
  closeTaskDb();
  closeSessionDb();
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

it('filters probes through REST, retitles in place and recovers when exclusions are removed', async () => {
  const ignored = '/home/dev/probes';
  await transcript('probe-session', `${ignored}/run`, 'Reply OK');
  const file = await transcript('deadbeef-1111', '/home/dev/work', '<system-reminder>Context</system-reminder>');
  await api('/api/config', 'PUT', { external_session_import: { excluded_cwds: { __local__: [ignored] } } });
  const first = await api('/api/sessions/import-external', 'POST', { days: 30 });
  expect(first.imported).toBe(1);
  expect(await getSessionByClaudeId('probe-session')).toBeNull();
  const session = await getSessionByClaudeId('deadbeef-1111');
  const task = await getTask(session!.taskId);
  await api(`/api/tasks/${task.id}`, 'PATCH', { project: 'Actual work', phase: 'COMPLETE' });
  const before = await getTask(task.id);
  const sessionBefore = await getSessionByClaudeId('deadbeef-1111');
  await fsp.appendFile(file, JSON.stringify({ type: 'ai-title', aiTitle: '真实工作标题', sessionId: 'deadbeef-1111' }) + '\n');
  const emit = vi.spyOn(bus, 'emit');
  const second = await api('/api/sessions/import-external', 'POST', { days: 30 });
  expect(second).toMatchObject({ imported: 0, retitled: 1 });
  expect(emit.mock.calls.some(([event]) => event === EventNames.TASK_COMPLETED)).toBe(false);
  expect(await getTask(task.id)).toEqual({ ...before, title: '真实工作标题' });
  expect(await getSessionByClaudeId('deadbeef-1111')).toEqual({ ...sessionBefore, title: '真实工作标题' });
  const listed = await api('/api/tasks?project=Actual%20work');
  expect(listed.tasks.some((row: { id: string }) => row.id === task.id)).toBe(true);
  expect((await api('/api/sessions/import-external', 'POST', {})).imported).toBe(0);
  await api('/api/config', 'PUT', { external_session_import: { excluded_cwds: {} } });
  expect((await api('/api/sessions/import-external', 'POST', {})).imported).toBe(1);
  expect(await getSessionByClaudeId('probe-session')).not.toBeNull();
});
