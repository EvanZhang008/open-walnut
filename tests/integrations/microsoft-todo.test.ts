import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import { EventEmitter } from 'node:events';
import type { Task, TaskPriority, TaskStatus } from '../../src/core/types.js';

// ── Mocks ──

// Mock node:https at the transport layer
const mockHttpsRequest = vi.fn();
vi.mock('node:https', () => ({
  default: { request: (...args: unknown[]) => mockHttpsRequest(...args) },
  request: (...args: unknown[]) => mockHttpsRequest(...args),
}));

// Mock MSAL — provide a fake PublicClientApplication that returns tokens
const mockAcquireTokenSilent = vi.fn();
const mockGetAllAccounts = vi.fn().mockResolvedValue([{ username: 'test@outlook.com' }]);
const mockSerialize = vi.fn().mockReturnValue('{}');
const mockDeserialize = vi.fn();

vi.mock('@azure/msal-node', () => ({
  PublicClientApplication: vi.fn().mockImplementation(() => ({
    acquireTokenSilent: mockAcquireTokenSilent,
    acquireTokenByDeviceCode: vi.fn(),
    getTokenCache: () => ({
      getAllAccounts: mockGetAllAccounts,
      serialize: mockSerialize,
      deserialize: mockDeserialize,
    }),
  })),
}));

vi.mock('../../src/core/config-manager.js', () => ({
  getConfig: vi.fn().mockResolvedValue({
    version: 1,
    user: {},
    defaults: { priority: 'none', category: 'personal' },
    provider: { type: 'claude-code' },
    plugins: { 'ms-todo': { client_id: 'test-client-id', list_mapping: {} } },
  }),
}));

const mockReadJsonFile = vi.fn();
const mockWriteJsonFile = vi.fn().mockResolvedValue(undefined);
vi.mock('../../src/utils/fs.js', () => ({
  readJsonFile: (...args: unknown[]) => mockReadJsonFile(...args),
  writeJsonFile: (...args: unknown[]) => mockWriteJsonFile(...args),
}));

import {
  mapToRemote,
  mapToLocal,
  parseMsTodoBody,
  pushTask,
  pullTasks,
  syncTasks,
  deltaPull,
  autoPushTask,
  getMsTodoSyncStatus,
  createList,
  renameList,
  deleteList,
  fetchChecklistItems,
  pushChecklistItem,
  deleteChecklistItem,
  clearListIdCache,
} from '../../src/integrations/microsoft-todo.js';

// ── Helpers ──

/** Helper to build ext data for ms-todo */
function msExt(id?: string, listId?: string): Record<string, unknown> {
  const ext: Record<string, unknown> = {};
  if (id !== undefined || listId !== undefined) {
    ext['ms-todo'] = { ...(id !== undefined && { id }), ...(listId !== undefined && { list_id: listId }) };
  }
  return ext;
}

function makeTask(overrides: Partial<Task> & { ms_todo_id?: string; ms_todo_list?: string } = {}): Task {
  const { ms_todo_id, ms_todo_list, ...rest } = overrides;
  const status = rest.status ?? 'todo';
  const phase = rest.phase ?? ({ todo: 'TODO', in_progress: 'IN_PROGRESS', done: 'COMPLETE' } as const)[status] ?? 'TODO';

  // Build ext from legacy field names for backward compat in tests
  let ext = rest.ext;
  if (ms_todo_id !== undefined || ms_todo_list !== undefined) {
    ext = { ...ext, ...msExt(ms_todo_id, ms_todo_list) };
  }

  return {
    id: 'test-id-123',
    title: 'Test Task',
    status,
    phase,
    priority: 'none',
    category: 'personal',
    project: 'personal',
    session_ids: [],
    created_at: '2024-01-01T00:00:00.000Z',
    updated_at: '2024-01-01T00:00:00.000Z',
    description: '',
    summary: '',
    note: '',
    source: 'ms-todo',
    ...rest,
    ...(ext && { ext }),
  };
}

/** Get ms-todo ext fields from a task for assertions */
function getMsExt(task: Task | Partial<Task>): { id?: string; list_id?: string } {
  return (task.ext?.['ms-todo'] ?? {}) as { id?: string; list_id?: string };
}

function makeMsTask(overrides = {}) {
  return {
    id: 'ms-task-id',
    title: 'MS Task',
    status: 'notStarted' as const,
    importance: 'normal' as const,
    createdDateTime: '2024-01-01T00:00:00Z',
    lastModifiedDateTime: '2024-01-02T00:00:00Z',
    ...overrides,
  };
}

/**
 * Set up mockHttpsRequest to return a sequence of Graph API responses.
 * Each call to https.request gets the next response from the queue.
 */
function setupGraphResponses(responses: { status?: number; body: unknown }[]) {
  let callIdx = 0;
  mockHttpsRequest.mockImplementation((_options: unknown, callback: (res: EventEmitter & { statusCode: number }) => void) => {
    const resp = responses[callIdx++] ?? { status: 200, body: {} };
    const res = new EventEmitter() as EventEmitter & { statusCode: number };
    res.statusCode = resp.status ?? 200;

    // Simulate async response
    process.nextTick(() => {
      callback(res);
      res.emit('data', Buffer.from(JSON.stringify(resp.body)));
      res.emit('end');
    });

    // Return a writable request mock
    return {
      on: vi.fn(),
      write: vi.fn(),
      end: vi.fn(),
      setTimeout: vi.fn(),
      destroy: vi.fn(),
    };
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  clearListIdCache();

  // Default: MSAL returns a valid token
  mockAcquireTokenSilent.mockResolvedValue({ accessToken: 'fake-token' });
  mockGetAllAccounts.mockResolvedValue([{ username: 'test@outlook.com' }]);

  // Default: token cache file has a valid token
  mockReadJsonFile.mockImplementation((_path: string, defaultVal: unknown) => {
    if (typeof _path === 'string' && _path.includes('tokens')) {
      return Promise.resolve({
        accessToken: 'fake-token',
        expiresAt: new Date(Date.now() + 3600000).toISOString(),
        msalCache: '{}',
      });
    }
    if (typeof _path === 'string' && _path.includes('delta')) {
      return Promise.resolve({ deltaLinks: {}, lastSync: '' });
    }
    return Promise.resolve(defaultVal);
  });
});

// ────────────────────────────────────────────────────────────────────
// mapToRemote
// ────────────────────────────────────────────────────────────────────

describe('mapToRemote', () => {
  it('maps basic task fields', () => {
    const task = makeTask({ title: 'Buy groceries', status: 'todo', priority: 'none' });
    const remote = mapToRemote(task);

    expect(remote.title).toBe('Buy groceries');
    expect(remote.status).toBe('notStarted');
    expect(remote.importance).toBe('normal');
  });

  it('maps all status values', () => {
    const statuses: [TaskStatus, string][] = [
      ['todo', 'notStarted'],
      ['in_progress', 'inProgress'],
      ['done', 'completed'],
    ];
    for (const [local, expected] of statuses) {
      expect(mapToRemote(makeTask({ status: local })).status).toBe(expected);
    }
  });

  it('maps all priority values', () => {
    const priorities: [TaskPriority, string][] = [
      ['immediate', 'high'],
      ['backlog', 'low'],
      ['none', 'normal'],
    ];
    for (const [local, expected] of priorities) {
      expect(mapToRemote(makeTask({ priority: local })).importance).toBe(expected);
    }
  });

  it('includes body when task has description, summary, and note', () => {
    const remote = mapToRemote(makeTask({
      description: 'Task description',
      summary: 'Task summary',
      note: 'Important note',
    }));
    expect(remote.body).toEqual({
      content: 'Phase: TODO\n\nTask description\n\n---\n\n## Summary\nTask summary\n\n## Notes\nImportant note',
      contentType: 'text',
    });
  });

  it('includes body with only note', () => {
    const remote = mapToRemote(makeTask({ note: 'Just a note' }));
    expect(remote.body).toEqual({
      content: 'Phase: TODO\n\n## Notes\nJust a note',
      contentType: 'text',
    });
  });

  it('includes body with only description', () => {
    const remote = mapToRemote(makeTask({ description: 'Just a description' }));
    expect(remote.body).toEqual({
      content: 'Phase: TODO\n\nJust a description',
      contentType: 'text',
    });
  });

  it('includes Phase line in body even when description, summary, and note are empty', () => {
    const body = mapToRemote(makeTask({ description: '', summary: '', note: '' })).body;
    expect(body).toEqual({ content: 'Phase: TODO', contentType: 'text' });
  });

  it('includes Parent line in body when task has parent_task_id', () => {
    const body = mapToRemote(makeTask({
      parent_task_id: 'abcdef1234567890',
      description: 'Child task desc',
    })).body;
    expect(body).toEqual({
      content: 'Phase: TODO\nParent: abcdef12\n\nChild task desc',
      contentType: 'text',
    });
  });

  it('includes DependsOn line in body when task has depends_on', () => {
    const body = mapToRemote(makeTask({
      depends_on: ['aaaabbbbccccdddd', 'eeeeffff00001111'],
      description: 'Task with deps',
    })).body;
    expect(body).toEqual({
      content: 'Phase: TODO\nDependsOn: aaaabbbb,eeeeffff\n\nTask with deps',
      contentType: 'text',
    });
  });

  it('includes both Parent and DependsOn in body', () => {
    const body = mapToRemote(makeTask({
      parent_task_id: 'parent1234567890',
      depends_on: ['dep1abcd12345678'],
      description: 'Both fields',
    })).body;
    expect(body).toEqual({
      content: 'Phase: TODO\nParent: parent12\nDependsOn: dep1abcd\n\nBoth fields',
      contentType: 'text',
    });
  });

  it('includes dueDateTime when task has due_date', () => {
    const remote = mapToRemote(makeTask({ due_date: '2024-06-15' }));
    expect(remote.dueDateTime).toEqual({ dateTime: '2024-06-15T00:00:00.0000000', timeZone: 'UTC' });
  });

  it('omits dueDateTime when task has no due_date', () => {
    expect(mapToRemote(makeTask()).dueDateTime).toBeUndefined();
  });
});

// ────────────────────────────────────────────────────────────────────
// mapToLocal
// ────────────────────────────────────────────────────────────────────

describe('mapToLocal', () => {
  it('maps basic MS task fields to local format', () => {
    const local = mapToLocal(makeMsTask({ title: 'Remote Task', status: 'notStarted', importance: 'high' }), 'work');
    expect(local.title).toBe('Remote Task');
    expect(local.status).toBe('todo');
    expect(local.priority).toBe('immediate');
    const extData = local.ext?.['ms-todo'] as Record<string, unknown> | undefined;
    expect(extData?.id).toBe('ms-task-id');
    expect(local.category).toBe('Work');
    expect(local.project).toBe('Work');
  });

  it('parses category and project from list name with separator', () => {
    const local = mapToLocal(makeMsTask({ title: 'Task' }), 'Work / HomeLab');
    expect(local.category).toBe('Work');
    expect(local.project).toBe('HomeLab');
  });

  it('maps all MS status values to local', () => {
    const statuses: [string, TaskStatus][] = [
      ['notStarted', 'todo'],
      ['inProgress', 'in_progress'],
      ['completed', 'done'],
    ];
    for (const [msStatus, expected] of statuses) {
      expect(mapToLocal(makeMsTask({ status: msStatus }), 'personal').status).toBe(expected);
    }
  });

  it('maps all MS importance values to local priority', () => {
    const priorities: [string, TaskPriority][] = [
      ['high', 'immediate'],
      ['normal', 'none'],
      ['low', 'backlog'],
    ];
    for (const [msImportance, expected] of priorities) {
      expect(mapToLocal(makeMsTask({ importance: msImportance }), 'personal').priority).toBe(expected);
    }
  });

  it('extracts structured body into description, summary, and note', () => {
    const body = 'Task description\n\n---\n\n## Summary\nTask summary\n\n## Notes\nImportant note';
    const msTask = makeMsTask({ body: { content: body, contentType: 'text' } });
    const local = mapToLocal(msTask, 'personal');
    expect(local.description).toBe('Task description');
    expect(local.summary).toBe('Task summary');
    expect(local.note).toBe('Important note');
  });

  it('puts unstructured body content into note', () => {
    const msTask = makeMsTask({ body: { content: 'Line 1\nLine 2\n\nLine 3', contentType: 'text' } });
    const local = mapToLocal(msTask, 'personal');
    expect(local.description).toBe('');
    expect(local.summary).toBe('');
    expect(local.note).toBe('Line 1\nLine 2\n\nLine 3');
  });

  it('handles missing body', () => {
    const local = mapToLocal(makeMsTask(), 'personal');
    expect(local.description).toBeUndefined();
    expect(local.summary).toBeUndefined();
    expect(local.note).toBeUndefined();
  });

  it('extracts due date from dueDateTime', () => {
    const msTask = makeMsTask({ dueDateTime: { dateTime: '2024-06-15T00:00:00.0000000', timeZone: 'UTC' } });
    expect(mapToLocal(msTask, 'personal').due_date).toBe('2024-06-15');
  });

  it('handles missing dueDateTime', () => {
    expect(mapToLocal(makeMsTask(), 'personal').due_date).toBeUndefined();
  });
});

// ────────────────────────────────────────────────────────────────────
// parseMsTodoBody
// ────────────────────────────────────────────────────────────────────

describe('parseMsTodoBody', () => {
  it('parses structured body with separator, summary, and notes', () => {
    const body = 'Task description\n\n---\n\n## Summary\nTask summary\n\n## Notes\nImportant note';
    const result = parseMsTodoBody(body);
    expect(result.description).toBe('Task description');
    expect(result.summary).toBe('Task summary');
    expect(result.note).toBe('Important note');
  });

  it('parses body with sections but no separator (description empty)', () => {
    const body = '## Summary\nTask summary\n\n## Notes\nSome notes here';
    const result = parseMsTodoBody(body);
    expect(result.description).toBe('');
    expect(result.summary).toBe('Task summary');
    expect(result.note).toBe('Some notes here');
  });

  it('puts plain text into note field', () => {
    const body = 'Just some plain text\nwith multiple lines';
    const result = parseMsTodoBody(body);
    expect(result.description).toBe('');
    expect(result.summary).toBe('');
    expect(result.note).toBe('Just some plain text\nwith multiple lines');
  });

  it('returns all empty for empty string', () => {
    const result = parseMsTodoBody('');
    expect(result.description).toBe('');
    expect(result.summary).toBe('');
    expect(result.note).toBe('');
  });

  it('returns all empty for whitespace-only string', () => {
    const result = parseMsTodoBody('   \n  \n  ');
    expect(result.description).toBe('');
    expect(result.summary).toBe('');
    expect(result.note).toBe('');
  });

  it('parses body with description and only summary (no notes section)', () => {
    const body = 'Task description\n\n---\n\n## Summary\nJust a summary';
    const result = parseMsTodoBody(body);
    expect(result.description).toBe('Task description');
    expect(result.summary).toBe('Just a summary');
    expect(result.note).toBe('');
  });

  it('parses body with description and only notes (no summary section)', () => {
    const body = 'Task description\n\n---\n\n## Notes\nJust a note';
    const result = parseMsTodoBody(body);
    expect(result.description).toBe('Task description');
    expect(result.summary).toBe('');
    expect(result.note).toBe('Just a note');
  });

  it('extracts Parent: line from body header', () => {
    const body = 'Phase: IN_PROGRESS\nParent: abc12345\n\nTask description\n\n---\n\n## Summary\nSummary text';
    const result = parseMsTodoBody(body);
    expect(result.phase).toBe('IN_PROGRESS');
    expect(result.parent_task_id).toBe('abc12345');
    expect(result.description).toBe('Task description');
    expect(result.summary).toBe('Summary text');
  });

  it('extracts Parent: line without Phase: line', () => {
    const body = 'Parent: deadbeef\n\nSome description';
    const result = parseMsTodoBody(body);
    expect(result.parent_task_id).toBe('deadbeef');
    expect(result.phase).toBeUndefined();
    expect(result.description).toBe('');
    expect(result.note).toBe('Some description');
  });

  it('returns no parent_task_id when not present', () => {
    const body = 'Phase: TODO\n\nJust a task';
    const result = parseMsTodoBody(body);
    expect(result.parent_task_id).toBeUndefined();
  });

  it('extracts DependsOn: header with single dep ID', () => {
    const body = 'Phase: TODO\nDependsOn: abcd1234\n\nTask description';
    const result = parseMsTodoBody(body);
    expect(result.depends_on).toEqual(['abcd1234']);
    expect(result.description).toBe('');
    expect(result.note).toBe('Task description');
  });

  it('extracts DependsOn: header with multiple dep IDs', () => {
    const body = 'Phase: IN_PROGRESS\nParent: deadbeef\nDependsOn: abcd1234,efgh5678\n\nChild with deps';
    const result = parseMsTodoBody(body);
    expect(result.depends_on).toEqual(['abcd1234', 'efgh5678']);
    expect(result.parent_task_id).toBe('deadbeef');
    expect(result.phase).toBe('IN_PROGRESS');
    expect(result.note).toBe('Child with deps');
  });

  it('returns no depends_on when DependsOn header absent', () => {
    const body = 'Phase: TODO\n\nNo deps here';
    const result = parseMsTodoBody(body);
    expect(result.depends_on).toBeUndefined();
  });

  it('handles DependsOn with all other headers present', () => {
    const body = 'Phase: AGENT_COMPLETE\nParent: 12345678\nAttention: true\nDependsOn: aaa11111,bbb22222,ccc33333\n\nDescription text\n\n---\n\n## Summary\nSummary text';
    const result = parseMsTodoBody(body);
    expect(result.phase).toBe('AGENT_COMPLETE');
    expect(result.parent_task_id).toBe('12345678');
    expect(result.needs_attention).toBe(true);
    expect(result.depends_on).toEqual(['aaa11111', 'bbb22222', 'ccc33333']);
    expect(result.description).toBe('Description text');
    expect(result.summary).toBe('Summary text');
  });
});

// ────────────────────────────────────────────────────────────────────
// mapToRemote → mapToLocal roundtrip
// ────────────────────────────────────────────────────────────────────

describe('mapToRemote → mapToLocal roundtrip', () => {
  it('preserves core fields through roundtrip', () => {
    const original = makeTask({
      title: 'Roundtrip Task',
      status: 'in_progress',
      priority: 'immediate',
      description: 'Task description',
      summary: 'Task summary',
      note: 'Important note',
      due_date: '2024-12-25',
    });

    const remote = mapToRemote(original);
    const msTask = {
      id: 'ms-id',
      title: remote.title!,
      status: remote.status as 'notStarted' | 'inProgress' | 'completed',
      importance: remote.importance as 'high' | 'normal' | 'low',
      body: remote.body as { content: string; contentType: string } | undefined,
      dueDateTime: remote.dueDateTime as { dateTime: string; timeZone: string } | undefined,
      createdDateTime: '2024-01-01T00:00:00Z',
      lastModifiedDateTime: '2024-01-02T00:00:00Z',
    };

    const local = mapToLocal(msTask, 'personal');
    expect(local.title).toBe('Roundtrip Task');
    expect(local.status).toBe('in_progress');
    expect(local.priority).toBe('immediate');
    expect(local.description).toBe('Task description');
    expect(local.summary).toBe('Task summary');
    expect(local.note).toBe('Important note');
    expect(local.due_date).toBe('2024-12-25');
  });

  it('roundtrips depends_on through body headers', () => {
    const original = makeTask({
      title: 'Dep Roundtrip',
      depends_on: ['aaaabbbbccccdddd', 'eeeeffff00001111'],
      description: 'Description',
      summary: 'Summary',
      note: 'Note',
    });

    const remote = mapToRemote(original);
    const msTask = {
      id: 'ms-id',
      title: remote.title!,
      status: remote.status as 'notStarted' | 'inProgress' | 'completed',
      importance: remote.importance as 'high' | 'normal' | 'low',
      body: remote.body as { content: string; contentType: string } | undefined,
      createdDateTime: '2024-01-01T00:00:00Z',
      lastModifiedDateTime: '2024-01-02T00:00:00Z',
    };

    const local = mapToLocal(msTask, 'personal');
    // IDs are stored as 8-char prefixes in remote
    expect(local.depends_on).toEqual(['aaaabbbb', 'eeeeffff']);
    expect(local.description).toBe('Description');
    expect(local.summary).toBe('Summary');
    expect(local.note).toBe('Note');
  });

  it('roundtrips with only note field populated', () => {
    const original = makeTask({
      title: 'Note Only',
      note: 'Just a note',
    });

    const remote = mapToRemote(original);
    const msTask = {
      id: 'ms-id',
      title: remote.title!,
      status: remote.status as 'notStarted' | 'inProgress' | 'completed',
      importance: remote.importance as 'high' | 'normal' | 'low',
      body: remote.body as { content: string; contentType: string } | undefined,
      createdDateTime: '2024-01-01T00:00:00Z',
      lastModifiedDateTime: '2024-01-02T00:00:00Z',
    };

    const local = mapToLocal(msTask, 'personal');
    expect(local.note).toBe('Just a note');
    expect(local.description).toBe('');
    expect(local.summary).toBe('');
  });
});

// ────────────────────────────────────────────────────────────────────
// pushTask (HTTP-layer)
// ────────────────────────────────────────────────────────────────────

describe('pushTask', () => {
  it('creates a new task via POST when ms_todo_id is absent', async () => {
    // Response 1: fetchTaskLists (for resolveListId — name matches category)
    // Response 2: POST create task
    setupGraphResponses([
      { body: { value: [{ id: 'list-1', displayName: 'personal' }] } },
      { body: { id: 'new-ms-id', title: 'Test Task', status: 'notStarted', importance: 'normal' } },
    ]);

    const task = makeTask({ title: 'New Task', category: 'personal' });
    const msId = await pushTask(task);

    expect(msId).toBe('new-ms-id');
    // Verify 2 HTTP calls were made
    expect(mockHttpsRequest).toHaveBeenCalledTimes(2);

    // Second call should be POST
    const secondCallOptions = mockHttpsRequest.mock.calls[1][0];
    expect(secondCallOptions.method).toBe('POST');
    expect(secondCallOptions.path).toContain('/me/todo/lists/list-1/tasks');
  });

  it('updates an existing task via PATCH when ms_todo_id is present', async () => {
    // Response 1: fetchTaskLists (for resolveListId — name matches category)
    // Response 2: PATCH update task
    setupGraphResponses([
      { body: { value: [{ id: 'list-1', displayName: 'personal' }] } },
      { body: { id: 'existing-ms-id', title: 'Updated Task' } },
    ]);

    const task = makeTask({ ms_todo_id: 'existing-ms-id', ms_todo_list: 'list-1', category: 'personal' });
    const msId = await pushTask(task);

    expect(msId).toBe('existing-ms-id');
    const secondCallOptions = mockHttpsRequest.mock.calls[1][0];
    expect(secondCallOptions.method).toBe('PATCH');
    expect(secondCallOptions.path).toContain('existing-ms-id');
  });

  it('sends correct body with mapped fields', async () => {
    setupGraphResponses([
      { body: { value: [{ id: 'list-1', displayName: 'personal' }] } },
      { body: { id: 'new-id' } },
    ]);

    const task = makeTask({
      title: 'Immediate Priority',
      priority: 'immediate',
      status: 'in_progress',
      description: 'Task desc',
      note: 'Note A',
      due_date: '2025-03-01',
    });
    await pushTask(task);

    // Verify the request body was written
    const reqMock = mockHttpsRequest.mock.results[1].value;
    const writtenBody = JSON.parse(reqMock.write.mock.calls[0][0]);
    expect(writtenBody.title).toBe('Immediate Priority');
    expect(writtenBody.status).toBe('inProgress');
    expect(writtenBody.importance).toBe('high');
    expect(writtenBody.body).toEqual({ content: 'Phase: IN_PROGRESS\n\nTask desc\n\n---\n\n## Notes\nNote A', contentType: 'text' });
    expect(writtenBody.dueDateTime.dateTime).toBe('2025-03-01T00:00:00.0000000');
  });

  it('sends DependsOn header in body when task has depends_on', async () => {
    setupGraphResponses([
      { body: { value: [{ id: 'list-1', displayName: 'personal' }] } },
      { body: { id: 'new-dep-id' } },
    ]);

    const task = makeTask({
      title: 'Task With Deps',
      depends_on: ['dep1aaaabbbbcccc', 'dep2ddddeeeeffff'],
      description: 'Has dependencies',
    });
    await pushTask(task);

    const reqMock = mockHttpsRequest.mock.results[1].value;
    const writtenBody = JSON.parse(reqMock.write.mock.calls[0][0]);
    expect(writtenBody.body.content).toContain('DependsOn: dep1aaaa,dep2dddd');
    expect(writtenBody.body.content).toContain('Has dependencies');
  });

  it('moves task to new list when category changed (delete old + create new)', async () => {
    setupGraphResponses([
      // resolveListId → fetchTaskLists (finds new list)
      { body: { value: [{ id: 'old-list', displayName: 'Work Idea' }, { id: 'new-list', displayName: 'idea / work idea' }] } },
      // DELETE from old list
      { body: {} },
      // POST create in new list
      { body: { id: 'new-ms-id', title: 'Moved Task' } },
    ]);

    const task = makeTask({
      ms_todo_id: 'old-ms-id',
      ms_todo_list: 'old-list',
      category: 'idea',
      project: 'work idea',  // buildListName → "idea / work idea"
    });
    const msId = await pushTask(task);

    expect(msId).toBe('new-ms-id');
    // Task object should be updated with new IDs via ext
    expect(getMsExt(task).id).toBe('new-ms-id');
    expect(getMsExt(task).list_id).toBe('new-list');

    // 3 HTTP calls: fetchTaskLists + DELETE old + POST new
    expect(mockHttpsRequest).toHaveBeenCalledTimes(3);
    expect(mockHttpsRequest.mock.calls[1][0].method).toBe('DELETE');
    expect(mockHttpsRequest.mock.calls[1][0].path).toContain('old-list');
    expect(mockHttpsRequest.mock.calls[2][0].method).toBe('POST');
    expect(mockHttpsRequest.mock.calls[2][0].path).toContain('new-list');
  });
});

// ────────────────────────────────────────────────────────────────────
// pullTasks (HTTP-layer)
// ────────────────────────────────────────────────────────────────────

describe('pullTasks', () => {
  it('fetches tasks from a list using delta endpoint', async () => {
    const msTask1 = makeMsTask({ id: 'ms-1', title: 'Remote Task 1' });
    const msTask2 = makeMsTask({ id: 'ms-2', title: 'Remote Task 2' });

    setupGraphResponses([
      {
        body: {
          value: [msTask1, msTask2],
          '@odata.deltaLink': 'https://graph.microsoft.com/delta?token=abc',
        },
      },
    ]);

    const result = await pullTasks('list-1');

    expect(result.tasks).toHaveLength(2);
    expect(result.tasks[0].id).toBe('ms-1');
    expect(result.tasks[1].id).toBe('ms-2');
    expect(result.deltaLink).toBe('https://graph.microsoft.com/delta?token=abc');
  });

  it('follows pagination via @odata.nextLink', async () => {
    setupGraphResponses([
      {
        body: {
          value: [makeMsTask({ id: 'ms-1' })],
          '@odata.nextLink': 'https://graph.microsoft.com/next-page',
        },
      },
      {
        body: {
          value: [makeMsTask({ id: 'ms-2' })],
          '@odata.deltaLink': 'https://graph.microsoft.com/delta?token=def',
        },
      },
    ]);

    const result = await pullTasks('list-1');

    expect(result.tasks).toHaveLength(2);
    expect(result.tasks[0].id).toBe('ms-1');
    expect(result.tasks[1].id).toBe('ms-2');
    // 2 HTTP calls: initial + next page
    expect(mockHttpsRequest).toHaveBeenCalledTimes(2);
  });

  it('saves the delta link to file', async () => {
    setupGraphResponses([
      {
        body: {
          value: [],
          '@odata.deltaLink': 'https://graph.microsoft.com/delta?token=saved',
        },
      },
    ]);

    await pullTasks('list-42');

    expect(mockWriteJsonFile).toHaveBeenCalledWith(
      expect.stringContaining('ms-todo-delta'),
      expect.objectContaining({
        deltaLinks: { 'list-42': 'https://graph.microsoft.com/delta?token=saved' },
      }),
    );
  });

  it('uses existing delta link if available', async () => {
    mockReadJsonFile.mockImplementation((_path: string, defaultVal: unknown) => {
      if (typeof _path === 'string' && _path.includes('delta')) {
        return Promise.resolve({
          deltaLinks: { 'list-1': 'https://graph.microsoft.com/delta?token=existing' },
          lastSync: '2024-01-01T00:00:00Z',
        });
      }
      if (typeof _path === 'string' && _path.includes('tokens')) {
        return Promise.resolve({
          accessToken: 'fake-token',
          expiresAt: new Date(Date.now() + 3600000).toISOString(),
          msalCache: '{}',
        });
      }
      return Promise.resolve(defaultVal);
    });

    setupGraphResponses([
      { body: { value: [], '@odata.deltaLink': 'https://graph.microsoft.com/delta?token=new' } },
    ]);

    await pullTasks('list-1');

    // Verify the request used the existing delta link (full URL, not relative path)
    const callOptions = mockHttpsRequest.mock.calls[0][0];
    expect(callOptions.hostname).toBe('graph.microsoft.com');
    expect(callOptions.path).toContain('token=existing');
  });
});

// ────────────────────────────────────────────────────────────────────
// autoPushTask
// ────────────────────────────────────────────────────────────────────

describe('autoPushTask', () => {
  it('returns ms_todo_id on success', async () => {
    setupGraphResponses([
      { body: { value: [{ id: 'list-1', displayName: 'personal' }] } },
      { body: { id: 'push-result-id' } },
    ]);

    const result = await autoPushTask(makeTask());
    expect(result).toBe('push-result-id');
  });

  it('returns null on failure instead of throwing', async () => {
    // Make getAccessToken fail
    mockAcquireTokenSilent.mockRejectedValueOnce(new Error('token expired'));
    mockGetAllAccounts.mockResolvedValueOnce([{ username: 'test@outlook.com' }]);
    mockReadJsonFile.mockImplementation((_path: string, defaultVal: unknown) => {
      if (typeof _path === 'string' && _path.includes('tokens')) {
        return Promise.resolve({
          accessToken: 'expired',
          expiresAt: '2020-01-01T00:00:00Z', // expired
          msalCache: '{}',
        });
      }
      return Promise.resolve(defaultVal);
    });

    const result = await autoPushTask(makeTask());
    expect(result).toBeNull();
  });
});

// ────────────────────────────────────────────────────────────────────
// syncTasks (full bidirectional sync)
// ────────────────────────────────────────────────────────────────────

describe('syncTasks', () => {
  it('pushes local tasks without ms_todo_id', async () => {
    const updateLocal = vi.fn();
    const addLocal = vi.fn();

    // Calls: getAccessToken → fetchTaskLists → resolveListId(fetchTaskLists) → POST push → pullTasks(delta)
    setupGraphResponses([
      // fetchTaskLists (from syncTasks)
      { body: { value: [{ id: 'list-1', displayName: 'personal' }] } },
      // resolveListId → fetchTaskLists (from pushTask)
      { body: { value: [{ id: 'list-1', displayName: 'personal' }] } },
      // POST create task
      { body: { id: 'new-ms-id', title: 'Local Task' } },
      // pullTasks for list-1
      { body: { value: [], '@odata.deltaLink': 'https://graph.microsoft.com/delta?t=1' } },
    ]);

    const localTasks = [makeTask({ id: 'local-1', title: 'Local Task' })];
    const result = await syncTasks(localTasks, updateLocal, addLocal);

    expect(result.pushed).toBe(1);
    expect(updateLocal).toHaveBeenCalledWith('local-1', expect.objectContaining({
      ext: expect.objectContaining({ 'ms-todo': expect.objectContaining({ list_id: 'list-1' }) }),
    }));
  });

  it('pulls remote tasks not in local store', async () => {
    const updateLocal = vi.fn();
    const addLocal = vi.fn().mockResolvedValue(makeTask({ id: 'new-local', ms_todo_id: 'ms-remote-1' }));

    setupGraphResponses([
      // fetchTaskLists
      { body: { value: [{ id: 'list-1', displayName: 'Personal' }] } },
      // pullTasks for list-1
      {
        body: {
          value: [makeMsTask({ id: 'ms-remote-1', title: 'From To-Do' })],
          '@odata.deltaLink': 'https://graph.microsoft.com/delta?t=2',
        },
      },
    ]);

    const result = await syncTasks([], updateLocal, addLocal);

    expect(result.pulled).toBe(1);
    expect(addLocal).toHaveBeenCalledWith(expect.objectContaining({
      title: 'From To-Do',
      ext: expect.objectContaining({ 'ms-todo': expect.objectContaining({ id: 'ms-remote-1' }) }),
    }));
  });

  it('updates local task when remote is newer (remote wins)', async () => {
    const updateLocal = vi.fn();
    const addLocal = vi.fn();

    const localTask = makeTask({
      id: 'local-1',
      ms_todo_id: 'ms-existing',
      title: 'Old Title',
      updated_at: '2024-01-01T00:00:00Z',
    });

    setupGraphResponses([
      // fetchTaskLists
      { body: { value: [{ id: 'list-1', displayName: 'Tasks' }] } },
      // pullTasks — remote has newer timestamp
      {
        body: {
          value: [makeMsTask({
            id: 'ms-existing',
            title: 'Updated Title',
            lastModifiedDateTime: '2024-06-01T00:00:00Z',
          })],
          '@odata.deltaLink': 'https://graph.microsoft.com/delta?t=3',
        },
      },
    ]);

    const result = await syncTasks([localTask], updateLocal, addLocal);

    expect(result.pulled).toBe(1);
    expect(updateLocal).toHaveBeenCalledWith('local-1', expect.objectContaining({
      title: 'Updated Title',
    }));
  });

  it('does not update local task when local is newer', async () => {
    const updateLocal = vi.fn();
    const addLocal = vi.fn();

    const localTask = makeTask({
      id: 'local-1',
      ms_todo_id: 'ms-existing',
      title: 'Local Title',
      category: 'Tasks',
      project: 'Tasks',
      updated_at: '2024-12-01T00:00:00Z', // newer than remote
    });

    setupGraphResponses([
      { body: { value: [{ id: 'list-1', displayName: 'Tasks' }] } },
      {
        body: {
          value: [makeMsTask({
            id: 'ms-existing',
            title: 'Remote Title',
            lastModifiedDateTime: '2024-01-01T00:00:00Z', // older than local
          })],
          '@odata.deltaLink': 'https://graph.microsoft.com/delta?t=4',
        },
      },
    ]);

    const result = await syncTasks([localTask], updateLocal, addLocal);

    expect(result.pulled).toBe(0);
    expect(updateLocal).not.toHaveBeenCalled();
  });

  it('reports errors without throwing', async () => {
    const updateLocal = vi.fn();
    const addLocal = vi.fn();

    // Make fetchTaskLists succeed but pushTask fail with a 500 error
    setupGraphResponses([
      { body: { value: [{ id: 'list-1', displayName: 'Tasks' }] } },
      // resolveListId for push
      { body: { value: [{ id: 'list-1', displayName: 'Tasks' }] } },
      // POST fails
      { status: 500, body: { error: { message: 'Internal Server Error' } } },
    ]);

    const localTasks = [makeTask({ id: 'local-1', title: 'Failing Task' })];
    const result = await syncTasks(localTasks, updateLocal, addLocal);

    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0]).toContain('Failing Task');
  });
});

// ────────────────────────────────────────────────────────────────────
// deltaPull (TUI polling)
// ────────────────────────────────────────────────────────────────────

describe('deltaPull', () => {
  it('returns true when new remote tasks are found', async () => {
    const updateLocal = vi.fn();
    const addLocal = vi.fn().mockResolvedValue(makeTask({ id: 'new-local' }));

    setupGraphResponses([
      // fetchTaskLists
      { body: { value: [{ id: 'list-1', displayName: 'Personal' }] } },
      // pullTasks
      {
        body: {
          value: [makeMsTask({ id: 'ms-new', title: 'New Remote Task' })],
          '@odata.deltaLink': 'https://graph.microsoft.com/delta?t=5',
        },
      },
    ]);

    const hasChanges = await deltaPull([], updateLocal, addLocal);

    expect(hasChanges).toBe(true);
    expect(addLocal).toHaveBeenCalledWith(expect.objectContaining({
      title: 'New Remote Task',
      ext: expect.objectContaining({ 'ms-todo': expect.objectContaining({ id: 'ms-new' }) }),
    }));
  });

  it('returns true when existing task is updated from remote', async () => {
    const updateLocal = vi.fn();
    const addLocal = vi.fn();

    const localTask = makeTask({
      id: 'local-1',
      ms_todo_id: 'ms-existing',
      updated_at: '2024-01-01T00:00:00Z',
    });

    setupGraphResponses([
      { body: { value: [{ id: 'list-1', displayName: 'Tasks' }] } },
      {
        body: {
          value: [makeMsTask({
            id: 'ms-existing',
            title: 'Updated by remote',
            lastModifiedDateTime: '2024-06-01T00:00:00Z',
          })],
          '@odata.deltaLink': 'https://graph.microsoft.com/delta?t=6',
        },
      },
    ]);

    const hasChanges = await deltaPull([localTask], updateLocal, addLocal);

    expect(hasChanges).toBe(true);
    expect(updateLocal).toHaveBeenCalledWith('local-1', expect.objectContaining({
      title: 'Updated by remote',
    }));
  });

  it('returns false when no changes', async () => {
    const updateLocal = vi.fn();
    const addLocal = vi.fn();

    setupGraphResponses([
      { body: { value: [{ id: 'list-1', displayName: 'Tasks' }] } },
      { body: { value: [], '@odata.deltaLink': 'https://graph.microsoft.com/delta?t=7' } },
    ]);

    const hasChanges = await deltaPull([], updateLocal, addLocal);
    expect(hasChanges).toBe(false);
  });

  it('skips update when local is newer', async () => {
    const updateLocal = vi.fn();
    const addLocal = vi.fn();

    const localTask = makeTask({
      id: 'local-1',
      ms_todo_id: 'ms-existing',
      category: 'Tasks',
      project: 'Tasks',
      updated_at: '2025-01-01T00:00:00Z', // very recent
    });

    setupGraphResponses([
      { body: { value: [{ id: 'list-1', displayName: 'Tasks' }] } },
      {
        body: {
          value: [makeMsTask({
            id: 'ms-existing',
            lastModifiedDateTime: '2024-01-01T00:00:00Z', // older
          })],
          '@odata.deltaLink': 'https://graph.microsoft.com/delta?t=8',
        },
      },
    ]);

    const hasChanges = await deltaPull([localTask], updateLocal, addLocal);
    expect(hasChanges).toBe(false);
    expect(updateLocal).not.toHaveBeenCalled();
  });
});

// ────────────────────────────────────────────────────────────────────
// getMsTodoSyncStatus
// ────────────────────────────────────────────────────────────────────

describe('getMsTodoSyncStatus', () => {
  it('returns configured + authenticated when token available', async () => {
    const status = await getMsTodoSyncStatus();

    expect(status.configured).toBe(true);
    expect(status.authenticated).toBe(true);
  });

  it('returns not authenticated when token acquisition fails', async () => {
    mockAcquireTokenSilent.mockRejectedValueOnce(new Error('no token'));
    mockReadJsonFile.mockImplementation((_path: string, defaultVal: unknown) => {
      if (typeof _path === 'string' && _path.includes('tokens')) {
        return Promise.resolve({
          accessToken: 'expired',
          expiresAt: '2020-01-01T00:00:00Z', // expired
          msalCache: '{}',
        });
      }
      if (typeof _path === 'string' && _path.includes('delta')) {
        return Promise.resolve({ deltaLinks: {}, lastSync: '' });
      }
      return Promise.resolve(defaultVal);
    });

    const status = await getMsTodoSyncStatus();

    expect(status.configured).toBe(true);
    expect(status.authenticated).toBe(false);
  });

  it('reports lastSync and deltaLinksCount from delta file', async () => {

    mockReadJsonFile.mockImplementation((_path: string, defaultVal: unknown) => {
      if (typeof _path === 'string' && _path.includes('delta')) {
        return Promise.resolve({
          deltaLinks: { 'list-1': 'link1', 'list-2': 'link2' },
          lastSync: '2024-06-15T12:00:00Z',
        });
      }
      if (typeof _path === 'string' && _path.includes('tokens')) {
        return Promise.resolve({
          accessToken: 'fake-token',
          expiresAt: new Date(Date.now() + 3600000).toISOString(),
          msalCache: '{}',
        });
      }
      return Promise.resolve(defaultVal);
    });

    const status = await getMsTodoSyncStatus();

    expect(status.lastSync).toBe('2024-06-15T12:00:00Z');
    expect(status.deltaLinksCount).toBe(2);
  });
});

// ────────────────────────────────────────────────────────────────────
// Checklist items (subtask sync)
// ────────────────────────────────────────────────────────────────────

describe('fetchChecklistItems', () => {
  it('fetches checklist items for a task', async () => {
    setupGraphResponses([
      {
        body: {
          value: [
            { id: 'cl-1', displayName: 'Step 1', isChecked: false },
            { id: 'cl-2', displayName: 'Step 2', isChecked: true },
          ],
        },
      },
    ]);

    const items = await fetchChecklistItems('fake-token', 'list-1', 'task-1');
    expect(items).toHaveLength(2);
    expect(items[0].displayName).toBe('Step 1');
    expect(items[1].isChecked).toBe(true);
  });
});

describe('pushChecklistItem', () => {
  it('creates a new checklist item via POST when no id', async () => {
    setupGraphResponses([
      { body: { id: 'new-cl-id', displayName: 'New step', isChecked: false } },
    ]);

    const id = await pushChecklistItem('fake-token', 'list-1', 'task-1', {
      displayName: 'New step',
      isChecked: false,
    });

    expect(id).toBe('new-cl-id');
    const callOptions = mockHttpsRequest.mock.calls[0][0];
    expect(callOptions.method).toBe('POST');
    expect(callOptions.path).toContain('checklistItems');
  });

  it('updates existing checklist item via PATCH when id provided', async () => {
    setupGraphResponses([
      { body: { id: 'existing-cl', displayName: 'Updated step', isChecked: true } },
    ]);

    const id = await pushChecklistItem('fake-token', 'list-1', 'task-1', {
      displayName: 'Updated step',
      isChecked: true,
      id: 'existing-cl',
    });

    expect(id).toBe('existing-cl');
    const callOptions = mockHttpsRequest.mock.calls[0][0];
    expect(callOptions.method).toBe('PATCH');
    expect(callOptions.path).toContain('existing-cl');
  });
});

describe('deleteChecklistItem', () => {
  it('sends DELETE request', async () => {
    setupGraphResponses([{ body: {} }]);

    await deleteChecklistItem('fake-token', 'list-1', 'task-1', 'cl-to-delete');

    const callOptions = mockHttpsRequest.mock.calls[0][0];
    expect(callOptions.method).toBe('DELETE');
    expect(callOptions.path).toContain('cl-to-delete');
  });
});

// ────────────────────────────────────────────────────────────────────
// List CRUD
// ────────────────────────────────────────────────────────────────────

describe('createList', () => {
  it('creates a new list via POST', async () => {
    setupGraphResponses([
      { body: { id: 'new-list-id', displayName: 'Work / NewProject' } },
    ]);

    const list = await createList('Work / NewProject');

    expect(list.id).toBe('new-list-id');
    expect(list.displayName).toBe('Work / NewProject');
    const callOptions = mockHttpsRequest.mock.calls[0][0];
    expect(callOptions.method).toBe('POST');
    expect(callOptions.path).toContain('/me/todo/lists');
  });
});

describe('renameList', () => {
  it('renames a list via PATCH', async () => {
    setupGraphResponses([
      { body: { id: 'list-1', displayName: 'Work / Renamed' } },
    ]);

    const list = await renameList('list-1', 'Work / Renamed');

    expect(list.displayName).toBe('Work / Renamed');
    const callOptions = mockHttpsRequest.mock.calls[0][0];
    expect(callOptions.method).toBe('PATCH');
    expect(callOptions.path).toContain('list-1');
  });
});

describe('deleteList', () => {
  it('deletes a list via DELETE', async () => {
    setupGraphResponses([{ body: {} }]);

    await deleteList('list-to-delete');

    const callOptions = mockHttpsRequest.mock.calls[0][0];
    expect(callOptions.method).toBe('DELETE');
    expect(callOptions.path).toContain('list-to-delete');
  });
});

// Subtask checklist sync removed — subtasks are now child tasks

// ────────────────────────────────────────────────────────────────────
// Concurrent list resolution (dedup / mutex)
// ────────────────────────────────────────────────────────────────────

describe('concurrent resolveListId dedup', () => {
  it('creates only one list when 4 tasks push to a new project concurrently', async () => {
    // Track how many POST list-creation calls are made
    let listCreateCount = 0;
    let taskCreateCount = 0;

    const createdListId = 'deduped-list-id';

    mockHttpsRequest.mockImplementation((options: { method: string; path: string }, callback: (res: EventEmitter & { statusCode: number }) => void) => {
      const res = new EventEmitter() as EventEmitter & { statusCode: number };
      res.statusCode = 200;

      let responseBody: unknown;
      const p = options.path; // e.g. /v1.0/me/todo/lists or /v1.0/me/todo/lists/{id}/tasks

      if (options.method === 'GET' && p.includes('/me/todo/lists')) {
        // fetchTaskLists — return empty to force creation
        responseBody = { value: [] };
      } else if (options.method === 'POST' && p.includes('/me/todo/lists') && !p.includes('/tasks')) {
        // createList (POST to /me/todo/lists without /tasks suffix)
        listCreateCount++;
        responseBody = { id: createdListId, displayName: 'Personal / Walnut-Idea' };
      } else if (options.method === 'POST' && p.includes('/tasks')) {
        // createTask in the list
        taskCreateCount++;
        responseBody = { id: `ms-task-${taskCreateCount}`, title: 'Task' };
      } else {
        responseBody = {};
      }

      process.nextTick(() => {
        callback(res);
        res.emit('data', Buffer.from(JSON.stringify(responseBody)));
        res.emit('end');
      });

      return {
        on: vi.fn(),
        write: vi.fn(),
        end: vi.fn(),
        setTimeout: vi.fn(),
        destroy: vi.fn(),
      };
    });

    // Simulate 4 concurrent pushTask calls for a new project
    const tasks = Array.from({ length: 4 }, (_, i) =>
      makeTask({
        id: `task-${i}`,
        title: `Task ${i}`,
        category: 'Personal',
        project: 'Walnut-Idea',
      }),
    );

    const results = await Promise.all(tasks.map((t) => pushTask(t)));

    // All 4 should succeed with an ms_todo_id
    expect(results).toHaveLength(4);
    results.forEach((r) => expect(r).toBeTruthy());

    // The key assertion: only 1 list creation, not 4
    expect(listCreateCount).toBe(1);
    // All 4 tasks should have been created
    expect(taskCreateCount).toBe(4);
  });

  it('caches resolved list ID for subsequent calls', async () => {
    let fetchListsCount = 0;

    mockHttpsRequest.mockImplementation((options: { method: string; path: string }, callback: (res: EventEmitter & { statusCode: number }) => void) => {
      const res = new EventEmitter() as EventEmitter & { statusCode: number };
      res.statusCode = 200;

      let responseBody: unknown;
      const p = options.path;

      if (options.method === 'GET' && p.includes('/me/todo/lists')) {
        fetchListsCount++;
        responseBody = { value: [{ id: 'cached-list-id', displayName: 'Personal / Walnut-Idea' }] };
      } else if (options.method === 'POST') {
        responseBody = { id: 'ms-task-new', title: 'Task' };
      } else {
        responseBody = {};
      }

      process.nextTick(() => {
        callback(res);
        res.emit('data', Buffer.from(JSON.stringify(responseBody)));
        res.emit('end');
      });

      return {
        on: vi.fn(),
        write: vi.fn(),
        end: vi.fn(),
        setTimeout: vi.fn(),
        destroy: vi.fn(),
      };
    });

    // First push: resolves list (hits API)
    const task1 = makeTask({ id: 'task-1', category: 'Personal', project: 'Walnut-Idea' });
    await pushTask(task1);

    // Second push: should use cache (no extra fetchTaskLists)
    const task2 = makeTask({ id: 'task-2', category: 'Personal', project: 'Walnut-Idea' });
    await pushTask(task2);

    // Only 1 fetchTaskLists call, not 2
    expect(fetchListsCount).toBe(1);
  });

  it('different list names resolve independently', async () => {
    let createCount = 0;

    mockHttpsRequest.mockImplementation((options: { method: string; path: string }, callback: (res: EventEmitter & { statusCode: number }) => void) => {
      const res = new EventEmitter() as EventEmitter & { statusCode: number };
      res.statusCode = 200;

      let responseBody: unknown;
      const p = options.path;

      if (options.method === 'GET' && p.includes('/me/todo/lists')) {
        // No existing lists — both names need creation
        responseBody = { value: [] };
      } else if (options.method === 'POST' && p.includes('/me/todo/lists') && !p.includes('/tasks')) {
        createCount++;
        responseBody = { id: `list-${createCount}`, displayName: `List ${createCount}` };
      } else if (options.method === 'POST' && p.includes('/tasks')) {
        responseBody = { id: `ms-task-${createCount}`, title: 'Task' };
      } else {
        responseBody = {};
      }

      process.nextTick(() => {
        callback(res);
        res.emit('data', Buffer.from(JSON.stringify(responseBody)));
        res.emit('end');
      });

      return {
        on: vi.fn(),
        write: vi.fn(),
        end: vi.fn(),
        setTimeout: vi.fn(),
        destroy: vi.fn(),
      };
    });

    // Two different projects — should create 2 lists
    const taskA = makeTask({ id: 'a', category: 'Personal', project: 'ProjectA' });
    const taskB = makeTask({ id: 'b', category: 'Personal', project: 'ProjectB' });

    await Promise.all([pushTask(taskA), pushTask(taskB)]);

    expect(createCount).toBe(2);
  });

  it('retries after a failed resolution (inflight cleaned up on error)', async () => {
    let callCount = 0;

    mockHttpsRequest.mockImplementation((options: { method: string; path: string }, callback: (res: EventEmitter & { statusCode: number }) => void) => {
      callCount++;
      const res = new EventEmitter() as EventEmitter & { statusCode: number };

      let responseBody: unknown;
      const p = options.path;

      if (options.method === 'GET' && p.includes('/me/todo/lists')) {
        if (callCount === 1) {
          // First call: simulate network error (500)
          res.statusCode = 500;
          responseBody = { error: { message: 'Internal Server Error' } };
        } else {
          // Subsequent calls: succeed
          res.statusCode = 200;
          responseBody = { value: [{ id: 'recovered-list', displayName: 'Personal / Walnut-Idea' }] };
        }
      } else if (options.method === 'POST' && p.includes('/tasks')) {
        res.statusCode = 200;
        responseBody = { id: 'ms-task-recovered', title: 'Task' };
      } else {
        res.statusCode = 200;
        responseBody = {};
      }

      process.nextTick(() => {
        callback(res);
        res.emit('data', Buffer.from(JSON.stringify(responseBody)));
        res.emit('end');
      });

      return {
        on: vi.fn(),
        write: vi.fn(),
        end: vi.fn(),
        setTimeout: vi.fn(),
        destroy: vi.fn(),
      };
    });

    const task1 = makeTask({ id: 'task-err', category: 'Personal', project: 'Walnut-Idea' });

    // First attempt should fail (500 from fetchTaskLists)
    await expect(pushTask(task1)).rejects.toThrow();

    // Second attempt should succeed — inflight was cleaned up, retries fresh
    const task2 = makeTask({ id: 'task-ok', category: 'Personal', project: 'Walnut-Idea' });
    const result = await pushTask(task2);

    expect(result).toBe('ms-task-recovered');
  });

  it('invalidates cache after renameList', async () => {
    let fetchListsCount = 0;

    mockHttpsRequest.mockImplementation((options: { method: string; path: string }, callback: (res: EventEmitter & { statusCode: number }) => void) => {
      const res = new EventEmitter() as EventEmitter & { statusCode: number };
      res.statusCode = 200;

      let responseBody: unknown;
      const p = options.path;

      if (options.method === 'GET' && p.includes('/me/todo/lists')) {
        fetchListsCount++;
        responseBody = { value: [{ id: 'list-orig', displayName: 'Personal / Walnut-Idea' }] };
      } else if (options.method === 'PATCH' && p.includes('/me/todo/lists')) {
        responseBody = { id: 'list-orig', displayName: 'Personal / Walnut-Renamed' };
      } else if (options.method === 'POST') {
        responseBody = { id: 'ms-task-new', title: 'Task' };
      } else {
        responseBody = {};
      }

      process.nextTick(() => {
        callback(res);
        res.emit('data', Buffer.from(JSON.stringify(responseBody)));
        res.emit('end');
      });

      return {
        on: vi.fn(),
        write: vi.fn(),
        end: vi.fn(),
        setTimeout: vi.fn(),
        destroy: vi.fn(),
      };
    });

    // First push: populates cache
    const task1 = makeTask({ id: 'task-1', category: 'Personal', project: 'Walnut-Idea' });
    await pushTask(task1);
    expect(fetchListsCount).toBe(1);

    // Rename: should invalidate cache
    await renameList('list-orig', 'Personal / Walnut-Renamed');

    // Second push: should re-fetch lists (cache was invalidated)
    const task2 = makeTask({ id: 'task-2', category: 'Personal', project: 'Walnut-Idea' });
    await pushTask(task2);
    expect(fetchListsCount).toBe(2);
  });
});
