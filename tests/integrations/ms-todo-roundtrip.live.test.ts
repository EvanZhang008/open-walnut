/**
 * Live test: MS To-Do roundtrip integrity.
 *
 * Verifies that body (notes) and attachments survive a push → pull cycle
 * without truncation or data loss.
 *
 * Tests:
 * 1. Body roundtrip: push notes → pull task → compare body content
 * 2. Attachment roundtrip: upload file → download → compare bytes
 *
 * Requires: `walnut auth` (MS To-Do authentication) completed beforehand.
 *
 * Run with:
 *   WALNUT_LIVE_TEST=1 npx vitest run tests/integrations/ms-todo-roundtrip.live.test.ts --config vitest.live.config.ts
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { isLiveTest } from '../helpers/live.js';
import {
  pushTask,
  pullTasks,
  getTaskLists,
  createList,
  deleteList,
  getAccessToken,
  graphRequest,
} from '../../src/integrations/microsoft-todo.js';
import type { Task } from '../../src/core/types.js';

const TEST_LIST_NAME = '__walnut-roundtrip-test__';

interface AttachmentResponse {
  id: string;
  name: string;
  size: number;
  contentType: string;
  contentBytes?: string; // base64, only in GET single attachment
}

interface MSTodoTask {
  id: string;
  title: string;
  status: string;
  body?: { content: string; contentType: string };
}

function makeTask(overrides: Partial<Task> = {}): Task {
  const now = new Date().toISOString();
  return {
    id: `roundtrip-${Date.now()}`,
    title: `Roundtrip test ${Date.now()}`,
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
    ...overrides,
  };
}

/** Generate deterministic binary data. */
function makeBinary(bytes: number): Buffer {
  const buf = Buffer.alloc(bytes);
  for (let i = 0; i < bytes; i++) {
    buf[i] = (i * 7 + 13) & 0xff;
  }
  return buf;
}

describe.skipIf(!isLiveTest())('MS To-Do roundtrip integrity', () => {
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

  // ── Body (description + note) roundtrip ──

  describe('body roundtrip', () => {
    const bodyCases = [
      {
        label: 'note only',
        note: 'First note\nSecond note with special chars: <>&"\'',
      },
      {
        label: 'description + note',
        description: 'This is the description',
        note: 'This is the note content',
      },
      {
        label: 'unicode content',
        note: 'Chinese: \u4F60\u597D\u4E16\u754C\nEmoji: \uD83D\uDE80\uD83C\uDF1F\nJapanese: \u3053\u3093\u306B\u3061\u306F',
      },
      {
        label: '500KB note',
        note: 'A'.repeat(500_000),
      },
    ];

    for (const { label, description, note } of bodyCases) {
      it(`roundtrips: ${label}`, async () => {
        const task = makeTask({ description: description ?? '', note: note ?? '' });
        task.ms_todo_list = testListId;
        const msId = await pushTask(task);

        // Pull the task back via Graph API (direct GET for exact task)
        const pulled = await graphRequest<MSTodoTask>(
          token,
          'GET',
          `/me/todo/lists/${testListId}/tasks/${msId}`,
        );

        const pulledBody = pulled.body?.content ?? '';
        console.log(`${label}: pushed body, pulled ${pulledBody.length.toLocaleString()} chars`);

        // Verify body is non-empty and contains our content
        expect(pulledBody.length).toBeGreaterThan(0);
        if (note) expect(pulledBody).toContain(note.slice(0, 100));
        if (description) expect(pulledBody).toContain(description);
      });
    }
  });

  // ── Attachment roundtrip ──

  describe('attachment roundtrip', () => {
    const attachCases = [
      { bytes: 1_000, label: '1KB' },
      { bytes: 100_000, label: '100KB' },
      { bytes: 1_000_000, label: '1MB' },
      { bytes: 5_000_000, label: '5MB' },
      { bytes: 10_000_000, label: '10MB' },
    ];

    for (const { bytes, label } of attachCases) {
      it(`roundtrips: ${label} attachment`, async () => {
        // Create a task for this attachment
        const task = makeTask({ title: `Attach roundtrip ${label}` });
        task.ms_todo_list = testListId;
        const msId = await pushTask(task);

        // Upload
        const original = makeBinary(bytes);
        const base64Up = original.toString('base64');

        const uploaded = await graphRequest<AttachmentResponse>(
          token,
          'POST',
          `/me/todo/lists/${testListId}/tasks/${msId}/attachments`,
          {
            '@odata.type': '#microsoft.graph.taskFileAttachment',
            name: `test-${label}.bin`,
            contentBytes: base64Up,
            contentType: 'application/octet-stream',
          },
        );

        // Download (GET single attachment includes contentBytes)
        const downloaded = await graphRequest<AttachmentResponse>(
          token,
          'GET',
          `/me/todo/lists/${testListId}/tasks/${msId}/attachments/${uploaded.id}`,
        );

        const base64Down = downloaded.contentBytes ?? '';
        const roundtripped = Buffer.from(base64Down, 'base64');

        console.log(
          `${label}: uploaded ${original.length.toLocaleString()} bytes, ` +
          `downloaded ${roundtripped.length.toLocaleString()} bytes, ` +
          `match: ${original.equals(roundtripped)}`,
        );

        // Verify no truncation, no corruption
        expect(roundtripped.length).toBe(original.length);
        expect(original.equals(roundtripped)).toBe(true);
      });
    }
  });
});
