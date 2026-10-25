import { beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { createMockConstants } from '../helpers/mock-constants.js';
vi.mock('../../src/constants.js', () => createMockConstants('walnut-routing-slice'));
import { WALNUT_HOME } from '../../src/constants.js';
import { addTask } from '../../src/core/task-manager.js';
import { createSessionRecord, updateSessionRecord } from '../../src/core/session-tracker.js';
import { buildHostSlice } from '../../src/core/host-slice.js';
import { markProcessing, removeProcessed, sendMessageToSession } from '../../src/core/session-message-queue.js';
import { noteTaskRoutingToldByHost } from '../../src/core/sessions/task-routing-notice.js';
import { notePlaceCompaction } from '../../src/core/sessions/place-notice.js';
import { TASK_ROUTING_CONTRACT } from '../../src/core/task-routing-contract.js';

beforeEach(async () => { await fs.rm(WALNUT_HOME, { recursive: true, force: true }); });
describe('server supplies canonical policy to old host-local org sessions', () => {
  it('the slice carries the rule only while due, and a host delivery under that key makes it told', async () => {
    const { task } = await addTask({ title: 'Main', project: 'Ask Walnut', walnut_agent: true, org_role: 'main' });
    const sid = randomUUID();
    await createSessionRecord(sid, task.id, task.project, WALNUT_HOME);
    await updateSessionRecord(sid, { appliedAppendSystemPrompt: 'Old area routing' });
    const row = async () => (await buildHostSlice('__local__')).sessions.find((r) => r.sid === sid);
    const due = await row();
    expect(due?.taskRoutingPolicy).toContain(TASK_ROUTING_CONTRACT);
    expect(due?.taskRoutingDue).toBeTruthy();
    // A stale key (the prompt or compaction moved on) records nothing.
    await noteTaskRoutingToldByHost(sid, 'not-the-current-key');
    expect((await row())?.taskRoutingDue).toBe(due?.taskRoutingDue);
    await noteTaskRoutingToldByHost(sid, due!.taskRoutingDue!);
    expect(await row()).not.toHaveProperty('taskRoutingPolicy');
    // The server's own queue now leaves it out too.
    await sendMessageToSession(sid, 'Next notice');
    const [line] = await markProcessing(sid);
    expect(line.message).not.toContain(TASK_ROUTING_CONTRACT);
    await removeProcessed(sid, [line.id]);
    // A compaction makes it due again, under a new key.
    await notePlaceCompaction(sid, 'boundary-1');
    const again = await row();
    expect(again?.taskRoutingDue).toBeTruthy();
    expect(again?.taskRoutingDue).not.toBe(due?.taskRoutingDue);
    // A line the server delivers itself also makes it told.
    await sendMessageToSession(sid, 'After compaction');
    const [led] = await markProcessing(sid);
    expect(led.message).toContain(TASK_ROUTING_CONTRACT);
    await removeProcessed(sid, [led.id]);
    expect(await row()).not.toHaveProperty('taskRoutingPolicy');
  });
  it('ordinary workers and current org prompts add no policy bytes', async () => {
    for (const role of [undefined, 'main', 'lead'] as const) {
      const { task } = await addTask({ title: role ?? 'Worker', project: role === 'main' ? 'Ask Walnut' : 'Mobile',
        ...(role ? { org_role: role } : {}), ...(role === 'main' ? { walnut_agent: true } : {}) });
      const sid = randomUUID();
      await createSessionRecord(sid, task.id, task.project, WALNUT_HOME);
      await updateSessionRecord(sid, { appliedAppendSystemPrompt: role ? TASK_ROUTING_CONTRACT : 'Old worker prompt' });
    }
    for (const row of (await buildHostSlice('__local__')).sessions) expect(row).not.toHaveProperty('taskRoutingPolicy');
  });
});
