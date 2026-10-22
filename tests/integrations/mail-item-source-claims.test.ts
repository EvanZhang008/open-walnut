import { describe, it, expect, vi } from 'vitest';
import { createMockConstants } from '../helpers/mock-constants.js';
vi.mock('../../src/constants.js', () => createMockConstants('mail-source-claims'));
import { MailMessageTasks } from '../../src/integrations/mail/message-tasks.js';
import { addTaskIdempotently } from '../../src/core/task-create-idempotency.js';
import { addTask, deleteTask, getTask, listTasksSlim } from '../../src/core/task-manager.js';
import { claimSourceTask, sourcePairKey } from '../../src/core/source-task-claims.js';
import type { MailMessageDto } from '../../src/integrations/mail/contract.js';

const rows = new Map<string, { task_id: string }>();
const store = { tasks: { getMessageTask: async (key: string) => rows.get(key), claimMessageTask: async (row: { key: string; taskId: string }) => {
  if (!rows.has(row.key)) rows.set(row.key, { task_id: row.taskId });
  return rows.get(row.key)!.task_id;
} } };
const message = { accountId: 'account-a', messageId: 'message-a', rfcMessageId: 'shared-reference', subject: 'A saved message', snippet: 'Reference data', from: { name: 'Fixture sender', address: 'sender@example.invalid' }, sentAt: 1 } as MailMessageDto;
const tasks = {
  get: async (id: string) => { try { return await getTask(id); } catch (error) { if (error instanceof Error && /No task found matching/.test(error.message)) return null; throw error; } },
  create: async (input: { title: string; description?: string; project?: string; tags?: string[]; idempotency_key?: string }) => (await addTaskIdempotently(input, input.idempotency_key, input)).task,
  appendNote: async () => {},
};
function service() {
  return new MailMessageTasks({ store: store as never, events: { messageTasked() {} } as never, tasks,
    read: { message: async () => message, accountLabel: async () => 'Fixture account', bodyText: async () => '' }, log: { warn() {} } });
}
describe('Legacy mail entry uses canonical pre-create claim', () => {
  it('two independent entry instances create one task and retain a deleted tombstone', async () => {
    const [one, two] = await Promise.all([service().link({ accountId: 'account-a', messageId: 'message-a' }), service().link({ accountId: 'account-a', messageId: 'message-a' })]);
    expect(one.taskId).toBe(two.taskId);
    expect(await listTasksSlim({ minimal: true })).toHaveLength(1);
    const original = one.taskId;
    await deleteTask(original);
    await expect(service().link({ accountId: 'account-a', messageId: 'message-a' })).rejects.toThrow('Target deleted');
    expect(rows.get('rfc:shared-reference')!.task_id).toBe(original);
    expect(await listTasksSlim({ minimal: true })).toHaveLength(0);
  });
  it('reuses an attached task through the legacy entry without creating an orphan', async () => {
    const target = (await addTask({ title: 'An existing task' })).task;
    const attachedMessage = { ...message, rfcMessageId: 'attached-reference', messageId: 'attached-message' };
    const attachedKey = 'rfc:attached-reference';
    await claimSourceTask({ key: attachedKey, pair: sourcePairKey('account-a', attachedMessage.messageId), targetTaskId: target.id,
      confirmation: { intent: 'attach_task', goal: 'Review the release', targetTaskId: target.id },
      adapter: { legacyTaskId: async k => rows.get(k)?.task_id, writeLegacy: async (k, taskId) => { rows.set(k, { task_id: taskId }); } } });
    const create = vi.fn(tasks.create);
    const linked = new MailMessageTasks({ store: store as never, events: { messageTasked() {} } as never, tasks: { ...tasks, create },
      read: { message: async () => attachedMessage, accountLabel: async () => 'Fixture account', bodyText: async () => '' }, log: { warn() {} } });
    expect(await linked.link({ accountId: 'account-a', messageId: attachedMessage.messageId })).toEqual({ taskId: target.id, created: false });
    expect(create).not.toHaveBeenCalled();
    expect(await listTasksSlim({ minimal: true })).toHaveLength(1);
    await deleteTask(target.id);
    await expect(linked.link({ accountId: 'account-a', messageId: attachedMessage.messageId })).rejects.toThrow('Target deleted');
    expect(create).not.toHaveBeenCalled();
  });
  it('does not treat a task read exception as deletion or authorization to recreate', async () => {
    const broken = new MailMessageTasks({ store: store as never, events: { messageTasked() {} } as never, tasks: { ...tasks, get: async () => { throw new Error('Transport unavailable'); } },
      read: { message: async () => ({ ...message, messageId: 'transport-message', rfcMessageId: 'transport-reference' }), accountLabel: async () => 'Fixture account', bodyText: async () => '' }, log: { warn() {} } });
    rows.set('rfc:transport-reference', { task_id: 'saved-task-id' });
    await expect(broken.link({ accountId: 'account-a', messageId: 'transport-message' })).rejects.toThrow('Transport unavailable');
    expect(rows.get('rfc:transport-reference')!.task_id).toBe('saved-task-id');
  });
});
