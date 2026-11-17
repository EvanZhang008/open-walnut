/**
 * A link tag a session writes through PATCH /api/tasks/:id (task_update, task_update_bulk) is the
 * agent's, never the user's own: it joins Task.auto_links, so a later LINKS list may drop it
 * (link-tags.ts droppedLinkTags). The same tag from the web console (no caller session) stays the
 * user's and is never dropped. Before the fix every tag written through the route read as the user's.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import { createMockConstants } from '../../helpers/mock-constants.js';

vi.mock('../../../src/constants.js', () => createMockConstants());

import express from 'express';
import request from 'supertest';
import { tasksRouter } from '../../../src/web/routes/tasks.js';
import { errorHandler } from '../../../src/web/middleware/error-handler.js';
import { addTask, getTask, updateTask, _resetForTesting } from '../../../src/core/task-manager.js';
import { droppedLinkTags } from '../../../src/core/link-tags.js';
import { closeDb } from '../../../src/core/task-db.js';
import { closeDb as closeSessionDb } from '../../../src/core/session-db.js';
import { _resetSessionTrackerForTesting } from '../../../src/core/session-tracker.js';
import { WALNUT_HOME } from '../../../src/constants.js';

const CR = 'cr:https://review.acme.dev/CR-1001';
const TICKET = 'ticket:https://tickets.acme.dev/T-2002';

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/tasks', tasksRouter);
  app.use(errorHandler);
  return app;
}

function patch(id: string, body: Record<string, unknown>, sid?: string) {
  let req = request(createApp()).patch(`/api/tasks/${id}`).send(body);
  if (sid) req = req.set('x-walnut-caller-sid', sid);
  return req;
}

beforeEach(async () => {
  closeDb();
  closeSessionDb();
  _resetSessionTrackerForTesting();
  _resetForTesting();
  await fs.rm(WALNUT_HOME, { recursive: true, force: true });
});

afterEach(async () => {
  closeDb();
  closeSessionDb();
  await fs.rm(WALNUT_HOME, { recursive: true, force: true });
});

describe('PATCH /api/tasks/:id link tags by caller', () => {
  it("a session's added link is Walnut's: in auto_links, and a LINKS list that leaves it out drops it", async () => {
    const { task } = await addTask({ title: 'Agent links' });
    const res = await patch(task.id, { add_tags: [CR, 'team:marina'] }, 'sess-agent-1');
    expect(res.status).toBe(200);
    const after = await getTask(task.id);
    expect(after.tags).toEqual(expect.arrayContaining([CR, 'team:marina']));
    expect(after.auto_links).toEqual(['https://review.acme.dev/CR-1001']);
    expect(droppedLinkTags(after, [])).toEqual([CR]);
  });

  it("a session's set_tags marks only the links that are new, never a link the user already had", async () => {
    const { task } = await addTask({ title: 'Mixed links' });
    expect((await patch(task.id, { add_tags: [TICKET] })).status).toBe(200);
    expect((await patch(task.id, { set_tags: [TICKET, CR] }, 'sess-agent-2')).status).toBe(200);
    const after = await getTask(task.id);
    expect(after.auto_links).toEqual(['https://review.acme.dev/CR-1001']);
    expect(droppedLinkTags(after, [])).toEqual([CR]);
  });

  it('a link a session writes through the API v1 path (actorSid) is the agent\'s too', async () => {
    const { task } = await addTask({ title: 'V1 links' });
    await updateTask(task.id, { add_tags: [TICKET] }, { source: 'api', actorSid: 'sess-agent-3' });
    const after = await getTask(task.id);
    expect(after.auto_links).toEqual(['https://tickets.acme.dev/T-2002']);
  });

  it('a link Walnut added, removed and then added again by the person, is the person\'s own', async () => {
    const { task } = await addTask({ title: 'Re-added link' });
    expect((await patch(task.id, { add_tags: [CR] }, 'sess-agent-4')).status).toBe(200);
    expect((await patch(task.id, { remove_tags: [CR] })).status).toBe(200);
    expect((await getTask(task.id)).auto_links).toEqual(['https://review.acme.dev/CR-1001']);
    expect((await patch(task.id, { add_tags: [CR] })).status).toBe(200);
    const after = await getTask(task.id);
    expect(after.auto_links).toEqual([]);
    expect(droppedLinkTags(after, [])).toEqual([]);
  });

  it("the web console's link (no caller session) stays the user's and is never dropped", async () => {
    const { task } = await addTask({ title: 'Person links' });
    expect((await patch(task.id, { add_tags: [CR] })).status).toBe(200);
    const after = await getTask(task.id);
    expect(after.auto_links ?? []).toEqual([]);
    expect(droppedLinkTags(after, [])).toEqual([]);
  });
});
