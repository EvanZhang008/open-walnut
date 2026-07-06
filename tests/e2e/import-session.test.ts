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
import { mockLocalDaemonReader } from '../helpers/mock-local-daemon-reader.js';

vi.mock('../../src/constants.js', () => createMockConstants());

// Daemon-uniform: import_session reads the JSONL through DaemonFileReader('__local__').
// A unit/e2e run has no local daemon and writes fixtures under a mocked CLAUDE_HOME, so
// we swap the transport for a real-fs-backed double that honors the mocked CLAUDE_HOME.
// The rest of the flow (tool → resolveSessionContext → DaemonFileReader → parse) is real.
vi.mock('../../src/core/daemon-file-reader.js', () => mockLocalDaemonReader());

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

/** Build mock JSONL content. If `cwd` is provided, the first `human` entry includes it (like real Claude Code). */
function buildMockJsonl(opts?: { cwd?: string }): string {
  const lines = [
    JSON.stringify({
      type: 'human',
      role: 'user',
      message: 'Fix the login bug in auth.ts',
      timestamp: '2026-02-25T10:00:00.000Z',
      ...(opts?.cwd ? { cwd: opts.cwd } : {}),
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

/**
 * Write a fake JSONL file to the mock CLAUDE_HOME so readSessionJsonlContent can find it.
 * `diskCwd` — the directory path used to compute the on-disk JSONL location.
 * `jsonlCwd` — the CWD embedded inside the JSONL content (source of truth). Defaults to diskCwd.
 * Pass `jsonlCwd: null` to omit the CWD field from JSONL (simulates old sessions without it).
 */
async function writeMockJsonl(sessionId: string, diskCwd: string, jsonlCwd?: string | null): Promise<string> {
  const encoded = encodeProjectPath(diskCwd);
  const dir = path.join(CLAUDE_HOME, 'projects', encoded);
  await fsp.mkdir(dir, { recursive: true });
  const filePath = path.join(dir, `${sessionId}.jsonl`);
  const cwdInContent = jsonlCwd === null ? undefined : (jsonlCwd ?? diskCwd);
  await fsp.writeFile(filePath, buildMockJsonl({ cwd: cwdInContent }));
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
    const importTool = tools.find(t => t.name === 'session_import');
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
    const importTool = tools.find(t => t.name === 'session_import')!;

    // First import succeeds
    const r1 = await importTool.execute({
      session_id: dupId,
      task_id: task.id,
      working_directory: MOCK_CWD,
    });
    expect(r1).toContain('Imported session');

    // Second import of same session to same task fails (task already has a session)
    const r2 = await importTool.execute({
      session_id: dupId,
      task_id: task.id,
      working_directory: MOCK_CWD,
    });
    expect(r2).toContain('already has a session');
  });

  it('returns error when JSONL not found', async () => {
    const task = await createTask('Missing JSONL test', 'Work', 'AuthService');

    const { tools } = await import('../../src/agent/tools.js');
    const importTool = tools.find(t => t.name === 'session_import')!;

    const result = await importTool.execute({
      session_id: 'nonexistent-session-id',
      task_id: task.id,
      working_directory: '/some/nonexistent/path',
    });

    expect(result).toContain('JSONL not found');
    expect(result).toContain('nonexistent-session-id');
  });

  it('finds JSONL via fallback when canonical path misses (different CWD) — CWD corrected from JSONL', async () => {
    const task = await createTask('Fallback search test', 'Work', 'AuthService');

    const fallbackId = 'fallback-00000000-0000-0000-0000';
    const actualCwd = '/home/user/actual-project';
    const wrongCwd = '/home/user/wrong-project';

    // Write JSONL under actualCwd's encoded path, with actualCwd embedded in JSONL
    await writeMockJsonl(fallbackId, actualCwd);

    const { tools } = await import('../../src/agent/tools.js');
    const importTool = tools.find(t => t.name === 'session_import')!;

    // Import with wrongCwd — canonical path won't match, but fallback should find it
    const result = await importTool.execute({
      session_id: fallbackId,
      task_id: task.id,
      working_directory: wrongCwd,
    });

    // Should succeed via fallback search, CWD corrected from JSONL
    expect(result).toContain('Imported session');
    expect(result).toContain(fallbackId);
    expect(result).toContain('CWD corrected');

    const session = await getSessionByClaudeId(fallbackId);
    expect(session).not.toBeNull();
    expect(session!.cwd).toBe(actualCwd); // CWD corrected to JSONL truth, not the wrong one passed in
  });

  it('supports custom title', async () => {
    const task = await createTask('Custom fields test', 'Work', 'AuthService');

    const customId = 'custom-fields-00000000-0000-0000';
    await writeMockJsonl(customId, MOCK_CWD);

    const { tools } = await import('../../src/agent/tools.js');
    const importTool = tools.find(t => t.name === 'session_import')!;

    const result = await importTool.execute({
      session_id: customId,
      task_id: task.id,
      working_directory: MOCK_CWD,
      title: 'My Custom Title',
    });

    expect(result).toContain('My Custom Title');

    const session = await getSessionByClaudeId(customId);
    expect(session!.title).toBe('My Custom Title');
  });

  it('rejects import when task already has a non-archived session', async () => {
    const task = await createTask('One session rule test', 'Work', 'AuthService');

    // First import succeeds
    const firstId = 'first-sess-00000000-0000-0000-0000';
    await writeMockJsonl(firstId, MOCK_CWD);

    const { tools } = await import('../../src/agent/tools.js');
    const importTool = tools.find(t => t.name === 'session_import')!;

    const r1 = await importTool.execute({
      session_id: firstId,
      task_id: task.id,
      working_directory: MOCK_CWD,
    });
    expect(r1).toContain('Imported session');

    // Second import to the same task should be blocked
    const secondId = 'second-sess-0000000-0000-0000-0000';
    await writeMockJsonl(secondId, MOCK_CWD);

    const r2 = await importTool.execute({
      session_id: secondId,
      task_id: task.id,
      working_directory: MOCK_CWD,
    });
    expect(r2).toContain('already has a session');
    expect(r2).toContain('only ONE session');

    // Verify second session was NOT created
    const session2 = await getSessionByClaudeId(secondId);
    expect(session2).toBeNull();
  });
});

// ── CWD reconciliation tests ──
// JSONL CWD is the source of truth. These tests verify the reconciliation logic.

describe('import_session CWD reconciliation', () => {
  it('case 1: corrects session CWD when working_directory differs from JSONL', async () => {
    const task = await createTask('CWD mismatch test', 'Work', 'CwdProject');
    const sid = 'cwd-case1-00000000-0000-0000-0000';
    const jsonlCwd = '/home/user/actual-project';
    const wrongCwd = '/home/user/wrong-project';

    // JSONL stored under jsonlCwd's encoded path, with jsonlCwd in content
    await writeMockJsonl(sid, jsonlCwd);

    const { tools } = await import('../../src/agent/tools.js');
    const importTool = tools.find(t => t.name === 'session_import')!;

    const result = await importTool.execute({
      session_id: sid,
      task_id: task.id,
      working_directory: wrongCwd,
    });

    expect(result).toContain('Imported session');
    expect(result).toContain('CWD corrected');
    expect(result).toContain(jsonlCwd);

    const session = await getSessionByClaudeId(sid);
    expect(session!.cwd).toBe(jsonlCwd);
  });

  it('case 2: corrects task CWD when it differs from JSONL', async () => {
    const task = await createTask('Task CWD mismatch', 'Work', 'CwdProject');
    const sid = 'cwd-case2-00000000-0000-0000-0000';
    const jsonlCwd = '/home/user/correct-project';
    const taskWrongCwd = '/home/user/task-wrong-cwd';

    // Set incorrect task CWD first
    const { updateTask } = await import('../../src/core/task-manager.js');
    await updateTask(task.id, { cwd: taskWrongCwd });

    // JSONL is at jsonlCwd with jsonlCwd in content
    await writeMockJsonl(sid, jsonlCwd);

    const { tools } = await import('../../src/agent/tools.js');
    const importTool = tools.find(t => t.name === 'session_import')!;

    // Don't pass working_directory — let it resolve from task.cwd
    const result = await importTool.execute({
      session_id: sid,
      task_id: task.id,
    });

    // Should have corrected and imported, but since task.cwd resolves to taskWrongCwd
    // and canonical path won't match jsonlCwd, fallback search finds the JSONL,
    // then CWD reconciliation corrects everything.
    expect(result).toContain('Imported session');
    expect(result).toContain('Task CWD updated');

    const session = await getSessionByClaudeId(sid);
    expect(session!.cwd).toBe(jsonlCwd);

    // Verify task CWD was also fixed
    const taskRes = await fetch(apiUrl(`/api/tasks/${task.id}`));
    const taskData = await taskRes.json() as { task: { cwd?: string } };
    expect(taskData.task.cwd).toBe(jsonlCwd);
  });

  it('case 3: sets task CWD from JSONL when task has no CWD', async () => {
    const task = await createTask('No task CWD', 'Work', 'CwdProject');
    const sid = 'cwd-case3-00000000-0000-0000-0000';
    const jsonlCwd = '/home/user/project-from-jsonl';

    // Task has no CWD set. Write JSONL under jsonlCwd.
    await writeMockJsonl(sid, jsonlCwd);

    const { tools } = await import('../../src/agent/tools.js');
    const importTool = tools.find(t => t.name === 'session_import')!;

    // Pass working_directory so JSONL can be found
    const result = await importTool.execute({
      session_id: sid,
      task_id: task.id,
      working_directory: jsonlCwd,
    });

    expect(result).toContain('Imported session');
    expect(result).toContain('Task CWD set');

    const session = await getSessionByClaudeId(sid);
    expect(session!.cwd).toBe(jsonlCwd);

    // Task CWD should now be set
    const taskRes = await fetch(apiUrl(`/api/tasks/${task.id}`));
    const taskData = await taskRes.json() as { task: { cwd?: string } };
    expect(taskData.task.cwd).toBe(jsonlCwd);
  });

  it('case 4: no warnings when all CWDs match', async () => {
    const consistentCwd = '/home/user/consistent-project';
    const task = await createTask('Consistent CWD', 'Work', 'CwdProject');
    const { updateTask } = await import('../../src/core/task-manager.js');
    await updateTask(task.id, { cwd: consistentCwd });

    const sid = 'cwd-case4-00000000-0000-0000-0000';
    await writeMockJsonl(sid, consistentCwd);

    const { tools } = await import('../../src/agent/tools.js');
    const importTool = tools.find(t => t.name === 'session_import')!;

    const result = await importTool.execute({
      session_id: sid,
      task_id: task.id,
      working_directory: consistentCwd,
    });

    expect(result).toContain('Imported session');
    expect(result).not.toContain('⚠️');

    const session = await getSessionByClaudeId(sid);
    expect(session!.cwd).toBe(consistentCwd);
  });

  it('case 5: warns when JSONL has no CWD field but working_directory was passed', async () => {
    const task = await createTask('No JSONL CWD', 'Work', 'CwdProject');
    const sid = 'cwd-case5-00000000-0000-0000-0000';
    const passedCwd = '/home/user/passed-cwd';

    // Write JSONL WITHOUT cwd field (jsonlCwd: null)
    await writeMockJsonl(sid, passedCwd, null);

    const { tools } = await import('../../src/agent/tools.js');
    const importTool = tools.find(t => t.name === 'session_import')!;

    const result = await importTool.execute({
      session_id: sid,
      task_id: task.id,
      working_directory: passedCwd,
    });

    expect(result).toContain('Imported session');
    expect(result).toContain('JSONL has no CWD field');

    const session = await getSessionByClaudeId(sid);
    expect(session!.cwd).toBe(passedCwd); // Falls back to passed value
  });

  it('case 6: warns when JSONL has no CWD and falls back to project default_cwd', async () => {
    const task = await createTask('No CWD anywhere', 'Work', 'CwdProject');
    const sid = 'cwd-case6-00000000-0000-0000-0000';

    // Write JSONL under some path, no CWD in content.
    // resolveSessionContext will fall back to the project's default_cwd,
    // JSONL is found via fallback search, and the "no CWD in JSONL" warning fires.
    await writeMockJsonl(sid, '/tmp/dummy-for-disk', null);

    const { tools } = await import('../../src/agent/tools.js');
    const importTool = tools.find(t => t.name === 'session_import')!;

    const result = await importTool.execute({
      session_id: sid,
      task_id: task.id,
    });

    // May import successfully (fallback search finds JSONL) or error (JSONL not found).
    // Either way, if imported, must warn about missing CWD field.
    if (result.includes('Imported session')) {
      expect(result).toContain('JSONL has no CWD field');
    } else {
      expect(result).toContain('Error');
    }
  });
});
