import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockConstants } from '../helpers/mock-constants.js';

vi.mock('../../src/constants.js', () => createMockConstants('router-history-write'));

import { WALNUT_HOME, TASKS_DIR, SESSIONS_FILE } from '../../src/constants.js';
import * as fsUtils from '../../src/utils/fs.js';
import { closeDb as closeTaskDb, getDb as getTaskDb, rowToTask } from '../../src/core/task-db.js';
import { updateTaskFromSession } from '../../src/hooks/shared.js';
import type { Database } from '../../src/lib/sqlite.js';
import { closeDb as closeSessionDb, getDb as getSessionDb } from '../../src/core/session-db.js';
import { _resetForTesting, addTask, addTasksBulk, applyTaskReplica, deleteTasksBulk, getTask, linkSessionSlot, listTasks, updateTask, updateTaskRaw, updateTasksBulk } from '../../src/core/task-manager.js';
import { _resetSessionTrackerForTesting, batchUpdateSessionRecords, createSessionRecord, getSessionByClaudeId, getSessionsForTask, importSessionRecord, renameSessionId, stageAcpSessionIdMigration, updateSessionRecord } from '../../src/core/session-tracker.js';
import { routerAreaProfile } from '../../src/core/router/session-policy.js';
import type { SessionProfile, Task } from '../../src/core/types.js';
import { patchLegacyTask } from '../helpers/router-history-fixtures.js';

const REFUSAL = { code: 'router_history_not_isolated', status: 409 };
const scope = (role: 'router' | 'work' = 'work') => ({
  router_area_id: 'desk', ...(role === 'router' ? { org_role: 'router' as const } : {}),
});

async function task(fields: Partial<Task> = {}) {
  return (await addTask({ title: 'History fixture', project: '', source: 'local', ...fields })).task;
}
async function scoped(role: 'router' | 'work' = 'work') {
  const owner = await task(scope(role));
  const sid = randomUUID();
  const record = await createSessionRecord(sid, owner.id, '', undefined, {
    host: '__local__', profile: routerAreaProfile('desk', role), initialProcessStatus: 'stopped',
  });
  return { owner, sid, record };
}

beforeEach(async () => {
  closeSessionDb(); closeTaskDb();
  _resetSessionTrackerForTesting(); _resetForTesting();
  await fs.rm(WALNUT_HOME, { recursive: true, force: true });
  await fs.mkdir(TASKS_DIR, { recursive: true });
});
afterEach(async () => {
  closeSessionDb(); closeTaskDb();
  _resetSessionTrackerForTesting(); _resetForTesting();
  await fs.rm(WALNUT_HOME, { recursive: true, force: true });
});

describe('the synchronous task and session history write boundary', () => {
  it('waits for an in-flight legacy migration before classifying a task, preserving the old conversation', async () => {
    const owner = await task();
    const sid = randomUUID();
    const now = new Date().toISOString();
    await fs.writeFile(SESSIONS_FILE, JSON.stringify({ version: 2, sessions: [{ claudeSessionId: sid,
      taskId: owner.id, project: '', process_status: 'stopped', mode: 'default', type: 'interactive',
      startedAt: now, lastActiveAt: now, last_status_change: now, messageCount: 1 }] }));
    closeSessionDb(); _resetSessionTrackerForTesting(); _resetForTesting();
    let release!: () => void;
    let entered = false;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const read = fsUtils.readJsonFile;
    const spy = vi.spyOn(fsUtils, 'readJsonFile').mockImplementation(async (...args) => {
      if (args[0] === SESSIONS_FILE) { entered = true; await gate; }
      return read(...args);
    });
    const oldHistory = getSessionByClaudeId(sid);
    let classify: Promise<unknown> | undefined;
    let settled = false;
    try {
      await vi.waitFor(() => expect(entered).toBe(true));
      classify = updateTaskRaw(owner.id, scope()).then(() => { settled = true; return undefined; },
        (error: unknown) => { settled = true; return error; });
      await Promise.resolve(); await Promise.resolve();
      expect(settled).toBe(false);
      release();
      expect(await classify).toMatchObject(REFUSAL);
      expect(await oldHistory).toMatchObject({ claudeSessionId: sid, taskId: owner.id });
      expect((await getTask(owner.id)).router_area_id).toBeFalsy();
    } finally {
      release(); spy.mockRestore();
      await Promise.allSettled([oldHistory, ...(classify ? [classify] : [])]);
    }
  });

  it('refuses classification when ordinary registration wins, preserving both rows', async () => {
    const owner = await task();
    const sid = randomUUID();
    await createSessionRecord(sid, owner.id, '', undefined, { initialProcessStatus: 'stopped' });
    const beforeTask = await getTask(owner.id);
    const beforeSession = await getSessionByClaudeId(sid);
    await expect(updateTaskRaw(owner.id, scope())).rejects.toMatchObject(REFUSAL);
    expect(await getTask(owner.id)).toEqual(beforeTask);
    expect(await getSessionByClaudeId(sid)).toEqual(beforeSession);
  });

  it('refuses ordinary registration when classification wins, without saving a session row', async () => {
    const owner = await task();
    await updateTaskRaw(owner.id, scope());
    const sid = randomUUID();
    await expect(createSessionRecord(sid, owner.id, '', undefined, { initialProcessStatus: 'stopped' }))
      .rejects.toMatchObject(REFUSAL);
    expect(await getSessionByClaudeId(sid)).toBeNull();
    expect(await getSessionsForTask(owner.id)).toEqual([]);
    expect((await getTask(owner.id)).router_area_id).toBe('desk');
    await createSessionRecord(sid, owner.id, '', undefined, { profile: routerAreaProfile('desk', 'work'), initialProcessStatus: 'stopped' });
    expect((await getSessionByClaudeId(sid))?.profile?.areaId).toBe('desk');
  });

  for (const writer of ['update', 'create-fill'] as const) {
    it(`never relabels an ordinary conversation with an isolated profile through ${writer}`, async () => {
      const owner = await task();
      const sid = randomUUID();
      await createSessionRecord(sid, owner.id, '', undefined, { initialProcessStatus: 'stopped' });
      const before = await getSessionByClaudeId(sid);
      const profile = routerAreaProfile('desk', 'work');
      const write = writer === 'update'
        ? updateSessionRecord(sid, { profile })
        : createSessionRecord(sid, owner.id, '', undefined, { profile });
      await expect(write).rejects.toMatchObject(REFUSAL);
      expect(await getSessionByClaudeId(sid)).toEqual(before);
      await expect(updateTaskRaw(owner.id, scope())).rejects.toMatchObject(REFUSAL);
    });
  }

  it('refuses a later taskless attachment and keeps the original ordinary history', async () => {
    const owner = await task(scope());
    const sid = randomUUID();
    await createSessionRecord(sid, '', '', undefined, { initialProcessStatus: 'stopped' });
    const before = await getSessionByClaudeId(sid);
    for (const patch of [{ taskId: owner.id }, { taskId: owner.id, profile: routerAreaProfile('desk', 'work') }]) {
      await expect(updateSessionRecord(sid, patch)).rejects.toMatchObject(REFUSAL);
      expect(await getSessionByClaudeId(sid)).toEqual(before);
    }
    const taskless = randomUUID();
    await expect(createSessionRecord(taskless, '', '', undefined, { profile: routerAreaProfile('desk', 'work') }))
      .rejects.toMatchObject(REFUSAL);
    expect(await getSessionByClaudeId(taskless)).toBeNull();
  });

  const invalidPolicies: Array<[string, Partial<SessionProfile>]> = [
    ['clear the area', { areaId: undefined }],
    ['change the area', { areaId: 'elsewhere' }],
    ['change the role', { areaRole: 'router' }],
    ['enable built-in tools', { tools: ['Bash'] }],
    ['enable default tools', { tools: [] }],
    ['allow a generic MCP tool', { allowedTools: ['mcp__walnut__task_list'] }],
    ['add a server', { mcpServers: { other: { command: '/bin/true', args: [] } } }],
    ['append rather than replace the prompt', { systemPromptMode: 'append' }],
    ['remove slim mode', { slim: false }],
  ];
  for (const [name, patch] of invalidPolicies) {
    it(`refuses to ${name} on a scoped session`, async () => {
      const { sid, record } = await scoped();
      await expect(updateSessionRecord(sid, { profile: { ...record.profile!, ...patch } }))
        .rejects.toMatchObject(REFUSAL);
      expect(await getSessionByClaudeId(sid)).toEqual(record);
    });
  }

  for (const patch of [{ profile: undefined }, { host: 'remote-fixture' }, { engine: 'codex' as const }]) {
    it(`refuses a scoped launch-policy change ${JSON.stringify(patch)}`, async () => {
      const { sid, record } = await scoped();
      await expect(updateSessionRecord(sid, patch)).rejects.toMatchObject(REFUSAL);
      expect(await getSessionByClaudeId(sid)).toEqual(record);
    });
  }

  it('refuses scope removal, reassignment and role conversion even with no conversation', async () => {
    const owner = await task(scope());
    const before = await getTask(owner.id);
    // An undefined field is no change (nothing is written); null is the stored clear.
    await expect(updateTaskRaw(owner.id, { router_area_id: undefined })).resolves.toEqual({ changed: false });
    expect(await getTask(owner.id)).toEqual(before);
    for (const patch of [{ router_area_id: null as never }, { router_area_id: '' }, { router_area_id: 'elsewhere' }]) {
      await expect(updateTaskRaw(owner.id, patch)).rejects.toMatchObject(REFUSAL);
      expect(await getTask(owner.id)).toEqual(before);
    }
    for (const org_role of ['main', 'lead'] as const) {
      await expect(updateTaskRaw(owner.id, { org_role })).rejects.toMatchObject(REFUSAL);
      expect(await getTask(owner.id)).toEqual(before);
    }
    const roleOnly = await task({ org_role: 'router' });
    await expect(updateTaskRaw(roleOnly.id, { org_role: null as never })).rejects.toMatchObject(REFUSAL);
    const { owner: work } = await scoped();
    await expect(updateTaskRaw(work.id, { org_role: 'router' })).rejects.toMatchObject(REFUSAL);
    const { owner: router } = await scoped('router');
    await expect(updateTaskRaw(router.id, { org_role: null as never })).rejects.toMatchObject(REFUSAL);
  });

  for (const field of ['session_id', 'exec_session_id', 'plan_session_id', 'session_ids', 'legacy_session_ids'] as const) {
    it(`validates every named history field ${field}, including missing records`, async () => {
      const owner = await task(scope());
      const plain = await task();
      const sid = randomUUID();
      await createSessionRecord(sid, plain.id, '', undefined, { initialProcessStatus: 'stopped' });
      const before = await getTask(owner.id);
      for (const id of [sid, randomUUID()]) {
        const value = field.endsWith('_ids') ? [id] : id;
        await expect(updateTaskRaw(owner.id, { [field]: value })).rejects.toMatchObject(REFUSAL);
        expect(await getTask(owner.id)).toEqual(before);
      }
    });
  }

  it('rejects another task\'s scoped history even in the same area, and accepts its own slot', async () => {
    const one = await scoped();
    const two = await task(scope());
    await expect(linkSessionSlot(two.id, one.sid, 'exec')).rejects.toMatchObject({ code: 'session_has_task', status: 409 });
    expect((await getTask(two.id)).exec_session_id).toBeFalsy();
    await linkSessionSlot(one.owner.id, one.sid, 'exec');
    expect((await getTask(one.owner.id)).exec_session_id).toBe(one.sid);
  });

  it('refuses to name an area conversation from an existing ordinary task', async () => {
    const one = await scoped();
    const ordinary = await task();
    const before = await getTask(ordinary.id);
    await expect(updateTaskRaw(ordinary.id, { session_ids: [one.sid] })).rejects.toMatchObject(REFUSAL);
    expect(await getTask(ordinary.id)).toEqual(before);
    expect(await getSessionByClaudeId(one.sid)).toEqual(one.record);
  });

  it('does not retask an area conversation to another task even in the same area', async () => {
    const one = await scoped();
    const other = await task(scope());
    await expect(updateSessionRecord(one.sid, { taskId: other.id })).rejects.toMatchObject(REFUSAL);
    expect(await getSessionByClaudeId(one.sid)).toEqual(one.record);
    expect(await getSessionsForTask(other.id)).toEqual([]);
  });

  it('keeps a deleted area conversation closed instead of making it an ordinary taskless session', async () => {
    const one = await scoped();
    await deleteTasksBulk([one.owner.id]);
    await expect(getTask(one.owner.id)).rejects.toThrow();
    expect(await getSessionByClaudeId(one.sid)).toMatchObject({ taskId: one.owner.id, profile: one.record.profile });
    await expect(addTask({ title: 'Reused ordinary identity', project: '', source: 'local', explicitId: one.owner.id }))
      .rejects.toMatchObject(REFUSAL);
    await expect(updateSessionRecord(one.sid, { taskId: '', profile: undefined })).rejects.toMatchObject(REFUSAL);
    await updateSessionRecord(one.sid, { title: 'Deleted fixture history' });
    expect((await getSessionByClaudeId(one.sid))?.profile).toEqual(one.record.profile);
  });

  it('does not leave rejected in-memory history edits in the cache or save them on the next write', async () => {
    const one = await scoped();
    await linkSessionSlot(one.owner.id, one.sid, 'exec');
    const snapshot = await getTask(one.owner.id);
    snapshot.session_ids.push('missing-rejected-history');
    await expect(updateTask(one.owner.id, { title: 'Must not save' })).rejects.toMatchObject(REFUSAL);
    expect((await getTask(one.owner.id)).session_ids).toEqual([one.sid]);
    expect((await listTasks()).find((row) => row.id === one.owner.id)?.session_ids).toEqual([one.sid]);
    await updateTask(one.owner.id, { title: 'Recovery fixture' });
    expect(await getTask(one.owner.id)).toMatchObject({ title: 'Recovery fixture', session_ids: [one.sid] });
  });

  it('rolls back an entire bulk classification when one row has ordinary history', async () => {
    const clean = await task();
    const old = await task();
    await createSessionRecord(randomUUID(), old.id, '', undefined, { initialProcessStatus: 'stopped' });
    await expect(updateTasksBulk([{ id: clean.id, patch: scope() }, { id: old.id, patch: scope() }]))
      .rejects.toMatchObject(REFUSAL);
    for (const id of [clean.id, old.id]) expect((await getTask(id)).router_area_id).toBeFalsy();
  });

  it('checks history on bulk insertion and saves none of a rejected batch', async () => {
    const ghostId = `ghost-${randomUUID()}`;
    await createSessionRecord(randomUUID(), ghostId, '', undefined, { initialProcessStatus: 'stopped' });
    const prototype = await task();
    const goodId = `new-${randomUUID()}`;
    await expect(addTasksBulk([
      { ...prototype, id: goodId, ...scope() },
      { ...prototype, id: ghostId, ...scope() },
    ])).rejects.toMatchObject(REFUSAL);
    await expect(getTask(goodId)).rejects.toThrow();
    await expect(getTask(ghostId)).rejects.toThrow();
  });

  it('rejects imported history whether it claims the isolated profile or names a scoped target', async () => {
    const area = await task(scope());
    const ordinary = await task();
    for (const opts of [
      { taskId: area.id },
      { taskId: area.id, profile: routerAreaProfile('desk', 'work') },
      { taskId: ordinary.id, profile: routerAreaProfile('desk', 'work') },
    ]) {
      const sid = randomUUID();
      await expect(importSessionRecord({ claudeSessionId: sid, project: '', ...opts }))
        .rejects.toMatchObject(REFUSAL);
      expect(await getSessionByClaudeId(sid)).toBeNull();
    }
  });

  for (const field of ['fromPlanSessionId', 'forkedFromSessionId', 'rewoundAtMessageUuid'] as const) {
    it(`does not accept copied history as a fresh area session via ${field}`, async () => {
      const owner = await task(scope());
      const sid = randomUUID();
      await expect(createSessionRecord(sid, owner.id, '', undefined, {
        profile: routerAreaProfile('desk', 'work'), [field]: randomUUID(), initialProcessStatus: 'stopped',
      })).rejects.toMatchObject(REFUSAL);
      expect(await getSessionByClaudeId(sid)).toBeNull();
    });
  }

  for (const migrate of [renameSessionId, stageAcpSessionIdMigration]) {
    it(`checks the original policy before ${migrate.name} and rolls back both identities`, async () => {
      const { sid, record } = await scoped();
      const next = randomUUID();
      await expect(migrate(sid, next, { profile: undefined })).rejects.toMatchObject(REFUSAL);
      expect(await getSessionByClaudeId(sid)).toEqual(record);
      expect(await getSessionByClaudeId(next)).toBeNull();
    });
  }

  it('batch updates skip rejected policy changes but accept subsequent status writes', async () => {
    const { sid, record } = await scoped();
    const plain = await task();
    const plainSid = randomUUID();
    await createSessionRecord(plainSid, plain.id, '', undefined, { initialProcessStatus: 'stopped' });
    expect(await batchUpdateSessionRecords([sid, plainSid], { profile: undefined })).toEqual([]);
    expect(await getSessionByClaudeId(sid)).toEqual(record);
    expect(new Set(await batchUpdateSessionRecords([sid, plainSid], { title: 'Batch fixture' })))
      .toEqual(new Set([sid, plainSid]));
    expect((await getSessionByClaudeId(sid))?.profile).toEqual(record.profile);
  });

  it('does not classify through an unreadable legacy history and can retry once it is readable', async () => {
    const owner = await task();
    closeSessionDb(); _resetSessionTrackerForTesting(); _resetForTesting();
    await fs.writeFile(SESSIONS_FILE, JSON.stringify({ version: 2, sessions: null }));
    await expect(updateTaskRaw(owner.id, scope())).rejects.toMatchObject({ code: 'router_history_unreadable', status: 503 });
    expect((await getTask(owner.id)).router_area_id).toBeFalsy();
    await updateTask(owner.id, { title: 'Ordinary metadata still works' });
    await updateTaskRaw(owner.id, { note: 'Ordinary findings still work' });
    expect(await getTask(owner.id)).toMatchObject({ title: 'Ordinary metadata still works', note: 'Ordinary findings still work' });
    await fs.writeFile(SESSIONS_FILE, JSON.stringify({ version: 2, sessions: [] }));
    await updateTaskRaw(owner.id, scope());
    expect((await getTask(owner.id)).router_area_id).toBe('desk');
  });

  it('never uses the replica copy exception on the primary', async () => {
    const owner = await task(scope());
    await expect(applyTaskReplica({ rows: [{ ...owner, router_area_id: undefined }], order: [owner.id] }))
      .rejects.toThrow(/Only a follower/);
    expect((await getTask(owner.id)).router_area_id).toBe('desk');
  });

  for (const writer of ['whole-store', 'raw-payload', 'bulk-payload'] as const) {
    it(`refuses ${writer} over an unreadable stored task policy without repairing it as ordinary`, async () => {
      const owner = await task(scope());
      const db = getTaskDb()!;
      db.prepare('UPDATE tasks SET payload = ? WHERE id = ?').run('{ invalid policy', owner.id);
      const write = writer === 'whole-store' ? updateTask(owner.id, { title: 'Must not save' })
        : writer === 'raw-payload' ? updateTaskRaw(owner.id, { unread: true })
          : updateTasksBulk([{ id: owner.id, patch: { unread: true } }]);
      await expect(write).rejects.toMatchObject({ code: 'router_history_unreadable', status: 503 });
      expect(db.prepare('SELECT payload FROM tasks WHERE id = ?').pluck().get(owner.id)).toBe('{ invalid policy');
    });
  }

  it('does not turn an unreadable task policy into ordinary registration permission', async () => {
    const owner = await task(scope());
    const db = getTaskDb()!;
    db.prepare('UPDATE tasks SET payload = ? WHERE id = ?').run('{ invalid policy', owner.id);
    const sid = randomUUID();
    await expect(createSessionRecord(sid, owner.id, '', undefined, { initialProcessStatus: 'stopped' }))
      .rejects.toMatchObject({ code: 'router_history_unreadable', status: 503 });
    expect(await getSessionByClaudeId(sid)).toBeNull();
  });

  it('does not overwrite an unreadable stored session policy with ordinary metadata', async () => {
    const one = await scoped();
    getSessionDb()!.prepare('UPDATE sessions SET payload = ? WHERE claude_session_id = ?').run('{ invalid policy', one.sid);
    await expect(updateSessionRecord(one.sid, { host: 'remote-fixture' }))
      .rejects.toMatchObject({ code: 'router_history_unreadable', status: 503 });
    expect(getSessionDb()!.prepare('SELECT payload FROM sessions WHERE claude_session_id = ?').pluck().get(one.sid))
      .toBe('{ invalid policy');
  });

  it('the standalone legacy stop hook leaves scoped tasks untouched and still updates ordinary tasks', async () => {
    const summary = { id: 'legacy-summary', project: '', slug: 'legacy-summary', summary: 'Fixture hook summary',
      status: 'completed', date: '2026-11-07', task_ids: [] };
    const owner = await task(scope());
    const before = await getTask(owner.id);
    updateTaskFromSession(owner.id, summary);
    expect(await getTask(owner.id)).toEqual(before);
    const plain = await task();
    updateTaskFromSession(plain.id, summary);
    const raw = getTaskDb()!.prepare('SELECT * FROM tasks WHERE id = ?').get(plain.id) as Record<string, unknown>;
    expect(rowToTask(raw)).toMatchObject({ session_ids: [summary.id], note: '[2026-11-07] Session: Fixture hook summary' });
  });

  it('the legacy hook SQL rechecks a scope mark made after its initial snapshot', async () => {
    const owner = await task();
    const handle = getTaskDb()!;
    const proto = Object.getPrototypeOf(handle) as Pick<Database, 'prepare'>;
    const prepare = proto.prepare;
    let injected = false;
    const spy = vi.spyOn(proto, 'prepare').mockImplementation(function (this: Database, sql: string) {
      if (!injected && /UPDATE tasks SET/.test(sql) && sql.includes('note = @note')) {
        injected = true;
        prepare.call(handle, `UPDATE tasks SET payload = json_set(coalesce(payload, '{}'), '$.router_area_id', 'desk') WHERE id = ?`).run(owner.id);
      }
      return prepare.call(this, sql);
    });
    try {
      updateTaskFromSession(owner.id, { id: 'late-summary', project: '', slug: 'late-summary', summary: 'Must not save',
        status: 'completed', date: '2026-11-07', task_ids: [] });
    } finally { spy.mockRestore(); }
    expect(injected).toBe(true);
    const raw = handle.prepare('SELECT * FROM tasks WHERE id = ?').get(owner.id) as Record<string, unknown>;
    expect(rowToTask(raw)).toMatchObject({ router_area_id: 'desk', note: '', session_ids: [] });
  });

  it('judges a whole-store write against the stored row, not a shadow a same-connection write left stale', async () => {
    const legacy = await task();
    const sid = randomUUID();
    await createSessionRecord(sid, legacy.id, '', undefined, { initialProcessStatus: 'stopped' });
    await task(); // the row shadow now describes the legacy row unmarked
    // Fault injection on the writer's own connection: data_version stays put, the shadow goes stale.
    patchLegacyTask(legacy.id, { router_area_id: 'desk' });
    const later = await task({ title: 'Written after the stale shadow' });
    expect((await getTask(later.id)).title).toBe('Written after the stale shadow');
    expect((await getTask(legacy.id)).router_area_id).toBe('desk');
    await expect(updateTaskRaw(legacy.id, { router_area_id: null as never })).rejects.toMatchObject(REFUSAL);
    expect((await getTask(legacy.id)).router_area_id).toBe('desk');
  });

  it('keeps ordinary and scoped status writes working without changing the history boundary', async () => {
    const { sid, owner, record } = await scoped();
    const updated = await updateSessionRecord(sid, { process_status: 'idle', title: 'Updated fixture' });
    expect(updated).toMatchObject({ taskId: owner.id, process_status: 'idle', title: 'Updated fixture', profile: record.profile });
    await updateTask(owner.id, { title: 'Updated area fixture' });
    await updateTaskRaw(owner.id, { note: 'Fixture findings' });
    expect(await getTask(owner.id)).toMatchObject({ router_area_id: 'desk', title: 'Updated area fixture', note: 'Fixture findings' });
    const plain = await task();
    const plainSid = randomUUID();
    await createSessionRecord(plainSid, plain.id, '', undefined, { initialProcessStatus: 'stopped' });
    await updateSessionRecord(plainSid, { process_status: 'idle', title: 'Ordinary fixture' });
    expect(await getSessionByClaudeId(plainSid)).toMatchObject({ taskId: plain.id, process_status: 'idle', title: 'Ordinary fixture' });
  });
});
