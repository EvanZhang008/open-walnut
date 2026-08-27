/**
 * POST /api/tasks — create-time pin tier (2026-08-27).
 *
 * The web console used to pick a tier at create time by doing TWO writes:
 * POST /api/tasks, then a focus-bar commit for the tier. If the second one
 * failed, the task silently dropped out of the tier the user picked. This route
 * now takes `focus_tier` so the tier lands in the same write as the pin.
 *
 * These cover the route's CONTRACT (which values it takes, what a bad one does,
 * what the response says). The value semantics themselves live in
 * tests/core/new-task-focus-tier.test.ts — the route delegates to the same
 * resolveNewTaskTier, so re-testing them here would just duplicate.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import { createMockConstants } from '../../helpers/mock-constants.js';

vi.mock('../../../src/constants.js', () => createMockConstants());

import express from 'express';
import request from 'supertest';
import { tasksRouter } from '../../../src/web/routes/tasks.js';
import { focusRouter } from '../../../src/web/routes/focus.js';
import { errorHandler } from '../../../src/web/middleware/error-handler.js';
import { createCustomTier, getTask, _resetForTesting } from '../../../src/core/task-manager.js';
import { closeDb } from '../../../src/core/task-db.js';
import { WALNUT_HOME } from '../../../src/constants.js';

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/tasks', tasksRouter);
  app.use('/api/focus', focusRouter);
  app.use(errorHandler);
  return app;
}

// SQLite keeps its fd on the unlinked inode — rm'ing WALNUT_HOME alone does not
// reset the store (see tasks.test.ts).
beforeEach(async () => {
  closeDb();
  _resetForTesting();
  await fs.rm(WALNUT_HOME, { recursive: true, force: true });
});

afterEach(async () => {
  closeDb();
  await fs.rm(WALNUT_HOME, { recursive: true, force: true });
});

/** POST a create body; returns { status, task }. */
async function create(body: unknown): Promise<{ status: number; body: Record<string, any> }> {
  const res = await request(createApp()).post('/api/tasks').send(body as object);
  return { status: res.status, body: res.body };
}

/** The tier split the focus surface serves. */
async function split(): Promise<Record<string, string[]>> {
  const res = await request(createApp()).get('/api/focus/tasks');
  expect(res.status).toBe(200);
  return res.body;
}

describe('POST /api/tasks — focus_tier', () => {
  it('lands the task in the named tier in ONE request', async () => {
    const { status, body } = await create({ title: 'Ship it', focus_tier: 'focus' });
    expect(status).toBe(201);
    // The 201 body already shows the final state — the client needs no second
    // call to know where the task went.
    expect(body.task.pinned).toBe(true);
    expect(body.task.focus_tier).toBe('focus');

    // And no follow-up write was needed for the board to agree.
    expect((await split()).focus_tasks).toEqual([body.task.id]);
  });

  it('normalizes satellite to pinned with no stored tier', async () => {
    const { status, body } = await create({ title: 'Soon', focus_tier: 'satellite' });
    expect(status).toBe(201);
    expect(body.task.pinned).toBe(true);
    expect(body.task.focus_tier).toBeUndefined();

    const s = await split();
    expect(s.satellite_tasks).toEqual([body.task.id]);
    expect(s.focus_tasks).toEqual([]);
  });

  it('pins from the tier alone (no explicit pinned in the body)', async () => {
    const { status, body } = await create({ title: 'Parked', focus_tier: 'wait' });
    expect(status).toBe(201);
    expect((await split()).wait_tasks).toEqual([body.task.id]);
  });

  it('400s an unknown tier instead of falling through to Satellite', async () => {
    const { status, body } = await create({ title: 'Bad tier', focus_tier: 'urgent' });
    expect(status).toBe(400);
    expect(body.error).toContain('unknown focus_tier');
    // The offending value comes back so the client can point at its own field.
    expect(body.focus_tier).toBe('urgent');
    // Nothing was created — a rejected create must not leave a task behind.
    expect((await request(createApp()).get('/api/tasks')).body.tasks).toEqual([]);
  });

  it('400s a non-string focus_tier before it reaches the core', async () => {
    // null is absent on purpose — see the "not specified" case below.
    for (const value of [7, {}, ['focus'], true]) {
      const { status, body } = await create({ title: 'Type check', focus_tier: value });
      expect(status).toBe(400);
      expect(body.error).toContain('focus_tier');
    }
  });

  it('treats "" / whitespace / null as "not specified"', async () => {
    // The shape a client sends when its tier picker was never touched — it must
    // behave exactly like omitting the field, not like a bad value.
    for (const value of ['', '   ', null]) {
      const { status, body } = await create({ title: 'Untouched picker', focus_tier: value });
      expect(status, JSON.stringify(value)).toBe(201);
      expect(body.task.pinned).toBe(true);
      expect(body.task.focus_tier).toBeUndefined();
    }
  });

  it('400s the pinned:false + tier contradiction', async () => {
    const { status, body } = await create({ title: 'Contradiction', pinned: false, focus_tier: 'focus' });
    expect(status).toBe(400);
    expect(body.error).toMatch(/contradicts pinned: false/);
  });

  it('accepts a registered ct_* and 400s an unregistered one', async () => {
    const { tier } = await createCustomTier('Errands');

    const ok = await create({ title: 'Custom tier task', focus_tier: tier.id });
    expect(ok.status).toBe(201);
    expect(ok.body.task.focus_tier).toBe(tier.id);
    expect((await split()).custom_tier_tasks[tier.id]).toEqual([ok.body.task.id]);

    const bad = await create({ title: 'Ghost tier', focus_tier: 'ct_notreal1' });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toContain('unknown focus_tier');
    // The valid list names the real tier so the client can recover in one trip.
    expect(bad.body.error).toContain(tier.id);
  });

  it('places a tiered create at the BOTTOM of the pinned set', async () => {
    const a = await create({ title: 'First' });
    const b = await create({ title: 'Second', focus_tier: 'focus' });
    const c = await create({ title: 'Third', focus_tier: 'backlog' });
    expect([a.status, b.status, c.status]).toEqual([201, 201, 201]);

    // pin_order is ONE board-wide sequence — the tier must not reorder it.
    expect((await split()).pinned_tasks).toEqual([a.body.task.id, b.body.task.id, c.body.task.id]);
    for (const [i, id] of [a, b, c].map((r, idx) => [idx, r.body.task.id] as const)) {
      expect((await getTask(id)).pin_order).toBe(i);
    }
  });

  it('keeps the pre-existing create behavior when focus_tier is omitted', async () => {
    // No-regression guard: this route's board default (Satellite via
    // newTaskPinDefault) and its explicit pinned:false escape hatch are
    // untouched by the new field.
    const dflt = await create({ title: 'Default create' });
    expect(dflt.status).toBe(201);
    expect(dflt.body.task.pinned).toBe(true);
    expect(dflt.body.task.focus_tier).toBeUndefined();
    expect((await split()).satellite_tasks).toEqual([dflt.body.task.id]);

    const off = await create({ title: 'Off the board', pinned: false });
    expect(off.status).toBe(201);
    expect(off.body.task.pinned).toBeUndefined();
    expect((await split()).pinned_tasks).toEqual([dflt.body.task.id]);
  });
});
