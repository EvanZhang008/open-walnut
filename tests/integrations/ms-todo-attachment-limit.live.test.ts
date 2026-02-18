/**
 * Live test: MS To-Do attachment size limits.
 *
 * Creates a task and attaches files of progressively larger sizes to find
 * the practical limits of the Graph API todoTask attachment endpoint.
 *
 * MS docs say:
 * - Direct upload (inline base64): < 3 MB
 * - Upload session: > 3 MB (for larger files)
 *
 * This test verifies the direct upload limit.
 *
 * Requires: `walnut auth` (MS To-Do authentication) completed beforehand.
 *
 * Run with:
 *   WALNUT_LIVE_TEST=1 npx vitest run tests/integrations/ms-todo-attachment-limit.live.test.ts --config vitest.live.config.ts
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
} from '../../src/integrations/microsoft-todo.js';
import type { Task } from '../../src/core/types.js';

const TEST_LIST_NAME = '__walnut-attachment-limit-test__';

interface AttachmentResponse {
  id: string;
  name: string;
  size: number;
  contentType: string;
  lastModifiedDateTime: string;
}

/** Generate random binary data of `bytes` size, return as base64. */
function makeBase64(bytes: number): string {
  const buf = Buffer.alloc(bytes);
  // Fill with pseudo-random but deterministic data
  for (let i = 0; i < bytes; i++) {
    buf[i] = (i * 7 + 13) & 0xff;
  }
  return buf.toString('base64');
}

function makeTestTask(): Task {
  const now = new Date().toISOString();
  return {
    id: `attach-limit-test-${Date.now()}`,
    title: `Attachment limit test ${new Date().toISOString()}`,
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
    note: '',
  };
}

describe.skipIf(!isLiveTest())('MS To-Do attachment size limits', () => {
  let testListId: string;
  let testTaskMsId: string;
  let token: string;

  beforeAll(async () => {
    // Get auth token
    token = await getAccessToken();

    // Ensure test list exists
    const lists = await getTaskLists();
    const existing = lists.find((l) => l.displayName === TEST_LIST_NAME);
    if (existing) {
      testListId = existing.id;
    } else {
      const created = await createList(TEST_LIST_NAME);
      testListId = created.id;
    }

    // Create a single test task to attach files to
    const task = makeTestTask();
    task.ms_todo_list = testListId;
    testTaskMsId = await pushTask(task);
    console.log(`Test task created: ${testTaskMsId}`);
  });

  afterAll(async () => {
    // Clean up: delete the test list (deletes all tasks + attachments)
    if (testListId) {
      try {
        await deleteList(testListId);
        console.log(`Cleaned up test list: ${TEST_LIST_NAME}`);
      } catch (err) {
        console.warn(`Failed to clean up test list: ${err}`);
      }
    }
  });

  // Direct upload test cases (< 3MB per MS docs)
  const directUploadCases = [
    { bytes: 1_000, label: '1KB' },
    { bytes: 10_000, label: '10KB' },
    { bytes: 100_000, label: '100KB' },
    { bytes: 500_000, label: '500KB' },
    { bytes: 1_000_000, label: '1MB' },
    { bytes: 2_000_000, label: '2MB' },
    { bytes: 2_500_000, label: '2.5MB' },
    { bytes: 3_000_000, label: '3MB' },
    { bytes: 3_500_000, label: '3.5MB' },
    { bytes: 4_000_000, label: '4MB' },
    { bytes: 6_000_000, label: '6MB' },
    { bytes: 8_000_000, label: '8MB' },
    { bytes: 10_000_000, label: '10MB' },
    { bytes: 15_000_000, label: '15MB' },
    { bytes: 20_000_000, label: '20MB' },
    { bytes: 25_000_000, label: '25MB' },
  ];

  for (const { bytes, label } of directUploadCases) {
    it(`direct upload: ${label} file`, async () => {
      const base64Content = makeBase64(bytes);
      const base64Size = Buffer.byteLength(base64Content);

      const startMs = Date.now();
      let response: AttachmentResponse | undefined;
      let error: Error | undefined;

      try {
        response = await graphRequest<AttachmentResponse>(
          token,
          'POST',
          `/me/todo/lists/${testListId}/tasks/${testTaskMsId}/attachments`,
          {
            '@odata.type': '#microsoft.graph.taskFileAttachment',
            name: `test-${label}.bin`,
            contentBytes: base64Content,
            contentType: 'application/octet-stream',
          },
        );
      } catch (err) {
        error = err as Error;
      }

      const elapsed = Date.now() - startMs;

      if (error) {
        console.log(
          `FAILED at ${label} (${bytes.toLocaleString()} raw bytes, ${base64Size.toLocaleString()} base64 bytes, ${elapsed}ms): ${error.message.slice(0, 300)}`,
        );
        expect(error.message).toContain('Graph API');
      } else {
        console.log(
          `OK at ${label} (${bytes.toLocaleString()} raw bytes, ${base64Size.toLocaleString()} base64 bytes, ${elapsed}ms) → id: ${response!.id.slice(0, 30)}... size: ${response!.size}`,
        );
        expect(response!.id).toBeTruthy();
        expect(response!.size).toBeGreaterThan(0);
      }
    });
  }

  it('lists all attachments on test task', async () => {
    const result = await graphRequest<{ value: AttachmentResponse[] }>(
      token,
      'GET',
      `/me/todo/lists/${testListId}/tasks/${testTaskMsId}/attachments`,
    );

    console.log(`\nTotal attachments: ${result.value.length}`);
    for (const att of result.value) {
      console.log(`  - ${att.name}: ${att.size.toLocaleString()} bytes (${att.contentType})`);
    }
    const totalSize = result.value.reduce((sum, a) => sum + a.size, 0);
    console.log(`Total size: ${(totalSize / 1024 / 1024).toFixed(2)} MB`);

    expect(result.value.length).toBeGreaterThan(0);
  });
});
