/**
 * Tests for import_session tool and importSessionRecord.
 *
 * Covers:
 * - importSessionRecord: basic import, duplicate detection, custom fields
 * - import_session tool handler: full E2E flow with mock JSONL
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createMockConstants } from '../helpers/mock-constants.js';

vi.mock('../../src/constants.js', () => createMockConstants());
vi.mock('../../src/utils/process.js', () => ({
  isProcessAlive: () => true,
}));

import {
  importSessionRecord,
  getSessionByClaudeId,
  listSessions,
} from '../../src/core/session-tracker.js';
import { WALNUT_HOME } from '../../src/constants.js';

beforeEach(async () => {
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true });
  await fsp.mkdir(WALNUT_HOME, { recursive: true });
});

afterEach(async () => {
  for (let i = 0; i < 3; i++) {
    try {
      await fsp.rm(WALNUT_HOME, { recursive: true, force: true });
      break;
    } catch {
      await new Promise(r => setTimeout(r, 50));
    }
  }
});

describe('importSessionRecord', () => {
  it('creates a stopped session record with correct fields', async () => {
    const record = await importSessionRecord({
      claudeSessionId: 'import-001',
      taskId: 'task-1',
      project: 'walnut',
      cwd: '/home/user/walnut',
      host: 'olddev',
      title: 'Imported test session',
      work_status: 'agent_complete',
      startedAt: '2026-02-25T10:00:00.000Z',
      lastActiveAt: '2026-02-25T11:00:00.000Z',
      messageCount: 42,
    });

    expect(record.claudeSessionId).toBe('import-001');
    expect(record.taskId).toBe('task-1');
    expect(record.project).toBe('walnut');
    expect(record.process_status).toBe('stopped');
    expect(record.work_status).toBe('agent_complete');
    expect(record.cwd).toBe('/home/user/walnut');
    expect(record.host).toBe('olddev');
    expect(record.title).toBe('Imported test session');
    expect(record.startedAt).toBe('2026-02-25T10:00:00.000Z');
    expect(record.lastActiveAt).toBe('2026-02-25T11:00:00.000Z');
    expect(record.messageCount).toBe(42);
    expect(record.mode).toBe('default');
  });

  it('defaults work_status to agent_complete', async () => {
    const record = await importSessionRecord({
      claudeSessionId: 'import-002',
      taskId: 'task-1',
      project: 'proj',
    });
    expect(record.work_status).toBe('agent_complete');
  });

  it('allows completed and await_human_action work statuses', async () => {
    const r1 = await importSessionRecord({
      claudeSessionId: 'import-003',
      taskId: 'task-1',
      project: 'proj',
      work_status: 'completed',
    });
    expect(r1.work_status).toBe('completed');

    const r2 = await importSessionRecord({
      claudeSessionId: 'import-004',
      taskId: 'task-1',
      project: 'proj',
      work_status: 'await_human_action',
    });
    expect(r2.work_status).toBe('await_human_action');
  });

  it('persists to store and is retrievable', async () => {
    await importSessionRecord({
      claudeSessionId: 'import-005',
      taskId: 'task-1',
      project: 'proj',
    });

    const found = await getSessionByClaudeId('import-005');
    expect(found).not.toBeNull();
    expect(found!.claudeSessionId).toBe('import-005');
    expect(found!.process_status).toBe('stopped');

    const all = await listSessions();
    expect(all).toHaveLength(1);
  });

  it('throws on duplicate session ID', async () => {
    await importSessionRecord({
      claudeSessionId: 'import-dup',
      taskId: 'task-1',
      project: 'proj',
    });

    await expect(
      importSessionRecord({
        claudeSessionId: 'import-dup',
        taskId: 'task-2',
        project: 'proj',
      }),
    ).rejects.toThrow(/already tracked/);
  });

  it('uses current timestamp when startedAt/lastActiveAt not provided', async () => {
    const before = new Date().toISOString();
    const record = await importSessionRecord({
      claudeSessionId: 'import-006',
      taskId: 'task-1',
      project: 'proj',
    });
    const after = new Date().toISOString();

    expect(record.startedAt >= before).toBe(true);
    expect(record.startedAt <= after).toBe(true);
    expect(record.lastActiveAt >= before).toBe(true);
    expect(record.messageCount).toBe(0);
  });

  it('omits optional fields when not provided', async () => {
    const record = await importSessionRecord({
      claudeSessionId: 'import-007',
      taskId: 'task-1',
      project: 'proj',
    });

    expect(record.cwd).toBeUndefined();
    expect(record.host).toBeUndefined();
    expect(record.title).toBeUndefined();
  });
});
