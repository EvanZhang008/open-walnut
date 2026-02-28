/**
 * E2E tests for import_session tool — real server + real persistence.
 *
 * What's real: Express server, task-manager, session-tracker, session-file-reader, REST API.
 * What's mocked: constants.js (temp dir), JSONL file created on disk in the mock CLAUDE_HOME.
 *
 * Tests verify:
 *   import_session tool → resolveSessionContext → readSessionJsonlContent →
 *   importSessionRecord → linkSession → REST API shows the imported session.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { Server as HttpServer } from 'node:http';
import { createMockConstants } from '../helpers/mock-constants.js';

vi.mock('../../src/constants.js', () => createMockConstants());

import { WALNUT_HOME, CLAUDE_HOME } from '../../src/constants.js';
import { startServer, stopServer } from '../../src/web/server.js';
import { encodeProjectPath } from '../../src/core/session-file-reader.js';
import { getSessionByClaudeId } from '../../src/core/session-tracker.js';

let server: HttpServer;
let port: number;

function apiUrl(p: string): string {
  return `http://localhost:${port}${p}`;
}

/** Create a task via REST API (ensures all migrations/defaults are applied). */
async function createTask(title: string, category: string, project: string): Promise<{ id: string; title: string }> {
  const res = await fetch(apiUrl('/api/tasks'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title, category, project }),
  });
  const data = await res.json() as { task: { id: string; title: string } };
  return data.task;
}

// ── Sample JSONL content (mimics Claude Code session output) ──
const MOCK_SESSION_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const MOCK_CWD = '/home/user/my-project';

function buildMockJsonl(): string {
  const lines = [
    JSON.stringify({
      type: 'human',
      role: 'user',
      message: 'Fix the login bug in auth.ts',
      timestamp: '2026-02-25T10:00:00.000Z',
    }),
    JSON.stringify({
      type: 'assistant',
      role: 'assistant',
      message: 'I will look at the auth module.',
      timestamp: '2026-02-25T10:01:00.000Z',
    }),
    JSON.stringify({
      type: 'human',
      role: 'user',
      message: 'Also check the session handling',
      timestamp: '2026-02-25T10:05:00.000Z',
    }),
    JSON.stringify({
      type: 'assistant',
      role: 'assistant',
      message: 'Done fixing both issues.',
      timestamp: '2026-02-25T10:10:00.000Z',
    }),
  ];
  return lines.join('\n') + '\n';
}

/** Write a fake JSONL file to the mock CLAUDE_HOME so readSessionJsonlContent can find it. */
async function writeMockJsonl(sessionId: string, cwd: string): Promise<string> {
  const encoded = encodeProjectPath(cwd);
  const dir = path.join(CLAUDE_HOME, 'projects', encoded);
  await fsp.mkdir(dir, { recursive: true });
  const filePath = path.join(dir, `${sessionId}.jsonl`);
  await fsp.writeFile(filePath, buildMockJsonl());
  return filePath;
}

beforeAll(async () => {
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true });
  await fsp.mkdir(WALNUT_HOME, { recursive: true });
  server = await startServer({ port: 0, dev: true });
  const addr = server.address();
  port = typeof addr === 'object' && addr ? addr.port : 0;
});

afterAll(async () => {
  await stopServer(server);
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true });
});

describe('import_session tool E2E', () => {
  it('imports a local session with explicit cwd and links to task', async () => {
    // Create a task via REST API
    const task = await createTask('Fix login bug', 'Work', 'AuthService');

    // Write the mock JSONL file
    await writeMockJsonl(MOCK_SESSION_ID, MOCK_CWD);

    // Call the import_session tool handler directly
    const { tools } = await import('../../src/agent/tools.js');
    const importTool = tools.find(t => t.name === 'import_session');
    expect(importTool).toBeDefined();

    const result = await importTool!.execute({
      session_id: MOCK_SESSION_ID,
      task_id: task.id,
      working_directory: MOCK_CWD,
    });

    // Verify success response
    expect(result).toContain('Imported session');
    expect(result).toContain(MOCK_SESSION_ID);

    // Verify session record was created correctly
    const session = await getSessionByClaudeId(MOCK_SESSION_ID);
    expect(session).not.toBeNull();
    expect(session!.process_status).toBe('stopped');
    expect(session!.work_status).toBe('agent_complete');
    expect(session!.taskId).toBe(task.id);
    expect(session!.cwd).toBe(MOCK_CWD);
    expect(session!.messageCount).toBe(4);
    // Title extracted from first user message
    expect(session!.title).toBe('Fix the login bug in auth.ts');
    // Timestamps from JSONL
    expect(session!.startedAt).toBe('2026-02-25T10:00:00.000Z');
    expect(session!.lastActiveAt).toBe('2026-02-25T10:10:00.000Z');

    // Verify task was linked — check via REST API
    const taskRes = await fetch(apiUrl(`/api/tasks/${task.id}`));
    const taskBody = await taskRes.json() as { task: { session_id?: string; session_ids?: string[] } };
    expect(taskBody.task.session_id).toBe(MOCK_SESSION_ID);
    expect(taskBody.task.session_ids).toContain(MOCK_SESSION_ID);

    // Verify session appears in session list via REST API
    const sessRes = await fetch(apiUrl('/api/sessions'));
    const sessBody = await sessRes.json() as { sessions: Array<{ claudeSessionId: string }> };
    const found = sessBody.sessions.find(s => s.claudeSessionId === MOCK_SESSION_ID);
    expect(found).toBeDefined();
  });

  it('rejects duplicate session import', async () => {
    const task = await createTask('Duplicate test', 'Work', 'AuthService');

    const dupId = 'dup-session-00000000-0000-0000-0000';
    await writeMockJsonl(dupId, MOCK_CWD);

    const { tools } = await import('../../src/agent/tools.js');
    const importTool = tools.find(t => t.name === 'import_session')!;

    // First import succeeds
    const r1 = await importTool.execute({
      session_id: dupId,
      task_id: task.id,
      working_directory: MOCK_CWD,
    });
    expect(r1).toContain('Imported session');

    // Second import of same session fails
    const r2 = await importTool.execute({
      session_id: dupId,
      task_id: task.id,
      working_directory: MOCK_CWD,
    });
    expect(r2).toContain('already tracked');
  });

  it('returns error when JSONL not found', async () => {
    const task = await createTask('Missing JSONL test', 'Work', 'AuthService');

    const { tools } = await import('../../src/agent/tools.js');
    const importTool = tools.find(t => t.name === 'import_session')!;

    const result = await importTool.execute({
      session_id: 'nonexistent-session-id',
      task_id: task.id,
      working_directory: '/some/nonexistent/path',
    });

    expect(result).toContain('JSONL file not found');
    expect(result).toContain('nonexistent-session-id');
  });

  it('supports custom title and work_status', async () => {
    const task = await createTask('Custom fields test', 'Work', 'AuthService');

    const customId = 'custom-fields-00000000-0000-0000';
    await writeMockJsonl(customId, MOCK_CWD);

    const { tools } = await import('../../src/agent/tools.js');
    const importTool = tools.find(t => t.name === 'import_session')!;

    const result = await importTool.execute({
      session_id: customId,
      task_id: task.id,
      working_directory: MOCK_CWD,
      title: 'My Custom Title',
      work_status: 'completed',
    });

    expect(result).toContain('My Custom Title');

    const session = await getSessionByClaudeId(customId);
    expect(session!.title).toBe('My Custom Title');
    expect(session!.work_status).toBe('completed');
  });
});
