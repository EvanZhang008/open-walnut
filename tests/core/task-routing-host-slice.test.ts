import { beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { createMockConstants } from '../helpers/mock-constants.js';
vi.mock('../../src/constants.js', () => createMockConstants('walnut-routing-slice'));
import { WALNUT_HOME } from '../../src/constants.js';
import { addTask } from '../../src/core/task-manager.js';
import { createSessionRecord, updateSessionRecord } from '../../src/core/session-tracker.js';
import { buildHostSlice } from '../../src/core/host-slice.js';
import { sendMessageToSession } from '../../src/core/session-message-queue.js';
import { TASK_ROUTING_CONTRACT } from '../../src/core/task-routing-contract.js';

beforeEach(async () => { await fs.rm(WALNUT_HOME, { recursive: true, force: true }); });
describe('server supplies canonical policy to old host-local org sessions', () => {
  it('a queued input never removes the host compact rule; prompt refresh does', async () => {
    const { task } = await addTask({ title: 'Main', project: 'Ask Walnut', walnut_agent: true, org_role: 'main' });
    const sid = randomUUID();
    await createSessionRecord(sid, task.id, task.project, WALNUT_HOME);
    await updateSessionRecord(sid, { appliedAppendSystemPrompt: 'Old area routing' });
    const before = await buildHostSlice('__local__');
    expect(before.sessions.find((row) => row.sid === sid)?.taskRoutingPolicy).toContain(TASK_ROUTING_CONTRACT);
    await sendMessageToSession(sid, 'A real new goal');
    const told = await buildHostSlice('__local__');
    expect(told.sessions.find((row) => row.sid === sid)?.taskRoutingPolicy).toContain(TASK_ROUTING_CONTRACT);
    expect(told.hash).toBe(before.hash);
    await updateSessionRecord(sid, { appliedAppendSystemPrompt: TASK_ROUTING_CONTRACT });
    const current = await buildHostSlice('__local__');
    expect(current.sessions.find((row) => row.sid === sid)).not.toHaveProperty('taskRoutingPolicy');
    expect(current.hash).not.toBe(told.hash);
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
