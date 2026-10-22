/**
 * API lifecycle, not a visual test. Both servers are real isolated child processes.
 * phone -> replica auth/router -> real bridge registry -> fixture-owned mock daemon
 * -> real primary DaemonConnection control handler -> real ops/self-HTTP/routes/store.
 * Only external mail and CLI/daemon transport are fake; no product operation is replaced.
 *
 * Lifecycle: fresh tmp lanes -> listen(0) -> completed receipts -> own primary TERM
 * -> same data, new primary process -> mirror reads while away -> reconnect/query.
 * The parent retains every child handle. No pid-file signals, process scans, git or prod data.
 */
import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { InboxItemProcessHarness, eventually, type Json } from './helpers/inbox-item-process-harness.js';

let fixture: InboxItemProcessHarness | undefined;
afterEach(async () => { await fixture?.stop(); fixture = undefined; }, 60_000);
const ACCOUNT = 'fixture-account+one';
const OTHER_ACCOUNT = 'fixture-account+two';
const MESSAGE = '<thread/0?x=%25@example.test>';
const items = () => Array.from({ length: 30 }, (_, n) => ({
  // Unicode is reference data, never a fixture instruction.
  id: `mail-${n}`, subject: `Update ${n}`, summary: `Untrusted summary ${n}: ${String.fromCodePoint(0x4eca, 0x65e5, 0x8981, 0x70b9)}. ` + 'Reference data only. '.repeat(40),
  source: { kind: 'mail', account: n === 29 ? OTHER_ACCOUNT : ACCOUNT, message: n === 0 || n === 29 ? MESSAGE : `message-${n}` },
  actions: [{ id: `read-${n}`, kind: 'op', intent: 'mark_read' }, { id: `create-${n}`, kind: 'op', intent: 'create_task' }, { id: `attach-${n}`, kind: 'op', intent: 'attach_task' }],
}));
const executionRequest = (plan: Json, requestId: string) => ({ actionId: plan.actionId, planId: plan.id, planVersion: plan.version, requestId, confirmed: true });
const itemRoot = (letter: string, n: number) => `/human-inbox/${letter}/items/mail-${n}`;
async function seed(f: InboxItemProcessHarness): Promise<string> {
  const sent = await f.local('POST', '/human-inbox', { subject: 'Thirty-mail snapshot', type: 'review', markdown: '# Mail snapshot\nThirty independent email items.', items: items() });
  expect(sent.status, JSON.stringify(sent.body)).toBe(201);
  return sent.body.id;
}
async function settled(f: InboxItemProcessHarness, route: string, requestId: string, phone = false): Promise<Json> {
  return eventually(async () => {
    const reply = phone ? await f.phone('GET', `${route}/execution`) : await f.local('GET', `${route}/execution`);
    if (reply.status !== 200) return false;
    const receipt = reply.body.receipts.find((r: Json) => r.requestId === requestId);
    if (!receipt || receipt.status === 'pending') return false;
    expect(receipt.status, JSON.stringify(receipt)).toBe('success');
    return receipt;
  }, `settled receipt ${requestId}`);
}
async function jsonFile(file: string): Promise<Json> { return JSON.parse(await fs.readFile(file, 'utf8')); }

// Scenario matrix: dense persisted details; exact source/account flags; forged origin and
// paired-phone denial on BOTH hops; create/start + attach/send; same-ID retries and query;
// real primary replacement; lost HTTP response; mirror receipts + nonqueued offline writes;
// interrupted create/start HTTP gates and post-CAS daemon start; query without dispatch;
// explicit same-ID recovery and rejection of a late cancelled start.
// No UI, real mail service, throughput or machine-load test is needed.
describe('Inbox item receipts across process restart and a paired-phone bridge', () => {
  it('persists thirty details and exact per-account mail facts, without lending the phone local mail power', async () => {
    const f = fixture = new InboxItemProcessHarness();
    await f.start();
    const letter = await seed(f);
    const route = itemRoot(letter, 0);
    for (const account of [ACCOUNT, OTHER_ACCOUNT]) expect((await f.control(f.primary, 'flags', { account, message: MESSAGE, read: false })).status).toBe(200);
    const prepared = await f.local('POST', `${route}/prepare`, { actionId: 'read-0' });
    expect(prepared.status).toBe(200);
    expect(prepared.body.plan.ops).toEqual([{ tool: 'mail_mark_read', args: { account: ACCOUNT, messages: [MESSAGE], read: true } }]);

    // The same phone credential is authenticated by each server. Its forged local
    // header cannot raise trust, even though transport arrives over loopback.
    for (const directPrimary of [true, false]) {
      const remote = await f.phone('POST', `${route}/prepare`, { actionId: 'read-0' }, directPrimary);
      expect(remote.status, JSON.stringify(remote.body)).toBe(200);
      expect(remote.body.plan).toBeUndefined();
      expect(remote.body.restrictions).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'local_only' })]));
      const stolen = await f.phone('POST', `${route}/execute`, executionRequest(prepared.body.plan, `refused-${directPrimary}`), directPrimary);
      expect(stolen.status).toBe(409);
      expect(stolen.body.error.code).toBe('origin_changed');
    }
    expect((await f.control(f.primary, 'state')).body.mailCalls).toEqual([]);
    expect(f.relays).toEqual(expect.arrayContaining(['server.human-inbox.item-prepare', 'server.human-inbox.item-execute']));

    const approved = executionRequest(prepared.body.plan, 'exact-mail-read');
    expect([200, 202]).toContain((await f.local('POST', `${route}/execute`, approved)).status);
    const receipt = await settled(f, route, approved.requestId);
    expect(receipt.source).toEqual(items()[0].source);
    const state = (await f.control(f.primary, 'state')).body;
    expect(state.mailCalls).toEqual([{ account: ACCOUNT, messages: [MESSAGE], read: true }]);
    expect(state.flags[JSON.stringify([ACCOUNT, MESSAGE])]).toBe(true);
    expect(state.flags[JSON.stringify([OTHER_ACCOUNT, MESSAGE])]).toBe(false);
    const oldPid = state.pid;
    const before = (await f.local('GET', `/human-inbox/${letter}`)).body.letter;
    expect(before.items).toHaveLength(30);
    expect(before.items.map(({ receipts: _receipts, ...item }: Json) => item)).toEqual(items());
    expect(before.read).toBe(false); expect(before.answered).toBeUndefined();
    await f.restartPrimary();
    const after = (await f.local('GET', `/human-inbox/${letter}`)).body.letter;
    expect(after).toEqual(before);
    expect((await f.control(f.primary, 'state')).body.pid).not.toBe(oldPid);
    expect(await settled(f, route, approved.requestId)).toEqual(receipt);
    expect((await f.local('POST', `${route}/execute`, approved)).body.receipt).toEqual(receipt);
    const restored = (await f.control(f.primary, 'state')).body;
    expect(restored.mailCalls).toEqual(state.mailCalls);
    expect(restored.flags).toEqual(state.flags);
    expect(f.commands.filter(command => command.cmd === 'start' || command.cmd === 'send')).toEqual([]);
  }, 240_000);

  it('runs real create/attach ops once, restores receipts in a new primary, and refuses to queue work while away', async () => {
    const f = fixture = new InboxItemProcessHarness();
    await f.start();
    const letter = await seed(f);
    const createRoute = itemRoot(letter, 0);
    const attachRoute = itemRoot(letter, 1);
    const createGoal = 'Report the approved release status';
    const attachGoal = 'Add the approved second-source review';
    const create = await f.phone('POST', `${createRoute}/prepare`, { actionId: 'create-0', title: 'Review update', project: '', goal: createGoal });
    expect(create.status, JSON.stringify(create.body)).toBe(200);
    const createPlan = create.body.plan;
    expect(createPlan.ops.map((op: Json) => op.tool)).toEqual(['task_create', 'task_start']);
    const createRequest = executionRequest(createPlan, 'lost-create-response');
    await expect(f.phone('POST', `${createRoute}/execute`, createRequest, false, true)).rejects.toMatchObject({ code: 'ECONNRESET' });
    const created = await settled(f, createRoute, createRequest.requestId, true);
    expect(created).toMatchObject({ taskId: createPlan.taskId, execution: 'running' });
    await eventually(async () => (await f.accepted()).filter(row => row.text.includes(createGoal)).length === 1 || false, 'the CLI accepted the create goal');
    const task = (await f.local('GET', `/tasks/${createPlan.taskId}`)).body.task;
    expect(task.id).toBe(createPlan.taskId);
    expect(task.last_start).toMatchObject({ id: createPlan.ops[1].args.start_attempt_id, state: 'started' });
    expect(task.session_ids).toHaveLength(1);
    expect(task.description).toContain(createGoal);
    expect(task.description).not.toContain('Untrusted summary');
    const same = await f.phone('POST', `${createRoute}/prepare`, { actionId: 'create-0', goal: createGoal });
    expect(same.body.existingWork.taskId).toBe(task.id);
    expect(same.body.plan).toBeUndefined();

    const attached = await f.phone('POST', `${attachRoute}/prepare`, { actionId: 'attach-1', selectedTaskId: task.id, goal: attachGoal });
    expect(attached.status, JSON.stringify(attached.body)).toBe(200);
    const attachPlan = attached.body.plan;
    expect(attachPlan.taskId).toBe(task.id);
    expect(attachPlan.ops.map((op: Json) => op.tool)).toEqual(['task_send']);
    expect(attachPlan.ops[0].args.messageId).toBe(attachPlan.messageId);
    const attachRequest = executionRequest(attachPlan, 'lost-attach-response');
    await expect(f.phone('POST', `${attachRoute}/execute`, attachRequest, false, true)).rejects.toMatchObject({ code: 'ECONNRESET' });
    const sent = await settled(f, attachRoute, attachRequest.requestId, true);
    expect(sent).toMatchObject({ taskId: task.id, delivery: 'queued', messageId: attachPlan.messageId });
    await eventually(async () => (await f.accepted()).filter(row => row.text.includes(attachGoal)).length === 1 || false, 'the CLI accepted the attach goal');
    for (const [route, request, receipt] of [[createRoute, createRequest, created], [attachRoute, attachRequest, sent]] as const) {
      const retries = await Promise.all([f.phone('POST', `${route}/execute`, request), f.phone('POST', `${route}/execute`, request)]);
      for (const retry of retries) { expect(retry.status).toBe(200); expect(retry.body.receipt).toEqual(receipt); }
    }
    const countWork = (rows: Json[]) => rows.filter(row => row.text.includes(createGoal) || row.text.includes(attachGoal));
    expect(countWork(await f.accepted())).toHaveLength(2);
    const effects = (await f.control(f.primary, 'state')).body.effects;
    expect(effects).toEqual(['task_create', 'task_start', 'task_send']);
    expect((await f.control(f.replica, 'state')).body.lostResponses).toBe(2);
    const oldPid = (await f.control(f.primary, 'state')).body.pid;
    const startCount = f.commands.filter(command => command.cmd === 'start').length;
    const sendCount = f.commands.filter(command => command.cmd === 'send').length;
    await f.restartPrimary();
    expect((await f.control(f.primary, 'state')).body.pid).not.toBe(oldPid);
    for (const [route, request, receipt] of [[createRoute, createRequest, created], [attachRoute, attachRequest, sent]] as const) {
      expect(await settled(f, route, request.requestId, true)).toEqual(receipt);
      expect((await f.phone('POST', `${route}/execute`, request)).body.receipt).toEqual(receipt);
    }
    expect((await f.local('GET', `/tasks/${task.id}`)).body.task.id).toBe(task.id);
    expect((await f.control(f.primary, 'state')).body.effects).toEqual(effects);
    expect(f.commands.filter(command => command.cmd === 'start')).toHaveLength(startCount);
    expect(f.commands.filter(command => command.cmd === 'send')).toHaveLength(sendCount);
    expect(countWork(await f.accepted())).toHaveLength(2);

    const offlineRoute = itemRoot(letter, 2);
    const offlinePlan = (await f.phone('POST', `${offlineRoute}/prepare`, { actionId: 'create-2', title: 'Offline work', project: '', goal: 'Never dispatch this while primary is away' })).body.plan;
    expect(offlinePlan).toBeDefined();
    const ledgerBefore = await jsonFile(path.join(f.primary.data, 'human-inbox/item-ledger.json'));
    // This is a copy of fixture data ONLY, standing in for a completed inbox sync.
    await f.copyInbox();
    await f.stopPrimary();
    const mirror = await f.phone('GET', `/human-inbox/${letter}`);
    expect(mirror.status).toBe(200); expect(mirror.body.servedFrom).toBe('mirror');
    expect(mirror.body.letter.items).toHaveLength(30);
    expect(mirror.body.letter.items[0].receipts).toContainEqual(created);
    expect(mirror.body.letter.items[1].receipts).toContainEqual(sent);
    const offlineRequest = executionRequest(offlinePlan, 'must-not-queue');
    for (const [method, suffix, body] of [
      ['POST', 'prepare', { actionId: 'create-3', title: 'Other offline work', project: '', goal: 'Do not queue' }],
      ['POST', 'execute', offlineRequest], ['GET', 'execution', undefined],
    ] as const) {
      const route = suffix === 'prepare' ? itemRoot(letter, 3) : offlineRoute;
      const refused = await f.phone(method, `${route}/${suffix}`, body);
      expect(refused.status).toBe(503); expect(refused.body.error.code).toBe('primary_unavailable');
      expect(refused.body.notSent).toBe(true); expect(refused.body.queued).toBeUndefined();
    }
    expect(await jsonFile(path.join(f.primary.data, 'human-inbox/item-ledger.json'))).toEqual(ledgerBefore);
    expect((await jsonFile(path.join(f.replica.data, 'human-inbox/item-ledger.json'))).receipts['must-not-queue']).toBeUndefined();
    const queueDir = path.join(f.replica.data, 'cache/human-inbox-queue');
    expect(await fs.readdir(queueDir).catch(error => { if (error.code === 'ENOENT') return []; throw error; })).toEqual([]);
    await f.bringPrimaryBack();
    expect(await settled(f, createRoute, createRequest.requestId, true)).toEqual(created);
    expect(await settled(f, attachRoute, attachRequest.requestId, true)).toEqual(sent);
    const resumed = (await f.phone('GET', `${offlineRoute}/execution`)).body;
    expect(resumed.receipts).toEqual([]);
    expect((await f.control(f.primary, 'state')).body.effects).toEqual(effects);
    expect((await f.control(f.replica, 'state')).body.effects).toEqual([]);
    expect(f.commands.filter(command => command.cmd === 'start')).toHaveLength(startCount);
    expect(f.commands.filter(command => command.cmd === 'send')).toHaveLength(sendCount);
    expect(countWork(await f.accepted())).toHaveLength(2);
    expect(f.relays).toEqual(expect.arrayContaining(['server.human-inbox.item-execution', 'server.human-inbox.item-execute']));
  }, 300_000);

  it.each([
    { kind: 'task_create', stage: 'creating', recovery: 'retry_create', taskCreated: false },
    { kind: 'task_start', stage: 'starting', recovery: 'retry_start', taskCreated: true },
  ] as const)('requires explicit same-ID recovery after restart at $stage', async scenario => {
    const f = fixture = new InboxItemProcessHarness();
    await f.start();
    const letter = await seed(f);
    const route = itemRoot(letter, 0);
    const input = { actionId: 'create-0', title: 'Recover reserved work', project: '', goal: `Finish the approved ${scenario.stage} recovery` };
    const prepared = await f.phone('POST', `${route}/prepare`, input);
    expect(prepared.status, JSON.stringify(prepared.body)).toBe(200);
    const plan = prepared.body.plan;
    expect(plan.ops.map((op: Json) => op.tool)).toEqual(['task_create', 'task_start']);
    expect((await f.hold(scenario.kind)).status).toBe(200);
    const request = executionRequest(plan, `interrupted-${scenario.stage}`);
    const accepted = await f.phone('POST', `${route}/execute`, request);
    expect([200, 202]).toContain(accepted.status);
    const ledgerFile = path.join(f.primary.data, 'human-inbox/item-ledger.json');
    await eventually(async () => {
      const state = (await f.control(f.primary, 'state')).body;
      const ledger = await jsonFile(ledgerFile);
      return state.heldRoute?.kind === scenario.kind && ledger.receipts[request.requestId]?.stage === scenario.stage || false;
    }, `the real ${scenario.kind} HTTP request held before mutation`);
    const held = (await f.control(f.primary, 'state')).body;
    expect(held.heldRoute.path).toBe(scenario.taskCreated ? `/tasks/${plan.taskId}/start` : '/tasks');
    expect((await jsonFile(ledgerFile)).receipts[request.requestId]).toMatchObject({ status: 'pending', stage: scenario.stage, taskId: plan.taskId });
    const before = await f.local('GET', `/tasks/${plan.taskId}`);
    if (scenario.taskCreated) {
      expect(before.status).toBe(200); expect(before.body.task.id).toBe(plan.taskId);
      expect(before.body.task.last_start).toBeUndefined(); expect(before.body.task.session_ids).toEqual([]);
    } else expect(before.status).toBe(404);
    expect(held.effects).toEqual(scenario.taskCreated ? ['task_create'] : []);
    expect(f.commands.filter(command => command.cmd === 'start' || command.cmd === 'send')).toEqual([]);
    expect(await f.accepted()).toEqual([]);

    await f.restartPrimary();
    expect((await f.control(f.primary, 'state')).body.pid).not.toBe(held.pid);
    const checked = await f.phone('GET', `${route}/execution`);
    expect(checked.status, JSON.stringify(checked.body)).toBe(200);
    const failure = checked.body.receipts.find((receipt: Json) => receipt.requestId === request.requestId);
    expect(failure).toMatchObject({ status: 'failure', stage: 'finished', execution: 'not_started', taskId: plan.taskId, taskCreated: scenario.taskCreated });
    expect(failure.recovery).toContain(scenario.recovery);
    expect((await jsonFile(ledgerFile)).receipts[request.requestId]).toEqual(failure);
    const queriedAgain = await f.phone('GET', `${route}/execution`);
    expect(queriedAgain.body.receipts.find((receipt: Json) => receipt.requestId === request.requestId)).toEqual(failure);
    const retried = await f.phone('POST', `${route}/prepare`, { ...input, ...(scenario.taskCreated ? { retryStart: true } : {}) });
    expect(retried.status, JSON.stringify(retried.body)).toBe(200);
    const retryPlan = retried.body.plan;
    expect(retryPlan).toBeDefined(); expect(retryPlan.id).not.toBe(plan.id);
    expect(retryPlan.taskId).toBe(plan.taskId); expect(retryPlan.source).toEqual(plan.source);
    expect(retryPlan.input).toMatchObject({ title: input.title, project: input.project, goal: input.goal });
    expect(retryPlan.ops.map((op: Json) => op.tool)).toEqual(scenario.taskCreated ? ['task_start'] : ['task_create', 'task_start']);
    if (!scenario.taskCreated) expect(retryPlan.ops[0]).toEqual(plan.ops[0]);
    const originalStart = plan.ops.find((op: Json) => op.tool === 'task_start').args;
    const newStart = retryPlan.ops.find((op: Json) => op.tool === 'task_start').args;
    const { start_attempt_id: oldAttempt, ...oldStartPayload } = originalStart;
    const { start_attempt_id: newAttempt, ...newStartPayload } = newStart;
    expect(newStartPayload).toEqual(oldStartPayload); expect(newAttempt).not.toBe(oldAttempt);
    expect((await f.control(f.primary, 'state')).body.effects).toEqual(held.effects);
    expect(f.commands.filter(command => command.cmd === 'start' || command.cmd === 'send')).toEqual([]);
    expect(await f.accepted()).toEqual([]);

    const confirm = executionRequest(retryPlan, `confirmed-${scenario.stage}`);
    expect([200, 202]).toContain((await f.phone('POST', `${route}/execute`, confirm)).status);
    const recovered = await settled(f, route, confirm.requestId, true);
    expect(recovered).toMatchObject({ taskId: plan.taskId, execution: 'running' });
    await eventually(async () => (await f.accepted()).filter(row => row.text.includes(input.goal)).length === 1 || false, 'the CLI accepted only the explicit recovery');
    const task = (await f.local('GET', `/tasks/${plan.taskId}`)).body.task;
    expect(task.id).toBe(plan.taskId); expect(task.title).toBe(input.title);
    expect(task.description).toBe(plan.ops[0].args.description);
    expect(task.session_ids).toHaveLength(1); expect(task.last_start).toMatchObject({ id: newAttempt, state: 'started' });
    expect((await f.phone('POST', `${route}/execute`, confirm)).body.receipt).toEqual(recovered);
    expect((await f.control(f.primary, 'state')).body.effects).toEqual(['task_create', 'task_start']);
    expect(f.commands.filter(command => command.cmd === 'start')).toHaveLength(1);
    expect(f.commands.filter(command => command.cmd === 'send')).toEqual([]);
    expect((await f.accepted()).filter(row => row.text.includes(input.goal))).toHaveLength(1);
    expect(f.relays).toEqual(expect.arrayContaining(['server.human-inbox.item-execution', 'server.human-inbox.item-prepare', 'server.human-inbox.item-execute']));
  }, 240_000);

  it('cancels only on human confirmation after post-CAS death and refuses a late old start', async () => {
    const f = fixture = new InboxItemProcessHarness();
    await f.start();
    const letter = await seed(f);
    const route = itemRoot(letter, 0);
    const input = { actionId: 'create-0', title: 'Recover recorded start', project: '', goal: 'Complete the confirmed post-CAS recovery' };
    const prepared = await f.phone('POST', `${route}/prepare`, input);
    expect(prepared.status, JSON.stringify(prepared.body)).toBe(200);
    const plan = prepared.body.plan;
    const originalStart = plan.ops.find((op: Json) => op.tool === 'task_start').args;
    f.holdDaemonStart();
    const request = executionRequest(plan, 'interrupted-recorded-start');
    expect([200, 202]).toContain((await f.phone('POST', `${route}/execute`, request)).status);
    const ledgerFile = path.join(f.primary.data, 'human-inbox/item-ledger.json');
    const held = await eventually(async () => {
      const command = f.heldDaemonStart();
      if (!command) return false;
      const task = (await f.local('GET', `/tasks/${plan.taskId}`)).body.task;
      const receipt = (await jsonFile(ledgerFile)).receipts[request.requestId];
      return task?.last_start?.id === originalStart.start_attempt_id && task.last_start.state === 'starting'
        && task.last_start.runtime_id === command.sid && receipt?.stage === 'starting' ? { command, task } : false;
    }, 'the exact recorded start reached the daemon before spawning');
    expect(held.command.message).toContain(input.goal);
    expect(held.task.last_start.session_id).toBe(held.command.sid);
    expect(f.spawnedSessionIds).toEqual([]); expect(await f.accepted()).toEqual([]);
    const effects = (await f.control(f.primary, 'state')).body.effects;
    expect(effects).toEqual(['task_create', 'task_start']);
    await f.restartPrimary();

    const checked = await f.phone('GET', `${route}/execution`);
    expect(checked.status, JSON.stringify(checked.body)).toBe(200);
    const failure = checked.body.receipts.find((receipt: Json) => receipt.requestId === request.requestId);
    expect(failure).toMatchObject({ status: 'failure', execution: 'unconfirmed', code: 'start_recovery_required', taskCreated: true, taskId: plan.taskId, source: plan.source });
    expect(failure.recovery).toEqual(expect.arrayContaining(['retry_start', 'check_status', 'open_task']));
    expect((await jsonFile(ledgerFile)).receipts[request.requestId]).toEqual(failure);
    expect((await f.local('GET', `/tasks/${plan.taskId}`)).body.task.last_start).toEqual(held.task.last_start);
    const reviewed = await f.phone('POST', `${route}/prepare`, { ...input, retryStart: true });
    expect(reviewed.status, JSON.stringify(reviewed.body)).toBe(200);
    const retryPlan = reviewed.body.plan;
    expect(retryPlan).toBeDefined(); expect(retryPlan.id).not.toBe(plan.id);
    expect(retryPlan.taskId).toBe(plan.taskId); expect(retryPlan.source).toEqual(plan.source);
    expect(retryPlan.ops.map((op: Json) => op.tool)).toEqual(['task_start']);
    expect(retryPlan.input).toMatchObject({ goal: input.goal, retryStart: true });
    const { start_attempt_id: newAttempt, ...newPayload } = retryPlan.ops[0].args;
    const { start_attempt_id: oldAttempt, ...oldPayload } = originalStart;
    expect(newPayload).toEqual(oldPayload); expect(newAttempt).not.toBe(oldAttempt);
    const queryAgain = await f.phone('GET', `${route}/execution`);
    expect(queryAgain.status).toBe(200);
    expect(queryAgain.body.receipts.find((receipt: Json) => receipt.requestId === request.requestId)).toMatchObject({ status: 'failure', execution: 'unconfirmed', code: 'start_recovery_required' });
    expect(f.commands.filter(command => command.cmd === 'cancelPendingStart')).toEqual([]);
    expect(f.commands.filter(command => command.cmd === 'start')).toHaveLength(1);
    expect(f.spawnedSessionIds).toEqual([]); expect(await f.accepted()).toEqual([]);
    expect((await f.control(f.primary, 'state')).body.effects).toEqual(effects);

    const confirm = executionRequest(retryPlan, 'confirmed-recorded-start');
    expect([200, 202]).toContain((await f.phone('POST', `${route}/execute`, confirm)).status);
    const recovered = await settled(f, route, confirm.requestId, true);
    expect(recovered).toMatchObject({ taskId: plan.taskId, execution: 'running' });
    await eventually(async () => (await f.accepted()).filter(row => row.text.includes(input.goal)).length === 1 || false, 'one CLI accepted the explicitly confirmed recovery');
    const cancelled = f.commands.filter(command => command.cmd === 'cancelPendingStart');
    expect(cancelled).toHaveLength(1); expect(cancelled[0].sid).toBe(held.command.sid);
    expect(f.spawnedSessionIds).toHaveLength(1); expect(f.spawnedSessionIds[0]).not.toBe(held.command.sid);
    const cancellationIndex = f.commands.findIndex(command => command.cmd === 'cancelPendingStart');
    const newStartIndex = f.commands.findIndex(command => command.cmd === 'start' && command.sid === f.spawnedSessionIds[0]);
    expect(newStartIndex).toBeGreaterThan(cancellationIndex);
    const task = (await f.local('GET', `/tasks/${plan.taskId}`)).body.task;
    expect(task.id).toBe(plan.taskId); expect(task.description).toBe(plan.ops[0].args.description);
    expect(task.session_ids).toHaveLength(1);
    expect(task.last_start).toMatchObject({ id: newAttempt, state: 'started', runtime_id: f.spawnedSessionIds[0] });

    await f.releaseDaemonStart();
    expect(f.rejectedStarts).toEqual([{ sid: held.command.sid, cancelled: true }]);
    expect(f.spawnedSessionIds).toEqual([task.last_start.runtime_id]);
    expect((await f.accepted()).filter(row => row.text.includes(input.goal))).toHaveLength(1);
    expect((await f.phone('POST', `${route}/execute`, confirm)).body.receipt).toEqual(recovered);
    expect((await f.local('GET', `/tasks/${plan.taskId}`)).body.task.session_ids).toEqual(task.session_ids);
    expect(f.commands.filter(command => command.cmd === 'cancelPendingStart')).toHaveLength(1);
    expect((await f.control(f.primary, 'state')).body.effects).toEqual(['task_create', 'task_start', 'task_start']);
  }, 240_000);
});
