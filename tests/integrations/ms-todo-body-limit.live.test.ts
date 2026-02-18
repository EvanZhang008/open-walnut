/**
 * Live test: MS To-Do body size limits.
 *
 * Creates a task with progressively larger body content to find
 * the practical limit of the MS Graph API todoTask body field.
 *
 * Requires: `walnut auth` (MS To-Do authentication) completed beforehand.
 *
 * Run with:
 *   WALNUT_LIVE_TEST=1 npx vitest run tests/integrations/ms-todo-body-limit.live.test.ts --config vitest.live.config.ts
 */

import { describe, it, expect, afterAll } from 'vitest';
import { isLiveTest } from '../helpers/live.js';
import {
  pushTask,
  getTaskLists,
  createList,
  deleteList,
} from '../../src/integrations/microsoft-todo.js';
import type { Task } from '../../src/core/types.js';

const TEST_LIST_NAME = '__walnut-body-limit-test__';

/** Generate a string of approximately `chars` characters. */
function makeContent(chars: number, label: string): string {
  const prefix = `[${label}] `;
  const fill = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789 ';
  let s = prefix;
  while (s.length < chars) {
    s += fill;
  }
  return s.slice(0, chars);
}

function makeTestTask(noteContent: string): Task {
  const now = new Date().toISOString();
  return {
    id: `body-limit-test-${Date.now()}`,
    title: `Body limit test (~${Math.round(noteContent.length / 1024)}KB)`,
    status: 'todo',
    priority: 'backlog',
    category: TEST_LIST_NAME,
    project: TEST_LIST_NAME,
    source: 'ms-todo',
    session_ids: [],
    active_session_ids: [],
    created_at: now,
    updated_at: now,
    description: '',
    summary: '',
    note: noteContent,
  };
}

describe.skipIf(!isLiveTest())('MS To-Do body size limits', () => {
  let testListId: string | undefined;
  const createdTaskIds: string[] = [];

  // Ensure test list exists
  async function ensureTestList(): Promise<string> {
    if (testListId) return testListId;
    const lists = await getTaskLists();
    const existing = lists.find((l) => l.displayName === TEST_LIST_NAME);
    if (existing) {
      testListId = existing.id;
    } else {
      const created = await createList(TEST_LIST_NAME);
      testListId = created.id;
    }
    return testListId;
  }

  afterAll(async () => {
    // Clean up: delete the test list (which deletes all tasks in it)
    if (testListId) {
      try {
        await deleteList(testListId);
        console.log(`Cleaned up test list: ${TEST_LIST_NAME}`);
      } catch (err) {
        console.warn(`Failed to clean up test list: ${err}`);
      }
    }
  });

  // Test cases: progressively larger bodies
  const testCases = [
    { size: 100, label: '100B' },
    { size: 1_000, label: '1KB' },
    { size: 10_000, label: '10KB' },
    { size: 50_000, label: '50KB' },
    { size: 100_000, label: '100KB' },
    { size: 500_000, label: '500KB' },
    { size: 1_000_000, label: '1MB' },
    { size: 2_000_000, label: '2MB' },
  ];

  for (const { size, label } of testCases) {
    it(`pushes body of ~${label}`, async () => {
      await ensureTestList();

      const noteContent = makeContent(size, `body-${label}`);
      const task = makeTestTask(noteContent);

      // Override ms_todo_list to point to our test list
      task.ms_todo_list = testListId;

      const startMs = Date.now();
      let msId: string | undefined;
      let error: Error | undefined;

      try {
        msId = await pushTask(task);
        createdTaskIds.push(msId);
      } catch (err) {
        error = err as Error;
      }

      const elapsed = Date.now() - startMs;

      if (error) {
        console.log(
          `FAILED at ~${label} (${size.toLocaleString()} chars, ${elapsed}ms): ${error.message}`,
        );
        // We found the limit — this is expected at some point
        expect(error.message).toContain('Graph API');
      } else {
        console.log(
          `OK at ~${label} (${size.toLocaleString()} chars, ${elapsed}ms) → ms_todo_id: ${msId}`,
        );
        expect(msId).toBeTruthy();
      }
    });
  }
});
