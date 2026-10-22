import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { InboxItemReceipt, InboxLetterItem } from '../../web/src/api/human-inbox-items';
import { actionText, askAILabel, currentTaskText, itemActions, mergeReceipts, receiptText, accountText, ambiguousAccounts, mailDateText, readHistoryText, retryTaskAction } from '../../web/src/components/inbox/item-receipt-model';
const query = vi.hoisted(() => vi.fn());
vi.mock('@/api/human-inbox-items', async original => ({ ...await original<typeof import('../../web/src/api/human-inbox-items')>(), queryItem: query }));
import { getItemSnapshot, itemKey, mergeItemResponse, noteItemUnconfirmed, refreshItem, resetItemStore, setItemSubmitting, watchItem } from '../../web/src/components/inbox/item-store';
const source = { kind: 'mail' as const, account: 'account-a', message: 'message-a' };
function receipt(revision: number, status: InboxItemReceipt['status'] = 'pending'): InboxItemReceipt {
  return { actionId: 'create-a', requestId: 'request-a', planId: 'plan-a', planVersion: 1, revision, updatedAt: `2026-10-22T00:00:0${revision}Z`,
    status, intent: 'create_task', source, input: { goal: 'Approved goal' }, stage: 'starting', recovery: ['check_status'], taskId: 'task-a' };
}
const item: InboxLetterItem = { id: 'item-a', subject: 'Update', summary: 'Summary', source,
  actions: [{ id: 'find', kind: 'op', intent: 'find_task' }, { id: 'attach', kind: 'op', intent: 'attach_task' }] };
beforeEach(() => { resetItemStore(); query.mockReset(); });
describe('Inbox item truth and fixed controls', () => {
  it('merges by revision and cannot regress success from list detail or duplicate event', () => {
    const success = receipt(3, 'success');
    expect(mergeReceipts([success], [receipt(1), receipt(3)])).toEqual([success]);
    expect(mergeReceipts([receipt(1)], [success])).toEqual([success]);
  });
  it('keeps read and task receipts independent', () => {
    const read = { ...receipt(2, 'success'), requestId: 'read-a', intent: 'mark_read' as const };
    expect(mergeReceipts([read], [receipt(3, 'failure')])).toHaveLength(2);
    expect(receiptText(read)).toContain('Marked read at');
  });
  it('renders only one exact task picker and refuses unknown or damaged source data', () => {
    expect(itemActions(item)).toEqual([item.actions[1]]);
    expect(actionText(item.actions[0])).toBe('Find task');
    expect(itemActions({ ...item, unavailableReason: 'Invalid source' })).toEqual([]);
    expect(itemActions({ ...item, source: { ...source, account: '' } })).toEqual([]);
    expect(itemActions({ ...item, actions: [{ id: 'unknown', kind: 'op', intent: 'delete' } as never] })).toEqual([]);
  });
  it('never converts AI labels into ops or doubles their prefix', () => {
    expect(askAILabel('Mark read')).toBe('Ask AI: Mark read');
    expect(askAILabel('Ask AI: Explain')).toBe('Ask AI: Explain');
  });
  it('reports Started history separately from current authoritative Running', () => {
    expect(receiptText({ ...receipt(3, 'success'), execution: 'running' })).toBe('Started (time unavailable)');
    expect(receiptText({ ...receipt(3), execution: 'unconfirmed' })).toBe('Task created. Start unconfirmed.');
    expect(currentTaskText()).toBe('Current task status unavailable');
    expect(currentTaskText({ taskId: 'task-a', status: 'stopped', observedAt: '2026-10-22T00:00:00Z' })).toContain('Stopped');
    expect(currentTaskText({ taskId: 'task-a', status: 'running', observedAt: '2026-10-22T00:00:00Z' }, true)).toContain('Last observed');
  });
  it('keeps saved read history when the origin becomes local-only', () => {
    const saved = { ...receipt(2, 'success'), intent: 'mark_read' as const };
    expect(readHistoryText(saved, true)).toBe(`Marked read previously at ${new Date(saved.updatedAt).toLocaleString()}`);
    expect(readHistoryText(saved)).toContain('Marked read at');
    expect(readHistoryText(undefined, true)).toBe('');
  });
  it('uses a mail date fallback rather than an execution time fallback', () => {
    expect(mailDateText()).toBe('Date unavailable');
    expect(mailDateText('invalid')).toBe('Date unavailable');
    expect(mailDateText('2026-10-22T00:00:00Z')).toBe(new Date('2026-10-22T00:00:00Z').toLocaleString());
  });
  it('maps cross-letter recovery to this item action with the same intent', () => {
    const current = { ...item, actions: [{ id: 'new-create', kind: 'op' as const, intent: 'create_task' as const }, ...item.actions] };
    expect(retryTaskAction(current, { ...receipt(3, 'failure'), actionId: 'old-create', recovery: ['retry_create'], taskCreated: false })?.id).toBe('new-create');
    expect(retryTaskAction(current, { ...receipt(3, 'failure'), intent: 'attach_task', recovery: ['retry_start'] })?.id).toBe('attach');
    expect(retryTaskAction(current, receipt(3))).toBeUndefined();
    expect(receiptText({ ...receipt(3, 'failure'), execution: 'not_started', taskCreated: false })).not.toContain('Task created');
  });
  it('does not label queue acceptance as Running', () => {
    expect(receiptText({ ...receipt(3, 'success'), delivery: 'queued' })).toBe('Work queued');
    expect(receiptText({ ...receipt(3, 'success'), delivery: 'deferred' })).toBe('Waiting for permission');
  });
  it('disambiguates saved account labels without inventing identities', () => {
    const a = { ...item, display: { accountLabel: 'Personal', accountHint: 'Mailbox A' } };
    const b = { ...a, source: { ...source, account: 'account-b' }, display: { accountLabel: 'Personal', accountHint: 'Mailbox B' } };
    expect(accountText(a, ambiguousAccounts([a, b]))).toBe('Personal · Mailbox A');
    expect(accountText(a, ambiguousAccounts([a, { ...b, display: a.display }]))).toBe('Personal · Mailbox A · account-a');
    expect(accountText(a, ambiguousAccounts([a, a]))).toBe('Personal · Mailbox A');
    expect(accountText(item, new Set())).toBe('Account label unavailable');
  });
});
describe('one item store shared across readers', () => {
  const key = itemKey('letter-a', 'item-a');
  it('locks competing clicks synchronously but not a different lane or item', () => {
    expect(setItemSubmitting(key, 'task', true)).toBe(true);
    expect(setItemSubmitting(key, 'task', true)).toBe(false);
    expect(setItemSubmitting(key, 'read', true)).toBe(true);
    expect(setItemSubmitting(itemKey('letter-a', 'item-b'), 'task', true)).toBe(true);
  });
  it('coalesces concurrent queries and keeps the last receipt on query failure', async () => {
    mergeItemResponse(key, { itemId: 'item-a', receipts: [receipt(3, 'success')], restrictions: [] });
    query.mockRejectedValue(new Error('Connection unavailable'));
    await Promise.all([refreshItem(key), refreshItem(key)]);
    expect(query).toHaveBeenCalledTimes(1);
    expect(getItemSnapshot(key).receipts[0].status).toBe('success');
    expect(getItemSnapshot(key).stale).toBe(true);
  });
  it('blocks an unknown execute until its exact receipt is observed', () => {
    noteItemUnconfirmed(key, undefined, 'task', 'request-a');
    mergeItemResponse(key, { itemId: 'item-a', receipts: [], restrictions: [] });
    expect(getItemSnapshot(key).uncertain.task).toBe('request-a');
    mergeItemResponse(key, { itemId: 'item-a', receipts: [receipt(3, 'success')], restrictions: [] });
    expect(getItemSnapshot(key).uncertain.task).toBeUndefined();
  });
  it('settles a lost aliased execute without unlocking a different AI action', () => {
    noteItemUnconfirmed(key, undefined, 'task', 'alias-request');
    noteItemUnconfirmed(key, undefined, 'ai:question', 'other-request');
    const settled = { ...receipt(4, 'success'), requestIds: ['request-a', 'alias-request'] };
    mergeItemResponse(key, { itemId: 'item-a', receipts: [settled], restrictions: [] });
    expect(getItemSnapshot(key).uncertain.task).toBeUndefined();
    expect(getItemSnapshot(key).uncertain['ai:question']).toBe('other-request');
  });
  it('does not replace new current observation with a late reply', () => {
    mergeItemResponse(key, { itemId: 'item-a', receipts: [], restrictions: [], currentTask: { taskId: 'task-a', status: 'completed', observedAt: '2026-10-22T01:00:00Z' } });
    mergeItemResponse(key, { itemId: 'item-a', receipts: [], restrictions: [], currentTask: { taskId: 'task-a', status: 'running', observedAt: '2026-10-22T00:00:00Z' } });
    expect(getItemSnapshot(key).currentTask?.status).toBe('completed');
  });
  it('stops automatic pending reads after thirty seconds without calling execute', async () => {
    vi.useFakeTimers();
    query.mockResolvedValue({ itemId: 'item-a', receipts: [receipt(1)], restrictions: [] });
    const stop = watchItem(key);
    try {
      await vi.advanceTimersByTimeAsync(36_000);
      const count = query.mock.calls.length;
      expect(getItemSnapshot(key).pollExpired).toBe(true);
      expect(getItemSnapshot(key).receipts[0].status).toBe('pending');
      await vi.advanceTimersByTimeAsync(60_000);
      expect(query).toHaveBeenCalledTimes(count);
      expect(count).toBeLessThan(12);
    } finally { stop(); vi.useRealTimers(); }
  });
});
