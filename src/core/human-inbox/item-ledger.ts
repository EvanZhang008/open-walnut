import path from 'node:path';
import { WALNUT_HOME } from '../../constants.js';
import { readJsonFile, updateJsonFile, writeJsonFile } from '../../utils/fs.js';
import { withFileLock } from '../../utils/file-lock.js';
import type { InboxItemPlan, InboxItemReceipt } from './types.js';
import { fingerprint, stableJson } from '../task-create-idempotency.js';

export interface SavedItemPlan { plan: InboxItemPlan; taskFingerprint?: string; launchFingerprint?: string; previousStartId?: string; sourceKey: string; origin: string }
interface ExecutionOwner { letterId: string; itemId: string; actionId: string; requestId?: string; planId?: string }
interface Ledger {
  version: 1;
  revision: number;
  plans: Record<string, SavedItemPlan>;
  receipts: Record<string, InboxItemReceipt>;
  aliases?: Record<string, string>;
  locks: Record<string, string>;
  readHistory: Record<string, string[]>;
  owners: Record<string, ExecutionOwner[]>;
  workerPids?: Record<string, number>;
}
const FILE = path.join(WALNUT_HOME, 'human-inbox', 'item-ledger.json');
const empty = (): Ledger => ({ version: 1, revision: 0, plans: {}, receipts: {}, aliases: {}, locks: {}, readHistory: {}, owners: {} });
export class ItemActionError extends Error {
  constructor(readonly code: string, message: string, readonly status = 409) { super(message); }
}
export async function readItemLedger(): Promise<Ledger> { return readJsonFile(FILE, empty(), { readErrors: 'throw' }); }
export function itemRequestReceipt(file: Ledger, requestId: string): InboxItemReceipt | undefined {
  const canonical = file.aliases && Object.hasOwn(file.aliases, requestId) ? file.aliases[requestId] : requestId;
  return Object.hasOwn(file.receipts, canonical) ? file.receipts[canonical] : undefined;
}
export function assertItemRequestPlan(file: Ledger, requestId: string, saved: SavedItemPlan): InboxItemReceipt | undefined {
  const receipt = itemRequestReceipt(file, requestId);
  if (!receipt) return undefined;
  const owner = file.owners[receipt.requestId]?.find(o => o.requestId === requestId);
  const original = file.plans[receipt.planId];
  const binding = owner?.planId ? file.plans[owner.planId] : requestId === receipt.requestId ? original : undefined;
  if (!original || !binding || binding.plan.id !== saved.plan.id || binding.plan.version !== saved.plan.version
    || binding.plan.actionId !== saved.plan.actionId || binding.plan.letterId !== saved.plan.letterId
    || binding.plan.itemId !== saved.plan.itemId || binding.origin !== saved.origin) {
    throw new ItemActionError('request_conflict', 'This request id belongs to another confirmed plan');
  }
  return receipt;
}
export async function saveItemPlan(value: SavedItemPlan): Promise<void> {
  await updateJsonFile(FILE, empty(), file => {
    const referenced = new Set([...Object.values(file.receipts).map(r => r.planId),
      ...Object.values(file.owners).flatMap(owners => owners.flatMap(o => o.planId ? [o.planId] : []))]);
    for (const [id, saved] of Object.entries(file.plans)) {
      if (Date.parse(saved.plan.expiresAt) <= Date.now() && !referenced.has(id)) delete file.plans[id];
    }
    file.plans[value.plan.id] = value;
    return file;
  }, { durable: true });
}
export async function getItemPlan(id: string): Promise<SavedItemPlan | undefined> {
  const plans = (await readItemLedger()).plans;
  return Object.hasOwn(plans, id) ? plans[id] : undefined;
}
function sameWork(file: Ledger, receipt: InboxItemReceipt, saved: SavedItemPlan): boolean {
  const plan = saved.plan;
  const previous = file.plans[receipt.planId];
  return receipt.intent === plan.intent && receipt.input.goal === plan.input.goal && receipt.taskId === plan.taskId
    && previous?.sourceKey === saved.sourceKey
    && (!plan.ops.some(op => op.tool === 'task_create') || stableJson(previous.plan.ops.find(op => op.tool === 'task_create')?.args) === stableJson(plan.ops.find(op => op.tool === 'task_create')?.args));
}
/** A failed retry still refers to the original start it could not cancel. */
export function inboxStartRecoveryMatches(receipt: InboxItemReceipt, saved: SavedItemPlan | undefined, taskId: string, previousStartId: string | undefined): boolean {
  const operation = saved?.plan.ops.find(op => op.tool === 'task_start');
  return !!previousStartId && receipt.status === 'failure' && receipt.execution === 'unconfirmed'
    && receipt.delivery !== 'unconfirmed' && receipt.code === 'start_recovery_required'
    && receipt.taskId === taskId && saved?.plan.taskId === taskId
    && operation?.args.id === taskId && operation.args.start_attempt_id === receipt.startAttemptId
    && (saved.plan.input.retryStart && saved.previousStartId ? saved.previousStartId : receipt.startAttemptId) === previousStartId;
}
function aliasReceipt(file: Ledger, previous: InboxItemReceipt, saved: SavedItemPlan, requestId: string): InboxItemReceipt {
  const receipt = { ...previous, requestIds: [...new Set([previous.requestId, ...(previous.requestIds ?? []), requestId])],
    revision: ++file.revision, updatedAt: new Date().toISOString() };
  (file.aliases ??= {})[requestId] = previous.requestId;
  (file.owners[previous.requestId] ??= []).push({ letterId: saved.plan.letterId, itemId: saved.plan.itemId,
    actionId: saved.plan.actionId, planId: saved.plan.id, requestId });
  file.receipts[previous.requestId] = receipt;
  return receipt;
}
export async function claimItemExecution(saved: SavedItemPlan, requestId: string): Promise<{ receipt: InboxItemReceipt; fresh: boolean }> {
  let receipt!: InboxItemReceipt;
  let fresh = false;
  await updateJsonFile(FILE, empty(), file => {
    const plan = saved.plan;
    const prior = assertItemRequestPlan(file, requestId, saved);
    if (prior) { receipt = prior; return file; }
    const pair = JSON.stringify([plan.source.account, plan.source.message]);
    const lock = plan.intent === 'mark_read' ? `read:${pair}` : plan.intent === 'reply_ai' ? `reply:${plan.letterId}:${plan.itemId}:${plan.actionId}` : `task:${saved.sourceKey}`;
    const owner = file.locks[lock];
    if (owner) {
      const previous = file.receipts[owner];
      const sameInput = sameWork(file, previous, saved);
      const previousPlan = file.plans[previous.planId];
      const sameFrozenTarget = sameInput && previousPlan?.origin === saved.origin
        && previousPlan.taskFingerprint === saved.taskFingerprint && previousPlan.launchFingerprint === saved.launchFingerprint;
      if (previous.status === 'pending') {
        if (!sameFrozenTarget) throw new ItemActionError('execution_pending', 'This email already has an action in progress');
        receipt = aliasReceipt(file, previous, saved, requestId); return file;
      }
      if (plan.intent !== 'mark_read' && !sameInput) {
        throw new ItemActionError('source_conflict', 'This email already has a different confirmed action. Review its task first.');
      }
      if (previous.status === 'success' && (plan.intent !== 'mark_read' || !plan.input.markReadAgain)) {
        if (!sameFrozenTarget) throw new ItemActionError('source_conflict', 'This confirmed action has different task or launch settings. Review its task first.');
        receipt = aliasReceipt(file, previous, saved, requestId); return file;
      }
      const startRecovery = sameInput && plan.input.retryStart === true
        && inboxStartRecoveryMatches(previous, previousPlan, plan.taskId!, saved.previousStartId)
        && plan.ops.length === 1 && plan.ops[0].tool === 'task_start'
        && plan.ops[0].args.id === plan.taskId && plan.ops[0].args.start_attempt_id !== previous.startAttemptId;
      if (previous.delivery === 'unconfirmed' || previous.execution === 'unconfirmed' && !startRecovery) {
        throw new ItemActionError('outcome_unconfirmed', 'Check the original action status before trying again');
      }
    }
    receipt = { actionId: plan.actionId, requestId, requestIds: [requestId], planId: plan.id, planVersion: plan.version,
      revision: ++file.revision, updatedAt: new Date().toISOString(), status: 'pending', intent: plan.intent,
      source: plan.source, input: plan.input, stage: 'accepted', recovery: ['check_status'],
      ...(plan.taskId ? { taskId: plan.taskId, taskCreated: !plan.ops.some(op => op.tool === 'task_create') } : {}),
      ...(plan.messageId ? { messageId: plan.messageId } : {}),
      ...(plan.ops.find(op => op.tool === 'task_start')?.args.start_attempt_id ? { startAttemptId: String(plan.ops.find(op => op.tool === 'task_start')!.args.start_attempt_id) } : {}),
    };
    file.receipts[requestId] = receipt;
    (file.workerPids ??= {})[requestId] = process.pid;
    file.locks[lock] = requestId;
    file.owners[requestId] = [{ letterId: plan.letterId, itemId: plan.itemId, actionId: plan.actionId, requestId, planId: plan.id }];
    if (plan.intent === 'mark_read') (file.readHistory[pair] ??= []).push(requestId);
    fresh = true;
    return file;
  }, { durable: true });
  return { receipt, fresh };
}
export async function withInboxStartAuthorization<T>(taskId: string, attemptId: string | undefined, mutate: () => Promise<T>): Promise<T> {
  if (!attemptId) return mutate();
  const known = Object.values((await readItemLedger()).receipts).some(r => r.taskId === taskId && r.startAttemptId === attemptId);
  if (!known) return mutate();
  // Same lock as receipt mutations; only the short task CAS runs inside it.
  return withFileLock(FILE, async () => {
    const file = await readItemLedger();
    const receipt = Object.values(file.receipts).find(r => r.taskId === taskId && r.startAttemptId === attemptId);
    const saved = receipt && file.plans[receipt.planId];
    if (!receipt || receipt.status !== 'pending' || receipt.stage !== 'starting'
      || saved?.plan.taskId !== taskId
      || !saved.plan.ops.some(op => op.tool === 'task_start' && op.args.id === taskId && op.args.start_attempt_id === attemptId)) {
      throw new ItemActionError('start_superseded', 'This start is no longer authorized. Review the current action.');
    }
    return mutate();
  });
}
export async function updateItemExecution(
  requestId: string,
  patch: Partial<InboxItemReceipt>,
  shouldUpdate?: (current: Readonly<InboxItemReceipt>) => Promise<boolean>,
): Promise<InboxItemReceipt> {
  // The same FILE lock as updateJsonFile and start authorization. A rejected
  // observation returns the current receipt without writing or advancing it.
  return withFileLock(FILE, async () => {
    const file = await readItemLedger();
    const previous = itemRequestReceipt(file, requestId);
    if (!previous) throw new ItemActionError('not_found', 'Execution record not found', 404);
    if (shouldUpdate && !await shouldUpdate(previous)) return previous;
    const receipt = { ...previous, ...patch, requestId: previous.requestId, requestIds: previous.requestIds,
      revision: ++file.revision, updatedAt: new Date().toISOString() };
    file.receipts[previous.requestId] = receipt;
    if (receipt.status !== 'pending') (file.workerPids ??= {})[previous.requestId] = 0;
    await writeJsonFile(FILE, file, { durable: true });
    return receipt;
  });
}
export async function itemReceipts(sourceKey: string, pair: string, letterId: string, itemId: string): Promise<InboxItemReceipt[]> {
  const file = await readItemLedger();
  return Object.values(file.receipts).filter(r => {
    const saved = file.plans[r.planId];
    return r.intent === 'mark_read' ? JSON.stringify([r.source.account, r.source.message]) === pair
      : r.intent === 'reply_ai' ? saved?.plan.letterId === letterId && saved?.plan.itemId === itemId
      : saved?.sourceKey === sourceKey;
  }).sort((a, b) => a.revision - b.revision);
}
export async function receiptSourcePairs(receipt: InboxItemReceipt): Promise<Set<string>> {
  const file = await readItemLedger();
  const own = JSON.stringify([receipt.source.account, receipt.source.message]);
  if (receipt.intent === 'mark_read' || receipt.intent === 'reply_ai') return new Set([own]);
  const key = file.plans[receipt.planId]?.sourceKey;
  return new Set([own, ...Object.values(file.plans).filter(p => p.sourceKey === key)
    .map(p => JSON.stringify([p.plan.source.account, p.plan.source.message]))]);
}
export async function releaseItemWorker(requestId: string): Promise<void> {
  await updateJsonFile(FILE, empty(), file => {
    const receipt = itemRequestReceipt(file, requestId);
    if (receipt) (file.workerPids ??= {})[receipt.requestId] = 0;
    return file;
  }, { durable: true });
}
export async function itemWorkerDead(requestId: string): Promise<boolean> {
  const file = await readItemLedger();
  const receipt = itemRequestReceipt(file, requestId);
  const pid = receipt && file.workerPids?.[receipt.requestId];
  if (pid === 0) return true;
  if (!pid || pid <= 1) return false;
  const { isProcessAliveAsync } = await import('../../utils/process.js');
  return !await isProcessAliveAsync(pid);
}
export async function storedPairReceipts(account: string, message: string): Promise<InboxItemReceipt[]> {
  const pair = JSON.stringify([account, message]);
  return Object.values((await readItemLedger()).receipts).filter(r => r.intent !== 'reply_ai' && JSON.stringify([r.source.account, r.source.message]) === pair);
}
export const planIdentity = (plan: InboxItemPlan) => `ip-${fingerprint(plan).slice(0, 40)}`;
