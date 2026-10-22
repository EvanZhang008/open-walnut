import { describe, it, expect, vi, afterEach } from 'vitest';
import * as processUtils from '../../src/utils/process.js';
const worker = vi.hoisted(() => ({ alive: true }));
const host = vi.hoisted(() => ({ send: vi.fn(), hasCapability: vi.fn() }));
vi.mock('../../src/utils/process.js', () => ({ isProcessAliveAsync: vi.fn(async () => worker.alive) }));
vi.mock('../../src/providers/daemon-connection.js', async importOriginal => ({
  ...await importOriginal<typeof import('../../src/providers/daemon-connection.js')>(),
  getConnectedDaemonConnection: vi.fn(() => host),
  getDaemonConnection: vi.fn(async () => host),
}));
import { createMockConstants } from '../helpers/mock-constants.js';
vi.mock('../../src/constants.js', () => createMockConstants('inbox-item-recovery'));
vi.mock('../../src/core/notifications/letter-bridge.js', () => ({ ensureLetterBridge() {}, mirrorLetterReadState: async () => {} }));
import { sendLetter, getLetter } from '../../src/core/human-inbox/store.js';
import { registerInboxMailSource } from '../../src/core/human-inbox/item-source-registry.js';
import { prepareInboxItem } from '../../src/core/human-inbox/item-plans.js';
import { queryInboxItem, executeInboxItem, validateInboxMessageBoundary, validateInboxStartBoundary } from '../../src/core/human-inbox/item-execution.js';
import { inboxOwnsStartFailure } from '../../src/core/human-inbox/item-start-notification.js';
import { claimItemExecution, getItemPlan, updateItemExecution, releaseItemWorker, saveItemPlan, readItemLedger, withInboxStartAuthorization } from '../../src/core/human-inbox/item-ledger.js';
import { addTaskIdempotently } from '../../src/core/task-create-idempotency.js';
import { updateTaskRaw, deleteTask, getTask } from '../../src/core/task-manager.js';
import * as tracker from '../../src/core/session-tracker.js';
import { startSessionForTask } from '../../src/core/sessions/task-start.js';
import { sessionRunner } from '../../src/providers/claude-code-session.js';
import { claimSourceTask, lookupSourceClaim } from '../../src/core/source-task-claims.js';
import * as ops from '../../src/ops/index.js';
import * as conversation from '../../src/core/sessions/task-session-claim.js';
import type { SessionRecord } from '../../src/core/types.js';
import { z } from 'zod';
import { definePluginOp } from '../../src/ops/registry.js';

const legacy = new Map<string, string>();
const adapter = { legacyTaskId: async (key: string) => legacy.get(key), writeLegacy: async (key: string, id: string) => { legacy.set(key, legacy.get(key) ?? id); } };
afterEach(() => { vi.restoreAllMocks(); worker.alive = true; host.send.mockReset(); host.hasCapability.mockReset(); });
async function fixture(name: string, intent: 'create_task' | 'attach_task' | 'mark_read' = 'create_task') {
  const unregisterSource = registerInboxMailSource({ resolve: async source => ({ key: `rfc:${name}`, source, adapter }) });
  const mail = intent === 'mark_read' ? definePluginOp('fixture-recovery-mail', { name: 'mail_mark_read', title: 'Flag fixture mail', description: 'Test provider only',
    input: { account: z.string(), messages: z.array(z.string()), read: z.boolean() }, tags: { readonly: false, remote: 'deny' },
    handler: async () => { throw new Error('Recovery must not send a provider operation'); } }) : undefined;
  const unregister = () => { unregisterSource(); mail?.dispose(); };
  const source = { kind: 'mail' as const, account: `account-${name}`, message: `message-${name}` };
  const letter = await sendLetter({ subject: 'Recovery summary', type: 'review', markdown: 'Reference only', sender: { sessionId: 'external', host: 'local' },
    items: [{ id: `item-${name}`, subject: 'Update', summary: 'Data', source, actions: [{ id: `action-${name}`, kind: 'op', intent }] }] });
  const input = { actionId: `action-${name}`, title: 'Recover work', project: '', goal: 'Review the update' };
  return { letter, source, input, itemId: `item-${name}`, unregister };
}
const request = (plan: NonNullable<Awaited<ReturnType<typeof prepareInboxItem>>['plan']>, requestId: string) => ({ actionId: plan.actionId, requestId, confirmed: true, planId: plan.id, planVersion: plan.version });
async function interruptedStart(name: string, state: 'starting' | 'unconfirmed' = 'starting') {
  const f = await fixture(name);
  const plan = (await prepareInboxItem(f.letter.id, f.itemId, f.input, '__local__')).plan!;
  const saved = (await getItemPlan(plan.id))!;
  const create = plan.ops.find(op => op.tool === 'task_create')!.args;
  const task = (await addTaskIdempotently({ title: String(create.title), project: '', description: String(create.description) }, String(create.idempotency_key))).task;
  await claimSourceTask({ key: saved.sourceKey, pair: JSON.stringify([f.source.account, f.source.message]), createPayload: create,
    confirmation: { intent: 'create_task', goal: f.input.goal, targetTaskId: task.id }, adapter });
  const requestId = `${name}-request`;
  await claimItemExecution(saved, requestId);
  await updateItemExecution(requestId, { stage: 'starting', taskCreated: true, execution: 'unconfirmed' });
  const previousId = String(plan.ops.find(op => op.tool === 'task_start')!.args.start_attempt_id);
  const attempt = { id: previousId, at: new Date().toISOString(), state, session_id: `${name}-session`,
    runtime_id: `${name}-runtime`, host: '__local__', engine: 'claude' as const };
  await updateTaskRaw(task.id, { last_start: attempt });
  return { ...f, task, plan, saved, requestId, previousId, attempt };
}
function mockStartRunner() {
  return vi.spyOn(sessionRunner, 'startSession').mockImplementation(async launch => ({ claudeSessionId: launch.preassignedSessionId!, title: 'Recovered work' }));
}
function startParams(plan: NonNullable<Awaited<ReturnType<typeof prepareInboxItem>>['plan']>) {
  return { taskIdPrefix: plan.taskId!, ...plan.launch, message: String(plan.ops[0].args.message),
    engine: plan.launch!.engine as 'claude', expectReply: false, startAttemptId: String(plan.ops[0].args.start_attempt_id), source: 'api-v1' };
}
describe('Persisted execution recovery without resending', () => {
  it('recovers accepted only after a durable worker is confirmed dead', async () => {
    const f = await fixture('accepted');
    try {
      const prepared = await prepareInboxItem(f.letter.id, f.itemId, f.input, '__local__');
      const saved = (await getItemPlan(prepared.plan!.id))!;
      await claimItemExecution(saved, 'accepted-request');
      expect((await queryInboxItem(f.letter.id, f.itemId, '__local__')).receipts[0].status).toBe('pending');
      worker.alive = false;
      const recovered = (await queryInboxItem(f.letter.id, f.itemId, '__local__')).receipts[0];
      expect(recovered).toMatchObject({ status: 'failure', stage: 'finished', code: 'not_dispatched', taskCreated: false, execution: 'not_started', recovery: ['retry_create'] });
      expect(recovered.reason).toContain('No operation was sent');
      const retry = await prepareInboxItem(f.letter.id, f.itemId, f.input, '__local__');
      expect(retry.plan!.taskId).toBe(prepared.plan!.taskId);
      expect(retry.plan!.ops.map(op => op.tool)).toEqual(['task_create', 'task_start']);
    } finally { f.unregister(); }
  });
  it('distinguishes a reserved task from deletion and retries the exact create payload', async () => {
    const f = await fixture('reservation');
    try {
      const prepared = await prepareInboxItem(f.letter.id, f.itemId, f.input, '__local__');
      const saved = (await getItemPlan(prepared.plan!.id))!;
      const create = saved.plan.ops.find(op => op.tool === 'task_create')!.args;
      await claimSourceTask({ key: saved.sourceKey, pair: JSON.stringify([f.source.account, f.source.message]), createPayload: create,
        confirmation: { intent: 'create_task', goal: f.input.goal, targetTaskId: saved.plan.taskId! }, adapter });
      await claimItemExecution(saved, 'reserved-request');
      await updateItemExecution('reserved-request', { stage: 'creating', execution: 'unconfirmed' });
      expect((await queryInboxItem(f.letter.id, f.itemId, '__local__')).receipts[0].status).toBe('pending');
      worker.alive = false;
      const recovered = await queryInboxItem(f.letter.id, f.itemId, '__local__');
      expect(recovered.receipts[0]).toMatchObject({ status: 'failure', taskCreated: false, execution: 'not_started', code: 'create_unconfirmed', recovery: ['retry_create'] });
      expect(recovered.currentTask).toBeUndefined();
      const retry = await prepareInboxItem(f.letter.id, f.itemId, f.input, '__local__');
      expect(retry.restrictions).toEqual([]); expect(retry.existingWork).toBeUndefined();
      expect(retry.plan!.taskId).toBe(saved.plan.taskId);
      expect(retry.plan!.ops.find(op => op.tool === 'task_create')!.args).toEqual(create);
      const changed = await prepareInboxItem(f.letter.id, f.itemId, { ...f.input, title: 'Changed title' }, '__local__');
      expect(changed.plan).toBeUndefined(); expect(changed.restrictions[0].code).toBe('source_conflict');
      const changedGoal = await prepareInboxItem(f.letter.id, f.itemId, { ...f.input, goal: 'Another goal' }, '__local__');
      expect(changedGoal.plan).toBeUndefined(); expect(changedGoal.restrictions[0].code).toBe('source_conflict');
    } finally { f.unregister(); }
  });
  it('offers create retry after a known operation failure but never for an unknown result', async () => {
    const f = await fixture('known-create');
    const invoke = vi.spyOn(ops, 'executeOp').mockResolvedValue({ ok: false, message: 'Fixture refused create' });
    try {
      const first = (await prepareInboxItem(f.letter.id, f.itemId, f.input, '__local__')).plan!;
      await executeInboxItem(f.letter.id, f.itemId, request(first, 'known-create-request'), '__local__', 'http://127.0.0.1:1');
      await vi.waitFor(async () => expect((await queryInboxItem(f.letter.id, f.itemId, '__local__')).receipts[0].status).toBe('failure'));
      const receipt = (await queryInboxItem(f.letter.id, f.itemId, '__local__')).receipts[0];
      expect(receipt).toMatchObject({ taskCreated: false, execution: 'not_started', recovery: ['retry_create'] });
      const retry = (await prepareInboxItem(f.letter.id, f.itemId, f.input, '__local__')).plan!;
      expect(retry.taskId).toBe(first.taskId); expect(retry.ops.map(op => op.tool)).toEqual(['task_create', 'task_start']);
      invoke.mockResolvedValue({ ok: false, message: 'Request timed out' });
      await executeInboxItem(f.letter.id, f.itemId, request(retry, 'unknown-create-request'), '__local__', 'http://127.0.0.1:1');
      await vi.waitFor(async () => expect((await readItemLedger()).receipts['unknown-create-request'].execution).toBe('unconfirmed'));
      expect((await readItemLedger()).receipts['unknown-create-request'].recovery).toEqual(['check_status']);
      expect(invoke.mock.calls.map(call => call[0])).toEqual(['task_create', 'task_create']);
      const blocked = await prepareInboxItem(f.letter.id, f.itemId, f.input, '__local__');
      expect(blocked.plan).toBeUndefined(); expect(blocked.restrictions[0].code).toBe('outcome_unconfirmed');
    } finally { f.unregister(); }
  });
  it('validates only the claimed sending plan and lets settled message replays pass', async () => {
    const f = await fixture('message-boundary', 'attach_task');
    const task = (await addTaskIdempotently({ title: 'Boundary task', project: '' }, 'boundary-fixture')).task;
    vi.spyOn(conversation, 'taskConversation').mockResolvedValue({ claudeSessionId: 'boundary-session', cwd: '/tmp', host: '__local__', engine: 'claude' } as SessionRecord);
    try {
      const input = { ...f.input, selectedTaskId: task.id };
      const expired = (await prepareInboxItem(f.letter.id, f.itemId, input, '__local__')).plan!;
      const old = (await getItemPlan(expired.id))!;
      await claimItemExecution(old, 'old-boundary-request');
      await updateItemExecution('old-boundary-request', { status: 'failure', stage: 'finished', delivery: 'failed' });
      await saveItemPlan({ ...old, plan: { ...old.plan, expiresAt: '2026-01-01T00:00:00Z' } });
      const current = (await prepareInboxItem(f.letter.id, f.itemId, input, '__local__')).plan!;
      expect(current.messageId).toBe(expired.messageId);
      await claimItemExecution((await getItemPlan(current.id))!, 'new-boundary-request');
      await updateItemExecution('new-boundary-request', { stage: 'sending' });
      await expect(validateInboxMessageBoundary('boundary-session', current.messageId!)).resolves.toBeUndefined();
      await expect(validateInboxMessageBoundary('wrong-session', current.messageId!)).rejects.toThrow('changed');
      await updateItemExecution('new-boundary-request', { status: 'success', stage: 'finished', delivery: 'queued' });
      await expect(validateInboxMessageBoundary('wrong-session', current.messageId!)).resolves.toBeUndefined();
      await executeInboxItem(f.letter.id, f.itemId, request(current, 'new-boundary-request'), '__local__', 'http://127.0.0.1:1');
      expect((await readItemLedger()).receipts['new-boundary-request'].status).toBe('success');
    } finally { f.unregister(); }
  });
  it('makes alias receipts queryable and mirrors them even when a provider later disappears', async () => {
    const f = await fixture('mirrored-alias', 'mark_read');
    try {
      const first = (await prepareInboxItem(f.letter.id, f.itemId, { actionId: f.input.actionId }, '__local__')).plan!;
      const second = (await prepareInboxItem(f.letter.id, f.itemId, { actionId: f.input.actionId }, '__local__')).plan!;
      await claimItemExecution((await getItemPlan(first.id))!, 'mirror-canonical');
      const receipt = await executeInboxItem(f.letter.id, f.itemId, request(second, 'mirror-alias'), '__local__', 'http://127.0.0.1:1');
      expect(receipt.requestIds).toEqual(['mirror-canonical', 'mirror-alias']);
      expect((await getLetter(f.letter.id))!.items![0].receipts![0].requestIds).toEqual(receipt.requestIds);
      expect((await queryInboxItem(f.letter.id, f.itemId, '__local__')).receipts).toHaveLength(1);
      await expect(executeInboxItem(f.letter.id, f.itemId, request(first, 'mirror-alias'), '__local__', 'http://127.0.0.1:1')).rejects.toThrow('another confirmed plan');
      f.unregister();
      expect((await queryInboxItem(f.letter.id, f.itemId, '__local__')).receipts[0].requestIds).toEqual(receipt.requestIds);
    } finally { f.unregister(); }
  });
  it('requires an explicit read retry after a dead worker loses provider confirmation', async () => {
    const f = await fixture('read-interrupted', 'mark_read');
    try {
      const plan = (await prepareInboxItem(f.letter.id, f.itemId, { actionId: f.input.actionId }, '__local__')).plan!;
      await claimItemExecution((await getItemPlan(plan.id))!, 'read-interrupted-request');
      await updateItemExecution('read-interrupted-request', { stage: 'marking_read' });
      expect((await queryInboxItem(f.letter.id, f.itemId, '__local__')).receipts[0].status).toBe('pending');
      worker.alive = false;
      const recovered = (await queryInboxItem(f.letter.id, f.itemId, '__local__')).receipts[0];
      expect(recovered).toMatchObject({ status: 'failure', code: 'read_unconfirmed', recovery: ['check_status', 'retry_mark_read'] });
      expect(recovered.reason).toContain('before the mail provider confirmed');
    } finally { f.unregister(); }
  });
  it('does not reserve an archived conversation and permits a fresh review after resume', async () => {
    const f = await fixture('archived', 'attach_task');
    const task = (await addTaskIdempotently({ title: 'Archived task', project: '' }, 'archived-fixture')).task;
    const session = { claudeSessionId: 'archived-session', cwd: '/tmp', host: '__local__', engine: 'claude', archived: true } as SessionRecord;
    const lookup = vi.spyOn(conversation, 'taskConversation').mockResolvedValue(session);
    try {
      const input = { ...f.input, selectedTaskId: task.id };
      const blocked = await prepareInboxItem(f.letter.id, f.itemId, input, '__local__');
      expect(blocked.plan).toBeUndefined(); expect(blocked.restrictions[0].code).toBe('target_archived');
      expect(await lookupSourceClaim(`rfc:archived`, JSON.stringify([f.source.account, f.source.message]), adapter)).toBeUndefined();
      lookup.mockResolvedValue({ ...session, archived: false });
      const resumed = await prepareInboxItem(f.letter.id, f.itemId, input, '__local__');
      expect(resumed.plan!.ops.map(op => op.tool)).toEqual(['task_send']);
      expect(await lookupSourceClaim(`rfc:archived`, JSON.stringify([f.source.account, f.source.message]), adapter)).toBeUndefined();
    } finally { f.unregister(); }
  });
  it('recovers a pre-claim start interruption and fences the old authorization before a same-task retry', async () => {
    const f = await fixture('start-before-claim');
    try {
      const plan = (await prepareInboxItem(f.letter.id, f.itemId, f.input, '__local__')).plan!;
      const saved = (await getItemPlan(plan.id))!;
      const create = plan.ops.find(op => op.tool === 'task_create')!.args;
      const task = (await addTaskIdempotently({ title: String(create.title), project: '', description: String(create.description) }, String(create.idempotency_key))).task;
      await claimSourceTask({ key: saved.sourceKey, pair: JSON.stringify([f.source.account, f.source.message]), createPayload: create,
        confirmation: { intent: 'create_task', goal: f.input.goal, targetTaskId: task.id }, adapter });
      await claimItemExecution(saved, 'before-claim-request');
      await updateItemExecution('before-claim-request', { stage: 'starting', taskCreated: true });
      worker.alive = false;
      const recovered = (await queryInboxItem(f.letter.id, f.itemId, '__local__')).receipts[0];
      expect(recovered).toMatchObject({ status: 'failure', stage: 'finished', execution: 'not_started', recovery: ['retry_start', 'open_task'] });
      await expect(validateInboxStartBoundary(task.id, plan.ops[1].args.start_attempt_id as string)).rejects.toThrow('no longer authorized');
      const retry = await prepareInboxItem(f.letter.id, f.itemId, { ...f.input, retryStart: true }, '__local__');
      expect(retry.plan!.taskId).toBe(task.id); expect(retry.plan!.ops.map(op => op.tool)).toEqual(['task_start']);
      await claimItemExecution((await getItemPlan(retry.plan!.id))!, 'fresh-start-request');
      await updateItemExecution('fresh-start-request', { stage: 'starting' });
      await expect(validateInboxStartBoundary(task.id, retry.plan!.ops[0].args.start_attempt_id as string)).resolves.toBeUndefined();
      await expect(validateInboxStartBoundary(task.id, plan.ops[1].args.start_attempt_id as string)).rejects.toThrow('no longer authorized');
    } finally { f.unregister(); }
  });
  it.each(['starting', 'unconfirmed'] as const)('offers reviewed recovery only for the exact %s attempt after worker death', async state => {
    const f = await interruptedStart(`dead-${state}`, state);
    const invoke = vi.spyOn(ops, 'executeOp');
    const spawn = mockStartRunner();
    try {
      expect((await queryInboxItem(f.letter.id, f.itemId, '__local__')).receipts[0].status).toBe('pending');
      expect((await prepareInboxItem(f.letter.id, f.itemId, { ...f.input, retryStart: true }, '__local__')).plan).toBeUndefined();
      worker.alive = false;
      const recovery = (await queryInboxItem(f.letter.id, f.itemId, '__local__')).receipts[0];
      expect(recovery).toMatchObject({ status: 'failure', stage: 'finished', taskId: f.task.id, taskCreated: true,
        startAttemptId: f.previousId, execution: 'unconfirmed', code: 'start_recovery_required', recovery: ['retry_start', 'check_status', 'open_task'] });
      expect(recovery.reason).toContain('Nothing will be resent automatically');
      expect(recovery.reason).toContain('Only confirming');
      expect((await getTask(f.task.id)).last_start).toEqual(f.attempt);
      expect((await prepareInboxItem(f.letter.id, f.itemId, f.input, '__local__')).plan).toBeUndefined();
      const retry = (await prepareInboxItem(f.letter.id, f.itemId, { ...f.input, retryStart: true }, '__local__')).plan!;
      expect(retry.taskId).toBe(f.task.id); expect(retry.ops.map(op => op.tool)).toEqual(['task_start']);
      expect(retry.ops[0].args.start_attempt_id).not.toBe(f.previousId);
      const saved = (await getItemPlan(retry.id))!;
      expect(saved.previousStartId).toBe(f.previousId);
      await expect(executeInboxItem(f.letter.id, f.itemId, { ...request(retry, `${state}-not-confirmed`), confirmed: false }, '__local__', 'http://127.0.0.1:1')).rejects.toMatchObject({ code: 'confirmation_required' });
      expect(host.send).not.toHaveBeenCalled(); expect(invoke).not.toHaveBeenCalled(); expect(spawn).not.toHaveBeenCalled();
      const claimed = await claimItemExecution(saved, `${state}-confirmed`);
      expect(claimed.fresh).toBe(true); expect(claimed.receipt).toMatchObject({ status: 'pending', stage: 'accepted', taskId: f.task.id });
      await updateItemExecution(claimed.receipt.requestId, { stage: 'starting' });
      await expect(validateInboxStartBoundary(f.task.id, String(retry.ops[0].args.start_attempt_id))).resolves.toEqual({ previousStartId: f.previousId });
      expect(host.send).not.toHaveBeenCalled(); expect(spawn).not.toHaveBeenCalled();
    } finally { f.unregister(); }
  });
  it.each(['awaiting_spawn', 'spawn_outcome_unknown'])('replaces only the interrupted %s row after confirmed host cancellation', async status_reason => {
    const f = await interruptedStart(`row-${status_reason}`);
    const row = { claudeSessionId: f.attempt.session_id, taskId: f.task.id, process_status: 'idle', status_reason,
      cwd: '/tmp', host: '__local__', engine: 'claude' } as SessionRecord;
    const lookup = vi.spyOn(conversation, 'taskConversation').mockResolvedValue(row);
    vi.spyOn(tracker, 'getSessionsForTask').mockResolvedValue([row]);
    vi.spyOn(tracker, 'updateSessionRecord').mockResolvedValue(row);
    const detach = vi.spyOn(conversation, 'detachTaskSession').mockResolvedValue(undefined);
    const spawn = mockStartRunner();
    host.hasCapability.mockReturnValue(true);
    host.send.mockImplementation(async () => {
      expect((await getTask(f.task.id)).last_start).toEqual(f.attempt);
      expect(spawn).not.toHaveBeenCalled();
      return { ok: true, cancelled: true, alive: false };
    });
    try {
      worker.alive = false;
      await queryInboxItem(f.letter.id, f.itemId, '__local__');
      const plan = (await prepareInboxItem(f.letter.id, f.itemId, { ...f.input, retryStart: true }, '__local__')).plan!;
      expect(plan.ops.map(op => op.tool)).toEqual(['task_start']);
      await claimItemExecution((await getItemPlan(plan.id))!, `row-${status_reason}-retry`);
      await updateItemExecution(`row-${status_reason}-retry`, { stage: 'starting' });
      await expect(startSessionForTask(startParams(plan))).resolves.toMatchObject({ taskId: f.task.id, started: true });
      expect(host.send).toHaveBeenCalledExactlyOnceWith('cancelPendingStart', { sid: f.attempt.runtime_id }, 5_000);
      expect(detach).toHaveBeenCalledWith(f.task.id, row.claudeSessionId, expect.stringContaining('confirmed recovery'));
      expect(spawn).toHaveBeenCalledTimes(1);
      expect((await getTask(f.task.id)).last_start).toMatchObject({ id: plan.ops[0].args.start_attempt_id, state: 'started' });
      expect(lookup).not.toHaveBeenCalledWith(f.task.id, { retire: true });
    } finally { f.unregister(); }
  });
  it.each(['unrelated', 'live'])('refuses %s conversations instead of sending or cancelling', async kind => {
    const f = await interruptedStart(`conversation-${kind}`);
    const lookup = vi.spyOn(conversation, 'taskConversation').mockResolvedValue(undefined);
    const spawn = mockStartRunner();
    try {
      worker.alive = false;
      await queryInboxItem(f.letter.id, f.itemId, '__local__');
      const row = { claudeSessionId: kind === 'unrelated' ? 'another-session' : f.attempt.session_id,
        process_status: 'running', status_reason: kind === 'unrelated' ? 'awaiting_spawn' : 'normal_completion' } as SessionRecord;
      lookup.mockResolvedValue(row);
      const blocked = await prepareInboxItem(f.letter.id, f.itemId, { ...f.input, retryStart: true }, '__local__');
      expect(blocked.plan).toBeUndefined(); expect(blocked.restrictions[0].code).toBe('retry_not_allowed');
      expect(host.send).not.toHaveBeenCalled(); expect(spawn).not.toHaveBeenCalled();
    } finally { f.unregister(); }
  });
  it('never offers recovery for another unconfirmed attempt', async () => {
    const f = await interruptedStart('different-unconfirmed');
    const spawn = mockStartRunner();
    try {
      worker.alive = false;
      await updateTaskRaw(f.task.id, { last_start: { ...f.attempt, id: 'another-attempt' } });
      const queried = (await queryInboxItem(f.letter.id, f.itemId, '__local__')).receipts[0];
      expect(queried).toMatchObject({ status: 'pending', execution: 'unconfirmed' });
      expect(queried.code).not.toBe('start_recovery_required');
      expect((await prepareInboxItem(f.letter.id, f.itemId, { ...f.input, retryStart: true }, '__local__')).plan).toBeUndefined();
      expect(host.send).not.toHaveBeenCalled(); expect(spawn).not.toHaveBeenCalled();
    } finally { f.unregister(); }
  });
  it('protects an active recovery and refuses a late confirmed old start before the new CAS', async () => {
    const f = await interruptedStart('late-old-result');
    vi.spyOn(conversation, 'taskConversation').mockResolvedValue(undefined);
    vi.spyOn(tracker, 'getSessionsForTask').mockResolvedValue([]);
    const spawn = mockStartRunner();
    let enter!: () => void;
    let release!: () => void;
    const entered = new Promise<void>(resolve => { enter = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    host.hasCapability.mockReturnValue(true);
    host.send.mockImplementation(async () => {
      enter(); await gate;
      await updateTaskRaw(f.task.id, { last_start: { ...f.attempt, state: 'started' } });
      return { ok: true, cancelled: true, alive: false };
    });
    try {
      worker.alive = false;
      await queryInboxItem(f.letter.id, f.itemId, '__local__');
      const plan = (await prepareInboxItem(f.letter.id, f.itemId, { ...f.input, retryStart: true }, '__local__')).plan!;
      await claimItemExecution((await getItemPlan(plan.id))!, 'late-old-result-retry');
      await updateItemExecution('late-old-result-retry', { stage: 'starting' });
      const starting = startSessionForTask(startParams(plan));
      const rejected = expect(starting).rejects.toThrow('changed');
      await entered;
      await expect(startSessionForTask(startParams(plan))).rejects.toThrow('already started or starting');
      release(); await rejected;
      expect(host.send).toHaveBeenCalledTimes(1); expect(spawn).not.toHaveBeenCalled();
      expect((await getTask(f.task.id)).last_start).toMatchObject({ id: f.previousId, state: 'started' });
    } finally { release?.(); f.unregister(); }
  });
  it.each(['old-host', 'alive', 'refused', 'long-refusal'])('keeps the original attempt and reviewable unknown outcome when cancellation is %s', async failure => {
    const f = await interruptedStart(`cancel-${failure}`);
    vi.spyOn(conversation, 'taskConversation').mockResolvedValue(undefined);
    vi.spyOn(tracker, 'getSessionsForTask').mockResolvedValue([]);
    const spawn = mockStartRunner();
    host.hasCapability.mockReturnValue(failure !== 'old-host');
    host.send.mockResolvedValue(failure === 'alive' ? { ok: true, cancelled: false, alive: true } : { ok: false, cancelled: false, alive: false, error: failure === 'long-refusal' ? 'Fixture host refusal '.repeat(100) : 'Fixture host refused cancellation' });
    const invoke = vi.spyOn(ops, 'executeOp').mockImplementation(async (tool, args) => {
      expect(tool).toBe('task_start');
      try {
        await startSessionForTask({ taskIdPrefix: String(args.id), cwd: String(args.cwd), host: String(args.host),
          model: String(args.model), mode: String(args.mode), engine: 'claude', message: String(args.message),
          expectReply: false, startAttemptId: String(args.start_attempt_id), source: 'api-v1' });
        throw new Error('Fixture must refuse recovery');
      } catch (error) { return { ok: false, message: String(error) }; }
    });
    try {
      worker.alive = false;
      await queryInboxItem(f.letter.id, f.itemId, '__local__');
      const plan = (await prepareInboxItem(f.letter.id, f.itemId, { ...f.input, retryStart: true }, '__local__')).plan!;
      const id = `cancel-${failure}-retry`;
      await executeInboxItem(f.letter.id, f.itemId, request(plan, id), '__local__', 'http://127.0.0.1:1');
      await vi.waitFor(async () => expect((await readItemLedger()).receipts[id].status).toBe('failure'));
      const receipt = (await queryInboxItem(f.letter.id, f.itemId, '__local__')).receipts.find(r => r.requestId === id)!;
      expect(receipt).toMatchObject({ taskId: f.task.id, taskCreated: true, execution: 'unconfirmed', code: 'start_recovery_required',
        startAttemptId: plan.ops[0].args.start_attempt_id, recovery: ['retry_start', 'check_status', 'open_task'] });
      expect(receipt.reason).toContain('previous outcome remains unconfirmed');
      expect(receipt.reason!.length).toBeLessThanOrEqual(500);
      await vi.waitFor(async () => {
        const persisted = (await getLetter(f.letter.id))!.items!.find(item => item.id === f.itemId)!;
        expect(persisted.unavailableReason).toBeUndefined();
        expect(persisted.receipts).toContainEqual(receipt);
      });
      expect((await getTask(f.task.id)).last_start).toEqual(f.attempt);
      expect(invoke).toHaveBeenCalledTimes(1); expect(spawn).not.toHaveBeenCalled();
      expect(host.send).toHaveBeenCalledTimes(failure === 'old-host' ? 0 : 1);
      const reviewed = await prepareInboxItem(f.letter.id, f.itemId, { ...f.input, retryStart: true }, '__local__');
      expect(reviewed.plan!.taskId).toBe(f.task.id);
      expect((await getItemPlan(reviewed.plan!.id))!.previousStartId).toBe(f.previousId);
    } finally { f.unregister(); }
  });
  it('offers another exact recovery after the retry worker dies before replacing the previous attempt', async () => {
    const f = await interruptedStart('retry-worker-died');
    const spawn = mockStartRunner();
    try {
      worker.alive = false;
      await queryInboxItem(f.letter.id, f.itemId, '__local__');
      const retry = (await prepareInboxItem(f.letter.id, f.itemId, { ...f.input, retryStart: true }, '__local__')).plan!;
      const saved = (await getItemPlan(retry.id))!;
      await claimItemExecution(saved, 'retry-worker-died-second');
      await updateItemExecution('retry-worker-died-second', { stage: 'starting', execution: 'starting' });
      const queried = await queryInboxItem(f.letter.id, f.itemId, '__local__');
      expect(queried.receipts.find(r => r.requestId === 'retry-worker-died-second')).toMatchObject({ status: 'failure',
        code: 'start_recovery_required', execution: 'unconfirmed', startAttemptId: retry.ops[0].args.start_attempt_id });
      const reviewed = (await prepareInboxItem(f.letter.id, f.itemId, { ...f.input, retryStart: true }, '__local__')).plan!;
      expect(reviewed.taskId).toBe(f.task.id); expect((await getItemPlan(reviewed.id))!.previousStartId).toBe(f.previousId);
      expect((await getTask(f.task.id)).last_start).toEqual(f.attempt);
      expect(host.send).not.toHaveBeenCalled(); expect(spawn).not.toHaveBeenCalled();
    } finally { f.unregister(); }
  });
  it.each(['worker-death', 'validation-failure'])('keeps an accepted recovery reviewable after %s', async failure => {
    const f = await interruptedStart(`accepted-retry-${failure}`);
    const invoke = vi.spyOn(ops, 'executeOp');
    const spawn = mockStartRunner();
    const lookup = vi.spyOn(conversation, 'taskConversation').mockResolvedValue(undefined);
    try {
      worker.alive = false;
      await queryInboxItem(f.letter.id, f.itemId, '__local__');
      const retry = (await prepareInboxItem(f.letter.id, f.itemId, { ...f.input, retryStart: true }, '__local__')).plan!;
      const id = `accepted-retry-${failure}-second-request`;
      if (failure === 'worker-death') {
        await claimItemExecution((await getItemPlan(retry.id))!, id);
      } else {
        // Preflight and background validation are separate reads. Change only
        // the latter's task fingerprint, before any operation is dispatched.
        lookup.mockResolvedValueOnce(undefined).mockResolvedValueOnce({ claudeSessionId: 'late-conversation' } as SessionRecord);
        await executeInboxItem(f.letter.id, f.itemId, request(retry, id), '__local__', 'http://127.0.0.1:1');
        await vi.waitFor(async () => expect((await readItemLedger()).receipts[id].status).toBe('failure'));
        lookup.mockResolvedValue(undefined);
      }
      const receipt = (await queryInboxItem(f.letter.id, f.itemId, '__local__')).receipts.find(r => r.requestId === id)!;
      expect(receipt).toMatchObject({ status: 'failure', stage: 'finished', taskId: f.task.id, taskCreated: true,
        execution: 'unconfirmed', code: 'start_recovery_required', startAttemptId: retry.ops[0].args.start_attempt_id });
      const reviewed = (await prepareInboxItem(f.letter.id, f.itemId, { ...f.input, retryStart: true }, '__local__')).plan!;
      expect(reviewed.taskId).toBe(f.task.id); expect((await getItemPlan(reviewed.id))!.previousStartId).toBe(f.previousId);
      expect((await getTask(f.task.id)).last_start).toEqual(f.attempt);
      expect(invoke).not.toHaveBeenCalled(); expect(host.send).not.toHaveBeenCalled(); expect(spawn).not.toHaveBeenCalled();
    } finally { f.unregister(); }
  });
  it.each(['started', 'failed'] as const)('checks a late exact %s outcome without dispatching another operation', async state => {
    const f = await interruptedStart(`late-outcome-${state}`);
    const spawn = mockStartRunner();
    try {
      worker.alive = false;
      await queryInboxItem(f.letter.id, f.itemId, '__local__');
      await updateTaskRaw(f.task.id, { last_start: { ...f.attempt, state, ...(state === 'failed' ? { error: 'Fixture late refusal' } : {}) } });
      const checked = (await queryInboxItem(f.letter.id, f.itemId, '__local__')).receipts[0];
      expect(checked).toMatchObject({ requestId: f.requestId, startAttemptId: f.previousId,
        status: state === 'started' ? 'success' : 'failure', execution: state === 'started' ? 'running' : 'not_started' });
      expect(checked.code).toBeUndefined();
      expect(checked.recovery).toEqual(state === 'started' ? ['open_task'] : ['retry_start', 'open_task']);
      expect(host.send).not.toHaveBeenCalled(); expect(spawn).not.toHaveBeenCalled();
    } finally { f.unregister(); }
  });
  it('does not claim a recovery start succeeded when only its previous attempt starts late', async () => {
    const f = await interruptedStart('late-previous-not-retry');
    const spawn = mockStartRunner();
    try {
      worker.alive = false;
      await queryInboxItem(f.letter.id, f.itemId, '__local__');
      const retry = (await prepareInboxItem(f.letter.id, f.itemId, { ...f.input, retryStart: true }, '__local__')).plan!;
      await claimItemExecution((await getItemPlan(retry.id))!, 'late-previous-second-request');
      await queryInboxItem(f.letter.id, f.itemId, '__local__');
      await updateTaskRaw(f.task.id, { last_start: { ...f.attempt, state: 'started' } });
      const checked = (await queryInboxItem(f.letter.id, f.itemId, '__local__')).receipts;
      expect(checked.find(r => r.requestId === f.requestId)?.status).toBe('success');
      expect(checked.find(r => r.requestId === 'late-previous-second-request')).toMatchObject({
        status: 'failure', execution: 'unconfirmed', startAttemptId: retry.ops[0].args.start_attempt_id });
      expect(host.send).not.toHaveBeenCalled(); expect(spawn).not.toHaveBeenCalled();
    } finally { f.unregister(); }
  });
  it('keeps a retry of a known failed start reviewable after death before its new CAS', async () => {
    const f = await interruptedStart('known-failure-retry');
    const spawn = mockStartRunner();
    try {
      await updateTaskRaw(f.task.id, { last_start: { ...f.attempt, state: 'failed', error: 'Fixture launch refused' } });
      worker.alive = false;
      await queryInboxItem(f.letter.id, f.itemId, '__local__');
      const retry = (await prepareInboxItem(f.letter.id, f.itemId, { ...f.input, retryStart: true }, '__local__')).plan!;
      await claimItemExecution((await getItemPlan(retry.id))!, 'known-failure-second-request');
      await updateItemExecution('known-failure-second-request', { stage: 'starting', execution: 'starting' });
      const recovered = (await queryInboxItem(f.letter.id, f.itemId, '__local__')).receipts.find(r => r.requestId === 'known-failure-second-request')!;
      expect(recovered).toMatchObject({ status: 'failure', execution: 'not_started', taskId: f.task.id,
        startAttemptId: retry.ops[0].args.start_attempt_id, recovery: ['retry_start', 'open_task'] });
      const reviewed = (await prepareInboxItem(f.letter.id, f.itemId, { ...f.input, retryStart: true }, '__local__')).plan!;
      expect(reviewed.taskId).toBe(f.task.id); expect(reviewed.ops.map(op => op.tool)).toEqual(['task_start']);
      expect(reviewed.ops[0].args.start_attempt_id).not.toBe(retry.ops[0].args.start_attempt_id);
      expect((await getTask(f.task.id)).last_start).toMatchObject({ id: f.previousId, state: 'failed' });
      expect(host.send).not.toHaveBeenCalled(); expect(spawn).not.toHaveBeenCalled();
    } finally { f.unregister(); }
  });
  it('rejects an old no-attempt query observation after the authorized start CAS', async () => {
    const f = await interruptedStart('query-before-cas');
    let enter!: () => void;
    let release!: () => void;
    const entered = new Promise<void>(resolve => { enter = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const liveness = vi.spyOn(processUtils, 'isProcessAliveAsync').mockImplementationOnce(async () => { enter(); await gate; return false; });
    try {
      await updateTaskRaw(f.task.id, { last_start: null } as unknown as Parameters<typeof updateTaskRaw>[1]);
      const querying = queryInboxItem(f.letter.id, f.itemId, '__local__');
      await entered;
      await withInboxStartAuthorization(f.task.id, f.previousId, () => updateTaskRaw(f.task.id, { last_start: f.attempt }, {
        shouldUpdate: current => current.last_start === undefined,
      }));
      const before = (await readItemLedger()).receipts[f.requestId];
      release();
      const after = (await querying).receipts[0];
      expect(after).toEqual(before);
      expect(after.execution).not.toBe('not_started');
      worker.alive = false;
      liveness.mockImplementation(async () => false);
      const recovered = (await queryInboxItem(f.letter.id, f.itemId, '__local__')).receipts[0];
      expect(recovered).toMatchObject({ status: 'failure', code: 'start_recovery_required', execution: 'unconfirmed' });
      expect((await prepareInboxItem(f.letter.id, f.itemId, { ...f.input, retryStart: true }, '__local__')).plan!.taskId).toBe(f.task.id);
      expect(host.send).not.toHaveBeenCalled();
    } finally { release?.(); f.unregister(); }
  });
  it('does not roll back a successful receipt when an older starting query resumes', async () => {
    const f = await interruptedStart('query-late-success');
    let enter!: () => void;
    let release!: () => void;
    const entered = new Promise<void>(resolve => { enter = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    vi.spyOn(processUtils, 'isProcessAliveAsync').mockImplementationOnce(async () => { enter(); await gate; return false; });
    try {
      const querying = queryInboxItem(f.letter.id, f.itemId, '__local__');
      await entered;
      await updateTaskRaw(f.task.id, { last_start: { ...f.attempt, state: 'started' } });
      const success = await updateItemExecution(f.requestId, { status: 'success', stage: 'finished', execution: 'running', recovery: ['open_task'] });
      release();
      expect((await querying).receipts[0]).toEqual(success);
      expect((await readItemLedger()).receipts[f.requestId]).toEqual(success);
      expect(host.send).not.toHaveBeenCalled();
    } finally { release?.(); f.unregister(); }
  });
  it('serializes authorization and task CAS against revocation without rewriting the ledger', async () => {
    const f = await interruptedStart('authorization-cas');
    let release!: () => void;
    let entered!: () => void;
    const inside = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    try {
      const before = await readItemLedger();
      const mutate = vi.fn(async () => { entered(); await gate; return 'claimed'; });
      const claimed = withInboxStartAuthorization(f.task.id, f.previousId, mutate);
      await inside;
      let revoked = false;
      const revoking = updateItemExecution(f.requestId, { status: 'failure', stage: 'finished' }).then(() => { revoked = true; });
      await new Promise(resolve => setTimeout(resolve, 30));
      expect(revoked).toBe(false);
      expect(await readItemLedger()).toEqual(before);
      release();
      await expect(claimed).resolves.toBe('claimed');
      await revoking;
      const forbidden = vi.fn(async () => 'must not run');
      await expect(withInboxStartAuthorization(f.task.id, f.previousId, forbidden)).rejects.toThrow('no longer authorized');
      expect(forbidden).not.toHaveBeenCalled(); expect(mutate).toHaveBeenCalledTimes(1);
    } finally { release?.(); f.unregister(); }
  });
  it('checks only the exact planned start and offers a fresh same-ID retry after a known failure', async () => {
    const unregister = registerInboxMailSource({ resolve: async source => ({ key: 'rfc:recover-start', source, adapter }) });
    try {
      const letter = await sendLetter({ subject: 'Recovery summary', type: 'review', markdown: 'Reference only', sender: { sessionId: 'external', host: 'local' }, items: [{ id: 'recover-one', subject: 'Update', summary: 'Data', source: { kind: 'mail', account: 'account-a', message: 'message-a' }, actions: [{ id: 'create-recover', kind: 'op', intent: 'create_task' }] }] });
      const first = await prepareInboxItem(letter.id, 'recover-one', { actionId: 'create-recover', title: 'Recover work', project: '', goal: 'Review the update' }, '__local__');
      const plan = first.plan!; const saved = (await getItemPlan(plan.id))!;
      await claimItemExecution(saved, 'recover-request');
      await releaseItemWorker('recover-request');
      const create = plan.ops.find(op => op.tool === 'task_create')!.args;
      const task = (await addTaskIdempotently({ title: String(create.title), project: String(create.project), description: String(create.description) }, String(create.idempotency_key))).task;
      await claimSourceTask({ key: saved.sourceKey, pair: JSON.stringify(['account-a', 'message-a']), adapter, confirmation: { intent: 'create_task', goal: plan.input.goal!, targetTaskId: task.id } });
      await updateItemExecution('recover-request', { stage: 'starting', execution: 'unconfirmed' });
      await updateTaskRaw(task.id, { last_start: { id: 'unrelated-attempt', at: '2026-01-01T00:00:00Z', state: 'started', engine: 'claude', host: '__local__' } });
      expect(await inboxOwnsStartFailure(task.id)).toBe(false);
      const unrelated = await queryInboxItem(letter.id, 'recover-one', '__local__');
      expect(unrelated.receipts[0].status).toBe('pending'); expect(unrelated.receipts[0].execution).toBe('unconfirmed');
      const expected = String(plan.ops.find(op => op.tool === 'task_start')!.args.start_attempt_id);
      await updateTaskRaw(task.id, { last_start: { id: expected, at: '2026-01-01T00:00:00Z', state: 'failed', engine: 'claude', host: '__local__', error: 'Fixture host unavailable' } });
      expect(await inboxOwnsStartFailure(task.id)).toBe(true);
      expect(await inboxOwnsStartFailure(task.id, 'unrelated-session')).toBe(false);
      const failure = await queryInboxItem(letter.id, 'recover-one', '__local__');
      expect(failure.receipts[0].status).toBe('failure'); expect(failure.receipts[0].recovery).toContain('retry_start');
      const retry = await prepareInboxItem(letter.id, 'recover-one', { actionId: 'create-recover', retryStart: true, goal: 'Review the update' }, '__local__');
      expect(retry.plan!.taskId).toBe(task.id); expect(retry.plan!.ops.map(op => op.tool)).toEqual(['task_start']);
      expect(retry.plan!.ops[0].args.start_attempt_id).not.toBe(expected);
      await updateTaskRaw(task.id, { last_start: { id: expected, at: '2026-01-01T00:00:00Z', state: 'started', engine: 'claude', host: '__local__' } });
      expect(await inboxOwnsStartFailure(task.id)).toBe(false);
      await updateTaskRaw(task.id, { last_start: { id: 'different-failed-attempt', at: '2026-01-01T00:00:00Z', state: 'failed', engine: 'claude', host: '__local__' } });
      expect(await inboxOwnsStartFailure(task.id)).toBe(false);
      await deleteTask(task.id);
      const deleted = await prepareInboxItem(letter.id, 'recover-one', { actionId: 'create-recover', goal: 'Review the update' }, '__local__');
      expect(deleted.existingWork!.status).toBe('deleted'); expect(deleted.plan).toBeUndefined();
    } finally { unregister(); }
  });
});
