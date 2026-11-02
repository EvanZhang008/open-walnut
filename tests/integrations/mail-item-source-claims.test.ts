/**
 * The mail plugin's half of the legacy Inbox `create_task` path (`item-source.ts`), which stays on
 * the server for older phone apps: the trusted source a letter's mail item resolves to, keyed and
 * ledgered the way the plugin's own read paths find it. A mail no longer becomes a task through the
 * plugin itself (the Mail reader offers Talk to CEO / New task), so this is the one ledger writer.
 */
import { afterAll, describe, it, expect, vi } from 'vitest';
import { createMockConstants } from '../helpers/mock-constants.js';
vi.mock('../../src/constants.js', () => createMockConstants('mail-source-claims'));
import { registerMailItemSource } from '../../src/integrations/mail/item-source.js';
import { resolveInboxSource } from '../../src/core/human-inbox/item-source-registry.js';
import { claimSourceTask, sourcePairKey } from '../../src/core/source-task-claims.js';
import { taskIdForKey } from '../../src/core/task-create-idempotency.js';

const ACCOUNT = 'account-a';
const ledger = new Map<string, string>();
const messages: Record<string, Record<string, unknown>> = {
  'message-a': { account_id: ACCOUNT, message_id: 'message-a', rfc_message_id: 'shared-reference', flags_json: '["\\\\Seen"]', updated_at: 5_000 },
  // No Message-ID header, so its key is the cache form.
  'message-b': { account_id: ACCOUNT, message_id: 'message-b', rfc_message_id: '', flags_json: '[]', updated_at: 0 },
};
const store = {
  getAccount: async (id: string) => (id === ACCOUNT ? { account_id: ACCOUNT } : undefined),
  getMessage: async (account: string, id: string) => (account === ACCOUNT ? messages[id] : undefined),
  tasks: {
    getMessageTask: async (key: string) => (ledger.has(key) ? { task_id: ledger.get(key)! } : undefined),
    claimMessageTask: async (row: { key: string; taskId: string }) => {
      if (!ledger.has(row.key)) ledger.set(row.key, row.taskId);
      return ledger.get(row.key)!;
    },
  },
};
const unregister = registerMailItemSource(store as never);
afterAll(() => unregister());

const source = (message: string) => ({ kind: 'mail' as const, account: ACCOUNT, message });

describe('the legacy Inbox mail source', () => {
  it('resolves a cached message to the ledger key the read paths use, with its read flag', async () => {
    const trusted = await resolveInboxSource(source('message-a'));
    expect(trusted.key).toBe('rfc:shared-reference');
    expect(trusted.readObservation).toEqual({ read: true, observedAt: new Date(5_000).toISOString() });
    expect((await resolveInboxSource(source('message-b'))).key).toBe(`cache:${JSON.stringify([ACCOUNT, 'message-b'])}`);
  });

  it('refuses a message the cache does not hold', async () => {
    await expect(resolveInboxSource(source('message-gone'))).rejects.toThrow('Email unavailable');
  });

  it('two overlapping claims through it reserve one task id and write one ledger row', async () => {
    const { key, adapter } = await resolveInboxSource(source('message-a'));
    const pair = sourcePairKey(ACCOUNT, 'message-a');
    const [one, two] = await Promise.all([claimSourceTask({ key, pair, adapter }), claimSourceTask({ key, pair, adapter })]);
    expect(one.taskId).toBe(taskIdForKey(`mail-source:${key}`));
    expect(two.taskId).toBe(one.taskId);
    expect(ledger.get(key)).toBe(one.taskId);
  });

  it('reuses the task an older Walnut linked, never a replacement', async () => {
    const { key, adapter } = await resolveInboxSource(source('message-b'));
    ledger.set(key, 'older-walnut-task');
    const claim = await claimSourceTask({ key, pair: sourcePairKey(ACCOUNT, 'message-b'), adapter });
    expect(claim).toMatchObject({ taskId: 'older-walnut-task', legacy: true, created: true });
    expect(ledger.get(key)).toBe('older-walnut-task');
  });
});
