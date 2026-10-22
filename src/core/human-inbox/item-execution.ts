import type { InboxItemReceipt, InboxItemExecutionResponse } from './types.js';
import { inboxExecuteSchema } from './item-schema.js';
import { getItemPlan, readItemLedger, claimItemExecution, assertItemRequestPlan, updateItemExecution, releaseItemWorker, itemWorkerDead, itemReceipts, inboxStartRecoveryMatches, ItemActionError, type SavedItemPlan } from './item-ledger.js';
import { storedInboxItem, taskPlanFingerprint, itemWorkText } from './item-plans.js';
import { resolveInboxSource } from './item-source-registry.js';
import { sourcePairKey, claimSourceTask, markSourceTaskCreated } from '../source-task-claims.js';
import { fingerprint, stableJson } from '../task-create-idempotency.js';
import { writeItemReceipt } from './store.js';
import { currentItemTaskStatus, exactItemTask } from './item-status.js';
import { resolveTaskLaunchReadOnly } from '../sessions/task-launch-plan.js';
import { humanActionRefusal } from '../../ops/human-action-policy.js';
import { executeOp, getOp } from '../../ops/index.js';
import { deliverLetterToOrigin } from './letter-ops.js';

const active = new Map<string, Promise<InboxItemReceipt>>();
/** A registry self-call rechecks the frozen task inside the actual start mutation. */
export async function validateInboxMessageBoundary(sessionId: string, messageId: string): Promise<void> {
  const ledger = await readItemLedger();
  const executing = Object.values(ledger.receipts).filter(r => r.messageId === messageId && r.status === 'pending' && r.stage === 'sending');
  if (executing.length > 1) throw new ItemActionError('execution_conflict', 'This message has more than one active execution');
  const saved = executing[0] && ledger.plans[executing[0].planId];
  if (!saved || !saved.plan.ops.some(op => op.tool === 'task_send')) return;
  const { taskConversation } = await import('../sessions/task-session-claim.js');
  const conversation = await taskConversation(saved.plan.taskId!);
  if (conversation?.claudeSessionId !== sessionId) throw new ItemActionError('task_changed', 'This task changed. Review the action again.');
  await validateItemPlan(saved, saved.origin, true);
}
export async function validateInboxStartBoundary(taskId: string, attemptId: string): Promise<{ previousStartId: string } | undefined> {
  const ledger = await readItemLedger();
  const receipt = Object.values(ledger.receipts).find(r => r.taskId === taskId && r.startAttemptId === attemptId);
  if (!receipt) return;
  if (receipt.status !== 'pending' || receipt.stage !== 'starting') throw new ItemActionError('start_superseded', 'This start is no longer authorized. Review the current action.');
  const saved = ledger.plans[receipt.planId];
  if (saved?.plan.taskId !== taskId || !saved.plan.ops.some(op => op.tool === 'task_start' && op.args.id === taskId && op.args.start_attempt_id === attemptId)) {
    throw new ItemActionError('plan_changed', 'Review the action again before starting');
  }
  await validateItemPlan(saved, saved.origin, true);
  const task = await exactItemTask(taskId);
  if (!task.last_start || !['starting', 'unconfirmed'].includes(task.last_start.state)) return;
  const previous = Object.values(ledger.receipts).find(r => inboxStartRecoveryMatches(r, ledger.plans[r.planId], taskId, task.last_start!.id)
    && ledger.plans[r.planId]?.sourceKey === saved.sourceKey && r.intent === receipt.intent && r.input.goal === receipt.input.goal);
  if (!saved.plan.input.retryStart || saved.previousStartId !== task.last_start.id || attemptId === task.last_start.id || !previous) {
    throw new ItemActionError('start_unconfirmed', 'The previous start outcome is unconfirmed. Review an explicit recovery before retrying.');
  }
  return { previousStartId: task.last_start.id };
}
export async function validateItemPlan(saved: SavedItemPlan, origin: string, confirmed: boolean): Promise<void> {
  const plan = saved.plan;
  if (saved.origin !== origin) throw new ItemActionError('origin_changed', 'Review this action from the current client');
  if (Date.parse(plan.expiresAt) < Date.now()) throw new ItemActionError('plan_expired', 'This plan expired. Review the action again.');
  const { item } = await storedInboxItem(plan.letterId, plan.itemId);
  const action = item.actions.find(a => a.id === plan.actionId);
  if (!action || fingerprint(item.source) !== fingerprint(plan.source)) throw new ItemActionError('plan_changed', 'This email changed. Review the action again.');
  const trusted = await resolveInboxSource(plan.source);
  if (trusted.key !== saved.sourceKey) throw new ItemActionError('source_changed', 'This email identity changed. Review the action again.');
  if (plan.intent === 'find_task') throw new ItemActionError('selection_required', 'Select a task before confirming', 400);
  for (const operation of plan.ops) {
    const op = getOp(operation.tool);
    if (!op) throw new ItemActionError('op_unavailable', 'Mail actions unavailable', 503);
    const refusal = humanActionRefusal(op, origin, confirmed);
    if (refusal) throw new ItemActionError(refusal.code, refusal.message, refusal.status);
  }
  if ((plan.intent === 'create_task' || plan.intent === 'attach_task') && !confirmed) throw new ItemActionError('confirmation_required', 'Confirm the exact task action first', 400);
  if (plan.input.markReadAgain && !confirmed) throw new ItemActionError('confirmation_required', 'Confirm setting this exact email to read again', 400);
  if (saved.taskFingerprint && plan.taskId && await taskPlanFingerprint(plan.taskId) !== saved.taskFingerprint) throw new ItemActionError('task_changed', 'This task changed. Review the action again.');
  if (saved.launchFingerprint && plan.launch) {
    const task = plan.task ?? { id: plan.taskId!, title: plan.input.title!, project: plan.input.project ?? '' };
    const full = saved.taskFingerprint ? await exactItemTask(plan.taskId!) : task;
    const launch = await resolveTaskLaunchReadOnly(full as Parameters<typeof resolveTaskLaunchReadOnly>[0], { taskIdPrefix: plan.taskId!, mode: 'default', source: 'human-inbox' });
    if (fingerprint({ host: launch.host || '__local__', cwd: launch.cwd, engine: launch.engine ?? 'claude', model: launch.model ?? 'default', mode: launch.mode ?? 'default' }) !== saved.launchFingerprint) {
      throw new ItemActionError('launch_changed', 'The launch settings changed. Review the action again.');
    }
  }
}
async function persist(saved: SavedItemPlan, id: string, patch: Partial<InboxItemReceipt>, shouldUpdate?: Parameters<typeof updateItemExecution>[2]): Promise<InboxItemReceipt> {
  const receipt = await updateItemExecution(id, patch, shouldUpdate);
  await writeItemReceipt(saved.plan.letterId, saved.plan.itemId, receipt);
  return receipt;
}
async function persistObservedReceipt(saved: SavedItemPlan, observed: InboxItemReceipt, patch: Partial<InboxItemReceipt>): Promise<InboxItemReceipt> {
  return persist(saved, observed.requestId, patch, async current => current.status === 'pending'
    && current.stage === observed.stage && current.revision === observed.revision);
}
async function persistObservedStart(saved: SavedItemPlan, observed: InboxItemReceipt, attempt: Awaited<ReturnType<typeof exactItemTask>>['last_start'], patch: Partial<InboxItemReceipt>): Promise<InboxItemReceipt> {
  const attemptValue = stableJson(attempt);
  return persist(saved, observed.requestId, patch, async current => {
    if (current.status !== 'pending' || !['accepted', 'starting'].includes(observed.stage)
      || current.stage !== observed.stage || current.revision !== observed.revision) return false;
    // Authorization's CAS takes this same ledger lock. No host operation runs here.
    const task = await exactItemTask(saved.plan.taskId!).catch(() => undefined);
    return !!task && stableJson(task.last_start) === attemptValue;
  });
}
export function confirmedMailRead(result: unknown, account: string): boolean {
  let payload: unknown = result;
  if (payload && typeof payload === 'object') {
    const wrapped = payload as Record<string, unknown>;
    payload = wrapped.text ?? wrapped.result ?? payload;
  }
  if (typeof payload !== 'string') return false;
  try {
    const first = JSON.parse(payload.split('\n')[0]) as Record<string, unknown>;
    return first.account === account && first.read === true && first.changed === 1 && (first.failed === undefined || Array.isArray(first.failed) && first.failed.length === 0);
  } catch { return false; }
}
export async function executeInboxItem(letterId: string, itemId: string, raw: unknown, origin: string, apiBase: string) {
  const parsed = inboxExecuteSchema.safeParse(raw);
  if (!parsed.success) throw new ItemActionError('bad_request', parsed.error.message, 400);
  const request = parsed.data;
  const saved = await getItemPlan(request.planId);
  if (!saved || saved.plan.letterId !== letterId || saved.plan.itemId !== itemId || saved.plan.actionId !== request.actionId || saved.plan.version !== request.planVersion) throw new ItemActionError('plan_changed', 'Review the action again before confirming');
  const ledger = await readItemLedger();
  if (saved.origin !== origin) throw new ItemActionError('origin_changed', 'Review this action from the current client');
  const prior = assertItemRequestPlan(ledger, request.requestId, saved);
  if (prior) {
    await writeItemReceipt(letterId, itemId, prior);
    return prior;
  }
  await validateItemPlan(saved, origin, request.confirmed === true);
  const claimed = await claimItemExecution(saved, request.requestId);
  await writeItemReceipt(letterId, itemId, claimed.receipt);
  if (claimed.fresh) {
    const attempt = runItemPlan(saved, claimed.receipt, origin, apiBase).catch(() => claimed.receipt).finally(async () => { active.delete(request.requestId); await releaseItemWorker(request.requestId).catch(() => {}); });
    active.set(request.requestId, attempt);
  }
  return claimed.receipt;
}
async function reconcileStart(saved: SavedItemPlan, requestId: string, observed?: InboxItemReceipt): Promise<InboxItemReceipt> {
  observed ??= (await readItemLedger()).receipts[requestId];
  if (!observed) throw new ItemActionError('not_found', 'Execution record not found', 404);
  const task = await exactItemTask(saved.plan.taskId!);
  const attempt = task.last_start;
  const plannedAttempt = saved.plan.ops.find(op => op.tool === 'task_start')?.args.start_attempt_id;
  if (!attempt || attempt.id !== plannedAttempt) {
    const dead = await itemWorkerDead(requestId);
    if (dead && attempt?.state === 'failed' && saved.plan.input.retryStart && saved.previousStartId === attempt.id) {
      return persistObservedStart(saved, observed, attempt, { status: 'failure', stage: 'finished', taskCreated: true,
        execution: 'not_started', reason: 'The server stopped before recording this retry. Review the same task before confirming another start.',
        recovery: ['retry_start', 'open_task'] });
    }
    if (dead && attempt && saved.plan.input.retryStart && saved.previousStartId === attempt.id && ['starting', 'unconfirmed'].includes(attempt.state)) {
      const ledger = await readItemLedger();
      const previous = Object.values(ledger.receipts).some(r => inboxStartRecoveryMatches(r, ledger.plans[r.planId], task.id, attempt.id)
        && ledger.plans[r.planId]?.sourceKey === saved.sourceKey && r.intent === saved.plan.intent && r.input.goal === saved.plan.input.goal);
      const current = ledger.receipts[requestId];
      if (previous && current) {
        const recovered = await persistStartRecoveryRefusal(saved, current, 'The server stopped before the recovery start outcome was recorded', observed, task);
        if (recovered) return recovered;
      }
    }
    return persistObservedStart(saved, observed, attempt, { status: dead && !attempt ? 'failure' : 'pending', execution: dead && !attempt ? 'not_started' : 'unconfirmed',
      ...(dead && !attempt ? { stage: 'finished', taskCreated: true, reason: 'The server stopped before recording this start. Review the same task before confirming a retry.' } : {}),
      recovery: dead && !attempt ? ['retry_start', 'open_task'] : ['check_status', 'open_task'] });
  }
  if (['starting', 'unconfirmed'].includes(attempt.state) && await itemWorkerDead(requestId)) {
    return persistObservedStart(saved, observed, attempt, { status: 'failure', stage: 'finished', taskCreated: true, startAttemptId: attempt.id,
      execution: 'unconfirmed', code: 'start_recovery_required',
      reason: 'The previous start outcome is unconfirmed. Nothing will be resent automatically. Only confirming a reviewed retry cancels the previous pending start before starting this same task again.',
      recovery: ['retry_start', 'check_status', 'open_task'] });
  }
  const started = attempt.state === 'started';
  const failed = attempt.state === 'failed';
  return persistObservedStart(saved, observed, attempt, { status: started ? 'success' : failed ? 'failure' : 'pending', taskCreated: true,
    stage: started || failed ? 'finished' : 'starting', startAttemptId: attempt.id,
    execution: started ? 'running' : failed ? 'not_started' : attempt.state === 'starting' ? 'starting' : 'unconfirmed',
    ...(started ? { startedAt: attempt.at } : {}), reason: attempt.error?.slice(0, 500),
    recovery: started ? ['open_task'] : failed ? ['retry_start', 'open_task'] : ['check_status', 'open_task'],
  });
}
async function reconcileLateStart(saved: SavedItemPlan, observed: InboxItemReceipt): Promise<InboxItemReceipt> {
  const task = await exactItemTask(saved.plan.taskId!);
  const attempt = task.last_start;
  const planned = saved.plan.ops.find(op => op.tool === 'task_start')?.args.start_attempt_id;
  if (!attempt || attempt.id !== planned || observed.startAttemptId !== planned || !['started', 'failed'].includes(attempt.state)) return observed;
  const started = attempt.state === 'started';
  return persist(saved, observed.requestId, { status: started ? 'success' : 'failure', execution: started ? 'running' : 'not_started',
    stage: 'finished', code: undefined, reason: attempt.error?.slice(0, 500), ...(started ? { startedAt: attempt.at } : {}),
    recovery: started ? ['open_task'] : ['retry_start', 'open_task'] }, async current => {
    if (current.status !== 'failure' || current.code !== 'start_recovery_required' || current.revision !== observed.revision) return false;
    const fresh = await exactItemTask(task.id).catch(() => undefined);
    return !!fresh && stableJson(fresh.last_start) === stableJson(attempt);
  });
}
export async function queryInboxItem(letterId: string, itemId: string, origin: string): Promise<InboxItemExecutionResponse> {
  const { item } = await storedInboxItem(letterId, itemId);
  let trusted: Awaited<ReturnType<typeof resolveInboxSource>> | undefined;
  try { trusted = await resolveInboxSource(item.source); } catch { /* Stored receipts remain readable without a mail plugin. */ }
  const receipts = trusted ? await itemReceipts(trusted.key, sourcePairKey(item.source.account, item.source.message), letterId, itemId) : item.receipts ?? [];
  for (const receipt of receipts) {
    if (receipt.status === 'failure' && receipt.code === 'start_recovery_required' && receipt.execution === 'unconfirmed') {
      const saved = await getItemPlan(receipt.planId);
      if (saved) {
        try { Object.assign(receipt, await reconcileLateStart(saved, receipt)); } catch { /* An unavailable task proves no new outcome. */ }
      }
      continue;
    }
    if (receipt.status !== 'pending' || active.has(receipt.requestId)) continue;
    if ((receipt.stage === 'accepted' || receipt.stage === 'creating') && !await itemWorkerDead(receipt.requestId)) continue;
    const saved = await getItemPlan(receipt.planId);
    if (!saved) continue;
    if (receipt.stage === 'accepted') {
      const recovery = await persistStartRecoveryRefusal(saved, receipt, 'The server stopped before the reviewed recovery was dispatched', receipt);
      if (recovery) { Object.assign(receipt, recovery); continue; }
      Object.assign(receipt, await persistObservedReceipt(saved, receipt, { status: 'failure', stage: 'finished', code: 'not_dispatched',
        reason: 'The server stopped before this action was dispatched. No operation was sent.',
        ...(receipt.taskId ? { execution: 'not_started' } : {}),
        recovery: saved.plan.ops.some(op => op.tool === 'task_create') ? ['retry_create'] : saved.plan.ops.some(op => op.tool === 'task_start') ? ['retry_start', 'open_task'] : receipt.taskId ? ['check_status', 'open_task'] : receipt.intent === 'mark_read' ? ['retry_mark_read'] : ['check_status'],
      }));
    } else if (receipt.stage === 'marking_read' && await itemWorkerDead(receipt.requestId)) {
      Object.assign(receipt, await persistObservedReceipt(saved, receipt, { status: 'failure', stage: 'finished', code: 'read_unconfirmed',
        reason: 'The server stopped before the mail provider confirmed this email as read. Check it or confirm setting it to read again.', recovery: ['check_status', 'retry_mark_read'] }));
    } else if (receipt.taskId && receipt.stage === 'starting') {
      try { Object.assign(receipt, await reconcileStart(saved, receipt.requestId, receipt)); } catch { /* No proof, no resend. */ }
    } else if (receipt.taskId && receipt.stage === 'creating') {
      try {
        await exactItemTask(receipt.taskId);
        await markSourceTaskCreated(saved.sourceKey, receipt.taskId);
        Object.assign(receipt, await persistObservedReceipt(saved, receipt, { status: 'failure', stage: 'finished', taskCreated: true, execution: 'not_started', reason: 'Task saved. The server stopped before its start was dispatched.', recovery: ['retry_start', 'open_task'] }));
      } catch (error) {
        if (error instanceof ItemActionError && error.code === 'target_deleted') {
          Object.assign(receipt, await persistObservedReceipt(saved, receipt, { status: 'failure', stage: 'finished', taskCreated: false, execution: 'not_started',
            code: 'create_unconfirmed', reason: 'The previous create result was not confirmed and the reserved task is not present. Confirm retrying the same task ID and payload.', recovery: ['retry_create'] }));
        }
      }
    } else if (receipt.messageId && (receipt.stage === 'sending' || receipt.stage === 'delivering')) {
      const { readQueueFileFresh } = await import('../session-queue-store.js');
      const { taskConversation } = await import('../sessions/task-session-claim.js');
      const { letter } = await storedInboxItem(letterId, itemId);
      const sid = receipt.taskId ? (await taskConversation(receipt.taskId))?.claudeSessionId : letter.sender.sessionId;
      if (sid) {
        const queue = await readQueueFileFresh();
        const rows = queue.queues[sid] ?? [];
        if (rows.some(row => row.id === receipt.messageId) || queue.settled?.[receipt.messageId]) {
          Object.assign(receipt, await persistObservedReceipt(saved, receipt, { status: 'success', stage: 'finished', delivery: 'queued', recovery: receipt.taskId ? ['open_task'] : [] }));
        }
      }
    }
  }
  const taskId = [...receipts].reverse().find(r => r.taskId && r.taskCreated !== false)?.taskId;
  const mark = getOp('mail_mark_read');
  const refusal = mark && humanActionRefusal(mark, origin, true);
  return { itemId, receipts, ...(taskId ? { currentTask: await currentItemTaskStatus(taskId) } : {}),
    ...(origin === '__local__' && trusted?.readObservation ? { readObservation: trusted.readObservation } : item.readObservation ? { readObservation: item.readObservation } : {}),
    restrictions: refusal ? [{ code: refusal.code, message: refusal.message }] : [],
  };
}

async function persistStartRecoveryRefusal(saved: SavedItemPlan, receipt: InboxItemReceipt, reason: string, observed?: InboxItemReceipt, observedTask?: Awaited<ReturnType<typeof exactItemTask>>): Promise<InboxItemReceipt | undefined> {
  if (!saved.plan.input.retryStart || !saved.previousStartId || !saved.plan.ops.some(op => op.tool === 'task_start')) return;
  const ledger = await readItemLedger();
  observed ??= ledger.receipts[receipt.requestId];
  if (!observed) return;
  const task = observedTask ?? await exactItemTask(saved.plan.taskId!).catch(() => undefined);
  if (task?.last_start?.id !== saved.previousStartId || !['starting', 'unconfirmed'].includes(task.last_start.state)) return;
  const previous = Object.values(ledger.receipts).some(r => r.requestId !== receipt.requestId
    && inboxStartRecoveryMatches(r, ledger.plans[r.planId], task.id, task.last_start!.id)
    && ledger.plans[r.planId]?.sourceKey === saved.sourceKey && r.intent === saved.plan.intent && r.input.goal === saved.plan.input.goal);
  if (!previous) return;
  return persistObservedStart(saved, observed, task.last_start, { status: 'failure', stage: 'finished', taskCreated: true,
    execution: 'unconfirmed', code: 'start_recovery_required',
    reason: `Recovery did not confirm cancelling the previous pending start: ${reason.slice(0, 250)}. The previous outcome remains unconfirmed; no replacement start is confirmed. Check status or review another retry. Cancellation happens only after confirmation.`,
    recovery: ['retry_start', 'check_status', 'open_task'] });
}
async function runItemPlan(saved: SavedItemPlan, receipt: InboxItemReceipt, origin: string, apiBase: string): Promise<InboxItemReceipt> {
  const plan = saved.plan;
  let taskCreated = false;
  let dispatched = false;
  try {
    await validateItemPlan(saved, origin, true);
    const { item, letter } = await storedInboxItem(plan.letterId, plan.itemId);
    if (plan.intent === 'reply_ai') {
      const action = item.actions.find(a => a.id === plan.actionId);
      if (action?.kind !== 'reply_ai') throw new Error('The AI question is unavailable');
      const messageId = `qm-inbox-ai-${fingerprint(`${plan.letterId}:${plan.itemId}:${plan.actionId}`).slice(0, 35)}`;
      await persist(saved, receipt.requestId, { stage: 'delivering', messageId });
      dispatched = true;
      const delivery = await deliverLetterToOrigin(letter, { choice: action.label, text: action.question }, { messageId });
      const uncertain = delivery.status === 'pending' || delivery.reason === 'timeout';
      return await persist(saved, receipt.requestId, { status: uncertain ? 'pending' : delivery.status === 'failed' ? 'failure' : 'success', stage: uncertain ? 'delivering' : 'finished',
        delivery: uncertain ? 'unconfirmed' : delivery.status as 'queued' | 'deferred' | 'skipped' | 'failed', reason: delivery.reason, recovery: uncertain || delivery.status === 'failed' ? ['check_status'] : [] });
    }
    if (plan.taskId) {
      if (!plan.ops.some(op => op.tool === 'task_create')) taskCreated = true;
      const trusted = await resolveInboxSource(plan.source);
      const claim = await claimSourceTask({ key: trusted.key, pair: sourcePairKey(plan.source.account, plan.source.message),
        ...(plan.intent === 'attach_task' ? { targetTaskId: plan.taskId } : {}),
        createPayload: plan.ops.find(op => op.tool === 'task_create')?.args,
        confirmation: { intent: plan.intent, goal: plan.input.goal!, targetTaskId: plan.taskId }, adapter: trusted.adapter });
      if (claim.taskId !== plan.taskId) throw new ItemActionError('source_changed', 'This email is already linked to another task');
    }
    for (const operation of plan.ops) {
      const stage = operation.tool === 'mail_mark_read' ? 'marking_read' : operation.tool === 'task_create' ? 'creating' : operation.tool === 'task_start' ? 'starting' : 'sending';
      dispatched = false;
      await persist(saved, receipt.requestId, { stage, ...(stage === 'starting' ? { execution: 'starting' } : {}) });
      if (operation.tool === 'task_send' || operation.tool === 'task_start') {
        const task = await exactItemTask(plan.taskId!);
        if (task.phase === 'COMPLETE') throw new ItemActionError('task_completed', 'This task changed. Review the action again.');
        if (saved.taskFingerprint && await taskPlanFingerprint(task.id) !== saved.taskFingerprint) throw new ItemActionError('task_changed', 'This task changed. Review the action again.');
      }
      dispatched = true;
      const outcome = await executeOp(operation.tool, operation.args, { apiBase, origin, callerMode: 'human', beforeMutation: async () => {
        if (operation.tool === 'task_start' || operation.tool === 'task_send') {
          const task = await exactItemTask(plan.taskId!);
          if (task.phase === 'COMPLETE') throw new ItemActionError('task_changed', 'This task changed. Review the action again.');
          if (saved.taskFingerprint && await taskPlanFingerprint(task.id) !== saved.taskFingerprint) throw new ItemActionError('task_changed', 'This task changed. Review the action again.');
        }
      } });
      if (!outcome.ok) {
        if (operation.tool === 'task_start') {
          const recovery = await persistStartRecoveryRefusal(saved, receipt, outcome.message);
          if (recovery) return recovery;
        }
        const unknown = /timeout|timed out|request failed|unreachable|not running at/i.test(outcome.message);
        return await persist(saved, receipt.requestId, { status: unknown ? 'pending' : 'failure', stage: unknown ? stage : 'finished', reason: outcome.message.slice(0, 500),
          ...(plan.taskId && (operation.tool === 'task_start' || operation.tool === 'task_create') ? { execution: unknown ? 'unconfirmed' : 'not_started', taskCreated } : {}),
          ...(operation.tool === 'task_send' ? { delivery: unknown ? 'unconfirmed' : 'failed' } : {}),
          recovery: unknown ? ['check_status'] : operation.tool === 'mail_mark_read' ? ['retry_mark_read'] : operation.tool === 'task_create' ? ['retry_create'] : operation.tool === 'task_start' ? ['retry_start', 'open_task'] : ['check_status', 'open_task'],
        });
      }
      if (operation.tool === 'mail_mark_read' && !confirmedMailRead(outcome.result, plan.source.account)) {
        return await persist(saved, receipt.requestId, { status: 'failure', stage: 'finished', code: 'read_not_confirmed', reason: 'The mail provider did not confirm this exact email as read', recovery: ['retry_mark_read'] });
      }
      if (operation.tool === 'task_create') {
        const result = outcome.result as Record<string, unknown>;
        if (result.id !== plan.taskId && result.taskId !== plan.taskId) throw new Error('The created task identity did not match the plan');
        taskCreated = true;
        await markSourceTaskCreated(saved.sourceKey, plan.taskId!);
        await persist(saved, receipt.requestId, { taskCreated: true });
      }
      if (operation.tool === 'task_start') return await reconcileStart(saved, receipt.requestId);
      if (operation.tool === 'task_send') {
        const result = outcome.result as Record<string, unknown>;
        if (result.delivery !== 'queued' && result.delivery !== 'deferred') throw new Error('The task queue did not confirm accepting this work');
        return await persist(saved, receipt.requestId, { status: 'success', stage: 'finished', delivery: result.delivery, recovery: ['open_task'] });
      }
    }
    return await persist(saved, receipt.requestId, { status: 'success', stage: 'finished', recovery: plan.intent === 'mark_read' ? ['mark_read_again'] : [] });
  } catch (error) {
    const recovery = await persistStartRecoveryRefusal(saved, receipt, String(error));
    if (recovery) return recovery;
    return await persist(saved, receipt.requestId, { status: dispatched ? 'pending' : 'failure', reason: String(error).slice(0, 500),
      ...(plan.taskId ? { execution: dispatched ? 'unconfirmed' : 'not_started' } : {}), recovery: ['check_status'] });
  }
}
