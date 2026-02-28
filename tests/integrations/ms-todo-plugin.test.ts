/**
 * MS To-Do plugin tests — sections C1-C6 of PLUGIN_TEST_PLAN.md.
 * Mocks the underlying microsoft-todo.ts functions at the module level.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createTestPluginApi, createMockTask } from '../core/plugin-test-utils.js';
import type { IntegrationSync } from '../../src/core/integration-types.js';

// ── Mocks for microsoft-todo.ts ──

const mockAutoPushTask = vi.fn();
const mockDeltaPull = vi.fn();

vi.mock('../../src/integrations/microsoft-todo.js', () => ({
  autoPushTask: (...args: unknown[]) => mockAutoPushTask(...args),
  deltaPull: (...args: unknown[]) => mockDeltaPull(...args),
  deleteMsTodoTask: vi.fn().mockResolvedValue(undefined),
  registerDeletedMsIds: vi.fn().mockResolvedValue(undefined),
}));

import register from '../../src/integrations/ms-todo/index.js';

// ── Helpers ──

function msTodoApi(configOverrides?: Record<string, unknown>) {
  return createTestPluginApi(
    { id: 'ms-todo', name: 'Microsoft To-Do' },
    { client_id: 'test-client-id', ...configOverrides },
  );
}

function msTodoTask(overrides?: Partial<ReturnType<typeof createMockTask>>) {
  return createMockTask({ category: 'Personal', source: 'ms-todo', ...overrides });
}

// ── Tests ──

beforeEach(() => {
  vi.clearAllMocks();
});

// C1: Unit — Plugin Registration
describe('C1: MS To-Do plugin registration', () => {
  it('C1.1: registers sync with all 16 methods', () => {
    const { api, collected } = msTodoApi();
    register(api);

    expect(collected.sync).not.toBeNull();
    const methods: (keyof IntegrationSync)[] = [
      'createTask', 'deleteTask', 'updateTitle', 'updateDescription',
      'updateSummary', 'updateNote', 'updateConversationLog', 'updatePriority',
      'updatePhase', 'updateDueDate', 'updateStar', 'updateCategory',
      'updateDependencies', 'associateSubtask', 'disassociateSubtask', 'syncPoll',
    ];
    for (const m of methods) {
      expect(typeof collected.sync![m]).toBe('function');
    }
  });

  it('C1.2: source claim returns true for all categories (priority 0)', async () => {
    const { api, collected } = msTodoApi();
    register(api);

    expect(collected.claim!.priority).toBe(0);
    expect(await collected.claim!.fn('Personal')).toBe(true);
    expect(await collected.claim!.fn('Work')).toBe(true);
    expect(await collected.claim!.fn('Anything')).toBe(true);
  });

  it('C1.3: display badge is "M" with Microsoft blue', () => {
    const { api, collected } = msTodoApi();
    register(api);

    expect(collected.display!.badge).toBe('M');
    expect(collected.display!.badgeColor).toBe('#0078D4');
    expect(collected.display!.externalLinkLabel).toBe('Microsoft To-Do');
  });

  it('C1.4: isSynced checks ext[ms-todo].id', () => {
    const { api, collected } = msTodoApi();
    register(api);

    expect(collected.display!.isSynced(msTodoTask({ ext: { 'ms-todo': { id: 'abc' } } }))).toBe(true);
    expect(collected.display!.isSynced(msTodoTask())).toBe(false);
  });

  it('C1.5: registers migration function', () => {
    const { api, collected } = msTodoApi();
    register(api);
    expect(collected.migrations.length).toBe(1);
  });

  it('C1.6: registers agent context string', () => {
    const { api, collected } = msTodoApi();
    register(api);
    expect(collected.agentContext).toContain('Microsoft To-Do');
  });
});

// C2: createTask flow (mocked)
describe('C2: MS To-Do createTask', () => {
  it('C2.1: calls autoPushTask and returns ext data', async () => {
    const { api, collected } = msTodoApi();
    register(api);
    mockAutoPushTask.mockResolvedValue('ms-task-123');

    const task = msTodoTask();
    const result = await collected.sync!.createTask(task);

    expect(mockAutoPushTask).toHaveBeenCalledWith(task);
    expect(result).toEqual({ 'ms-todo': { id: 'ms-task-123', list_id: undefined } });
  });

  it('C2.2: returns null when autoPushTask returns null', async () => {
    const { api, collected } = msTodoApi();
    register(api);
    mockAutoPushTask.mockResolvedValue(null);

    expect(await collected.sync!.createTask(msTodoTask())).toBeNull();
  });
});

// C3: updatePhase flow (mocked)
describe('C3: MS To-Do updatePhase', () => {
  it('C3.1: updatePhase calls autoPushTask', async () => {
    const { api, collected } = msTodoApi();
    register(api);
    mockAutoPushTask.mockResolvedValue('ms-id');

    const task = msTodoTask({ phase: 'IN_PROGRESS' });
    await collected.sync!.updatePhase(task, 'IN_PROGRESS');
    expect(mockAutoPushTask).toHaveBeenCalledWith(task);
  });
});

// Additional update methods
describe('MS To-Do update methods', () => {
  it('updateTitle delegates to autoPushTask', async () => {
    const { api, collected } = msTodoApi();
    register(api);
    mockAutoPushTask.mockResolvedValue('ms-id');

    const task = msTodoTask({ title: 'New Title' });
    await collected.sync!.updateTitle(task, 'New Title');
    expect(mockAutoPushTask).toHaveBeenCalledWith(task);
  });

  it('updateDescription delegates to autoPushTask', async () => {
    const { api, collected } = msTodoApi();
    register(api);
    mockAutoPushTask.mockResolvedValue('ms-id');

    const task = msTodoTask({ description: 'New desc' });
    await collected.sync!.updateDescription(task, 'New desc');
    expect(mockAutoPushTask).toHaveBeenCalledWith(task);
  });

  it('deleteTask does not throw', async () => {
    const { api, collected } = msTodoApi();
    register(api);
    await expect(collected.sync!.deleteTask(msTodoTask())).resolves.toBeUndefined();
  });
});

// C4: syncPoll (deltaPull)
describe('C4: MS To-Do syncPoll', () => {
  it('C4.1: calls deltaPull with correct context', async () => {
    const { api, collected } = msTodoApi();
    register(api);
    mockDeltaPull.mockResolvedValue(true);

    const tasks = [msTodoTask()];
    const ctx = {
      getTasks: () => tasks,
      updateTask: vi.fn(),
      addTask: vi.fn(),
      deleteTask: vi.fn(),
      emit: vi.fn(),
    };

    await collected.sync!.syncPoll(ctx);

    expect(mockDeltaPull).toHaveBeenCalledTimes(1);
    expect(mockDeltaPull.mock.calls[0][0]).toBe(tasks);
  });
});

// C5: Migration
describe('C5: MS To-Do migration', () => {
  it('A3.1: ms_todo_id migrates to ext[ms-todo] with list_id', () => {
    const { api, collected } = msTodoApi();
    register(api);

    const task = msTodoTask() as any;
    task.ms_todo_id = 'ms-old-id';
    task.ms_todo_list = 'list-old';

    const migrated = collected.migrations[0]([task]);
    expect(migrated[0].ext?.['ms-todo']).toEqual({ id: 'ms-old-id', list_id: 'list-old' });
    expect(task.ms_todo_id).toBeUndefined();
    expect(task.ms_todo_list).toBeUndefined();
  });

  it('A3.2: skips tasks already migrated', () => {
    const { api, collected } = msTodoApi();
    register(api);

    const task = msTodoTask({ ext: { 'ms-todo': { id: 'existing' } } }) as any;
    task.ms_todo_id = 'old-id';

    const migrated = collected.migrations[0]([task]);
    expect(migrated[0].ext?.['ms-todo']).toEqual({ id: 'existing' });
  });

  it('A3.3: handles tasks without ms_todo_id (no-op)', () => {
    const { api, collected } = msTodoApi();
    register(api);

    const task = createMockTask({ source: 'plugin-b' });
    const migrated = collected.migrations[0]([task]);
    expect(migrated[0].ext).toBeUndefined();
  });

  it('A3.4: repairs double-nested ext[ms-todo][ms-todo]', () => {
    const { api, collected } = msTodoApi();
    register(api);

    const task = msTodoTask({
      ext: { 'ms-todo': { 'ms-todo': { id: 'inner-id', list_id: 'inner-list' } } },
    }) as any;

    const migrated = collected.migrations[0]([task]);
    expect(migrated[0].ext?.['ms-todo']).toEqual({ id: 'inner-id', list_id: 'inner-list' });
  });

  it('A3.5: normalizes list → list_id', () => {
    const { api, collected } = msTodoApi();
    register(api);

    const task = msTodoTask({
      ext: { 'ms-todo': { id: 'some-id', list: 'old-list-field' } },
    }) as any;

    const migrated = collected.migrations[0]([task]);
    const msExt = migrated[0].ext?.['ms-todo'] as Record<string, unknown>;
    expect(msExt.list_id).toBe('old-list-field');
    expect(msExt.list).toBeUndefined();
    expect(msExt.id).toBe('some-id');
  });

  it('A3.6: handles double-nested with list (not list_id) in inner', () => {
    const { api, collected } = msTodoApi();
    register(api);

    const task = msTodoTask({
      ext: { 'ms-todo': { 'ms-todo': { id: 'deep-id', list: 'deep-list' } } },
    }) as any;

    const migrated = collected.migrations[0]([task]);
    expect(migrated[0].ext?.['ms-todo']).toEqual({ id: 'deep-id', list_id: 'deep-list' });
  });

  it('A3.8: migration is idempotent', () => {
    const { api, collected } = msTodoApi();
    register(api);

    const task = msTodoTask() as any;
    task.ms_todo_id = 'ms-old-id';

    const first = collected.migrations[0]([task]);
    const second = collected.migrations[0](first);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });
});

// C6: Error handling
describe('C6: MS To-Do error handling', () => {
  it('C6.1: createTask propagates autoPushTask errors', async () => {
    const { api, collected } = msTodoApi();
    register(api);
    mockAutoPushTask.mockRejectedValue(new Error('Graph API timeout'));

    await expect(collected.sync!.createTask(msTodoTask())).rejects.toThrow('Graph API timeout');
  });
});

// Display
describe('MS To-Do display', () => {
  it('getExternalUrl returns MS To-Do URL', () => {
    const { api, collected } = msTodoApi();
    register(api);
    expect(collected.display!.getExternalUrl(msTodoTask())).toBe('https://to-do.microsoft.com');
  });

  it('syncTooltip shows error when sync_error present', () => {
    const { api, collected } = msTodoApi();
    register(api);
    expect(collected.display!.syncTooltip!(msTodoTask({ sync_error: 'Graph 401' }))).toContain('Graph 401');
  });
});
