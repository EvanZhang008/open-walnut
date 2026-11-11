import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import fs from 'node:fs/promises';
import { createMockConstants } from '../helpers/mock-constants.js';
vi.mock('../../src/constants.js', () => createMockConstants('experimental-sync'));
import { WALNUT_HOME } from '../../src/constants.js';
import { addTask, getTask, updateTask, updateTaskRaw } from '../../src/core/task-manager.js';
import { createSessionRecord, updateSessionRecord } from '../../src/core/session-tracker.js';
import { updateConfig } from '../../src/core/config-manager.js';
import { syncUserStatuses, stopUserStatusSync } from '../../src/core/user-status-sync.js';

beforeEach(async () => { stopUserStatusSync(); await fs.rm(WALNUT_HOME, { recursive: true, force: true }); });
afterAll(async () => { stopUserStatusSync(); await fs.rm(WALNUT_HOME, { recursive: true, force: true }); });

async function team() {
  const p = (await addTask({ title: 'Leader' })).task;
  const m = (await addTask({ title: 'Nested leader', parent_task_id: p.id })).task;
  const w = (await addTask({ title: 'Worker', parent_task_id: m.id })).task;
  for (const t of [p, m, w]) {
    const sid = `session-${t.id}`;
    await createSessionRecord(sid, t.id);
    await updateTaskRaw(t.id, { phase: 'IN_PROGRESS', session_id: sid }, { emitEvent: false, push: false });
    await updateSessionRecord(sid, { process_status: t.id === w.id ? 'running' : 'idle' });
  }
  return { p, m, w };
}

describe('experimental stored status across a tree', () => {
  it('the same pass updates every ancestor, and disabling restores the old rule', async () => {
    const { p, m, w } = await team();
    await syncUserStatuses(null);
    expect((await getTask(p.id)).user_status?.state).toBe('waiting');
    await updateConfig({ experimental: { leader_status_follows_workers: true } });
    await syncUserStatuses(new Set([w.id]));
    for (const t of [p, m, w]) expect((await getTask(t.id)).user_status?.state).toBe('working');
    await updateSessionRecord(`session-${w.id}`, { process_status: 'idle' });
    await updateTask(w.id, { phase: 'WAITING', wait_until: new Date(Date.now() + 60_000).toISOString() });
    await syncUserStatuses(new Set([w.id]));
    for (const t of [p, m, w]) expect((await getTask(t.id)).user_status?.state).toBe('waiting');
    await updateConfig({ experimental: { leader_status_follows_workers: false } });
    await updateSessionRecord(`session-${w.id}`, { process_status: 'running' });
    await syncUserStatuses(null);
    expect((await getTask(w.id)).user_status?.state).toBe('working');
    expect((await getTask(p.id)).user_status?.state).toBe('waiting');
  });

  it('with the experiment off a pass reads the statuses as they were before it, as today', async () => {
    const { p, m, w } = await team();
    await syncUserStatuses(null);
    await updateSessionRecord(`session-${w.id}`, { process_status: 'idle' });
    await updateTaskRaw(w.id, { phase: 'NEED_ACTION', status_report: { state: 'needs', ask: 'Approve the post', at: new Date().toISOString() } }, { emitEvent: false, push: false });
    await syncUserStatuses(null);
    expect((await getTask(w.id)).user_status?.state).toBe('needs');
    // One level per pass (rollUpAsks reads the stored child): the leader above has no ask yet.
    expect((await getTask(m.id)).user_status?.asks ?? []).toEqual([]);
    await syncUserStatuses(null);
    expect((await getTask(m.id)).user_status?.asks).toEqual([expect.objectContaining({ id: w.id })]);
    expect((await getTask(p.id)).user_status?.asks ?? []).toEqual([]);
  });

  it('asks propagate with their owner and completion becomes a result to read', async () => {
    const { p, m, w } = await team();
    await updateConfig({ experimental: { leader_status_follows_workers: true } });
    await updateSessionRecord(`session-${w.id}`, { process_status: 'idle' });
    await updateTaskRaw(w.id, { phase: 'NEED_ACTION', status_report: { state: 'needs', ask: 'Approve the post', at: new Date().toISOString() } }, { emitEvent: false, push: false });
    await syncUserStatuses(new Set([w.id]));
    for (const t of [p, m]) {
      const status = (await getTask(t.id)).user_status;
      expect(status?.state).toBe('needs');
      expect(status?.asks).toEqual([expect.objectContaining({ id: w.id, ask: 'Approve the post' })]);
    }
    await updateTask(w.id, { phase: 'COMPLETE' });
    await syncUserStatuses(new Set([w.id]));
    expect((await getTask(m.id)).user_status).toMatchObject({ state: 'waiting', kind: 'lead' });
    expect((await getTask(p.id)).user_status).toMatchObject({ state: 'read', toRead: 'result', category: 'close' });
    expect((await getTask(p.id)).phase).toBe('IN_PROGRESS');
  });
});
