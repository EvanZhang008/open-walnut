/**
 * E2E: the composable task query over REST (`GET /api/tasks`) against ONE real
 * server + real SQLite. REST is the only implementation now: every agent-facing
 * surface reaches this query through the `task_list` op, which is a loopback call
 * to this same route.
 *
 * What this locks down (the drift risks the shared query module exists to kill):
 *  1. pinned + complete + last-6-hours picks exactly the one fixture that has
 *     all three properties (the combination that used to be unexpressible).
 *  2. project + updated-in-last-24h combines an attribution and a time window.
 *  3. COMPLETE is never hidden without an explicit state filter.
 *  4. Invalid enum / limit / conflicting time window → 400 with { error }.
 *  5. full / slim / minimal projections return identical ID sets.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'node:fs/promises';
import type { Server as HttpServer } from 'node:http';
import { createMockConstants } from '../helpers/mock-constants.js';

vi.mock('../../src/constants.js', () => createMockConstants('walnut-task-query-e2e'));

import { WALNUT_HOME } from '../../src/constants.js';
import { startServer, stopServer } from '../../src/web/server.js';
import { addTask, updateTaskRaw } from '../../src/core/task-manager.js';
import type { Task } from '../../src/core/types.js';

let server: HttpServer;
let port: number;

// Fixed clock offsets so relative windows ("last 6 hours") are deterministic
// regardless of when the suite runs.
const NOW = Date.now();
const HOUR = 60 * 60 * 1000;
const iso = (msAgo: number): string => new Date(NOW - msAgo).toISOString();

/** taskId keyed by fixture label, filled by seedFixtures(). */
const ids: Record<string, string> = {};

function apiUrl(p: string): string {
  return `http://localhost:${port}${p}`;
}

async function getTasks(qs: string): Promise<Task[]> {
  const res = await fetch(apiUrl(`/api/tasks${qs}`));
  expect(res.status).toBe(200);
  const body = await res.json() as { tasks: Task[] };
  return body.tasks;
}

async function getError(qs: string): Promise<string> {
  const res = await fetch(apiUrl(`/api/tasks${qs}`));
  expect(res.status).toBe(400);
  const body = await res.json() as { error?: string };
  expect(typeof body.error).toBe('string');
  return body.error!;
}

/**
 * Seed one fixture per interesting combination. Timestamps are stamped through
 * updateTaskRaw (an exact-id single-row UPDATE) because addTask always writes
 * "now" — the raw path is the only way to place a row in the past.
 */
async function seedFixtures(): Promise<void> {
  const fixtures: Array<{
    label: string;
    title: string;
    project?: string;
    raw: Partial<Task>;
  }> = [
    // THE target of the pinned+complete+6h query.
    {
      label: 'pinnedCompleteRecent',
      title: 'Pinned, completed 2h ago',
      project: 'Marina',
      raw: { pinned: true, phase: 'COMPLETE', created_at: iso(80 * HOUR), updated_at: iso(2 * HOUR), completed_at: iso(2 * HOUR) },
    },
    // Same shape but OUTSIDE the 6h window.
    {
      label: 'pinnedCompleteOld',
      title: 'Pinned, completed 30h ago',
      project: 'Marina',
      raw: { pinned: true, phase: 'COMPLETE', created_at: iso(90 * HOUR), updated_at: iso(30 * HOUR), completed_at: iso(30 * HOUR) },
    },
    // Recent + pinned but NOT complete.
    {
      label: 'pinnedActiveRecent',
      title: 'Pinned, still in progress',
      project: 'Marina',
      raw: { pinned: true, phase: 'IN_PROGRESS', created_at: iso(70 * HOUR), updated_at: iso(1 * HOUR) },
    },
    // Recent + complete but NOT pinned.
    {
      label: 'unpinnedCompleteRecent',
      title: 'Unpinned, completed 3h ago',
      project: 'Marina',
      raw: { phase: 'COMPLETE', created_at: iso(60 * HOUR), updated_at: iso(3 * HOUR), completed_at: iso(3 * HOUR) },
    },
    // Other project, updated inside 24h.
    {
      label: 'acmeRecent',
      title: 'Acme task updated 5h ago',
      project: 'Acme',
      raw: { phase: 'TODO', priority: 'immediate', created_at: iso(50 * HOUR), updated_at: iso(5 * HOUR) },
    },
    // Other project, updated well outside 24h.
    {
      label: 'acmeStale',
      title: 'Acme task updated 40h ago',
      project: 'Acme',
      raw: { phase: 'TODO', created_at: iso(45 * HOUR), updated_at: iso(40 * HOUR) },
    },
    // Inbox row with tags, for tag + Inbox coverage.
    {
      label: 'inboxTagged',
      title: 'Inbox task with tags',
      raw: { phase: 'NEED_ACTION', tags: ['urgent', 'home'], created_at: iso(10 * HOUR), updated_at: iso(9 * HOUR) },
    },
  ];

  for (const fixture of fixtures) {
    const { task } = await addTask({
      title: fixture.title,
      ...(fixture.project !== undefined ? { project: fixture.project } : {}),
    });
    ids[fixture.label] = task.id;
    const result = await updateTaskRaw(task.id, fixture.raw);
    expect(result.changed).toBe(true);
  }
}

beforeAll(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true });
  await fs.mkdir(WALNUT_HOME, { recursive: true });
  server = await startServer({ port: 0, dev: true });
  const addr = server.address();
  port = typeof addr === 'object' && addr ? addr.port : 0;
  await seedFixtures();
});

afterAll(async () => {
  await stopServer();
  await fs.rm(WALNUT_HOME, { recursive: true, force: true });
});

describe('REST composable filters', () => {
  it('pinned + complete + last 6 hours returns exactly the one matching fixture', async () => {
    const tasks = await getTasks('?pinned=true&completion=complete&time_basis=updated&last_hours=6');
    expect(tasks.map((t) => t.id)).toEqual([ids.pinnedCompleteRecent]);
  });

  it('drops the pinned dimension → the unpinned completed fixture joins the result', async () => {
    const tasks = await getTasks('?completion=complete&time_basis=updated&last_hours=6');
    expect(new Set(tasks.map((t) => t.id)))
      .toEqual(new Set([ids.pinnedCompleteRecent, ids.unpinnedCompleteRecent]));
  });

  it('project + updated in the last 24h excludes the stale same-project task', async () => {
    const tasks = await getTasks('?projects=Acme&time_basis=updated&last_hours=24');
    expect(tasks.map((t) => t.id)).toEqual([ids.acmeRecent]);
  });

  it('matches project names case-insensitively', async () => {
    const tasks = await getTasks('?projects=acme&time_basis=updated&last_hours=24');
    expect(tasks.map((t) => t.id)).toEqual([ids.acmeRecent]);
  });

  it('created_or_updated hits a row whose created_at is old but updated_at is recent', async () => {
    const viaUpdated = await getTasks('?projects=Acme&time_basis=created_or_updated&last_hours=24');
    expect(viaUpdated.map((t) => t.id)).toEqual([ids.acmeRecent]);
    // created_at for both Acme fixtures is >24h old, so the created basis alone
    // matches neither — proving the OR branch (not a passthrough) did the work.
    const viaCreated = await getTasks('?projects=Acme&time_basis=created&last_hours=24');
    expect(viaCreated).toEqual([]);
  });

  it('phases AND completion intersect rather than override', async () => {
    // COMPLETE is not in the in_progress group → empty, not "phase wins".
    expect(await getTasks('?completion=in_progress&phases=COMPLETE')).toEqual([]);
    const both = await getTasks('?completion=complete&phases=COMPLETE&projects=Marina');
    expect(new Set(both.map((t) => t.id)))
      .toEqual(new Set([ids.pinnedCompleteRecent, ids.pinnedCompleteOld, ids.unpinnedCompleteRecent]));
  });

  it('does NOT hide COMPLETE without an explicit state filter', async () => {
    const tasks = await getTasks('');
    expect(tasks.map((t) => t.id)).toContain(ids.pinnedCompleteOld);
    expect(tasks).toHaveLength(Object.keys(ids).length);
  });

  it('sorts by updated_desc with a stable id tie-breaker, and honors limit', async () => {
    const all = await getTasks('?sort=updated_desc');
    const updatedTimes = all.map((t) => Date.parse(t.updated_at));
    expect(updatedTimes).toEqual([...updatedTimes].sort((a, b) => b - a));
    const limited = await getTasks('?sort=updated_desc&limit=2');
    expect(limited.map((t) => t.id)).toEqual(all.slice(0, 2).map((t) => t.id));
  });

  it('tags_any / tags_all filter the tagged Inbox fixture', async () => {
    expect((await getTasks('?tags_any=urgent')).map((t) => t.id)).toEqual([ids.inboxTagged]);
    expect((await getTasks('?tags_all=urgent,home')).map((t) => t.id)).toEqual([ids.inboxTagged]);
    expect(await getTasks('?tags_all=urgent,missing')).toEqual([]);
  });

  it('projects= (empty value) filters to Inbox', async () => {
    expect((await getTasks('?projects=')).map((t) => t.id)).toEqual([ids.inboxTagged]);
  });

  it('keeps the legacy singular params working', async () => {
    // Legacy ?status= maps into completion; ?project=/?tags=/?sprint= into arrays.
    const todo = await getTasks('?status=todo&project=Acme');
    expect(new Set(todo.map((t) => t.id))).toEqual(new Set([ids.acmeRecent, ids.acmeStale]));
    expect((await getTasks('?tags=home')).map((t) => t.id)).toEqual([ids.inboxTagged]);
    // A bare ?tags= filtered nothing before — keep that.
    expect(await getTasks('?tags=')).toHaveLength(Object.keys(ids).length);
  });

  it('blocked=false evaluates the derived dimension', async () => {
    // No fixture is blocked, so the false side returns everything.
    expect(await getTasks('?blocked=false')).toHaveLength(Object.keys(ids).length);
    expect(await getTasks('?blocked=true')).toEqual([]);
  });

  it('applies limit AFTER a derived predicate (blocked) rather than in SQL', async () => {
    // With a derived filter present the limit must be honored on the FINAL set;
    // an SQL-side limit could have been consumed by rows blocked=false drops.
    const limited = await getTasks('?blocked=false&sort=updated_desc&limit=3');
    expect(limited).toHaveLength(3);
    const all = await getTasks('?sort=updated_desc');
    expect(limited.map((t) => t.id)).toEqual(all.slice(0, 3).map((t) => t.id));
  });
});

describe('REST validation', () => {
  it('rejects an unknown completion value', async () => {
    expect(await getError('?completion=finished')).toMatch(/completion/i);
  });

  it('rejects an unknown phase, priority and sort', async () => {
    expect(await getError('?phases=SHIPPED')).toMatch(/phase/i);
    expect(await getError('?priorities=urgent')).toMatch(/priority/i);
    expect(await getError('?sort=alphabetical')).toMatch(/sort/i);
  });

  it('rejects a limit outside 1..200', async () => {
    expect(await getError('?limit=0')).toMatch(/limit/i);
    expect(await getError('?limit=201')).toMatch(/limit/i);
    expect(await getError('?limit=abc')).toMatch(/limit/i);
  });

  it('rejects conflicting / incomplete time windows', async () => {
    expect(await getError('?time_basis=updated&last_hours=6&last_days=2')).toMatch(/mutually exclusive/i);
    expect(await getError('?time_basis=updated&last_hours=6&time_from=2026-01-01T00:00:00Z'))
      .toMatch(/cannot be combined/i);
    expect(await getError('?last_hours=6')).toMatch(/time_basis/i);
    expect(await getError('?time_basis=yesterday&last_hours=6')).toMatch(/basis/i);
    expect(await getError('?time_basis=updated&last_hours=0')).toMatch(/last_hours/i);
    expect(await getError('?time_basis=updated&time_from=not-a-date')).toMatch(/time\.from|timestamp/i);
  });

  it('rejects a non-boolean boolean param', async () => {
    expect(await getError('?pinned=yes')).toMatch(/pinned/i);
  });
});

describe('projection parity', () => {
  it('full, slim and minimal return identical ID sets and order', async () => {
    const qs = '?projects=Marina&sort=updated_desc';
    const full = await getTasks(qs);
    const slim = await getTasks(`${qs}&slim=1`);
    const minimal = await getTasks(`${qs}&fields=list`);
    expect(full.length).toBeGreaterThan(0);
    const idsOf = (list: Task[]) => list.map((t) => t.id);
    expect(idsOf(slim)).toEqual(idsOf(full));
    expect(idsOf(minimal)).toEqual(idsOf(full));
    // …and the projections really do differ in shape.
    expect('note' in full[0]).toBe(true);
    expect('note' in slim[0]).toBe(false);
    expect('summary' in minimal[0]).toBe(false);
  });
});

describe('project counts', () => {
  it('the project registry counts the seeded fixtures per project', async () => {
    const res = await fetch(apiUrl('/api/projects'));
    expect(res.status).toBe(200);
    const body = await res.json() as {
      projects: Array<{ name: string; counts: { todo: number; active: number; done: number } }>
    };
    const acme = body.projects.find((p) => p.name === 'Acme');
    expect(acme).toBeDefined();
    // Both Acme fixtures are TODO, so nothing is done there …
    expect(acme!.counts.done).toBe(0);
    expect(acme!.counts.todo).toBe(2);
    // … while Marina holds the three COMPLETE fixtures.
    const marina = body.projects.find((p) => p.name === 'Marina');
    expect(marina!.counts.done).toBe(3);
  });
});
