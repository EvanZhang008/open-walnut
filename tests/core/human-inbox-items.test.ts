import { describe, it, expect, vi } from 'vitest';
import { createMockConstants } from '../helpers/mock-constants.js';
vi.mock('../../src/constants.js', () => createMockConstants('inbox-items'));
vi.mock('../../src/core/notifications/letter-bridge.js', () => ({ ensureLetterBridge() {}, mirrorLetterReadState: async () => {} }));
import { sendLetter, agentReply, getLetter, writeItemReceipt, setLetterState } from '../../src/core/human-inbox/store.js';
import { normalizeStore } from '../../src/core/human-inbox/normalize.js';
import { validateNewItems, inboxExecuteSchema, inboxPrepareSchema } from '../../src/core/human-inbox/item-schema.js';
import { mergeItemReceipts, mergeLetterItemFacts } from '../../src/core/human-inbox/item-merge.js';
import type { InboxLetterItem, InboxItemReceipt } from '../../src/core/human-inbox/types.js';

const item = (id: string): InboxLetterItem => ({ id, subject: 'A status update', summary: 'Reference data', source: { kind: 'mail', account: 'account-one', message: `message-${id}` }, actions: [{ id: `read-${id}`, kind: 'op', intent: 'mark_read' }] });
const receipt = (i: InboxLetterItem, revision = 2): InboxItemReceipt => ({ actionId: i.actions[0].id, requestId: 'req-one', planId: 'plan-one', planVersion: 1, revision, updatedAt: '2026-01-01T00:00:00Z', status: 'success', intent: 'mark_read', source: i.source, input: {}, stage: 'finished', recovery: [] });

describe('Inbox item persistence and strict contract', () => {
  it('keeps thirty review items and their facts through normalization and flag writes', async () => {
    const items = Array.from({ length: 30 }, (_, n) => item(`item-${n}`));
    const letter = await sendLetter({ subject: 'Mail summary', type: 'review', markdown: 'Snapshot', items, sender: { sessionId: 'external', host: 'local' } });
    await writeItemReceipt(letter.id, items[0].id, receipt(items[0]));
    await setLetterState(letter.id, 'read', true);
    await setLetterState(letter.id, 'pinned', true);
    await setLetterState(letter.id, 'archived', true);
    const saved = (await getLetter(letter.id))!;
    expect(saved.items).toHaveLength(30);
    expect(saved.items![0].receipts).toEqual([receipt(items[0])]);
    expect(saved.answered).toBeUndefined();
    expect(normalizeStore({ version: 1, letters: [saved] }).letters[0].items).toEqual(saved.items);
  });
  it('appends new items only to their agent turn and preserves original receipt', async () => {
    const one = item('first');
    const letter = await sendLetter({ subject: 'Summary', type: 'info', markdown: 'Mail', items: [one], sender: { sessionId: 'external', host: 'local' } });
    await writeItemReceipt(letter.id, one.id, receipt(one));
    await agentReply(letter.id, { text: 'Another mail', items: [item('second')] });
    const saved = (await getLetter(letter.id))!;
    expect(saved.items![0].receipts).toHaveLength(1);
    expect(saved.thread[0].items!.map(i => i.id)).toEqual(['second']);
    await expect(agentReply(letter.id, { text: 'Duplicate', items: [one] })).rejects.toThrow('Duplicate');
    expect((await getLetter(letter.id))!.thread).toHaveLength(1);
  });
  it.each([{ source: { kind: 'mail', account: '', message: 'm' } }, { actions: [{ id: 'bad', kind: 'op', intent: 'delete' }] }, { actions: [{ id: 'bad', kind: 'op', intent: 'mark_read', label: 'Run', target: 'other' }] }])('rejects unsafe definitions before writing', patch => {
    expect(() => validateNewItems([{ ...item('safe'), ...patch }])).toThrow();
  });
  it('keeps a corrupt receipt read-only without affecting another mail item', () => {
    const unsafe = { ...item('unsafe'), receipts: [{ revision: 99, status: 'success', tool: 'delete' }] };
    const letter = normalizeStore({ version: 1, letters: [{ id: 'lt-abc-1234', items: [unsafe, item('neighbor')] }] }).letters[0];
    expect(letter.items![0].unavailableReason).toBe('Invalid saved execution receipt');
    expect(letter.items![0].receipts).toEqual([]);
    expect(letter.items![1].unavailableReason).toBeUndefined();
    expect(() => validateNewItems([{ ...item('controls'), source: { kind: 'mail', account: 'account-a', message: 'msg\u0000alias' } }])).toThrow();
  });
  it('enforces global ids and unique intents, while supporting all task-selector declarations', () => {
    expect(() => validateNewItems([item('same'), item('same')])).toThrow('Duplicate');
    expect(() => validateNewItems([{ ...item('one'), actions: [{ id: 'a', kind: 'op', intent: 'find_task' }, { id: 'b', kind: 'op', intent: 'find_task' }] }])).toThrow();
    for (const intents of [['find_task'], ['attach_task'], ['find_task', 'attach_task']] as const) {
      expect(validateNewItems([{ ...item('one'), actions: intents.map((intent, n) => ({ id: `action-${n}`, kind: 'op', intent })) }])).toHaveLength(1);
    }
  });
  it('refuses execution payloads and incomplete task ids, retaining valid neighbors of corrupt items', () => {
    for (const key of ['source', 'tool', 'args', 'receipt', 'senderSid']) expect(inboxExecuteSchema.safeParse({ actionId: 'a', requestId: 'r', planId: 'p', planVersion: 1, [key]: {} }).success).toBe(false);
    expect(inboxPrepareSchema.safeParse({ actionId: 'a', selectedTaskId: 'title with spaces' }).success).toBe(false);
    const letter = normalizeStore({ version: 1, letters: [{ id: 'lt-abc-1234', items: [item('valid'), { ...item('bad'), source: null }] }] }).letters[0];
    expect(letter.items![0].unavailableReason).toBeUndefined();
    expect(letter.items![1].unavailableReason).toBeDefined();
  });
  it('round trips aliases and reserved create recovery without rejecting stored receipts', () => {
    const one = item('reserved');
    const saved = { ...receipt(one), intent: 'create_task', taskId: 'reserved-task', taskCreated: false,
      requestIds: ['req-one', 'req-two'], status: 'failure', recovery: ['retry_create'] };
    const normalized = normalizeStore({ version: 1, letters: [{ id: 'lt-abc-1234', items: [{ ...one, receipts: [saved] }] }] }).letters[0].items![0];
    expect(normalized.unavailableReason).toBeUndefined();
    expect(normalized.receipts).toEqual([saved]);
  });
  it('merges a legacy copied letter without thread while keeping newer item facts', () => {
    const saved = item('legacy');
    const previous = { id: 'lt-legacy-1234', items: [{ ...saved, receipts: [receipt(saved, 9)] }] };
    const incoming = { id: previous.id, read: true, items: [{ ...saved, receipts: [receipt(saved, 3)] }] };
    const merged = mergeLetterItemFacts(previous as Parameters<typeof mergeLetterItemFacts>[0], incoming as Parameters<typeof mergeLetterItemFacts>[1]);
    expect(merged.read).toBe(true);
    expect(merged.items![0].receipts).toEqual([receipt(saved, 9)]);
    const plain = { id: previous.id, read: true };
    expect(mergeLetterItemFacts(previous as Parameters<typeof mergeLetterItemFacts>[0], plain as Parameters<typeof mergeLetterItemFacts>[1])).toEqual(plain);
  });
  it('does not let stale replicas replace a newer success with pending', () => {
    const one = receipt(item('one'), 9);
    expect(mergeItemReceipts([one], [{ ...one, revision: 3, status: 'pending' }])).toEqual([one]);
  });
});
