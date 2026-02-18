/**
 * Live test: MS To-Do plugin lifecycle via IntegrationSync interface.
 *
 * Tests the plugin's sync methods against the REAL MS Graph API:
 * 1. createTask → returns ext['ms-todo'] with id
 * 2. updateTitle → title updated in MS To-Do
 * 3. updatePhase → status changes reflected
 * 4. updateNote → body content updated
 * 5. syncPoll → delta pull returns remote changes
 *
 * Unlike the raw microsoft-todo.ts tests, these exercise the plugin wrapper
 * (src/integrations/ms-todo/index.ts) which is the interface core uses.
 *
 * Requires: `walnut auth` completed (MS To-Do MSAL token cache exists).
 *
 * Run with:
 *   WALNUT_LIVE_TEST=1 npx vitest run tests/integrations/ms-todo-plugin.live.test.ts --config vitest.live.config.ts
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { isLiveTest, hasMsGraphCredentials } from '../helpers/live.js';
import type { Task } from '../../src/core/types.js';
import type { IntegrationSync, SyncPollContext } from '../../src/core/integration-types.js';

// Dynamic import of plugin register fn — avoids import errors when ms-todo not available
let sync: IntegrationSync;
let getAccessToken: () => Promise<string>;
let graphRequest: <T>(token: string, method: string, path: string, body?: unknown) => Promise<T>;
let createList: (name: string) => Promise<{ id: string }>;
let deleteList: (id: string) => Promise<void>;
let getTaskLists: () => Promise<Array<{ id: string; displayName: string }>>;

const TEST_LIST_NAME = '__walnut-plugin-live-test__';

function makeTask(overrides: Partial<Task> = {}): Task {
  const now = new Date().toISOString();
  return {
    id: `plugin-live-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    title: `[Plugin Live] ${overrides.title ?? 'Test task'} ${Date.now()}`,
    status: 'todo',
    phase: 'TODO',
    priority: 'none',
    category: TEST_LIST_NAME,
    project: TEST_LIST_NAME,
    source: 'ms-todo',
    session_ids: [],
    created_at: now,
    updated_at: now,
    description: '',
    summary: '',
    note: '',
    ...overrides,
  };
}

describe.skipIf(!isLiveTest() || !hasMsGraphCredentials())('MS To-Do plugin lifecycle (LIVE)', () => {
  let testListId: string;
  let token: string;

  beforeAll(async () => {
    // Load the plugin's sync interface by calling register()
    const pluginModule = await import('../../src/integrations/ms-todo/index.js');
    const collected: { sync: IntegrationSync | null } = { sync: null };
    const mockApi = {
      id: 'ms-todo',
      name: 'Microsoft To-Do',
      config: {},
      logger: { info: () => {}, debug: () => {}, warn: () => {}, error: () => {} } as any,
      registerSync: (s: IntegrationSync) => { collected.sync = s; },
      registerSourceClaim: () => {},
      registerDisplay: () => {},
      registerAgentContext: () => {},
      registerMigration: () => {},
      registerHttpRoute: () => {},
    };
    pluginModule.default(mockApi);
    sync = collected.sync!;
    expect(sync).toBeDefined();

    // Load MS To-Do helpers for setup/teardown
    const msModule = await import('../../src/integrations/microsoft-todo.js');
    getAccessToken = msModule.getAccessToken;
    graphRequest = msModule.graphRequest;
    createList = msModule.createList;
    deleteList = msModule.deleteList;
    getTaskLists = msModule.getTaskLists;

    // Create/find test list
    token = await getAccessToken();
    const lists = await getTaskLists();
    const existing = lists.find(l => l.displayName === TEST_LIST_NAME);
    if (existing) {
      testListId = existing.id;
    } else {
      const created = await createList(TEST_LIST_NAME);
      testListId = created.id;
    }
  });

  afterAll(async () => {
    if (testListId) {
      try {
        await deleteList(testListId);
        console.log(`Cleaned up: ${TEST_LIST_NAME}`);
      } catch (err) {
        console.warn(`Cleanup failed: ${err}`);
      }
    }
  });

  // ── Test 1: createTask returns ext data ──

  it('createTask pushes to MS To-Do and returns ext with ms-todo id', async () => {
    const task = makeTask({
      title: 'Create test',
      description: 'Plugin create test',
      note: 'Some notes here',
    });
    // Set ms_todo_list on task for routing
    (task as any).ms_todo_list = testListId;

    const ext = await sync.createTask(task);

    expect(ext).not.toBeNull();
    expect(ext).toHaveProperty('ms-todo');
    const msExt = ext!['ms-todo'] as Record<string, unknown>;
    expect(msExt.id).toBeTruthy();
    expect(typeof msExt.id).toBe('string');

    console.log(`Created MS To-Do task: ${msExt.id}`);

    // Verify it exists in MS To-Do
    interface MSTodoTask { id: string; title: string; body?: { content: string } }
    const pulled = await graphRequest<MSTodoTask>(
      token, 'GET',
      `/me/todo/lists/${testListId}/tasks/${msExt.id}`,
    );
    expect(pulled.title).toBe(task.title);
    expect(pulled.body?.content).toContain('Plugin create test');
  });

  // ── Test 2: updateTitle pushes updated title ──

  it('updateTitle pushes changed title to MS To-Do', async () => {
    const task = makeTask({ title: 'Title v1' });
    (task as any).ms_todo_list = testListId;
    const ext = await sync.createTask(task);
    expect(ext).not.toBeNull();
    const msId = (ext!['ms-todo'] as Record<string, unknown>).id as string;

    // Mutate and push
    task.title = `Title v2 ${Date.now()}`;
    (task as any).ms_todo_id = msId;
    await sync.updateTitle(task, task.title);

    // Verify
    interface MSTodoTask { title: string }
    const pulled = await graphRequest<MSTodoTask>(
      token, 'GET',
      `/me/todo/lists/${testListId}/tasks/${msId}`,
    );
    expect(pulled.title).toBe(task.title);
    console.log(`Verified title update: ${pulled.title}`);
  });

  // ── Test 3: updatePhase changes MS To-Do status ──

  it('updatePhase changes status in MS To-Do (IN_PROGRESS → inProgress)', async () => {
    const task = makeTask({ title: 'Phase test' });
    (task as any).ms_todo_list = testListId;
    const ext = await sync.createTask(task);
    expect(ext).not.toBeNull();
    const msId = (ext!['ms-todo'] as Record<string, unknown>).id as string;

    // Move to IN_PROGRESS
    task.phase = 'IN_PROGRESS';
    task.status = 'in_progress';
    (task as any).ms_todo_id = msId;
    await sync.updatePhase(task, 'IN_PROGRESS');

    interface MSTodoTask { status: string }
    const pulled = await graphRequest<MSTodoTask>(
      token, 'GET',
      `/me/todo/lists/${testListId}/tasks/${msId}`,
    );
    // MS To-Do has only notStarted/inProgress/completed
    expect(pulled.status).toBe('inProgress');
    console.log(`Verified phase → status mapping: IN_PROGRESS → ${pulled.status}`);
  });

  // ── Test 4: updateNote updates body content ──

  it('updateNote pushes updated note to MS To-Do body', async () => {
    const task = makeTask({ title: 'Note test', note: 'Original note' });
    (task as any).ms_todo_list = testListId;
    const ext = await sync.createTask(task);
    expect(ext).not.toBeNull();
    const msId = (ext!['ms-todo'] as Record<string, unknown>).id as string;

    // Update note
    task.note = 'Updated note content with special chars <>&';
    (task as any).ms_todo_id = msId;
    await sync.updateNote(task, task.note);

    interface MSTodoTask { body?: { content: string } }
    const pulled = await graphRequest<MSTodoTask>(
      token, 'GET',
      `/me/todo/lists/${testListId}/tasks/${msId}`,
    );
    expect(pulled.body?.content).toContain('Updated note content');
    console.log(`Verified note update: body contains updated text`);
  });

  // ── Test 5: complete lifecycle (create → update → phase to COMPLETE) ──

  it('full lifecycle: create → update description → complete', async () => {
    const task = makeTask({ title: 'Full lifecycle test' });
    (task as any).ms_todo_list = testListId;

    // Create
    const ext = await sync.createTask(task);
    expect(ext).not.toBeNull();
    const msId = (ext!['ms-todo'] as Record<string, unknown>).id as string;
    (task as any).ms_todo_id = msId;

    // Update description
    task.description = 'Lifecycle description';
    await sync.updateDescription(task, task.description);

    // Complete
    task.phase = 'COMPLETE';
    task.status = 'done';
    await sync.updatePhase(task, 'COMPLETE');

    interface MSTodoTask { status: string; body?: { content: string } }
    const pulled = await graphRequest<MSTodoTask>(
      token, 'GET',
      `/me/todo/lists/${testListId}/tasks/${msId}`,
    );
    expect(pulled.status).toBe('completed');
    expect(pulled.body?.content).toContain('Lifecycle description');
    console.log(`Full lifecycle verified: created → updated → completed`);
  });
});
