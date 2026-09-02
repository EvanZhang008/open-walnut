import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import { EventEmitter } from 'node:events';
import type { Task, TaskPriority, TaskStatus } from '../../src/core/types.js';
import { PHASE_ORDER } from '../../src/core/phase.js';
import { PHASE_TO_MS_STATUS, phaseToMsStatus } from '../../src/integrations/ms-todo/phase.js';

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
    defaults: { priority: 'none', project: 'personal' },
    provider: { type: 'claude-code' },
    plugins: { 'ms-todo': { client_id: 'test-client-id', list_mapping: {} } },
  }),
}));

const mockReadJsonFile = vi.fn();
const mockWriteJsonFile = vi.fn().mockResolvedValue(undefined);
// Mirror ALL of src/utils/fs.ts — a partial factory throws
// 'No "<export>" export is defined on the mock' the moment src reaches the
// missing one (ensureDir, via initDirectories, was that case).
vi.mock('../../src/utils/fs.js', () => ({
  readJsonFile: (...args: unknown[]) => mockReadJsonFile(...args),
  writeJsonFile: (...args: unknown[]) => mockWriteJsonFile(...args),
  ensureDir: vi.fn().mockResolvedValue(undefined),
}));

// Task-store reads are the boundary of this unit, on two axes:
//  1. reconcilePulledTasks resolves locals through the SQLite-indexed
//     findTaskByExtId (it replaced a caller-built localByMsId Map), so tasks
//     handed to syncTasks/deltaPull are only findable if seeded here.
//  2. The project registry is now what decides the remote list name (the
//     `remote_list` alias) and who owns a project. `fakeRegistry` below is a
//     faithful in-memory stand-in (NOCASE identity, first-writer-wins metadata
//     merge) so the alias model is genuinely exercised rather than stubbed flat.
const mockFindTaskByExtId = vi.fn();

interface FakeProjectRow { name: string; source: string; metadata: Record<string, unknown> }
/** lower(name) → row. Mirrors task_projects' NOCASE primary key. */
const fakeRegistry = new Map<string, FakeProjectRow>();

function registrySeed(name: string, source = 'ms-todo', metadata: Record<string, unknown> = {}): void {
  fakeRegistry.set(name.toLowerCase(), { name, source, metadata });
}
function registryGet(name: string): FakeProjectRow | undefined {
  return fakeRegistry.get((name ?? '').trim().toLowerCase());
}

const mockEnsureProject = vi.fn(async (name: string, source = 'local') => {
  const trimmed = (name ?? '').trim();
  if (!trimmed) return { name: '', source: 'local', created: false };
  const existing = registryGet(trimmed);
  // The existing row always wins on BOTH spelling and claim.
  if (existing) return { name: existing.name, source: existing.source, created: false };
  fakeRegistry.set(trimmed.toLowerCase(), { name: trimmed, source, metadata: {} });
  return { name: trimmed, source, created: true };
});

const mockGetProjectRecord = vi.fn(async (name: string) => {
  const row = registryGet(name);
  return row ? { name: row.name, source: row.source, metadata: row.metadata } : null;
});

const mockSetProjectMetadata = vi.fn(async (name: string, settings: Record<string, unknown>) => {
  const trimmed = (name ?? '').trim();
  if (!trimmed) throw new Error('Inbox has no project settings — pass a project name.');
  const row = registryGet(trimmed) ?? { name: trimmed, source: 'local', metadata: {} };
  row.metadata = { ...row.metadata, ...settings };
  fakeRegistry.set(trimmed.toLowerCase(), row);
  return row.metadata;
});

const mockRemoteListNameFor = vi.fn(async (project: string) => {
  const name = (project ?? '').trim();
  if (!name) return '';
  const alias = registryGet(name)?.metadata?.remote_list;
  return typeof alias === 'string' && alias.trim() ? alias : name;
});

vi.mock('../../src/core/task-manager.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/core/task-manager.js')>()),
  findTaskByExtId: (...args: unknown[]) => mockFindTaskByExtId(...args),
  ensureProject: (...args: unknown[]) => (mockEnsureProject as any)(...args),
  getProjectRecord: (...args: unknown[]) => (mockGetProjectRecord as any)(...args),
  setProjectMetadata: (...args: unknown[]) => (mockSetProjectMetadata as any)(...args),
  remoteListNameFor: (...args: unknown[]) => (mockRemoteListNameFor as any)(...args),
}));

import {
  mapToRemote,
  mapToLocal,
  parseMsTodoBody,
  pushTask,
  pullTasks,
  syncTasks,
  deltaPull,
  reconcilePulledTasks,
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

/**
 * Register the local tasks that findTaskByExtId should resolve, keyed by their
 * ms-todo ext id — the store-side half of a pull test's fixture.
 */
function seedLocalByMsId(tasks: Task[]) {
  const byMsId = new Map(
    tasks
      .map((t) => [getMsExt(t).id, t] as const)
      .filter((entry): entry is readonly [string, Task] => typeof entry[0] === 'string'),
  );
  mockFindTaskByExtId.mockImplementation(async (source: string, extId: string) =>
    source === 'ms-todo' ? byMsId.get(extId) : undefined);
}

beforeEach(() => {
  vi.clearAllMocks();
  clearListIdCache();
  fakeRegistry.clear();

  // Default: an empty task store — no local task resolves and no project is
  // claimed yet, so a push resolves its list straight from the project name.
  // Pull tests opt in via seedLocalByMsId; alias tests seed the registry.
  seedLocalByMsId([]);

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

  it('includes startDateTime when task has start_date (day-truncated like due)', () => {
    const remote = mapToRemote(makeTask({ start_date: '2024-06-10T09:30:00.000Z' }));
    expect(remote.startDateTime).toEqual({ dateTime: '2024-06-10T00:00:00.0000000', timeZone: 'UTC' });
  });

  it('omits startDateTime when task has no start_date', () => {
    expect(mapToRemote(makeTask()).startDateTime).toBeUndefined();
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
    expect(local.project).toBe('Work');
    expect('category' in local).toBe(false);
  });

  it('takes the trailing segment of a legacy two-level list name as the project', () => {
    const local = mapToLocal(makeMsTask({ title: 'Task' }), 'Work / HomeLab');
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

  // Missing remote date must OMIT the key (not emit a null clear): a pull that
  // races a not-yet-pushed local edit would otherwise wipe the local date.
  it('missing dueDateTime leaves due_date untouched (no clear on pull)', () => {
    expect('due_date' in mapToLocal(makeMsTask(), 'personal')).toBe(false);
  });

  it('extracts start date from startDateTime', () => {
    const msTask = makeMsTask({ startDateTime: { dateTime: '2024-06-10T00:00:00.0000000', timeZone: 'UTC' } });
    expect(mapToLocal(msTask, 'personal').start_date).toBe('2024-06-10');
  });

  it('missing startDateTime leaves start_date untouched (no clear on pull)', () => {
    expect('start_date' in mapToLocal(makeMsTask(), 'personal')).toBe(false);
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

  // A body sitting on the MS server was written by whatever Walnut version last
  // pushed it, so retired phase names outlive the local SQLite migration. Dropping
  // the header would reset the task to whatever the MS status implies.
  it('folds a legacy Phase: header through migratePhase instead of dropping it', () => {
    expect(parseMsTodoBody('Phase: HUMAN_VERIFIED\n\nReviewed task').phase).toBe('AGENT_COMPLETE');
    expect(parseMsTodoBody('Phase: POST_WORK_COMPLETED\n\nShipped task').phase).toBe('AGENT_COMPLETE');
  });

  // (WAIT removed 2026-08-18) — WAIT and its ancestors now migrate to TODO, and
  // the parser's guard (`migrated !== 'TODO' || value === 'TODO'`) deliberately
  // treats a non-literal TODO fold as "not a phase I recognise". So these headers
  // leave phase undefined and the task falls back to phaseFromMsStatus — the MS
  // server's own status, which is the fresher signal for a parked task anyway.
  it('a retired blocked-phase header falls back to the MS status (folds to TODO → not claimed)', () => {
    expect(parseMsTodoBody('Phase: WAIT\n\nBlocked task').phase).toBeUndefined();
    expect(parseMsTodoBody('Phase: AWAIT_HUMAN_ACTION\n\nBlocked task').phase).toBeUndefined();
    expect(parseMsTodoBody('Phase: HUMAN_VERIFICATION\n\nBlocked task').phase).toBeUndefined();
    // A literal TODO header IS still honored — that's what the `value === 'TODO'` half is for.
    expect(parseMsTodoBody('Phase: TODO\n\nPlain task').phase).toBe('TODO');
  });

  it('leaves phase undefined for a junk Phase: value', () => {
    // Falls through to phaseFromMsStatus rather than silently claiming TODO.
    expect(parseMsTodoBody('Phase: NOT_A_PHASE\n\nSome task').phase).toBeUndefined();
    expect(parseMsTodoBody('Phase: TODO\n\nSome task').phase).toBe('TODO');
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
    expect(result.unread).toBe(true);
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

  it('roundtrips ALL phases 1:1 — no data loss on any phase', () => {
    // This test enforces the contract: every Walnut phase must survive
    // a mapToRemote → mapToLocal roundtrip unchanged. If a new phase is
    // added to PHASE_ORDER but not handled by the MS To-Do body
    // serializer, this test will catch it.


    for (const phase of PHASE_ORDER) {
      const original = makeTask({
        title: `Phase roundtrip: ${phase}`,
        phase,
        description: 'desc',
        summary: 'sum',
        note: 'note',
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
      expect(local.phase, `phase ${phase} did not roundtrip`).toBe(phase);
    }
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
// Phase map completeness
// ────────────────────────────────────────────────────────────────────

describe('phase map completeness', () => {
  it('PHASE_TO_MS_STATUS covers every phase in PHASE_ORDER', () => {



    for (const phase of PHASE_ORDER) {
      expect(PHASE_TO_MS_STATUS[phase], `PHASE_TO_MS_STATUS missing: ${phase}`).toBeDefined();
    }
  });

  it('phaseToMsStatus never returns fallback for valid phases', () => {


    const validStatuses = new Set(['notStarted', 'inProgress', 'completed']);

    for (const phase of PHASE_ORDER) {
      const status = phaseToMsStatus(phase);
      expect(validStatuses.has(status), `phaseToMsStatus(${phase}) returned invalid: ${status}`).toBe(true);
    }
  });
});

// ────────────────────────────────────────────────────────────────────
// pushTask (HTTP-layer)
// ────────────────────────────────────────────────────────────────────

describe('pushTask', () => {
  it('creates a new task via POST when ms_todo_id is absent', async () => {
    // Response 1: fetchTaskLists (for resolveListId — name matches the project)
    // Response 2: POST create task
    setupGraphResponses([
      { body: { value: [{ id: 'list-1', displayName: 'personal' }] } },
      { body: { id: 'new-ms-id', title: 'Test Task', status: 'notStarted', importance: 'normal' } },
    ]);

    const task = makeTask({ title: 'New Task', project: 'personal' });
    const msId = await pushTask(task);

    expect(msId.msTaskId).toBe('new-ms-id');
    // Verify 2 HTTP calls were made
    expect(mockHttpsRequest).toHaveBeenCalledTimes(2);

    // Second call should be POST
    const secondCallOptions = mockHttpsRequest.mock.calls[1][0];
    expect(secondCallOptions.method).toBe('POST');
    expect(secondCallOptions.path).toContain('/me/todo/lists/list-1/tasks');
  });

  it('updates an existing task via PATCH when ms_todo_id is present', async () => {
    // Response 1: fetchTaskLists (for resolveListId — name matches the project)
    // Response 2: PATCH update task
    setupGraphResponses([
      { body: { value: [{ id: 'list-1', displayName: 'personal' }] } },
      { body: { id: 'existing-ms-id', title: 'Updated Task' } },
    ]);

    const task = makeTask({ ms_todo_id: 'existing-ms-id', ms_todo_list: 'list-1', project: 'personal' });
    const msId = await pushTask(task);

    expect(msId.msTaskId).toBe('existing-ms-id');
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

  it('moves task to new list when project changed (delete old + create new)', async () => {
    setupGraphResponses([
      // resolveListId → fetchTaskLists (finds the list named after the project)
      { body: { value: [{ id: 'old-list', displayName: 'Old Home' }, { id: 'new-list', displayName: 'work idea' }] } },
      // DELETE from old list
      { body: {} },
      // POST create in new list
      { body: { id: 'new-ms-id', title: 'Moved Task' } },
    ]);

    const task = makeTask({
      ms_todo_id: 'old-ms-id',
      ms_todo_list: 'old-list',
      project: 'work idea',  // no alias → list name is the project name verbatim
    });
    const msId = await pushTask(task);

    expect(msId.msTaskId).toBe('new-ms-id');
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

  it('refuses to push an Inbox task (empty project is local-only)', async () => {
    setupGraphResponses([{ body: { value: [] } }]);

    await expect(pushTask(makeTask({ title: 'Loose capture', project: '' })))
      .rejects.toThrow(/no project \(Inbox tasks are local-only\)/);
    // Refused before any Graph traffic — no unnamed remote list gets created.
    expect(mockHttpsRequest).not.toHaveBeenCalled();
  });

  it('refuses to push when the project is claimed by another source', async () => {
    registrySeed('Tickets', 'jira');
    setupGraphResponses([{ body: { value: [] } }]);

    await expect(pushTask(makeTask({ title: 'Not ours', project: 'Tickets' })))
      .rejects.toThrow(/project "Tickets" is registered as jira/);
    expect(mockHttpsRequest).not.toHaveBeenCalled();
  });
});

// ────────────────────────────────────────────────────────────────────
// remote_list alias (push side)
// ────────────────────────────────────────────────────────────────────

// ────────────────────────────────────────────────────────────────────
// pushTask — a stored (list, id) pair that Graph rejects
//
// Measured on the live account 2026-09-02: two tasks carried ext.id from the OLD
// list beside an ext.list_id already rewritten to the NEW one, and every push
// PATCHed /lists/{new}/tasks/{old} forever. Graph answers that pair with
// 400 ParentFolderDoesNotContainTaskWithGivenId — NOT 404 — so a recovery that
// matched only 404 left the wedge exactly where it was.
//
// The dangerous half is the repair: re-POSTing (right for a dead id) would mint a
// SECOND remote item for one that is merely misfiled. So the recovery has to look
// for the item first, and these tests pin that it does.
// ────────────────────────────────────────────────────────────────────

describe('pushTask — stale (list, id) pair recovery', () => {
  const PARENT_MISMATCH = {
    error: {
      code: 'invalidRequest',
      message: 'Parent folder specified does not contain a Task with given Id',
      innerError: { code: 'ParentFolderDoesNotContainTaskWithGivenId' },
    },
  };

  it('a 400 parent-mismatch relocates the item and PATCHes its REAL list', async () => {
    const LISTS = {
      value: [{ id: 'list-new', displayName: 'personal' }, { id: 'list-old', displayName: 'archive' }],
    };
    setupGraphResponses([
      { body: LISTS },                                // resolveListId → 'personal' = list-new
      { status: 400, body: PARENT_MISMATCH },         // PATCH the stored pair → the wedge
      { body: LISTS },                                // locateRemoteTask enumerates lists
      // Only ONE probe happens: the stored list is skipped as already-known-bad,
      // so list-old is the single candidate — and it has the item.
      { body: { id: 'ms-1', title: 'Found here' } },
      { body: { id: 'ms-1', title: 'Patched', lastModifiedDateTime: '2026-09-02T00:00:00Z' } },
    ]);

    const task = makeTask({ ms_todo_id: 'ms-1', ms_todo_list: 'list-new', project: 'personal' });
    const result = await pushTask(task);

    // Same id kept — the item was never re-created.
    expect(result.msTaskId).toBe('ms-1');
    const methods = mockHttpsRequest.mock.calls.map((c: any[]) => c[0].method);
    expect(methods).not.toContain('POST');
    // The retry went to the list that actually holds the item...
    const patchPaths = mockHttpsRequest.mock.calls
      .filter((c: any[]) => c[0].method === 'PATCH').map((c: any[]) => c[0].path);
    expect(patchPaths).toHaveLength(2);
    expect(patchPaths[1]).toContain('/lists/list-old/tasks/ms-1');
    // ...and list_id was corrected to it, written together with the id.
    expect(result.listId).toBe('list-old');
    expect(getMsExt(task).id).toBe('ms-1');
    expect(getMsExt(task).list_id).toBe('list-old');
  });

  it('re-creates ONLY when the id is in no list at all', async () => {
    setupGraphResponses([
      { body: { value: [{ id: 'list-new', displayName: 'personal' }] } },
      { status: 404, body: { error: { code: 'itemNotFound' } } },   // PATCH
      { body: { value: [{ id: 'list-new', displayName: 'personal' }] } }, // locate: lists
      // list-new is the skipped one, so no probes remain → not found anywhere
      { body: { id: 'ms-recreated', lastModifiedDateTime: '2026-09-02T00:00:00Z' } }, // POST
    ]);

    const task = makeTask({ ms_todo_id: 'ms-dead', ms_todo_list: 'list-new', project: 'personal' });
    const result = await pushTask(task);

    expect(result.msTaskId).toBe('ms-recreated');
    expect(mockHttpsRequest.mock.calls.map((c: any[]) => c[0].method)).toContain('POST');
    expect(getMsExt(task).id).toBe('ms-recreated');
    expect(getMsExt(task).list_id).toBe(result.listId);
  });

  // Real ids from the live account, trimmed: the middle segment after `GAAI` is
  // the parent list. `…1uimvg…` and `…1uimvw…` are two different lists, which is
  // what makes the first pair below self-contradictory.
  const ID_IN_OLD = 'AQMkGAAI1uimvgAAAPQ05ueahVdDACPN3OgUAAAA=';
  const LIST_OLD = 'AQMkGAAI1uimvgAAAA==';
  const LIST_NEW = 'AQMkGAAI1uimvwAAAA==';

  it('re-anchors a self-contradictory identity BEFORE deciding migrate-vs-patch', async () => {
    // The exact live shape: item id from the old list, list_id already rewritten
    // to the new one. Graph would ACCEPT a PATCH to the wrong list, so nothing
    // ever errors — the contradiction has to be noticed up front, from the ids
    // alone, or the row pushes "fine" forever and its next migration deletes
    // from a list the item is not in.
    setupGraphResponses([
      { body: { value: [{ id: LIST_NEW, displayName: 'personal' }, { id: LIST_OLD, displayName: 'archive' }] } },
      // locateRemoteTask enumerates, then probes the list the ID ITSELF names
      // first — so LIST_OLD is candidate #1 and one GET settles it, even though
      // LIST_NEW comes first in the list response.
      { body: { value: [{ id: LIST_NEW, displayName: 'personal' }, { id: LIST_OLD, displayName: 'archive' }] } },
      { body: { id: ID_IN_OLD } },
      // Re-anchored to LIST_OLD, which now differs from the project's list →
      // ordinary migration: DELETE from the real list, POST into the target.
      { body: {} },
      { body: { id: 'ms-migrated', lastModifiedDateTime: '2026-09-02T00:00:00Z' } },
    ]);

    const task = makeTask({ ms_todo_id: ID_IN_OLD, ms_todo_list: LIST_NEW, project: 'personal' });
    const result = await pushTask(task);

    const calls = mockHttpsRequest.mock.calls.map((c: any[]) => `${c[0].method} ${c[0].path}`);
    // The DELETE went to the list that really held the item — the whole point.
    // Addressed to LIST_NEW it would have silently failed and orphaned the item.
    expect(calls.some((c) => c.startsWith('DELETE') && c.includes(LIST_OLD))).toBe(true);
    expect(calls.some((c) => c.startsWith('DELETE') && c.includes(LIST_NEW))).toBe(false);
    // One probe, not a 26-list scan: the id named its own list.
    expect(calls.filter((c) => c.startsWith('GET') && c.includes('/tasks/'))).toHaveLength(1);
    expect(result.msTaskId).toBe('ms-migrated');
    expect(result.listId).toBe(LIST_NEW);
    expect(getMsExt(task).list_id).toBe(LIST_NEW);
  });

  it('leaves a CONSISTENT identity alone — no extra lookups on the common path', async () => {
    // The guard must not tax the 1968-of-1970 rows that are fine: one list
    // resolution, one PATCH, nothing else.
    setupGraphResponses([
      { body: { value: [{ id: LIST_OLD, displayName: 'personal' }] } },
      { body: { id: ID_IN_OLD, lastModifiedDateTime: '2026-09-02T00:00:00Z' } },
    ]);

    const task = makeTask({ ms_todo_id: ID_IN_OLD, ms_todo_list: LIST_OLD, project: 'personal' });
    await pushTask(task);

    expect(mockHttpsRequest).toHaveBeenCalledTimes(2);
    expect(mockHttpsRequest.mock.calls[1][0].method).toBe('PATCH');
  });

  it('a PATCH failure that is NOT a stale pair still throws (no blind re-create)', async () => {
    // 500/429/auth must keep their retry semantics: inventing a remote item on a
    // transient error is how one flaky tick becomes a permanent duplicate.
    setupGraphResponses([
      { body: { value: [{ id: 'list-1', displayName: 'personal' }] } },
      { status: 500, body: { error: { code: 'internalServerError' } } },
    ]);

    const task = makeTask({ ms_todo_id: 'ms-1', ms_todo_list: 'list-1', project: 'personal' });
    await expect(pushTask(task)).rejects.toThrow(/500/);
    expect(mockHttpsRequest.mock.calls.map((c: any[]) => c[0].method)).not.toContain('POST');
    // The identity is untouched, so the next tick retries the same pair.
    expect(getMsExt(task).id).toBe('ms-1');
    expect(getMsExt(task).list_id).toBe('list-1');
  });
});

describe('pushTask — remote_list alias', () => {
  it('pushes into the aliased legacy list, not a new project-named one', async () => {
    // A project migrated off the retired two-level model: name "HomeLab",
    // alias still the original remote list "Work / HomeLab".
    registrySeed('HomeLab', 'ms-todo', { remote_list: 'Work / HomeLab' });

    setupGraphResponses([
      // Both lists exist remotely; only the alias must be picked.
      { body: { value: [
        { id: 'legacy-list', displayName: 'Work / HomeLab' },
        { id: 'fresh-list', displayName: 'HomeLab' },
      ] } },
      { body: { id: 'aliased-ms-id', title: 'Aliased Task' } },
    ]);

    const task = makeTask({ title: 'Aliased Task', project: 'HomeLab' });
    const result = await pushTask(task);

    expect(result.msTaskId).toBe('aliased-ms-id');
    expect(getMsExt(task).list_id).toBe('legacy-list');
    expect(mockHttpsRequest.mock.calls[1][0].path).toContain('legacy-list');
    // Zero renames / list creations — the remote side is left untouched.
    expect(mockHttpsRequest).toHaveBeenCalledTimes(2);
  });

  it('creates a list named after the project when there is no alias', async () => {
    registrySeed('FreshProject', 'ms-todo');

    setupGraphResponses([
      { body: { value: [] } },                                        // no lists yet
      { body: { id: 'created-list', displayName: 'FreshProject' } },  // createList
      { body: { id: 'new-ms-id', title: 'First Task' } },             // POST task
    ]);

    const task = makeTask({ title: 'First Task', project: 'FreshProject' });
    await pushTask(task);

    const createCall = mockHttpsRequest.mock.calls[1][0];
    expect(createCall.method).toBe('POST');
    expect(createCall.path).toMatch(/\/me\/todo\/lists$/);
    const createdBody = JSON.parse(mockHttpsRequest.mock.results[1].value.write.mock.calls[0][0]);
    expect(createdBody.displayName).toBe('FreshProject');
  });
});

// ────────────────────────────────────────────────────────────────────
// remote_list alias (pull side) — reconcilePulledTasks
// ────────────────────────────────────────────────────────────────────

describe('reconcilePulledTasks — project registry + remote_list alias', () => {
  const addOk = () => vi.fn().mockResolvedValue(makeTask({ id: 'created' }));

  it('a legacy "Category / Project" list lands on the trailing project + stamps the alias', async () => {
    const addLocal = addOk();
    const count = await reconcilePulledTasks(
      [makeMsTask({ id: 'ms-legacy-1', title: 'Legacy list task' })],
      { id: 'legacy-list', displayName: 'Work / HomeLab' },
      vi.fn(),
      addLocal,
    );

    expect(count).toBe(1);
    // Task is filed under the trailing segment only — the leading category is gone.
    expect(addLocal).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Legacy list task',
      project: 'HomeLab',
      source: 'ms-todo',
    }));
    // Registry row created + claimed, with the FULL remote display name aliased so
    // later pushes keep landing in that exact list instead of forking a new one.
    const row = registryGet('HomeLab')!;
    expect(row.source).toBe('ms-todo');
    expect(row.metadata.remote_list).toBe('Work / HomeLab');
    // And the push side resolves back to the legacy list.
    await expect(mockRemoteListNameFor('HomeLab')).resolves.toBe('Work / HomeLab');
  });

  it('a project-named list needs no alias', async () => {
    const addLocal = addOk();
    await reconcilePulledTasks(
      [makeMsTask({ id: 'ms-plain-1', title: 'Plain list task' })],
      { id: 'plain-list', displayName: 'HomeLab' },
      vi.fn(),
      addLocal,
    );

    expect(addLocal).toHaveBeenCalledWith(expect.objectContaining({ project: 'HomeLab' }));
    expect(registryGet('HomeLab')!.metadata.remote_list).toBeUndefined();
  });

  it('a case-only difference is the same list, so no alias is written', async () => {
    registrySeed('HomeLab', 'ms-todo');
    const addLocal = addOk();
    await reconcilePulledTasks(
      [makeMsTask({ id: 'ms-case-1', title: 'Case task' })],
      { id: 'case-list', displayName: 'homelab' },
      vi.fn(),
      addLocal,
    );

    // Canonical registry spelling wins over the remote list's casing, so two
    // lists differing only in case can't split one project.
    expect(addLocal).toHaveBeenCalledWith(expect.objectContaining({ project: 'HomeLab' }));
    expect(registryGet('HomeLab')!.metadata.remote_list).toBeUndefined();
  });

  it('first alias writer wins when two legacy lists flatten onto one project', async () => {
    const addLocal = addOk();
    await reconcilePulledTasks(
      [makeMsTask({ id: 'ms-a', title: 'From Work' })],
      { id: 'list-a', displayName: 'Work / VPA' },
      vi.fn(),
      addLocal,
    );
    await reconcilePulledTasks(
      [makeMsTask({ id: 'ms-b', title: 'From Personal' })],
      { id: 'list-b', displayName: 'Personal / VPA' },
      vi.fn(),
      addLocal,
    );

    // Both tasks land in project "VPA"; the alias stays pinned to the first list
    // so pushes don't shuffle between remote lists on every tick.
    expect(registryGet('VPA')!.metadata.remote_list).toBe('Work / VPA');
    expect(addLocal).toHaveBeenCalledTimes(2);
    for (const call of addLocal.mock.calls) expect(call[0].project).toBe('VPA');
  });

  it('skips a whole list whose project is claimed by another source', async () => {
    registrySeed('Tickets', 'jira');
    const addLocal = addOk();
    const updateLocal = vi.fn();

    const count = await reconcilePulledTasks(
      [makeMsTask({ id: 'ms-jira-1', title: 'Not ours' })],
      { id: 'list-jira', displayName: 'Tickets' },
      updateLocal,
      addLocal,
    );

    expect(count).toBe(0);
    expect(addLocal).not.toHaveBeenCalled();
    expect(updateLocal).not.toHaveBeenCalled();
    // The claim is untouched — a pull can never re-claim someone else's project.
    expect(registryGet('Tickets')!.source).toBe('jira');
  });

  it('an empty list never manufactures a registry row', async () => {
    const count = await reconcilePulledTasks(
      [],
      { id: 'list-empty', displayName: 'Work / Ghost' },
      vi.fn(),
      addOk(),
    );

    expect(count).toBe(0);
    expect(registryGet('Ghost')).toBeUndefined();
    expect(mockEnsureProject).not.toHaveBeenCalled();
  });

  it('an update from a legacy list rewrites the task onto the project', async () => {
    const localTask = makeTask({
      id: 'local-legacy',
      ms_todo_id: 'ms-upd-1',
      project: 'HomeLab',
      updated_at: '2024-01-01T00:00:00Z',
    });
    seedLocalByMsId([localTask]);
    const updateLocal = vi.fn();

    const count = await reconcilePulledTasks(
      [makeMsTask({ id: 'ms-upd-1', title: 'Renamed remotely', lastModifiedDateTime: '2026-01-01T00:00:00Z' })],
      { id: 'legacy-list', displayName: 'Work / HomeLab' },
      updateLocal,
      addOk(),
    );

    expect(count).toBe(1);
    const updates = updateLocal.mock.calls[0][1];
    expect(updates.project).toBe('HomeLab');
    expect('category' in updates).toBe(false);
  });
});

// ────────────────────────────────────────────────────────────────────
// Retired grouping names must NOT be resurrected as projects on pull
// ────────────────────────────────────────────────────────────────────
// The v5 migration routed 'Quick Start' (any category) and the 'Inbox' category
// to Inbox (''). The remote lists still carry those names, so a pull that only
// split the display name re-created them as real projects AND the catch-up pass
// rewrote project='Quick Start' back onto the migrated tasks — sync silently
// undoing the migration.

describe('reconcilePulledTasks — retired grouping names route to Inbox', () => {
  const addOk = () => vi.fn().mockResolvedValue(makeTask({ id: 'created' }));

  const retiredLists = [
    'Passion / Quick Start',
    'Inbox / Quick Start',
    'Work / quick start',
    'Quick Start',
    'Inbox',
    'inbox',
  ];

  for (const displayName of retiredLists) {
    it(`skips the "${displayName}" list wholesale`, async () => {
      const addLocal = addOk();
      const updateLocal = vi.fn();

      const count = await reconcilePulledTasks(
        [makeMsTask({ id: 'ms-retired-1', title: 'Captured thought' })],
        { id: 'list-retired', displayName },
        updateLocal,
        addLocal,
      );

      // Inbox is structurally local-only, so a provider task cannot live there —
      // skipping is the same outcome as a create-time refusal, without the noise.
      expect(count).toBe(0);
      expect(addLocal).not.toHaveBeenCalled();
      expect(updateLocal).not.toHaveBeenCalled();
      // No registry row, no ensureProject call — the retired name never becomes a project.
      expect(mockEnsureProject).not.toHaveBeenCalled();
      expect(fakeRegistry.size).toBe(0);
    });
  }

  it('still imports a real project from a list whose LEADING segment is "Inbox"', async () => {
    // "Inbox / Marina" = category Inbox + project Marina → Marina survives
    // (promoteLegacyGroup only sends the DEGENERATE Inbox group to Inbox).
    const addLocal = addOk();
    const count = await reconcilePulledTasks(
      [makeMsTask({ id: 'ms-real-1', title: 'Real work' })],
      { id: 'list-real', displayName: 'Inbox / Marina' },
      vi.fn(),
      addLocal,
    );
    expect(count).toBe(1);
    expect(addLocal).toHaveBeenCalledWith(expect.objectContaining({ project: 'Marina' }));
    expect(registryGet('Marina')!.metadata.remote_list).toBe('Inbox / Marina');
  });

  it('does not route a project that merely CONTAINS a retired word', async () => {
    const addLocal = addOk();
    await reconcilePulledTasks(
      [makeMsTask({ id: 'ms-guide-1', title: 'Guide task' })],
      { id: 'list-guide', displayName: 'Quick Start Guide' },
      vi.fn(),
      addLocal,
    );
    expect(addLocal).toHaveBeenCalledWith(expect.objectContaining({ project: 'Quick Start Guide' }));
  });

  it('mapToLocal itself routes a retired list name to Inbox', async () => {
    // The field mapper is the second write path (it feeds the UPDATE branch and
    // fullPullAllTasks), so the rule has to live below reconcile too.
    expect(mapToLocal(makeMsTask({ id: 'x' }), 'Passion / Quick Start').project).toBe('');
    expect(mapToLocal(makeMsTask({ id: 'x' }), 'Inbox').project).toBe('');
    expect(mapToLocal(makeMsTask({ id: 'x' }), 'Work / VPA').project).toBe('VPA');
  });

  it('an UPDATE from a retired list does not rewrite the task back to Quick Start', async () => {
    // The regression shape: a migrated task (project '') whose remote twin still
    // lives in "Passion / Quick Start". The whole list is skipped, so no update.
    const localTask = makeTask({
      id: 'local-migrated',
      ms_todo_id: 'ms-qs-1',
      project: '',
      updated_at: '2024-01-01T00:00:00Z',
    });
    seedLocalByMsId([localTask]);
    const updateLocal = vi.fn();

    const count = await reconcilePulledTasks(
      [makeMsTask({ id: 'ms-qs-1', title: 'Renamed remotely', lastModifiedDateTime: '2026-01-01T00:00:00Z' })],
      { id: 'list-qs', displayName: 'Passion / Quick Start' },
      updateLocal,
      addOk(),
    );

    expect(count).toBe(0);
    expect(updateLocal).not.toHaveBeenCalled();
  });
});

// ────────────────────────────────────────────────────────────────────
// deltaPull catch-up must not rewrite migrated tasks either
// ────────────────────────────────────────────────────────────────────

describe('deltaPull catch-up — retired list names', () => {
  function seedDeltaState(listNames: Record<string, string>): void {
    mockReadJsonFile.mockImplementation((_path: string, defaultVal: unknown) => {
      if (typeof _path === 'string' && _path.includes('tokens')) {
        return Promise.resolve({
          accessToken: 'fake-token',
          expiresAt: new Date(Date.now() + 3600000).toISOString(),
          msalCache: '{}',
        });
      }
      if (typeof _path === 'string' && _path.includes('delta')) {
        return Promise.resolve({ deltaLinks: {}, listNames, lastSync: '' });
      }
      return Promise.resolve(defaultVal);
    });
  }

  it('leaves a migrated Inbox task alone when its list is still named "… / Quick Start"', async () => {
    seedDeltaState({ 'list-qs': 'Passion / Quick Start' });
    setupGraphResponses([
      { body: { value: [{ id: 'list-qs', displayName: 'Passion / Quick Start' }] } },
      { body: { value: [], '@odata.deltaLink': 'https://graph.microsoft.com/delta?t=qs' } },
    ]);

    const localTask = makeTask({
      id: 'local-migrated',
      ms_todo_id: 'ms-1',
      ms_todo_list: 'list-qs',
      project: '',
    });
    const updateLocal = vi.fn();

    const hasChanges = await deltaPull([localTask], updateLocal, vi.fn());

    // The catch-up pass used to fire `updateLocal(id, { project: 'Quick Start' })`
    // here on EVERY tick, undoing the migration.
    expect(updateLocal).not.toHaveBeenCalled();
    expect(hasChanges).toBe(false);
    expect(fakeRegistry.size).toBe(0);
  });

  it('a remote RENAME onto a retired name also leaves tasks alone', async () => {
    seedDeltaState({ 'list-1': 'Work / HomeLab' });
    setupGraphResponses([
      // The user renamed the list to the retired grouping name.
      { body: { value: [{ id: 'list-1', displayName: 'Inbox' }] } },
      { body: { value: [], '@odata.deltaLink': 'https://graph.microsoft.com/delta?t=r' } },
    ]);

    const localTask = makeTask({
      id: 'local-1', ms_todo_id: 'ms-1', ms_todo_list: 'list-1', project: 'HomeLab',
    });
    const updateLocal = vi.fn();

    await deltaPull([localTask], updateLocal, vi.fn());

    expect(updateLocal).not.toHaveBeenCalled();
    expect(registryGet('Inbox')).toBeUndefined();
  });

  it('still performs the catch-up for an ordinary list-name change', async () => {
    // Guardrail: the skip above must be name-specific, not a blanket disable.
    registrySeed('HomeLab', 'ms-todo');
    seedDeltaState({ 'list-1': 'Work / HomeLab' });
    setupGraphResponses([
      { body: { value: [{ id: 'list-1', displayName: 'Work / LabAtHome' }] } },
      { body: { value: [], '@odata.deltaLink': 'https://graph.microsoft.com/delta?t=ok' } },
    ]);

    const localTask = makeTask({
      id: 'local-1', ms_todo_id: 'ms-1', ms_todo_list: 'list-1', project: 'HomeLab',
    });
    const updateLocal = vi.fn();

    await deltaPull([localTask], updateLocal, vi.fn());
    expect(updateLocal).toHaveBeenCalledWith('local-1', { project: 'LabAtHome' });
  });
});

// ────────────────────────────────────────────────────────────────────
// Store errors must fail loudly, not degrade to an unverified project
// ────────────────────────────────────────────────────────────────────

describe('ms-todo pull — store failure handling', () => {
  const addOk = () => vi.fn().mockResolvedValue(makeTask({ id: 'created' }));

  it('SKIPS a list when the project registry read fails for a real reason', async () => {
    // We cannot know who owns the project, and importing under an unverified name
    // could steal another provider's claim. Skip and let the next tick retry.
    mockEnsureProject.mockRejectedValueOnce(new Error('SQLITE_CORRUPT: database disk image is malformed'));
    const addLocal = addOk();

    const count = await reconcilePulledTasks(
      [makeMsTask({ id: 'ms-err-1', title: 'Task' })],
      { id: 'list-err', displayName: 'Work / HomeLab' },
      vi.fn(),
      addLocal,
    );

    expect(count).toBe(0);
    expect(addLocal).not.toHaveBeenCalled();
  });

  it('still degrades to the routed name when there is NO task store at all', async () => {
    // The unit-test / no-DB shape: dropping the list's tasks would be worse.
    mockEnsureProject.mockRejectedValueOnce(new Error('ensureExtIndexes: task-db is not open'));
    const addLocal = addOk();

    const count = await reconcilePulledTasks(
      [makeMsTask({ id: 'ms-nodb-1', title: 'Task' })],
      { id: 'list-nodb', displayName: 'Work / HomeLab' },
      vi.fn(),
      addLocal,
    );

    expect(count).toBe(1);
    expect(addLocal).toHaveBeenCalledWith(expect.objectContaining({ project: 'HomeLab' }));
  });

  it('pushTask refuses when the registry read fails for a real reason', async () => {
    mockGetProjectRecord.mockRejectedValueOnce(new Error('SQLITE_CORRUPT: database disk image is malformed'));
    await expect(pushTask(makeTask({ project: 'HomeLab' })))
      .rejects.toThrow(/project registry unreadable/);
  });

  it('pushTask proceeds when there is NO task store at all', async () => {
    mockGetProjectRecord.mockRejectedValueOnce(new Error('task-db is not open'));
    setupGraphResponses([
      { body: { value: [{ id: 'list-1', displayName: 'HomeLab' }] } },
      { body: { id: 'ms-new-1', lastModifiedDateTime: '2026-01-01T00:00:00Z' } },
    ]);
    const result = await pushTask(makeTask({ project: 'HomeLab' }));
    expect(result.msTaskId).toBe('ms-new-1');
  });
});

// ────────────────────────────────────────────────────────────────────
// deltaPull: remote list rename re-points the alias
// ────────────────────────────────────────────────────────────────────

describe('deltaPull — remote list rename', () => {
  it('re-points the alias and moves tasks when a tracked list is renamed', async () => {
    // Pre-state: project HomeLab aliased to the legacy list name we stored last tick.
    registrySeed('HomeLab', 'ms-todo', { remote_list: 'Work / HomeLab' });
    mockReadJsonFile.mockImplementation((_path: string, defaultVal: unknown) => {
      if (typeof _path === 'string' && _path.includes('tokens')) {
        return Promise.resolve({
          accessToken: 'fake-token',
          expiresAt: new Date(Date.now() + 3600000).toISOString(),
          msalCache: '{}',
        });
      }
      if (typeof _path === 'string' && _path.includes('delta')) {
        return Promise.resolve({
          deltaLinks: {},
          listNames: { 'list-1': 'Work / HomeLab' },
          lastSync: '',
        });
      }
      return Promise.resolve(defaultVal);
    });

    setupGraphResponses([
      // fetchTaskLists — the list now has a new display name
      { body: { value: [{ id: 'list-1', displayName: 'Work / LabAtHome' }] } },
      // pullTasks — nothing new to reconcile
      { body: { value: [], '@odata.deltaLink': 'https://graph.microsoft.com/delta?t=rename' } },
    ]);

    const localTask = makeTask({
      id: 'local-1',
      ms_todo_id: 'ms-1',
      ms_todo_list: 'list-1',
      project: 'HomeLab',
    });
    const updateLocal = vi.fn();

    const hasChanges = await deltaPull([localTask], updateLocal, vi.fn());

    expect(hasChanges).toBe(true);
    // Task follows the list to the new trailing project name…
    expect(updateLocal).toHaveBeenCalledWith('local-1', { project: 'LabAtHome' });
    // …and the alias is OVERWRITTEN (same remote list, new name) so the next push
    // doesn't resolve the vanished old name and create a duplicate list.
    expect(registryGet('LabAtHome')!.metadata.remote_list).toBe('Work / LabAtHome');
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
    expect(result!.msTaskId).toBe('push-result-id');
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
    seedLocalByMsId([localTask]);

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
      project: 'Tasks',
      updated_at: '2024-12-01T00:00:00Z', // newer than remote
      _syncedAt: '2024-12-01T00:00:00Z',
    });
    seedLocalByMsId([localTask]);

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
    seedLocalByMsId([localTask]);

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
      project: 'Tasks',
      updated_at: '2025-01-01T00:00:00Z', // very recent
      _syncedAt: '2025-01-01T00:00:00Z',
    });
    seedLocalByMsId([localTask]);

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
      { body: { id: 'new-list-id', displayName: 'NewProject' } },
    ]);

    const list = await createList('NewProject');

    expect(list.id).toBe('new-list-id');
    expect(list.displayName).toBe('NewProject');
    const callOptions = mockHttpsRequest.mock.calls[0][0];
    expect(callOptions.method).toBe('POST');
    expect(callOptions.path).toContain('/me/todo/lists');
  });
});

describe('renameList', () => {
  it('renames a list via PATCH', async () => {
    setupGraphResponses([
      { body: { id: 'list-1', displayName: 'Renamed' } },
    ]);

    const list = await renameList('list-1', 'Renamed');

    expect(list.displayName).toBe('Renamed');
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
        responseBody = { id: createdListId, displayName: 'Walnut-Idea' };
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
        responseBody = { value: [{ id: 'cached-list-id', displayName: 'Walnut-Idea' }] };
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
    const task1 = makeTask({ id: 'task-1', project: 'Walnut-Idea' });
    await pushTask(task1);

    // Second push: should use cache (no extra fetchTaskLists)
    const task2 = makeTask({ id: 'task-2', project: 'Walnut-Idea' });
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
    const taskA = makeTask({ id: 'a', project: 'ProjectA' });
    const taskB = makeTask({ id: 'b', project: 'ProjectB' });

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
          responseBody = { value: [{ id: 'recovered-list', displayName: 'Walnut-Idea' }] };
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

    const task1 = makeTask({ id: 'task-err', project: 'Walnut-Idea' });

    // First attempt should fail (500 from fetchTaskLists)
    await expect(pushTask(task1)).rejects.toThrow();

    // Second attempt should succeed — inflight was cleaned up, retries fresh
    const task2 = makeTask({ id: 'task-ok', project: 'Walnut-Idea' });
    const result = await pushTask(task2);

    expect(result!.msTaskId).toBe('ms-task-recovered');
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
        responseBody = { value: [{ id: 'list-orig', displayName: 'Walnut-Idea' }] };
      } else if (options.method === 'PATCH' && p.includes('/me/todo/lists')) {
        responseBody = { id: 'list-orig', displayName: 'Walnut-Renamed' };
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
    const task1 = makeTask({ id: 'task-1', project: 'Walnut-Idea' });
    await pushTask(task1);
    expect(fetchListsCount).toBe(1);

    // Rename: should invalidate cache
    await renameList('list-orig', 'Walnut-Renamed');

    // Second push: should re-fetch lists (cache was invalidated)
    const task2 = makeTask({ id: 'task-2', project: 'Walnut-Idea' });
    await pushTask(task2);
    expect(fetchListsCount).toBe(2);
  });
});
