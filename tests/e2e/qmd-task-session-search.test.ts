/**
 * Category B: QMD Task + Session Search E2E
 *
 * Tests that tasks and sessions are synced to QMD stores and searchable
 * via the status API, search API, and memoryNotesSearch function.
 *
 * B1: QMD status API returns 4 stores (tasks + sessions have totalIndexed > 0)
 * B2: search() with types=['session'] returns session results
 * B3: memoryNotesSearch with sources=['task'] routes to task store
 * B4: memoryNotesSearch with sources=['session'] routes to session store
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { Server as HttpServer } from 'node:http';
import { createMockConstants } from '../helpers/mock-constants.js';

vi.mock('../../src/constants.js', () => createMockConstants('walnut-e2e-qmd-search'));

import {
  WALNUT_HOME,
  TASKS_DIR,
  TASKS_FILE,
  SESSIONS_FILE,
  MEMORY_DIR,
  NOTES_DIR,
} from '../../src/constants.js';
import { startServer, stopServer } from '../../src/web/server.js';
import { memoryNotesSearch } from '../../src/core/memory-search.js';
import { getTaskStore } from '../../src/core/qmd-store.js';
import { getSessionStore } from '../../src/core/qmd-store.js';
import {
  deleteSessionRecords,
  updateSessionRecord,
} from '../../src/core/session-tracker.js';
import { updateTaskRaw } from '../../src/core/task-manager.js';
import { bus, EventNames } from '../../src/core/event-bus.js';
import {
  getQmdIndexWorkState,
  waitForQmdIndexWork,
} from '../../src/core/qmd-work-queue.js';

let server: HttpServer;
let port: number;
const startupQmdLabels = new Set<string>();

function apiUrl(p: string): string {
  return `http://localhost:${port}${p}`;
}

// ── Seed data ──

const SEED_TASKS = [
  {
    id: 'task-alpha-001',
    title: 'Implement authentication middleware',
    status: 'todo',
    priority: 'important',
    category: 'Work',
    project: 'Backend',
    session_ids: [],
    note: 'JWT tokens with refresh rotation',
    phase: 'TODO',
    source: 'local',
    description: 'Add Express middleware for JWT auth',
    created_at: '2026-04-01T00:00:00Z',
    updated_at: '2026-04-10T00:00:00Z',
  },
  {
    id: 'task-beta-002',
    title: 'Design database schema for user profiles',
    status: 'todo',
    priority: 'none',
    category: 'Work',
    project: 'Backend',
    session_ids: [],
    note: 'PostgreSQL with JSONB columns',
    phase: 'TODO',
    source: 'local',
    description: 'Schema design for user profiles table',
    created_at: '2026-04-02T00:00:00Z',
    updated_at: '2026-04-10T00:00:00Z',
  },
  {
    id: 'task-gamma-003',
    title: 'Write unit tests for payment gateway',
    status: 'todo',
    priority: 'urgent',
    category: 'Work',
    project: 'Payments',
    session_ids: [],
    note: 'Cover Stripe webhook handling',
    phase: 'TODO',
    source: 'local',
    description: 'Test coverage for payment processing module',
    created_at: '2026-04-03T00:00:00Z',
    updated_at: '2026-04-10T00:00:00Z',
  },
  {
    id: 'task-semantic-004',
    title: 'Achievement self-review for manager',
    status: 'todo',
    priority: 'important',
    category: 'Work',
    project: 'Career',
    session_ids: [],
    note: 'Demonstrates leadership impact across major launches',
    phase: 'TODO',
    source: 'local',
    description: 'Compiled promotion evidence and accomplishments for annual performance discussion',
    created_at: '2026-04-04T00:00:00Z',
    updated_at: '2026-04-10T00:00:00Z',
  },
  {
    id: 'task-semantic-en-005',
    title: 'Assemble promotion impact dossier',
    status: 'todo',
    priority: 'important',
    category: 'Work',
    project: 'Reviews',
    session_ids: [],
    note: 'Summarize leadership outcomes across major launches for a manager review',
    phase: 'TODO',
    source: 'local',
    description: 'Collect evidence of broad organizational influence and delivery results',
    created_at: '2026-04-05T00:00:00Z',
    updated_at: '2026-04-10T00:00:00Z',
  },
  {
    id: 'task-semantic-zh-006',
    title: 'Refresh token rotation signs users out',
    status: 'todo',
    priority: 'important',
    category: 'Work',
    project: 'Identity',
    session_ids: [],
    note: 'Authentication credentials expire during silent renewal',
    phase: 'TODO',
    source: 'local',
    description: 'Keep authenticated clients active while credentials are renewed',
    created_at: '2026-04-06T00:00:00Z',
    updated_at: '2026-04-10T00:00:00Z',
  },
  {
    id: 'task-semantic-mixed-007',
    title: 'Restore concept retrieval after embedding upgrade',
    status: 'todo',
    priority: 'important',
    category: 'Work',
    project: 'Indexing',
    session_ids: [],
    note: 'Vector index migration stopped returning related work items',
    phase: 'TODO',
    source: 'local',
    description: 'Repair nearest-neighbor lookup after changing representation models',
    created_at: '2026-04-07T00:00:00Z',
    updated_at: '2026-04-10T00:00:00Z',
  },
  ...Array.from({ length: 24 }, (_, index) => ({
    id: `task-distractor-${String(index + 1).padStart(3, '0')}`,
    title: `Routine operations item ${index + 1}`,
    status: 'todo',
    priority: 'none',
    category: index % 2 === 0 ? 'Personal' : 'Work',
    project: index % 3 === 0 ? 'Planning' : 'Maintenance',
    session_ids: [],
    note: `Checklist ${index + 1} for schedules, inventory, and recurring administration`,
    phase: 'TODO',
    source: 'local',
    description: `Track ordinary coordination details for weekly process ${index + 1}`,
    created_at: '2026-04-08T00:00:00Z',
    updated_at: '2026-04-10T00:00:00Z',
  })),
];

const MULTILINGUAL_SEMANTIC_CASES = [
  {
    language: 'short English',
    query: 'career wins',
    taskId: 'task-semantic-en-005',
    title: 'Assemble promotion impact dossier',
  },
  {
    language: 'Chinese',
    query: '登录状态总是失效',
    taskId: 'task-semantic-zh-006',
    title: 'Refresh token rotation signs users out',
  },
  {
    language: 'mixed Chinese/English',
    query: '语义 search 坏了',
    taskId: 'task-semantic-mixed-007',
    title: 'Restore concept retrieval after embedding upgrade',
  },
] as const;

const SEED_SESSIONS = [
  {
    claudeSessionId: 'sess-qmd-test-aaa111',
    taskId: 'task-alpha-001',
    project: 'Backend',
    process_status: 'stopped',
    mode: 'exec',
    startedAt: '2026-04-09T10:00:00Z',
    lastActiveAt: '2026-04-09T11:00:00Z',
    messageCount: 5,
    title: 'Authentication middleware implementation session',
    description: 'Implemented JWT auth middleware with refresh token rotation',
  },
  {
    claudeSessionId: 'sess-qmd-test-bbb222',
    taskId: 'task-gamma-003',
    project: 'Payments',
    process_status: 'stopped',
    mode: 'exec',
    startedAt: '2026-04-10T14:00:00Z',
    lastActiveAt: '2026-04-10T15:30:00Z',
    messageCount: 12,
    title: 'Payment gateway unit tests session',
    description: 'Wrote comprehensive Stripe webhook handler tests',
  },
];

// ── Setup / Teardown ──

beforeAll(async () => {
  // Clean + create directories
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true });
  await fsp.mkdir(WALNUT_HOME, { recursive: true });
  await fsp.mkdir(TASKS_DIR, { recursive: true });
  await fsp.mkdir(MEMORY_DIR, { recursive: true });

  // Seed tasks.json
  fs.writeFileSync(
    TASKS_FILE,
    JSON.stringify({ version: 1, tasks: SEED_TASKS }),
    'utf-8',
  );

  // Seed sessions.json
  fs.writeFileSync(
    SESSIONS_FILE,
    JSON.stringify({ version: 2, sessions: SEED_SESSIONS }),
    'utf-8',
  );

  // Start server (QMD sync happens in background). Sample the real production
  // queue so this suite proves startup entry points use it, not only that the
  // queue helper works in isolation.
  const startupSampler = setInterval(() => {
    const label = getQmdIndexWorkState().activeLabel;
    if (label) startupQmdLabels.add(label);
  }, 5);
  server = await startServer({ port: 0, dev: true });
  const addr = server.address();
  port = typeof addr === 'object' && addr ? addr.port : 0;

  // Wait for QMD task + session sync to complete.
  // syncAllTasks and syncAllSessions run in the background on server start.
  // FTS5 triggers fire synchronously on insert, so keyword search works immediately
  // once sync finishes. Poll until task store has indexed docs.
  const maxWaitMs = 30_000;
  const pollMs = 500;
  const start = Date.now();
  let ready = false;
  while (Date.now() - start < maxWaitMs) {
    try {
      const res = await fetch(apiUrl('/api/qmd/status'));
      const data = await res.json();
      const tasksReady = data.stores?.tasks?.totalIndexed >= 3;
      const sessionsReady = data.stores?.sessions?.totalIndexed >= 2;
      if (tasksReady && sessionsReady) {
        ready = true;
        break;
      }
    } catch {
      // Server or QMD not ready yet
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }

  if (!ready) {
    // Log current state for debugging, but don't fail — tests will catch specifics
    try {
      const res = await fetch(apiUrl('/api/qmd/status'));
      const data = await res.json();
      console.warn('QMD sync did not reach expected counts within timeout:', JSON.stringify(data.stores, null, 2));
    } catch {}
  }
  clearInterval(startupSampler);
}, 60_000);

afterAll(async () => {
  await stopServer();
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true });
}, 15_000);

// ── Tests ──

describe('Category B: QMD Task + Session Search', () => {
  // B1: QMD status API returns 4 stores with indexed data
  describe('B1: QMD status API', () => {
    it('returns stores.tasks with totalIndexed >= 3', async () => {
      const res = await fetch(apiUrl('/api/qmd/status'));
      expect(res.status).toBe(200);
      const data = await res.json();

      expect(data.stores).toBeDefined();
      expect(data.stores.tasks).toBeDefined();
      expect(data.stores.tasks.totalIndexed).toBeGreaterThanOrEqual(3);
    });

    it('returns stores.sessions with totalIndexed >= 2', async () => {
      const res = await fetch(apiUrl('/api/qmd/status'));
      expect(res.status).toBe(200);
      const data = await res.json();

      expect(data.stores).toBeDefined();
      expect(data.stores.sessions).toBeDefined();
      expect(data.stores.sessions.totalIndexed).toBeGreaterThanOrEqual(2);
    });

    it('returns all 4 store keys (memory, notes, tasks, sessions)', async () => {
      const res = await fetch(apiUrl('/api/qmd/status'));
      expect(res.status).toBe(200);
      const data = await res.json();

      expect(data.stores).toHaveProperty('memory');
      expect(data.stores).toHaveProperty('notes');
      expect(data.stores).toHaveProperty('tasks');
      expect(data.stores).toHaveProperty('sessions');
    });

    it('serializes every production startup indexing phase', () => {
      for (const label of [
        'qmd:startup-init',
        'tasks:startup-sync',
        'sessions:startup-sync',
      ]) {
        expect(startupQmdLabels.has(label), `missing startup queue label ${label}`)
          .toBe(true);
      }
    });

    it('routes filesystem watcher indexing through the shared queue', async () => {
      const observedLabels = new Set<string>();
      const sampler = setInterval(() => {
        const label = getQmdIndexWorkState().activeLabel;
        if (label) observedLabels.add(label);
      }, 5);

      try {
        const dailyDir = path.join(MEMORY_DIR, 'daily');
        await fsp.mkdir(dailyDir, { recursive: true });
        await fsp.writeFile(
          path.join(dailyDir, 'queue-watcher.md'),
          '# Queue Watcher\n\nViolet observatory semantic sentinel.\n',
          'utf-8',
        );

        await vi.waitFor(() => {
          expect(observedLabels.has('memory:incremental-sync')).toBe(true);
        }, { timeout: 10_000, interval: 20 });
        await waitForQmdIndexWork();
      } finally {
        clearInterval(sampler);
      }

      const results = await memoryNotesSearch(
        'violet observatory semantic sentinel',
        ['memory_daily'],
        10,
        undefined,
        { rerank: false },
      );
      expect(results.some((result) =>
        result.filepath.endsWith('queue-watcher.md'))).toBe(true);
    }, 15_000);

    it('indexes content events but ignores status-only session events', async () => {
      const taskUpdate = await updateTaskRaw('task-alpha-001', {
        summary: 'Copper lighthouse task queue sentinel',
      });
      expect(taskUpdate.task).toBeDefined();
      await updateSessionRecord('sess-qmd-test-aaa111', {
        activity: 'Status-only queue sentinel',
      });

      const observedLabels = new Set<string>();
      const sampler = setInterval(() => {
        const state = getQmdIndexWorkState();
        if (state.activeLabel) observedLabels.add(state.activeLabel);
      }, 5);

      try {
        bus.emit(
          EventNames.TASK_UPDATED,
          { task: taskUpdate.task! },
          ['*'],
          { source: 'qmd-queue-e2e' },
        );

        await vi.waitFor(() => {
          expect(observedLabels.has('tasks:incremental-sync')).toBe(true);
        }, { timeout: 10_000, interval: 20 });
        await waitForQmdIndexWork();

        // A status transition changes no indexed fields. Give the old 2-second
        // debounce enough time to prove it does not dispatch a session worker.
        await new Promise((resolve) => setTimeout(resolve, 2_500));
        expect(observedLabels.has('sessions:incremental-sync')).toBe(false);

        bus.emit(
          EventNames.SESSION_RESULT,
          {
            sessionId: 'sess-qmd-test-aaa111',
            result: 'Session content settled',
          },
          ['*'],
          { source: 'qmd-queue-e2e' },
        );

        await vi.waitFor(() => {
          expect(observedLabels.has('sessions:incremental-sync')).toBe(true);
        }, { timeout: 15_000, interval: 20 });
        await waitForQmdIndexWork();
      } finally {
        clearInterval(sampler);
      }

      const taskResults = await memoryNotesSearch(
        'copper lighthouse task queue sentinel',
        ['task'],
        10,
        undefined,
        { rerank: false },
      );
      expect(taskResults.some((result) =>
        result.taskId === 'task-alpha-001')).toBe(true);
    }, 20_000);
  });

  // B2: search() with types=['session'] returns session results
  describe('B2: search API with types=session', () => {
    it('returns session results for a matching query', async () => {
      const res = await fetch(apiUrl('/api/search?q=authentication+middleware&types=session'));
      expect(res.status).toBe(200);
      const data = await res.json();

      expect(data.results.length).toBeGreaterThan(0);
      const sessionResults = data.results.filter(
        (r: { type: string }) => r.type === 'session',
      );
      expect(sessionResults.length).toBeGreaterThan(0);
    });

    it('session results have sessionId field', async () => {
      const res = await fetch(apiUrl('/api/search?q=payment+gateway&types=session'));
      expect(res.status).toBe(200);
      const data = await res.json();

      // At least one result should have sessionId
      const withSessionId = data.results.filter(
        (r: { sessionId?: string }) => r.sessionId,
      );
      expect(withSessionId.length).toBeGreaterThan(0);
    });

    it('all results are type=session when types=session filter is used', async () => {
      const res = await fetch(apiUrl('/api/search?q=Stripe+webhook&types=session'));
      expect(res.status).toBe(200);
      const data = await res.json();

      if (data.results.length > 0) {
        const allSession = data.results.every(
          (r: { type: string }) => r.type === 'session',
        );
        expect(allSession).toBe(true);
      }
    });

    it('joins an exact session record to its task and suppresses semantic noise', async () => {
      const sessionId = 'sess-qmd-test-aaa111';
      const res = await fetch(apiUrl(`/api/search?q=${sessionId}&types=task,memory`));
      expect(res.status).toBe(200);
      const data = await res.json() as {
        results: Array<{ type: string; taskId?: string; sessionId?: string }>;
      };

      expect(data.results).toEqual([expect.objectContaining({
        type: 'task',
        taskId: 'task-alpha-001',
        sessionId,
      })]);
    });
  });

  // B3: memoryNotesSearch with sources=['task'] routes to task store
  describe('B3: memoryNotesSearch with sources=[task]', () => {
    it('returns results with source=task for matching query', async () => {
      const results = await memoryNotesSearch('authentication middleware', ['task']);

      expect(results.length).toBeGreaterThan(0);
      const taskResults = results.filter((r) => r.source === 'task');
      expect(taskResults.length).toBeGreaterThan(0);
    });

    it('extracts taskId from results', async () => {
      const results = await memoryNotesSearch('payment gateway', ['task']);

      expect(results.length).toBeGreaterThan(0);
      const withTaskId = results.filter((r) => r.taskId);
      expect(withTaskId.length).toBeGreaterThan(0);

      // Verify the taskId matches one of our seeded tasks
      const seededIds = new Set(SEED_TASKS.map((t) => t.id));
      const matched = withTaskId.some((r) => seededIds.has(r.taskId!));
      expect(matched).toBe(true);
    });

    it('finds task by unique content (PostgreSQL JSONB)', async () => {
      const results = await memoryNotesSearch('PostgreSQL JSONB', ['task']);

      expect(results.length).toBeGreaterThan(0);
      // Should match task-beta-002 which mentions PostgreSQL JSONB
      const match = results.find((r) => r.taskId === 'task-beta-002');
      expect(match).toBeDefined();
    });

    it('finds a semantic-only task when the query shares no keywords', async () => {
      const results = await memoryNotesSearch(
        'professional success recognition',
        ['task'],
        10,
        undefined,
        { rerank: false },
      );

      expect(results.find((result) => result.taskId === 'task-semantic-004'))
        .toBeDefined();
    });

    it.each(MULTILINGUAL_SEMANTIC_CASES)(
      'finds a $language short query through the real no-rerank search API',
      async ({ query, taskId, title }) => {
        const taskStore = await getTaskStore();
        const lexical = await taskStore.searchLex(query, { limit: 10 });
        expect(lexical.some((result) => result.title === title)).toBe(false);

        const startedAt = performance.now();
        const response = await fetch(apiUrl(
          `/api/search?q=${encodeURIComponent(query)}&types=task&limit=10`,
        ));
        const durationMs = performance.now() - startedAt;
        expect(response.status).toBe(200);

        const data = await response.json() as {
          results: Array<{ taskId?: string }>;
        };
        expect(data.results.map((result) => result.taskId)).toContain(taskId);
        // A generous regression ceiling: the measured no-rerank p90 is under
        // 100 ms, while the local reranker takes multiple seconds.
        expect(durationMs).toBeLessThan(5_000);
      },
      15_000,
    );

    it('removes a deleted task from semantic results through the REST subscriber', async () => {
      const query = 'payment processing Stripe webhook handling';
      const targetId = 'task-gamma-003';
      const before = await memoryNotesSearch(
        query,
        ['task'],
        15,
        undefined,
        { rerank: false },
      );
      expect(before.some((result) => result.taskId === targetId)).toBe(true);

      const deleted = await fetch(apiUrl(`/api/tasks/${targetId}`), {
        method: 'DELETE',
      });
      expect(deleted.status).toBe(204);

      await vi.waitFor(async () => {
        const results = await memoryNotesSearch(
          query,
          ['task'],
          15,
          undefined,
          { rerank: false },
        );
        expect(results.some((result) => result.taskId === targetId)).toBe(false);
      }, { timeout: 10_000, interval: 250 });

      const res = await fetch(
        apiUrl('/api/search?q=payment+processing+Stripe+webhook+handling&types=task'),
      );
      expect(res.status).toBe(200);
      const data = await res.json() as {
        results: Array<{ taskId?: string }>;
      };
      expect(data.results.some((result) => result.taskId === targetId)).toBe(false);
    }, 15_000);
  });

  // B4: memoryNotesSearch with sources=['session'] routes to session store
  describe('B4: memoryNotesSearch with sources=[session]', () => {
    it('returns results with source=session for matching query', async () => {
      const results = await memoryNotesSearch('JWT auth middleware', ['session']);

      expect(results.length).toBeGreaterThan(0);
      const sessionResults = results.filter((r) => r.source === 'session');
      expect(sessionResults.length).toBeGreaterThan(0);
    });

    it('extracts sessionId from results', async () => {
      const results = await memoryNotesSearch('Stripe webhook', ['session']);

      expect(results.length).toBeGreaterThan(0);
      const withSessionId = results.filter((r) => r.sessionId);
      expect(withSessionId.length).toBeGreaterThan(0);

      // Verify the sessionId matches one of our seeded sessions
      const seededIds = new Set(SEED_SESSIONS.map((s) => s.claudeSessionId));
      const matched = withSessionId.some((r) => seededIds.has(r.sessionId!));
      expect(matched).toBe(true);
    });

    it('finds session by unique content (refresh token rotation)', async () => {
      const results = await memoryNotesSearch('refresh token rotation', ['session']);

      expect(results.length).toBeGreaterThan(0);
      // Should match sess-qmd-test-aaa111 which mentions refresh token rotation
      const match = results.find((r) => r.sessionId === 'sess-qmd-test-aaa111');
      expect(match).toBeDefined();
    });

    it('refreshes searchable session metadata without a lifecycle event', async () => {
      const sessionId = 'sess-qmd-test-aaa111';
      const marker = 'Ultraviolet metadata beacon';
      await updateSessionRecord(sessionId, { title: marker });

      await vi.waitFor(async () => {
        const store = await getSessionStore();
        const results = await store.searchLex(
          'ultraviolet metadata beacon',
          { collection: 'sessions' },
        );
        expect(results.some((result) =>
          result.filepath.endsWith(`sess-${sessionId}`))).toBe(true);
      }, { timeout: 10_000, interval: 250 });
    }, 15_000);

    it('removes a deleted session from semantic API results through the server subscriber', async () => {
      const query = 'comprehensive Stripe webhook handler tests';
      const targetId = 'sess-qmd-test-bbb222';
      const before = await memoryNotesSearch(
        query,
        ['session'],
        15,
        undefined,
        { rerank: false },
      );
      expect(before.some((result) => result.sessionId === targetId)).toBe(true);

      await deleteSessionRecords(new Set([targetId]));

      await vi.waitFor(async () => {
        const results = await memoryNotesSearch(
          query,
          ['session'],
          15,
          undefined,
          { rerank: false },
        );
        expect(results.some((result) => result.sessionId === targetId)).toBe(false);
      }, { timeout: 10_000, interval: 250 });

      const res = await fetch(
        apiUrl('/api/search?q=comprehensive+Stripe+webhook+handler+tests&types=session'),
      );
      expect(res.status).toBe(200);
      const data = await res.json() as {
        results: Array<{ sessionId?: string }>;
      };
      expect(data.results.some((result) => result.sessionId === targetId)).toBe(false);
    }, 15_000);
  });
});
