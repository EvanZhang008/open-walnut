import { describe, it, expect, vi } from 'vitest';
import { createMockConstants } from '../helpers/mock-constants.js';
vi.mock('../../src/constants.js', () => createMockConstants('item-ledger'));
import { saveItemPlan, getItemPlan, claimItemExecution, updateItemExecution, itemReceipts, readItemLedger, assertItemRequestPlan } from '../../src/core/human-inbox/item-ledger.js';
import { confirmedMailRead } from '../../src/core/human-inbox/item-execution.js';
import type { InboxItemPlan } from '../../src/core/human-inbox/types.js';
const plan = (id: string, intent: 'mark_read' | 'create_task' = 'mark_read'): InboxItemPlan => ({ id, version: 1, letterId: 'lt-abc-1234', itemId: id, actionId: `a-${id}`, source: { kind: 'mail', account: id, message: 'same' }, input: {}, intent, ops: [], createdAt: '2026-01-01T00:00:00Z', expiresAt: '2027-01-01T00:00:00Z' });

describe('Execution ledger claims and provider receipts', () => {
  it('persists pending before running, deduplicates one request and separates mail pairs', async () => {
    const saved = { plan: plan('one'), sourceKey: 'rfc:one', origin: '__local__' };
    await saveItemPlan(saved);
    expect(await getItemPlan('one')).toEqual(saved);
    const results = await Promise.all(Array.from({ length: 4 }, () => claimItemExecution(saved, 'same-request')));
    expect(results.filter(r => r.fresh)).toHaveLength(1);
    expect(results[0].receipt.status).toBe('pending');
    await updateItemExecution('same-request', { status: 'success', stage: 'finished' });
    expect((await claimItemExecution(saved, 'same-request')).receipt.status).toBe('success');
    expect((await claimItemExecution({ ...saved, plan: plan('two') }, 'other-account')).fresh).toBe(true);
    expect(await itemReceipts('rfc:one', JSON.stringify(['one', 'same']), 'lt-abc-1234', 'one')).toHaveLength(1);
  });
  it('atomically aliases concurrent requests without claiming another execution', async () => {
    const first = { plan: { ...plan('alias-first', 'create_task'), taskId: 'reserved-task', input: { goal: 'Review update' } }, sourceKey: 'rfc:aliases', origin: '__local__' };
    const second = { ...first, plan: { ...first.plan, id: 'alias-second', letterId: 'lt-other-1234', itemId: 'alias-other', actionId: 'alias-action' } };
    await saveItemPlan(first); await saveItemPlan(second);
    const canonical = await claimItemExecution(first, 'alias-canonical');
    const aliases = await Promise.all(Array.from({ length: 8 }, (_, n) => claimItemExecution(second, `alias-${n}`)));
    expect(canonical.fresh).toBe(true);
    expect(aliases.every(r => !r.fresh && r.receipt.requestId === 'alias-canonical')).toBe(true);
    const ledger = await readItemLedger();
    expect(new Set(ledger.receipts['alias-canonical'].requestIds)).toEqual(new Set(['alias-canonical', ...Array.from({ length: 8 }, (_, n) => `alias-${n}`)]));
    expect(Object.keys(ledger.receipts).filter(key => key.startsWith('alias-'))).toEqual(['alias-canonical']);
    expect(ledger.owners['alias-canonical']).toHaveLength(9);
    expect(assertItemRequestPlan(ledger, 'alias-3', second)?.planId).toBe(first.plan.id);
    expect(() => assertItemRequestPlan(ledger, 'alias-3', first)).toThrow('another confirmed plan');
    await expect(claimItemExecution({ ...second, plan: { ...second.plan, input: { goal: 'Different goal' } } }, 'alias-conflict')).rejects.toThrow('in progress');
    expect((await readItemLedger()).aliases?.['alias-conflict']).toBeUndefined();
    const updated = await updateItemExecution('alias-3', { status: 'success', stage: 'finished' });
    expect(updated.requestId).toBe('alias-canonical'); expect(updated.requestIds).toHaveLength(9);
    expect((await claimItemExecution(second, 'alias-3')).receipt.status).toBe('success');
    expect((await claimItemExecution(second, 'alias-after-success')).fresh).toBe(false);
  });
  it('rejects changed frozen targets as aliases but allows a failed start to review new launch settings', async () => {
    const first = { plan: { ...plan('frozen-first', 'create_task'), taskId: 'frozen-task', input: { goal: 'Review launch' } },
      sourceKey: 'rfc:frozen', origin: '__local__', taskFingerprint: 'task-before', launchFingerprint: 'launch-before' };
    const changed = { ...first, plan: { ...first.plan, id: 'frozen-second' }, taskFingerprint: 'task-after', launchFingerprint: 'launch-after' };
    await saveItemPlan(first); await saveItemPlan(changed);
    await claimItemExecution(first, 'frozen-original');
    await expect(claimItemExecution(changed, 'frozen-pending-alias')).rejects.toThrow('in progress');
    await updateItemExecution('frozen-original', { status: 'success', stage: 'finished' });
    await expect(claimItemExecution(changed, 'frozen-success-alias')).rejects.toThrow('different task or launch');
    await updateItemExecution('frozen-original', { status: 'failure', execution: 'not_started' });
    const retry = await claimItemExecution(changed, 'frozen-retry');
    expect(retry.fresh).toBe(true); expect(retry.receipt.planId).toBe(changed.plan.id);
    const ledger = await readItemLedger();
    expect(ledger.aliases?.['frozen-pending-alias']).toBeUndefined();
    expect(ledger.aliases?.['frozen-success-alias']).toBeUndefined();
  });
  it('cleans expired review plans while retaining every execution and alias binding', async () => {
    const now = Date.now();
    const held = { plan: { ...plan('retained-expired'), expiresAt: new Date(now - 1).toISOString() }, sourceKey: 'rfc:retained', origin: '__local__' };
    await saveItemPlan(held); await claimItemExecution(held, 'retained-request');
    const alias = { ...held, plan: { ...held.plan, id: 'retained-alias' } };
    await saveItemPlan(alias); await claimItemExecution(alias, 'retained-alias-request');
    for (let n = 0; n < 12; n++) await saveItemPlan({ ...held, plan: { ...plan(`ephemeral-${n}`), expiresAt: new Date(now + 200).toISOString() } });
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now + 201);
    try {
      await saveItemPlan({ ...held, plan: { ...plan('new-review'), expiresAt: new Date(now + 1000).toISOString() } });
      const ledger = await readItemLedger();
      expect(Object.keys(ledger.plans).filter(id => id.startsWith('ephemeral-'))).toEqual([]);
      expect(Object.keys(ledger.plans)).toEqual(expect.arrayContaining(['retained-expired', 'retained-alias', 'new-review']));
      expect(ledger.receipts['retained-request'].requestIds).toEqual(['retained-request', 'retained-alias-request']);
      expect(assertItemRequestPlan(ledger, 'retained-alias-request', alias)?.requestId).toBe('retained-request');
    } finally { clock.mockRestore(); }
  });
  it.each([
    ['{"account":"account-a","read":true,"changed":1}\nOne changed', true],
    ['{"account":"account-a","read":true,"changed":0}', false],
    ['{"account":"account-b","read":true,"changed":1}', false],
    ['{"account":"account-a","read":false,"changed":1}', false],
    ['{"account":"account-a","read":true,"changed":1,"failed":[{"message":"m"}]}', false],
    ['Operation refused', false],
    [{ ok: true, text: 'Operation refused' }, false],
  ])('requires exact inner plugin evidence %j', (result, expected) => {
    expect(confirmedMailRead(result, 'account-a')).toBe(expected);
  });
});
