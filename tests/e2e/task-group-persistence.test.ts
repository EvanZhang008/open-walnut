/**
 * E2E regression: a virtual task group (local-only `group_id`) must survive a
 * session phase transition that writes a payload-only field (`unread`).
 *
 * Background — the user-reported bug ("grouped session/incident tasks lose their
 * group after a while"): `group_id` has no dedicated SQLite column; it spills
 * into the `payload` JSON blob. The hot-path partial-update helper
 * `updateTaskRaw` (and its bulk sibling) rebuilt the `payload` column from
 * `taskToRow(prepared)` — i.e. from the PATCH alone. Every session phase
 * transition through `applySessionPhase` (src/core/phase.ts) injects
 * `unread` (also a payload field), so each transition rewrote the whole
 * payload column from just `{ phase, unread }`, silently dropping
 * `group_id`. Plain tasks rarely raw-update so it looked intermittent; session
 * tasks transition phase constantly, so their group "vanished".
 *
 * Fix (task-manager.ts updateTaskRaw / updateTasksBulk): after building the patch
 * row, if it touches `payload`, recompute payload from the MERGED task
 * (`taskToRow({ ...task, ...prepared }).payload`) so untouched payload fields
 * (group_id, …) survive the partial update.
 *
 * The 3 unit-level regression tests in tests/core/task-groups.test.ts already
 * cover the store fns directly. This file instead proves the fix END-TO-END at
 * the API + real production phase-transition layer:
 *   - tasks created via POST /api/tasks
 *   - group created + asserted via POST + GET /api/tasks/groups
 *   - the mutation is driven through the REAL production function
 *     `applySessionPhase(taskId, 'session:error' | 'session:streaming', ...)`
 *     — the exact code production runs from src/web/server.ts on session events —
 *     which itself calls updateTaskRaw with `unread`. (A full live CLI
 *     session would emit those events; we invoke the same downstream function
 *     directly so no Claude CLI is needed.)
 *   - downstream we re-fetch over HTTP and assert the group + group_id + the
 *     applied `unread` all survived MULTIPLE transitions.
 *
 * Would it fail on reverted code? YES. Revert the `taskToRow({ ...task,
 * ...prepared }).payload` line and the first `session:error` transition wipes
 * group_id: GET /api/tasks/groups would no longer list the group (or drop a
 * member) and GET /api/tasks/:id would report group_id === undefined, failing
 * the assertions below.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'node:fs/promises';
import type { Server as HttpServer } from 'node:http';
import { createMockConstants } from '../helpers/mock-constants.js';

vi.mock('../../src/constants.js', () => createMockConstants('walnut-e2e-group-persist'));

import { WALNUT_HOME } from '../../src/constants.js';
import { startServer, stopServer } from '../../src/web/server.js';
import { applySessionPhase } from '../../src/core/phase.js';

// ── Types ──

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

// ── REST helpers ──

/** Create a task in the given category+project (both default to a shared scope). */
async function createTask(
  title: string,
  category = 'e2e-grp-persist-work',
  project = 'alpha',
): Promise<{ id: string; category: string; project: string; phase: string }> {
  const res = await fetch(apiUrl('/api/tasks'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title, category, project }),
  });
  expect(res.status).toBe(201);
  const body = (await res.json()) as {
    task: { id: string; category: string; project: string; phase: string };
  };
  return body.task;
}

/** Re-fetch a single task via GET so we assert on PERSISTED state, not internals. */
async function getTask(
  id: string,
): Promise<{ id: string; group_id?: string; unread?: boolean; phase?: string }> {
  const res = await fetch(apiUrl(`/api/tasks/${id}`));
  expect(res.status).toBe(200);
  const body = (await res.json()) as {
    task: { id: string; group_id?: string; unread?: boolean; phase?: string };
  };
  return body.task;
}

/** GET the aggregate group listing. */
async function listGroups(): Promise<GroupSummary[]> {
  const res = await fetch(apiUrl('/api/tasks/groups'));
  expect(res.status).toBe(200);
  const body = (await res.json()) as { groups: GroupSummary[] };
  return body.groups;
}

/** POST /api/tasks/groups to group the given ids under a label. */
async function createGroup(taskIds: string[], label: string): Promise<GroupResult> {
  const res = await fetch(apiUrl('/api/tasks/groups'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ task_ids: taskIds, label }),
  });
  expect(res.status).toBe(200);
  return (await res.json()) as GroupResult;
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

// ── Test ──

describe('virtual group survives session phase transitions (REST → real phase path → SQLite)', () => {
  /**
   * Full-consequence scenario:
   *   1. POST two same-scope tasks via /api/tasks.
   *   2. POST /api/tasks/groups → 200 with a group_id; GET /api/tasks/groups lists
   *      the group with BOTH members; both tasks carry group_id (persisted).
   *   3. Drive a REAL session phase transition on ONE member through the exact
   *      production function applySessionPhase('session:error'): TODO →
   *      AGENT_COMPLETE, which makes updateTaskRaw write `unread:true`
   *      into the payload column. Then a second transition
   *      ('session:input': AGENT_COMPLETE → IN_PROGRESS, writes
   *      unread:false), then a third ('session:result' →
   *      AGENT_COMPLETE). Each rewrites the payload column — exactly what the
   *      bug exploited — so surviving all three is a strong guard.
   *      (WAIT removed 2026-08-18: error now lands on AGENT_COMPLETE, and the
   *      middle pullback moved from the retired session:streaming trigger to
   *      session:input. The point of the test is three payload rewrites, and
   *      that is unchanged.)
   *   4. Downstream over HTTP: GET /api/tasks/groups STILL lists the group with
   *      BOTH members; GET /api/tasks/:id shows group_id unchanged AND
   *      unread reflecting the last transition (proves BOTH the patch
   *      applied and group_id survived). The untouched sibling keeps group_id too.
   *
   * Reverting the fix breaks step 4: the first transition drops group_id from the
   * mutated member, dropping it from the group listing and nulling its task
   * group_id.
   */
  it('keeps group_id (+ applies unread) across repeated session phase transitions', async () => {
    // 1. Two tasks in the same category+project.
    const a = await createTask('Session task A');
    const b = await createTask('Sibling task B');
    expect(a.phase).toBe('TODO'); // sanity: fresh tasks start in TODO

    // 2. Group them via the REST API; assert the group is created + listed.
    const group = await createGroup([a.id, b.id], 'Incident group');
    expect(typeof group.group_id).toBe('string');
    expect(group.group_id.length).toBeGreaterThan(0);
    expect(group.member_ids.sort()).toEqual([a.id, b.id].sort());

    const before = await listGroups();
    const listedBefore = before.find((g) => g.group_id === group.group_id);
    expect(listedBefore, 'group should be listed right after creation').toBeDefined();
    expect(listedBefore!.member_ids.sort()).toEqual([a.id, b.id].sort());
    expect((await getTask(a.id)).group_id).toBe(group.group_id);
    expect((await getTask(b.id)).group_id).toBe(group.group_id);

    // 3. Drive REAL production phase transitions on member A. applySessionPhase is
    //    the exact function src/web/server.ts invokes on session:error /
    //    session:input / session:result events; it calls updateTaskRaw with unread,
    //    rewriting the payload column each time (the bug's trigger).

    // TODO → AGENT_COMPLETE (writes unread: true) — (WAIT removed 2026-08-18)
    const t1 = await applySessionPhase(a.id, 'session:error', 'e2e:phase-persist');
    expect(t1.changed).toBe(true);
    expect(t1.newPhase).toBe('AGENT_COMPLETE');

    // group_id must survive the very first payload-rewriting transition.
    {
      const ra = await getTask(a.id);
      expect(ra.phase).toBe('AGENT_COMPLETE');
      expect(ra.unread).toBe(true); // the patch applied
      expect(ra.group_id).toBe(group.group_id); // ...and group_id survived
    }

    // AGENT_COMPLETE → IN_PROGRESS (writes unread: false). session:streaming was
    // the old vehicle here; it is a no-op since the WAIT removal, so use the live
    // pullback trigger instead.
    const t2 = await applySessionPhase(a.id, 'session:input', 'e2e:phase-persist');
    expect(t2.changed).toBe(true);
    expect(t2.newPhase).toBe('IN_PROGRESS');

    // IN_PROGRESS → AGENT_COMPLETE (writes unread: true again)
    const t3 = await applySessionPhase(a.id, 'session:result', 'e2e:phase-persist');
    expect(t3.changed).toBe(true);
    expect(t3.newPhase).toBe('AGENT_COMPLETE');

    // 4. Downstream assertions over HTTP after THREE payload rewrites.
    const ra = await getTask(a.id);
    expect(ra.phase).toBe('AGENT_COMPLETE');
    expect(ra.unread).toBe(true); // last transition's payload field applied
    expect(ra.group_id).toBe(group.group_id); // group_id survived every rewrite

    // The untouched sibling never lost its group_id.
    const rb = await getTask(b.id);
    expect(rb.group_id).toBe(group.group_id);

    // The aggregate group listing STILL shows the group with BOTH members.
    const after = await listGroups();
    const listedAfter = after.find((g) => g.group_id === group.group_id);
    expect(
      listedAfter,
      'group must still be listed after the session phase transitions',
    ).toBeDefined();
    expect(listedAfter!.member_ids.sort()).toEqual([a.id, b.id].sort());
  });
});
