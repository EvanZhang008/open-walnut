import { describe, it, expect, vi } from 'vitest';
import { createMockConstants } from '../helpers/mock-constants.js';
vi.mock('../../src/constants.js', () => createMockConstants('source-claims'));
import { claimSourceTask, lookupSourceClaim, markSourceTaskCreated, sourcePairKey, SourceClaimConflict } from '../../src/core/source-task-claims.js';
import { taskIdForKey } from '../../src/core/task-create-idempotency.js';
import { messageTaskKey } from '../../src/integrations/mail/message-tasks.js';
const rows = new Map<string, string>();
const adapter = { legacyTaskId: async (key: string) => rows.get(key), writeLegacy: async (key: string, id: string) => { rows.set(key, rows.get(key) ?? id); } };

describe('Canonical source task claim', () => {
  it('reuses an old binding before payload comparison and reserves before create', async () => {
    rows.set('rfc:old-reference', '11111111-1111-4111-a111-111111111111');
    const old = await claimSourceTask({ key: 'rfc:old-reference', pair: sourcePairKey('account-a', 'message-a'), adapter, createPayload: { title: 'Changed suggestion' } });
    expect(old.taskId).toBe(rows.get('rfc:old-reference'));
    expect(old.legacy).toBe(true);
    const key = 'rfc:new-reference';
    const claimed = await Promise.all(Array.from({ length: 5 }, (_, n) => claimSourceTask({ key, pair: sourcePairKey(`account-${n}`, `message-${n}`), adapter })));
    expect(new Set(claimed.map(c => c.taskId))).toEqual(new Set([taskIdForKey(`mail-source:${key}`)]));
    expect(claimed.every(c => !c.created)).toBe(true);
    await markSourceTaskCreated(key, claimed[0].taskId);
    expect((await lookupSourceClaim(key, sourcePairKey('account-0', 'message-0'), adapter))!.created).toBe(true);
  });
  it('keeps pair identity and rejects contradicting aliases and confirmed goals', async () => {
    const pair = sourcePairKey('account-a', 'same-provider-id');
    await claimSourceTask({ key: 'rfc:identity-one', pair, adapter });
    await expect(claimSourceTask({ key: 'rfc:identity-two', pair, adapter })).rejects.toBeInstanceOf(SourceClaimConflict);
    const target = '22222222-2222-4222-a222-222222222222';
    await claimSourceTask({ key: 'rfc:confirmed', pair: sourcePairKey('account-a', 'confirmed'), targetTaskId: target, adapter, confirmation: { intent: 'attach_task', goal: 'Review it', targetTaskId: target } });
    await expect(claimSourceTask({ key: 'rfc:confirmed', pair: sourcePairKey('account-a', 'confirmed'), targetTaskId: target, adapter, confirmation: { intent: 'attach_task', goal: 'Delete it', targetTaskId: target } })).rejects.toThrow('different confirmed action');
    expect(messageTaskKey('account-a', '', 'same')).not.toBe(messageTaskKey('account-b', '', 'same'));
    expect(messageTaskKey('account-a', 'same-rfc', 'one')).toBe(messageTaskKey('account-b', 'same-rfc', 'two'));
  });
  it('repairs an interrupted legacy write from the durable reservation', async () => {
    const failing = { ...adapter, writeLegacy: async () => { throw new Error('Interrupted write'); } };
    const key = 'rfc:recover';
    await expect(claimSourceTask({ key, pair: sourcePairKey('account-r', 'message-r'), adapter: failing })).rejects.toThrow('Interrupted');
    expect(rows.has(key)).toBe(false);
    const recovered = await claimSourceTask({ key, pair: sourcePairKey('account-r', 'message-r'), adapter });
    expect(rows.get(key)).toBe(recovered.taskId);
  });
});
