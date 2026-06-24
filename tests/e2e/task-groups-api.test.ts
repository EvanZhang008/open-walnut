/**
 * E2E tests for the virtual task-group REST API: REST → core store → event bus
 * → WebSocket, exercised through a real server (startServer({ port: 0, dev: true })).
 *
 * Virtual groups are a local-only VISUAL grouping (NOT subtasks): tasks sharing a
 * `group_id` render boxed together but keep independent lifecycles. The core store
 * ops live in src/core/task-manager.ts and have dedicated unit coverage in
 * tests/core/task-groups.test.ts — this file does NOT duplicate those. Instead it
 * verifies the full HTTP path and its DOWNSTREAM effects:
 *
 *   1. POST /api/tasks/groups → response body has group_id + member_ids, the
 *      `task:groups-changed` WS event fires, GET /api/tasks/groups lists the new
 *      group (group_id + label + member_ids), and the grouped tasks have group_id
 *      persisted (re-fetched via GET /api/tasks/:id).
 *   2. POST /api/tasks/groups with cross-category tasks → HTTP 409 (TaskGroupScopeError).
 *   3. POST /api/tasks/groups/remove dropping a 2-member group to 1 → group dissolves
 *      (response reports dissolved_group_ids; both tasks lose group_id).
 *   4. PATCH /api/tasks/groups/:groupId → response body + WS event carry the new label.
 *
 * Each test asserts on the HTTP response body + WS events + persisted GET — never on
 * internal state — so each fails if the feature were reverted.
 *
 * REGRESSION GUARD: the aggregate listing GET /api/tasks/groups was previously
 * shadowed by the earlier `GET /:id` catch-all in src/web/routes/tasks.ts (route
 * registered after it), so it 404'd — a defect this suite surfaced and that has now
 * been fixed (the listing route was moved above `GET /:id`). Test #1 asserts the
 * listing returns 200 with the group, locking the fix in. Per-task GET is kept as an
 * additional persistence check.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'node:fs/promises';
import type { Server as HttpServer } from 'node:http';
import { WebSocket } from 'ws';
import { createMockConstants } from '../helpers/mock-constants.js';

vi.mock('../../src/constants.js', () => createMockConstants('walnut-e2e-task-groups'));

import { WALNUT_HOME } from '../../src/constants.js';
import { startServer, stopServer } from '../../src/web/server.js';

// ── Types ──

interface WsFrame {
  type: string;
  name?: string;
  data?: unknown;
  [key: string]: unknown;
}

interface GroupResult {
  group_id: string;
  label: string;
  member_ids: string[];
}

interface GroupSummary {
  group_id: string;
  label: string;
  member_ids: string[];
}

// ── Server state ──

let server: HttpServer;
let port: number;

function apiUrl(p: string): string {
  return `http://localhost:${port}${p}`;
}

// ── WebSocket helpers ──

function connectWs(): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${port}/ws`);
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
  });
}

/**
 * Wait for the next WS event matching eventName (rejects on timeout).
 */
function waitForWsEvent(ws: WebSocket, eventName: string, timeoutMs = 5000): Promise<WsFrame> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Timed out waiting for WS event "${eventName}"`)),
      timeoutMs,
    );
    const handler = (raw: WebSocket.RawData) => {
      const frame = JSON.parse(raw.toString()) as WsFrame;
      if (frame.type === 'event' && frame.name === eventName) {
        clearTimeout(timer);
        ws.off('message', handler);
        resolve(frame);
      }
    };
    ws.on('message', handler);
  });
}

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// ── REST helpers ──

/** Create a task in the given category+project (both default to a shared scope). */
async function createTask(
  title: string,
  category = 'e2e-grp-work',
  project = 'alpha',
): Promise<{ id: string; category: string; project: string }> {
  const res = await fetch(apiUrl('/api/tasks'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title, category, project }),
  });
  expect(res.status).toBe(201);
  const body = (await res.json()) as { task: { id: string; category: string; project: string } };
  return body.task;
}

/** Re-fetch a single task via GET so we assert on PERSISTED state, not internals. */
async function getTask(id: string): Promise<{ id: string; group_id?: string }> {
  const res = await fetch(apiUrl(`/api/tasks/${id}`));
  expect(res.status).toBe(200);
  const body = (await res.json()) as { task: { id: string; group_id?: string } };
  return body.task;
}

/** GET the aggregate group listing (asserts 200 — the route-order regression guard). */
async function listGroups(): Promise<GroupSummary[]> {
  const res = await fetch(apiUrl('/api/tasks/groups'));
  expect(res.status).toBe(200);
  const body = (await res.json()) as { groups: GroupSummary[] };
  return body.groups;
}

// ── Setup / Teardown ──

beforeAll(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true });
  await fs.mkdir(WALNUT_HOME, { recursive: true });
  server = await startServer({ port: 0, dev: true });
  const addr = server.address();
  port = typeof addr === 'object' && addr ? addr.port : 0;
});

afterAll(async () => {
  await stopServer();
  await fs.rm(WALNUT_HOME, { recursive: true, force: true });
});

// ── Tests ──

describe('task-group REST API (REST → core → bus → WS)', () => {
  /**
   * Test 1: POST /api/tasks/groups with two same-scope tasks.
   *   - HTTP body returns { group_id, member_ids } (both members).
   *   - The `task:groups-changed` WS event fires (bus → web-ui subscriber → broadcast).
   *   - GET /api/tasks/groups returns 200 and lists the new group with group_id +
   *     label + both member_ids (regression guard for the route-order fix).
   *   - Each grouped task, re-fetched via GET /api/tasks/:id, has group_id persisted
   *     to the SAME group_id (the persisted-membership downstream effect).
   * Fails if reverted: no group_id on the response, no group listed (or 404 if the
   *   route-order regression returns), none persisted on tasks, no WS event.
   */
  it('POST /groups creates a group, emits task:groups-changed, persists group_id', async () => {
    const a = await createTask('Group member A');
    const b = await createTask('Group member B');

    const ws = await connectWs();
    try {
      // Begin waiting BEFORE the mutation so we never miss the event.
      const eventPromise = waitForWsEvent(ws, 'task:groups-changed');

      const res = await fetch(apiUrl('/api/tasks/groups'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ task_ids: [a.id, b.id], label: 'My E2E Group' }),
      });
      expect(res.status).toBe(200);
      const result = (await res.json()) as GroupResult;

      // (a) HTTP body downstream effect
      expect(typeof result.group_id).toBe('string');
      expect(result.group_id.length).toBeGreaterThan(0);
      expect(result.member_ids.sort()).toEqual([a.id, b.id].sort());
      expect(result.label).toBe('My E2E Group');

      // (b) WS event fired with the same group_id
      const frame = await eventPromise;
      expect(frame.name).toBe('task:groups-changed');
      const evData = frame.data as { group_id?: string; label?: string };
      expect(evData.group_id).toBe(result.group_id);
      expect(evData.label).toBe('My E2E Group');

      // (c) GET /api/tasks/groups now lists the group (200, not shadowed by /:id) —
      //     regression guard for the route-order fix.
      const groups = await listGroups();
      const listed = groups.find((g) => g.group_id === result.group_id);
      expect(
        listed,
        `group ${result.group_id} should be listed by GET /api/tasks/groups`,
      ).toBeDefined();
      expect(listed!.label).toBe('My E2E Group');
      expect(listed!.member_ids.sort()).toEqual([a.id, b.id].sort());

      // (d) group_id persisted on BOTH tasks under the same group (re-fetched via GET)
      const pa = await getTask(a.id);
      const pb = await getTask(b.id);
      expect(pa.group_id).toBe(result.group_id);
      expect(pb.group_id).toBe(result.group_id);
      expect(pa.group_id).toBe(pb.group_id);
    } finally {
      ws.close();
      await delay(50);
    }
  });

  /**
   * Test 2: POST /api/tasks/groups across two different categories.
   *   The core throws TaskGroupScopeError → the route maps it to HTTP 409.
   * Fails if reverted: the scope rule (or its 409 mapping) is gone.
   */
  it('POST /groups with cross-category tasks returns 409 and creates no group', async () => {
    // Distinct categories ⇒ different scope.
    const a = await createTask('Cross-scope A', 'e2e-grp-work', 'alpha');
    const b = await createTask('Cross-scope B', 'e2e-grp-life', 'home');
    expect(a.category).not.toBe(b.category);

    const res = await fetch(apiUrl('/api/tasks/groups'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ task_ids: [a.id, b.id] }),
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/same category \+ project/i);

    // Downstream: the rejected grouping left NO group_id on either task.
    expect((await getTask(a.id)).group_id).toBeUndefined();
    expect((await getTask(b.id)).group_id).toBeUndefined();
  });

  /**
   * Test 3: POST /api/tasks/groups/remove dropping a 2-member group to 1.
   *   The lone survivor is pruned → the whole group auto-dissolves.
   *   - Response reports dissolved_group_ids (the dissolved group).
   *   - The `task:groups-changed` WS event carries dissolved_group_ids.
   *   - Both tasks lose group_id (re-fetched via GET /api/tasks/:id).
   * Fails if reverted: auto-dissolve (≥2-member invariant) is gone.
   */
  it('POST /groups/remove dissolves the group when it would drop below 2 members', async () => {
    const a = await createTask('Dissolve A');
    const b = await createTask('Dissolve B');

    const createRes = await fetch(apiUrl('/api/tasks/groups'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ task_ids: [a.id, b.id], label: 'Dissolve Me' }),
    });
    expect(createRes.status).toBe(200);
    const created = (await createRes.json()) as GroupResult;

    // Sanity: both tasks carry the group_id before removal (persisted membership).
    expect((await getTask(a.id)).group_id).toBe(created.group_id);
    expect((await getTask(b.id)).group_id).toBe(created.group_id);

    const ws = await connectWs();
    try {
      const eventPromise = waitForWsEvent(ws, 'task:groups-changed');

      const res = await fetch(apiUrl('/api/tasks/groups/remove'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ task_ids: [a.id] }),
      });
      expect(res.status).toBe(200);
      const result = (await res.json()) as {
        removed_ids: string[];
        dissolved_group_ids: string[];
      };
      expect(result.removed_ids).toContain(a.id);
      expect(result.dissolved_group_ids).toContain(created.group_id);

      // WS event reports the dissolution.
      const frame = await eventPromise;
      expect(frame.name).toBe('task:groups-changed');
      const evData = frame.data as { dissolved_group_ids?: string[] };
      expect(evData.dissolved_group_ids).toContain(created.group_id);

      // Both tasks are ungrouped (a removed explicitly, b pruned as lone survivor) —
      // the dissolution downstream effect, verified on the persisted tasks.
      expect((await getTask(a.id)).group_id).toBeUndefined();
      expect((await getTask(b.id)).group_id).toBeUndefined();
    } finally {
      ws.close();
      await delay(50);
    }
  });

  /**
   * Test 4: PATCH /api/tasks/groups/:groupId renames the group.
   *   - Response body returns the new label for the same group_id.
   *   - The `task:groups-changed` WS event carries the new label (registry update →
   *     bus → web-ui broadcast), proving the rename propagated downstream.
   * Fails if reverted: rename endpoint / registry update / WS emit is gone.
   */
  it('PATCH /groups/:groupId renames the group (response + WS event carry new label)', async () => {
    const a = await createTask('Rename A');
    const b = await createTask('Rename B');

    const createRes = await fetch(apiUrl('/api/tasks/groups'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ task_ids: [a.id, b.id], label: 'Original Label' }),
    });
    expect(createRes.status).toBe(200);
    const created = (await createRes.json()) as GroupResult;
    expect(created.label).toBe('Original Label');

    const ws = await connectWs();
    try {
      const eventPromise = waitForWsEvent(ws, 'task:groups-changed');

      const res = await fetch(apiUrl(`/api/tasks/groups/${created.group_id}`), {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ label: 'Renamed Label' }),
      });
      expect(res.status).toBe(200);
      const result = (await res.json()) as { group_id: string; label: string };
      expect(result.group_id).toBe(created.group_id);
      expect(result.label).toBe('Renamed Label');

      // WS event carries the new label.
      const frame = await eventPromise;
      expect(frame.name).toBe('task:groups-changed');
      const evData = frame.data as { group_id?: string; label?: string };
      expect(evData.group_id).toBe(created.group_id);
      expect(evData.label).toBe('Renamed Label');
    } finally {
      ws.close();
      await delay(50);
    }
  });
});
