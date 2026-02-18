/**
 * Live test: MS To-Do dependency (DependsOn) roundtrip.
 *
 * Creates REAL tasks in Microsoft To-Do with DependsOn headers,
 * pulls them back, and verifies the header survives the roundtrip.
 *
 * Tests:
 * 1. Push task with single dep → pull → DependsOn header preserved
 * 2. Push task with multiple deps → pull → all IDs preserved
 * 3. Push task with deps + parent + description → all fields coexist
 * 4. Chain: task1, task2(dep:1), task3(dep:2) → pull all → verify chain
 * 5. Update: add deps to existing task → pull → header updated
 * 6. Clear deps → pull → DependsOn header gone
 *
 * Requires: `walnut auth` (MS To-Do authentication) completed beforehand.
 *
 * Run with:
 *   WALNUT_LIVE_TEST=1 npx vitest run tests/integrations/ms-todo-dependency.live.test.ts --config vitest.live.config.ts
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { isLiveTest } from '../helpers/live.js';
import {
  pushTask,
  getTaskLists,
  createList,
  deleteList,
  getAccessToken,
  graphRequest,
  parseMsTodoBody,
} from '../../src/integrations/microsoft-todo.js';
import type { Task } from '../../src/core/types.js';

const TEST_LIST_NAME = '__walnut-dep-test__';

interface MSTodoTask {
  id: string;
  title: string;
  status: string;
  body?: { content: string; contentType: string };
}

function makeTask(overrides: Partial<Task> = {}): Task {
  const now = new Date().toISOString();
  return {
    id: `dep-test-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    title: `Dep test ${Date.now()}`,
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

describe.skipIf(!isLiveTest())('MS To-Do dependency roundtrip (LIVE)', () => {
  let testListId: string;
  let token: string;

  beforeAll(async () => {
    token = await getAccessToken();
    const lists = await getTaskLists();
    const existing = lists.find((l) => l.displayName === TEST_LIST_NAME);
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

  /** Helper: push a task and pull it back from Graph API. */
  async function pushAndPull(task: Task): Promise<{ msId: string; body: string; parsed: ReturnType<typeof parseMsTodoBody> }> {
    task.ms_todo_list = testListId;
    const msId = await pushTask(task);

    const pulled = await graphRequest<MSTodoTask>(
      token,
      'GET',
      `/me/todo/lists/${testListId}/tasks/${msId}`,
    );

    const body = pulled.body?.content ?? '';
    const parsed = parseMsTodoBody(body);
    return { msId, body, parsed };
  }

  // ── Test 1: Single dependency ──

  it('roundtrips DependsOn header with single dep', async () => {
    const depId = 'aaaabbbbccccdddd11112222';
    const task = makeTask({
      title: 'Single dep test',
      depends_on: [depId],
      note: 'Has one dependency',
    });

    const { body, parsed } = await pushAndPull(task);
    console.log('Single dep body:', body.slice(0, 200));

    expect(body).toContain('DependsOn:');
    expect(parsed.depends_on).toBeDefined();
    expect(parsed.depends_on).toHaveLength(1);
    expect(parsed.depends_on![0]).toBe(depId.slice(0, 8)); // 8-char prefix
    expect(parsed.note).toBe('Has one dependency');
  });

  // ── Test 2: Multiple dependencies ──

  it('roundtrips DependsOn header with multiple deps', async () => {
    const dep1 = 'dep1aaaabbbbcccc';
    const dep2 = 'dep2ddddeeeeffff';
    const dep3 = 'dep3111122223333';
    const task = makeTask({
      title: 'Multi dep test',
      depends_on: [dep1, dep2, dep3],
      summary: 'Three deps',
    });

    const { body, parsed } = await pushAndPull(task);
    console.log('Multi dep body:', body.slice(0, 300));

    expect(body).toContain('DependsOn:');
    expect(parsed.depends_on).toHaveLength(3);
    expect(parsed.depends_on).toEqual([
      dep1.slice(0, 8),
      dep2.slice(0, 8),
      dep3.slice(0, 8),
    ]);
    expect(parsed.summary).toBe('Three deps');
  });

  // ── Test 3: DependsOn coexists with Parent, Phase, description ──

  it('roundtrips DependsOn alongside Parent and Phase headers', async () => {
    const task = makeTask({
      title: 'Full headers test',
      phase: 'IN_PROGRESS',
      status: 'in_progress',
      parent_task_id: 'parent1234567890abcdef',
      depends_on: ['dep1aaaabbbbcccc', 'dep2ddddeeeeffff'],
      description: 'Task with all headers',
      summary: 'Full summary',
      note: 'Full note',
    });

    const { body, parsed } = await pushAndPull(task);
    console.log('Full headers body:', body.slice(0, 400));

    // All headers parsed correctly
    expect(parsed.phase).toBe('IN_PROGRESS');
    expect(parsed.parent_task_id).toBe('parent12');
    expect(parsed.depends_on).toEqual(['dep1aaaa', 'dep2dddd']);

    // Body content preserved
    expect(parsed.description).toBe('Task with all headers');
    expect(parsed.summary).toBe('Full summary');
    expect(parsed.note).toBe('Full note');
  });

  // ── Test 4: Dependency chain (task1 → task2 → task3) ──

  it('creates a 3-task dependency chain and verifies each', async () => {
    // Task 1: no deps
    const task1 = makeTask({ title: 'Chain task 1 (root)', note: 'Root task' });
    const r1 = await pushAndPull(task1);
    expect(r1.parsed.depends_on).toBeUndefined();
    expect(r1.parsed.note).toBe('Root task');

    // Task 2: depends on task 1
    const task2 = makeTask({
      title: 'Chain task 2 (depends on 1)',
      depends_on: [task1.id],
      note: 'Depends on root',
    });
    const r2 = await pushAndPull(task2);
    expect(r2.parsed.depends_on).toHaveLength(1);
    expect(r2.parsed.depends_on![0]).toBe(task1.id.slice(0, 8));

    // Task 3: depends on task 2
    const task3 = makeTask({
      title: 'Chain task 3 (depends on 2)',
      depends_on: [task2.id],
      note: 'Depends on middle',
    });
    const r3 = await pushAndPull(task3);
    expect(r3.parsed.depends_on).toHaveLength(1);
    expect(r3.parsed.depends_on![0]).toBe(task2.id.slice(0, 8));

    console.log(`Chain: ${task1.id.slice(0, 8)} → ${task2.id.slice(0, 8)} → ${task3.id.slice(0, 8)}`);
  });

  // ── Test 5: Update — add deps to existing task ──

  it('adds DependsOn header to an existing task via update', async () => {
    // Create task without deps
    const task = makeTask({ title: 'Update deps test', note: 'Initially no deps' });
    task.ms_todo_list = testListId;
    const msId = await pushTask(task);

    // Verify no DependsOn initially
    const pulled1 = await graphRequest<MSTodoTask>(token, 'GET', `/me/todo/lists/${testListId}/tasks/${msId}`);
    const parsed1 = parseMsTodoBody(pulled1.body?.content ?? '');
    expect(parsed1.depends_on).toBeUndefined();

    // Now update with deps
    task.ms_todo_id = msId;
    task.depends_on = ['newdep11aabbccdd', 'newdep22eeffgghh'];
    task.note = 'Now has deps';
    await pushTask(task);

    // Pull again and verify
    const pulled2 = await graphRequest<MSTodoTask>(token, 'GET', `/me/todo/lists/${testListId}/tasks/${msId}`);
    const parsed2 = parseMsTodoBody(pulled2.body?.content ?? '');
    console.log('Updated body:', pulled2.body?.content?.slice(0, 200));

    expect(parsed2.depends_on).toHaveLength(2);
    expect(parsed2.depends_on).toEqual(['newdep11', 'newdep22']);
    expect(parsed2.note).toBe('Now has deps');
  });

  // ── Test 6: Clear deps — DependsOn header removed ──

  it('removes DependsOn header when deps are cleared', async () => {
    // Create with deps
    const task = makeTask({
      title: 'Clear deps test',
      depends_on: ['cleardep1aabbccdd'],
      note: 'Will clear deps',
    });
    task.ms_todo_list = testListId;
    const msId = await pushTask(task);

    // Verify DependsOn present
    const pulled1 = await graphRequest<MSTodoTask>(token, 'GET', `/me/todo/lists/${testListId}/tasks/${msId}`);
    const parsed1 = parseMsTodoBody(pulled1.body?.content ?? '');
    expect(parsed1.depends_on).toHaveLength(1);

    // Clear deps
    task.ms_todo_id = msId;
    delete task.depends_on;
    task.note = 'Deps cleared';
    await pushTask(task);

    // Verify DependsOn gone
    const pulled2 = await graphRequest<MSTodoTask>(token, 'GET', `/me/todo/lists/${testListId}/tasks/${msId}`);
    const parsed2 = parseMsTodoBody(pulled2.body?.content ?? '');
    console.log('Cleared body:', pulled2.body?.content?.slice(0, 200));

    expect(parsed2.depends_on).toBeUndefined();
    expect(parsed2.note).toBe('Deps cleared');
  });

  // ── Test 7: Diamond deps (task depends on 2 tasks) ──

  it('roundtrips diamond dependency (one task depends on two)', async () => {
    const taskA = makeTask({ title: 'Diamond A' });
    const taskB = makeTask({ title: 'Diamond B' });
    const taskC = makeTask({
      title: 'Diamond C (depends on A+B)',
      depends_on: [taskA.id, taskB.id],
      note: 'Blocked by both A and B',
    });

    const rc = await pushAndPull(taskC);
    expect(rc.parsed.depends_on).toHaveLength(2);
    expect(rc.parsed.depends_on).toEqual([
      taskA.id.slice(0, 8),
      taskB.id.slice(0, 8),
    ]);
    console.log(`Diamond: ${taskA.id.slice(0, 8)}, ${taskB.id.slice(0, 8)} → ${taskC.id.slice(0, 8)}`);
  });
});
