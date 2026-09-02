/**
 * E2E tests for the task FOLDER REST API: REST → core store → event bus
 * → WebSocket, exercised through a real server (startServer({ port: 0, dev: true })).
 *
 * A folder (storage name: "group" — `Task.group_id` + the task_groups registry) is a
 * local-only sub-folder INSIDE ONE PROJECT: tasks sharing a `group_id` render inside
 * it but keep independent lifecycles. The core store ops live in
 * src/core/task-manager.ts and have dedicated unit coverage in
 * tests/core/task-groups.test.ts — this file does NOT duplicate those. Instead it
 * verifies the full HTTP path and its DOWNSTREAM effects:
 *
 *   1. POST /api/tasks/groups → response body has group_id + member_ids, the
 *      `task:groups-changed` WS event fires, GET /api/tasks/groups lists the new
 *      folder (group_id + label + project + member_ids), and the grouped tasks have
 *      group_id persisted (re-fetched via GET /api/tasks/:id).
 *   2. POST /api/tasks/groups with cross-project tasks → HTTP 400 (the folder model: a
 *      folder belongs to exactly one project), nothing created.
 *   3. POST /api/tasks/groups/remove → the folder is NEVER auto-pruned: dropping it
 *      to 1 member and then to 0 both keep the registry row (GET still lists it with
 *      member_ids []), and `dissolved_group_ids` is always [].
 *   4. PATCH /api/tasks/groups/:groupId → response body + WS event carry the new label.
 *   5. PATCH /api/tasks/groups/:groupId/hidden → listing + WS reflect the flag.
 *   6. POST /api/tasks/folders → 201 for an EMPTY folder (the "project + → New
 *      folder" entry point), PATCH /api/tasks/folders/:gid nests / un-nests it,
 *      DELETE /api/tasks/folders/:gid releases its members in place, and the error
 *      contract is 404 for an unknown id vs 400 for a caller-fixable violation.
 *   7. PATCH /api/tasks/folders/:gid with { project } → the folder, its descendant
 *      folders and every member task move to the other project (members keep
 *      group_id); '' = Inbox works; same-project is a 200 no-op; parent_id and
 *      project in one call is 400.
 *   8. Input hardening on the same route: a traversal project name is 400 and
 *      moves nothing; a JS-magic folder id (`__proto__`) is refused and leaves the
 *      server unpolluted (a later create with no project still means Inbox); a
 *      malformed folder id is 400 on shape; and `keepGroupId` — the internal flag
 *      that lets a folder move keep membership — can NOT be smuggled through a
 *      PATCH /api/tasks/:id body.
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
  hidden?: boolean;
  member_ids: string[];
  project: string;
  parent_id?: string;
}

interface FolderResult {
  group_id: string;
  label: string;
  project: string;
  parent_id?: string;
}

interface FolderMoveResult {
  group_id: string;
  project: string;
  moved_task_ids: string[];
  moved_folder_ids: string[];
  failed?: Array<{ id: string; error: string }>;
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

/** Create a task in the given project (defaults to a shared scope). */
async function createTask(
  title: string,
  project = 'e2e-grp-alpha',
): Promise<{ id: string; project: string }> {
  const res = await fetch(apiUrl('/api/tasks'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title, project }),
  });
  expect(res.status).toBe(201);
  const body = (await res.json()) as { task: { id: string; project: string } };
  return body.task;
}

/** Re-fetch a single task via GET so we assert on PERSISTED state, not internals. */
async function getTask(id: string): Promise<{ id: string; group_id?: string; project?: string }> {
  const res = await fetch(apiUrl(`/api/tasks/${id}`));
  expect(res.status).toBe(200);
  const body = (await res.json()) as { task: { id: string; group_id?: string; project?: string } };
  return body.task;
}

/** POST /api/tasks/folders — create an EMPTY folder. Returns the raw response. */
function createFolder(body: Record<string, unknown>): Promise<Response> {
  return fetch(apiUrl('/api/tasks/folders'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/** PATCH /api/tasks/folders/:gid — move a folder in the nesting tree. */
function setFolderParent(groupId: string, parentId: string | null): Promise<Response> {
  return patchFolder(groupId, { parent_id: parentId });
}

/** PATCH /api/tasks/folders/:gid with a RAW body — for the project move and the
 *  "one move per call" guard, which need bodies the typed helpers can't express. */
function patchFolder(groupId: string, body: Record<string, unknown>): Promise<Response> {
  return fetch(apiUrl(`/api/tasks/folders/${groupId}`), {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/** Add tasks to an existing folder (the membership route the folder tests reuse). */
async function addToFolder(groupId: string, taskIds: string[]): Promise<void> {
  const res = await fetch(apiUrl(`/api/tasks/groups/${groupId}/add`), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ task_ids: taskIds }),
  });
  expect(res.status).toBe(200);
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
      // Folder model: the listing carries the folder's owning project, top-level by default.
      expect(listed!.project).toBe(a.project);
      expect(listed!.parent_id).toBeUndefined();

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
   * Test 2: POST /api/tasks/groups across two different projects → 400.
   *   The folder model: a folder belongs to exactly ONE project, so a cross-project
   *   selection has no valid home. The route must answer 400 with the
   *   caller-fixable message and create nothing.
   * Fails if reverted: the old no-scope-rule behaviour answered 200 and grouped
   *   the two tasks anyway.
   */
  it('POST /groups with cross-project tasks is rejected 400 (a folder belongs to one project)', async () => {
    const a = await createTask('Cross-scope A', 'e2e-grp-alpha');
    const b = await createTask('Cross-scope B', 'e2e-grp-home');
    expect(a.project).not.toBe(b.project);

    const before = await listGroups();
    const res = await fetch(apiUrl('/api/tasks/groups'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ task_ids: [a.id, b.id] }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toMatch(/A folder belongs to one project/);

    // Downstream: neither task was grouped, and no folder was minted.
    expect((await getTask(a.id)).group_id).toBeUndefined();
    expect((await getTask(b.id)).group_id).toBeUndefined();
    expect(await listGroups()).toHaveLength(before.length);
  });

  /** Test 2b: joining a folder from another project is the same 400. */
  it('POST /groups/:groupId/add rejects a cross-project task with 400', async () => {
    const a = await createTask('Join A', 'e2e-grp-alpha');
    const b = await createTask('Join B', 'e2e-grp-alpha');
    const outsider = await createTask('Outsider', 'e2e-grp-home');

    const createRes = await fetch(apiUrl('/api/tasks/groups'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ task_ids: [a.id, b.id], label: 'Alpha only' }),
    });
    expect(createRes.status).toBe(200);
    const created = (await createRes.json()) as GroupResult;

    const res = await fetch(apiUrl(`/api/tasks/groups/${created.group_id}/add`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ task_ids: [outsider.id] }),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error?: string }).error).toMatch(/A folder belongs to one project/);
    expect((await getTask(outsider.id)).group_id).toBeUndefined();
  });

  /** Test 2c: an unknown folder id is a 404, not a 400 (the error contract). */
  it('POST /groups/:groupId/add answers 404 for an unknown folder id', async () => {
    const a = await createTask('Orphan join');
    const res = await fetch(apiUrl('/api/tasks/groups/g_does_not_exist/add'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ task_ids: [a.id] }),
    });
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error?: string }).error).toMatch(/not found/i);
  });

  /**
   * Test 3: POST /api/tasks/groups/remove emptying a 2-member folder.
   *   The folder model: folders are NEVER auto-pruned. Removing one member leaves the lone
   *   survivor foldered; removing the LAST one leaves an EMPTY folder that GET
   *   /api/tasks/groups still lists (member_ids []). `dissolved_group_ids` is always [].
   * Fails if reverted: the old auto-dissolve reported the group in
   *   dissolved_group_ids and dropped it from the listing, losing the user's folder.
   */
  it('POST /groups/remove never dissolves the folder — it persists empty in the listing', async () => {
    const a = await createTask('Empty Me A');
    const b = await createTask('Empty Me B');

    const createRes = await fetch(apiUrl('/api/tasks/groups'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ task_ids: [a.id, b.id], label: 'Outlives Its Tasks' }),
    });
    expect(createRes.status).toBe(200);
    const created = (await createRes.json()) as GroupResult;

    // Sanity: both tasks carry the group_id before removal (persisted membership).
    expect((await getTask(a.id)).group_id).toBe(created.group_id);
    expect((await getTask(b.id)).group_id).toBe(created.group_id);

    const ws = await connectWs();
    try {
      // First removal: a leaves, b stays as the lone member.
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
      expect(result.dissolved_group_ids).toEqual([]);

      // Downstream: a ungrouped, b STILL in the folder.
      expect((await getTask(a.id)).group_id).toBeUndefined();
      expect((await getTask(b.id)).group_id).toBe(created.group_id);

      // Second removal: b is the last member — the folder STILL survives.
      const eventPromise = waitForWsEvent(ws, 'task:groups-changed');
      const res2 = await fetch(apiUrl('/api/tasks/groups/remove'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ task_ids: [b.id] }),
      });
      expect(res2.status).toBe(200);
      const result2 = (await res2.json()) as { dissolved_group_ids: string[] };
      expect(result2.dissolved_group_ids).toEqual([]);

      const frame = await eventPromise;
      expect(frame.name).toBe('task:groups-changed');
      expect((await getTask(b.id)).group_id).toBeUndefined();

      // The registry row is still there, now with zero members.
      const listed = (await listGroups()).find((g) => g.group_id === created.group_id);
      expect(listed, 'the emptied folder must still be listed').toBeDefined();
      expect(listed!.label).toBe('Outlives Its Tasks');
      expect(listed!.member_ids).toEqual([]);
      expect(listed!.project).toBe(a.project);
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

  /**
   * Test 5: PATCH /api/tasks/groups/:groupId/hidden hides then unhides a group.
   *   Hiding is a Focus-area rendering flag — the group + membership stay intact and
   *   the GET /groups listing reports hidden=true; unhiding flips it back. Verifies
   *   the response body, the `task:groups-changed` WS event (carrying the hidden
   *   flag), and the downstream persisted state via the listing.
   * Fails if reverted: no hidden field on the listing, no route, or no WS event.
   */
  it('PATCH /groups/:groupId/hidden hides then unhides a group (listing + WS reflect it)', async () => {
    const a = await createTask('Hide A');
    const b = await createTask('Hide B');

    const createRes = await fetch(apiUrl('/api/tasks/groups'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ task_ids: [a.id, b.id], label: 'Hideable' }),
    });
    expect(createRes.status).toBe(200);
    const created = (await createRes.json()) as GroupResult;

    // Sanity: not hidden on creation.
    let listed = (await listGroups()).find((g) => g.group_id === created.group_id);
    expect(listed?.hidden).toBe(false);

    const ws = await connectWs();
    try {
      // Hide.
      const hideEvent = waitForWsEvent(ws, 'task:groups-changed');
      const hideRes = await fetch(apiUrl(`/api/tasks/groups/${created.group_id}/hidden`), {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ hidden: true }),
      });
      expect(hideRes.status).toBe(200);
      expect((await hideRes.json())).toEqual({ group_id: created.group_id, hidden: true });

      const hideFrame = await hideEvent;
      expect(hideFrame.name).toBe('task:groups-changed');
      expect((hideFrame.data as { hidden?: boolean }).hidden).toBe(true);

      // Downstream: the listing now reports hidden=true, membership intact.
      listed = (await listGroups()).find((g) => g.group_id === created.group_id);
      expect(listed?.hidden).toBe(true);
      expect(listed?.member_ids.sort()).toEqual([a.id, b.id].sort());

      // Unhide.
      const unhideRes = await fetch(apiUrl(`/api/tasks/groups/${created.group_id}/hidden`), {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ hidden: false }),
      });
      expect(unhideRes.status).toBe(200);
      expect((await unhideRes.json())).toEqual({ group_id: created.group_id, hidden: false });
      listed = (await listGroups()).find((g) => g.group_id === created.group_id);
      expect(listed?.hidden).toBe(false);
    } finally {
      ws.close();
      await delay(50);
    }
  });

  /** Test 6: a non-boolean `hidden` body is rejected 400 (input validation). */
  it('PATCH /groups/:groupId/hidden rejects a non-boolean hidden with 400', async () => {
    const a = await createTask('Bad hidden A');
    const b = await createTask('Bad hidden B');
    const createRes = await fetch(apiUrl('/api/tasks/groups'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ task_ids: [a.id, b.id] }),
    });
    const created = (await createRes.json()) as GroupResult;

    const res = await fetch(apiUrl(`/api/tasks/groups/${created.group_id}/hidden`), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ hidden: 'yes' }),
    });
    expect(res.status).toBe(400);
  });
});

describe('folder REST API (/api/tasks/folders)', () => {
  /**
   * Create an EMPTY folder. This is the "project + → New folder" entry point, so
   * the folder must be listable BEFORE its first task arrives — otherwise the user
   * has nothing to drag onto. Asserts 201 + the body shape + the WS event + the
   * downstream GET /api/tasks/groups listing (member_ids []).
   * Fails if reverted: no route (404), or the empty folder missing from the listing.
   */
  it('POST /folders creates an empty folder (201), emits the event, and lists it with no members', async () => {
    const ws = await connectWs();
    try {
      const eventPromise = waitForWsEvent(ws, 'task:groups-changed');
      const res = await createFolder({ label: 'Empty by design', project: 'e2e-grp-alpha' });
      expect(res.status).toBe(201);
      const created = (await res.json()) as FolderResult;
      expect(created.label).toBe('Empty by design');
      expect(created.project).toBe('e2e-grp-alpha');
      expect(created.parent_id).toBeUndefined();
      expect(typeof created.group_id).toBe('string');

      const frame = await eventPromise;
      expect((frame.data as { group_id?: string }).group_id).toBe(created.group_id);

      const listed = (await listGroups()).find((g) => g.group_id === created.group_id);
      expect(listed, 'an empty folder must be listed immediately').toBeDefined();
      expect(listed!.label).toBe('Empty by design');
      expect(listed!.project).toBe('e2e-grp-alpha');
      expect(listed!.member_ids).toEqual([]);
      expect(listed!.hidden).toBe(false);
    } finally {
      ws.close();
      await delay(50);
    }
  });

  /** An empty label is caller-fixable input → 400, nothing created. */
  it('POST /folders rejects an empty label with 400', async () => {
    const before = await listGroups();
    const res = await createFolder({ label: '   ', project: 'e2e-grp-alpha' });
    expect(res.status).toBe(400);
    expect(await listGroups()).toHaveLength(before.length);
  });

  /** An unknown parent id is 404; a parent in ANOTHER project is 400. */
  it('POST /folders answers 404 for an unknown parent and 400 for a cross-project parent', async () => {
    const ghost = await createFolder({
      label: 'Orphan child',
      project: 'e2e-grp-alpha',
      parent_id: 'g_does_not_exist',
    });
    expect(ghost.status).toBe(404);
    expect(((await ghost.json()) as { error?: string }).error).toMatch(/not found/i);

    const elsewhere = (await (await createFolder({ label: 'Home root', project: 'e2e-grp-home' })).json()) as FolderResult;
    const crossed = await createFolder({
      label: 'Wrong project child',
      project: 'e2e-grp-alpha',
      parent_id: elsewhere.group_id,
    });
    expect(crossed.status).toBe(400);
    expect(((await crossed.json()) as { error?: string }).error).toMatch(/same project/i);
  });

  /**
   * PATCH nests a folder under another, then `parent_id: null` promotes it back to
   * the top level; the listing carries parent_id both ways. Cross-project + self
   * parenting are refused.
   * Fails if reverted: no route, or parent_id missing from GET /api/tasks/groups.
   */
  it('PATCH /folders/:gid nests a folder, then un-nests it with parent_id null', async () => {
    const parent = (await (await createFolder({ label: 'Nest parent', project: 'e2e-grp-alpha' })).json()) as FolderResult;
    const child = (await (await createFolder({ label: 'Nest child', project: 'e2e-grp-alpha' })).json()) as FolderResult;

    const ws = await connectWs();
    try {
      const eventPromise = waitForWsEvent(ws, 'task:groups-changed');
      const nested = await setFolderParent(child.group_id, parent.group_id);
      expect(nested.status).toBe(200);
      expect(await nested.json()).toEqual({ group_id: child.group_id, parent_id: parent.group_id });
      await eventPromise;

      let listed = (await listGroups()).find((g) => g.group_id === child.group_id);
      expect(listed!.parent_id).toBe(parent.group_id);

      const promoted = await setFolderParent(child.group_id, null);
      expect(promoted.status).toBe(200);
      expect(await promoted.json()).toEqual({ group_id: child.group_id });
      listed = (await listGroups()).find((g) => g.group_id === child.group_id);
      expect(listed!.parent_id).toBeUndefined();
    } finally {
      ws.close();
      await delay(50);
    }
  });

  it('PATCH /folders/:gid answers 404 for an unknown id and 400 for self/cross-project parents', async () => {
    const alpha = (await (await createFolder({ label: 'Alpha self', project: 'e2e-grp-alpha' })).json()) as FolderResult;
    const home = (await (await createFolder({ label: 'Home other', project: 'e2e-grp-home' })).json()) as FolderResult;

    const unknown = await setFolderParent('g_does_not_exist', alpha.group_id);
    expect(unknown.status).toBe(404);

    const self = await setFolderParent(alpha.group_id, alpha.group_id);
    expect(self.status).toBe(400);
    expect(((await self.json()) as { error?: string }).error).toMatch(/its own parent/i);

    const crossed = await setFolderParent(home.group_id, alpha.group_id);
    expect(crossed.status).toBe(400);
    expect(((await crossed.json()) as { error?: string }).error).toMatch(/same project/i);
  });

  /**
   * DELETE is consequence-free: member tasks fall back to the project IN PLACE
   * (group_id cleared, task still exists), child folders re-parent, no task dies.
   * Fails if reverted: no route, or the members disappearing with the folder.
   */
  it('DELETE /folders/:gid releases members in place and re-parents children', async () => {
    const a = await createTask('Folder delete A');
    const b = await createTask('Folder delete B');

    const parent = (await (await createFolder({ label: 'Delete parent', project: 'e2e-grp-alpha' })).json()) as FolderResult;
    const doomed = (await (await createFolder({ label: 'Doomed', project: 'e2e-grp-alpha', parent_id: parent.group_id })).json()) as FolderResult;
    const grandchild = (await (await createFolder({ label: 'Grandchild', project: 'e2e-grp-alpha', parent_id: doomed.group_id })).json()) as FolderResult;

    const added = await fetch(apiUrl(`/api/tasks/groups/${doomed.group_id}/add`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ task_ids: [a.id, b.id] }),
    });
    expect(added.status).toBe(200);
    expect((await getTask(a.id)).group_id).toBe(doomed.group_id);

    const ws = await connectWs();
    try {
      const eventPromise = waitForWsEvent(ws, 'task:groups-changed');
      const res = await fetch(apiUrl(`/api/tasks/folders/${doomed.group_id}`), { method: 'DELETE' });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        group_id: string;
        released_task_ids: string[];
        reparented_folder_ids: string[];
      };
      expect(body.group_id).toBe(doomed.group_id);
      expect(body.released_task_ids.sort()).toEqual([a.id, b.id].sort());
      expect(body.reparented_folder_ids).toEqual([grandchild.group_id]);
      await eventPromise;

      // Members survive as ordinary tasks in the same project.
      const ra = await getTask(a.id);
      expect(ra.group_id).toBeUndefined();
      expect(ra.project).toBe('e2e-grp-alpha');
      expect((await getTask(b.id)).group_id).toBeUndefined();

      const groups = await listGroups();
      expect(groups.find((g) => g.group_id === doomed.group_id)).toBeUndefined();
      // The grandchild moved up to the deleted folder's parent.
      expect(groups.find((g) => g.group_id === grandchild.group_id)!.parent_id).toBe(parent.group_id);
    } finally {
      ws.close();
      await delay(50);
    }
  });

  it('DELETE /folders/:gid answers 404 for an unknown id', async () => {
    const res = await fetch(apiUrl('/api/tasks/folders/g_does_not_exist'), { method: 'DELETE' });
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error?: string }).error).toMatch(/not found/i);
  });

  /**
   * PATCH { project } moves a folder to ANOTHER project. The whole subtree goes:
   * descendant folders, and every member task (which keeps its group_id — the
   * folder is what moved, so membership survives). The moved folder becomes
   * top-level in the destination.
   * Fails if reverted: 400 "parent_id must be a string or null" instead of a move.
   */
  it('PATCH /folders/:gid with a project moves the subtree and its member tasks', async () => {
    const root = (await (await createFolder({ label: 'Move root', project: 'e2e-grp-alpha' })).json()) as FolderResult;
    const child = (await (await createFolder({
      label: 'Move child', project: 'e2e-grp-alpha', parent_id: root.group_id,
    })).json()) as FolderResult;
    const rootTask = await createTask('Project move root member');
    const childTask = await createTask('Project move child member');
    await addToFolder(root.group_id, [rootTask.id]);
    await addToFolder(child.group_id, [childTask.id]);

    const ws = await connectWs();
    try {
      const eventPromise = waitForWsEvent(ws, 'task:groups-changed');
      const res = await patchFolder(root.group_id, { project: 'e2e-grp-dest' });
      expect(res.status).toBe(200);
      const body = (await res.json()) as FolderMoveResult;

      expect(body.group_id).toBe(root.group_id);
      expect(body.project).toBe('e2e-grp-dest');
      expect(body.moved_folder_ids).toEqual([root.group_id, child.group_id]);
      expect(body.moved_task_ids.sort()).toEqual([rootTask.id, childTask.id].sort());

      const frame = await eventPromise;
      const evData = frame.data as { group_id?: string; project?: string };
      expect(evData.group_id).toBe(root.group_id);
      expect(evData.project).toBe('e2e-grp-dest');

      const groups = await listGroups();
      const listedRoot = groups.find((g) => g.group_id === root.group_id)!;
      const listedChild = groups.find((g) => g.group_id === child.group_id)!;
      expect(listedRoot.project).toBe('e2e-grp-dest');
      expect(listedRoot.parent_id).toBeUndefined();
      expect(listedChild.project).toBe('e2e-grp-dest');
      // The subtree's shape survives the move.
      expect(listedChild.parent_id).toBe(root.group_id);

      // Members moved WITH their membership.
      const movedRootTask = await getTask(rootTask.id);
      expect(movedRootTask.project).toBe('e2e-grp-dest');
      expect(movedRootTask.group_id).toBe(root.group_id);
      const movedChildTask = await getTask(childTask.id);
      expect(movedChildTask.project).toBe('e2e-grp-dest');
      expect(movedChildTask.group_id).toBe(child.group_id);
    } finally {
      ws.close();
      await delay(50);
    }
  });

  /** '' = Inbox is a real destination (and never gets a registry row). */
  it("PATCH /folders/:gid moves a folder to Inbox ('')", async () => {
    const f = (await (await createFolder({ label: 'To Inbox', project: 'e2e-grp-alpha' })).json()) as FolderResult;
    const task = await createTask('Inbox-bound member');
    await addToFolder(f.group_id, [task.id]);

    const res = await patchFolder(f.group_id, { project: '' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as FolderMoveResult;
    expect(body.project).toBe('');
    expect(body.moved_task_ids).toEqual([task.id]);

    expect((await listGroups()).find((g) => g.group_id === f.group_id)!.project).toBe('');
    const moved = await getTask(task.id);
    expect(moved.project).toBe('');
    expect(moved.group_id).toBe(f.group_id);
  });

  /** Same-project is a 200 no-op, not an error — the drag landed where it started. */
  it('PATCH /folders/:gid answers 200 with empty moves when the project is unchanged', async () => {
    const f = (await (await createFolder({ label: 'Stays put', project: 'e2e-grp-alpha' })).json()) as FolderResult;
    const res = await patchFolder(f.group_id, { project: 'e2e-grp-alpha' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      group_id: f.group_id, project: 'e2e-grp-alpha', moved_task_ids: [], moved_folder_ids: [],
    });
  });

  it('PATCH /folders/:gid rejects parent_id + project in one call with 400', async () => {
    const parent = (await (await createFolder({ label: 'Combo parent', project: 'e2e-grp-alpha' })).json()) as FolderResult;
    const f = (await (await createFolder({ label: 'Combo child', project: 'e2e-grp-alpha' })).json()) as FolderResult;

    const res = await patchFolder(f.group_id, { parent_id: parent.group_id, project: 'e2e-grp-dest' });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error?: string }).error).toMatch(/not both/i);

    // Nothing was applied.
    const listed = (await listGroups()).find((g) => g.group_id === f.group_id)!;
    expect(listed.project).toBe('e2e-grp-alpha');
    expect(listed.parent_id).toBeUndefined();
  });

  it('PATCH /folders/:gid answers 404 for an unknown id and 400 for a non-string project', async () => {
    const unknown = await patchFolder('g_does_not_exist', { project: 'e2e-grp-dest' });
    expect(unknown.status).toBe(404);
    expect(((await unknown.json()) as { error?: string }).error).toMatch(/not found/i);

    const f = (await (await createFolder({ label: 'Type guard', project: 'e2e-grp-alpha' })).json()) as FolderResult;
    const badType = await patchFolder(f.group_id, { project: 42 });
    expect(badType.status).toBe(400);
    expect(((await badType.json()) as { error?: string }).error).toMatch(/must be a string/i);
  });

  /**
   * A destination project name becomes a FILESYSTEM PATH SEGMENT
   * (memory/projects/<name>/), so a traversal attempt is refused with 400 and the
   * folder + its member stay exactly where they were.
   */
  it('PATCH /folders/:gid rejects a traversal project name with 400 and moves nothing', async () => {
    const f = (await (await createFolder({ label: 'Traversal guard', project: 'e2e-grp-alpha' })).json()) as FolderResult;
    const member = await createTask('Stays in alpha');
    await addToFolder(f.group_id, [member.id]);

    const res = await patchFolder(f.group_id, { project: '../etc' });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error?: string }).error).toMatch(/not allowed|invalid project name/i);

    // Nothing moved: neither the folder record nor its member.
    expect((await listGroups()).find((g) => g.group_id === f.group_id)!.project).toBe('e2e-grp-alpha');
    const reloaded = await getTask(member.id);
    expect(reloaded.project).toBe('e2e-grp-alpha');
    expect(reloaded.group_id).toBe(f.group_id);
  });

  /**
   * PROTOTYPE POLLUTION regression (a folder id is an object key).
   * `PATCH /api/tasks/folders/__proto__` used to pass the store's truthiness
   * existence check — `task_groups['__proto__']` resolves through
   * Object.prototype — and then wrote `project` onto the PROTOTYPE. After that
   * every later request body inherited `.project`, so updateTask's
   * `if (updates.project !== undefined)` fired on every update and re-projected
   * unrelated tasks. The request must fail, and the SERVER must still behave
   * afterwards: a create with no project must land in Inbox.
   */
  it('PATCH /folders/__proto__ is refused and leaves the server unpolluted', async () => {
    for (const magic of ['__proto__', 'constructor', 'prototype']) {
      const res = await patchFolder(magic, { project: 'polluted' });
      expect(res.status, `PATCH /folders/${magic} must fail`).toBeGreaterThanOrEqual(400);
      expect(res.status).toBeLessThan(500);
      const del = await fetch(apiUrl(`/api/tasks/folders/${magic}`), { method: 'DELETE' });
      expect(del.status).toBeGreaterThanOrEqual(400);
      expect(del.status).toBeLessThan(500);
    }

    // The probe: a create with NO project must still mean Inbox. If
    // Object.prototype carried `project: 'polluted'`, the parsed request body
    // would inherit it and this task would land in that project instead.
    const created = await fetch(apiUrl('/api/tasks'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Pollution probe' }),
    });
    expect(created.status).toBe(201);
    const probe = (await created.json()) as { task: { id: string; project?: string } };
    expect(probe.task.project ?? '').toBe('');
    // ...and the folder listing is still clean (no record acquired the payload).
    expect((await listGroups()).every((g) => g.project !== 'polluted')).toBe(true);
  });

  /** A malformed folder id never reaches the store — it's rejected on shape. */
  it('PATCH /folders/:gid rejects a malformed folder id with 400', async () => {
    const res = await patchFolder('g$bad!id', { project: 'e2e-grp-dest' });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error?: string }).error).toMatch(/invalid folder id/i);
  });

  /**
   * RATCHET: `keepGroupId` is INTERNAL. moveFolderToProject is the only caller
   * allowed to keep a task's folder membership across a project change; a plain
   * task PATCH must never buy that behaviour by putting the flag in its body
   * (updateTask takes it in its THIRD argument, which the route hard-codes).
   */
  it('PATCH /tasks/:id can NOT smuggle keepGroupId through the request body', async () => {
    const f = (await (await createFolder({ label: 'No smuggling', project: 'e2e-grp-alpha' })).json()) as FolderResult;
    const member = await createTask('Leaves the folder');
    await addToFolder(f.group_id, [member.id]);
    expect((await getTask(member.id)).group_id).toBe(f.group_id);

    const res = await fetch(apiUrl(`/api/tasks/${member.id}`), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ project: 'e2e-grp-dest', keepGroupId: true }),
    });
    expect(res.status).toBe(200);

    // The project move applied, and the auto-unfolder still ran.
    const reloaded = await getTask(member.id);
    expect(reloaded.project).toBe('e2e-grp-dest');
    expect(reloaded.group_id).toBeUndefined();
    // The folder itself stayed in its own project, minus the member.
    const listed = (await listGroups()).find((g) => g.group_id === f.group_id)!;
    expect(listed.project).toBe('e2e-grp-alpha');
    expect(listed.member_ids).not.toContain(member.id);
  });
});
