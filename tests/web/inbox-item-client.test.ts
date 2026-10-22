import { beforeEach, describe, expect, it, vi } from 'vitest';
const get = vi.hoisted(() => vi.fn());
const post = vi.hoisted(() => vi.fn());
vi.mock('../../web/src/api/client', () => ({ apiGet: get, apiPost: post }));
import { executeItem, itemError, itemRoute, prepareItem, previewItemTask, queryItem, searchItemTasks } from '../../web/src/api/human-inbox-items';
import { getLetter } from '../../web/src/api/human-inbox';
beforeEach(() => { get.mockReset(); post.mockReset(); });
describe('Inbox item HTTP contract', () => {
  it('encodes stable IDs and sends only the server plan reference on execute', async () => {
    const input = { actionId: 'create', requestId: 'request', planId: 'plan', planVersion: 1, confirmed: true };
    await executeItem('letter /', 'item /', input);
    expect(post.mock.calls[0][0]).toBe('/api/v1/human-inbox/letter%20%2F/items/item%20%2F/execute');
    expect(post.mock.calls[0][1]).toEqual(input);
    expect(post).toHaveBeenCalledTimes(1);
  });
  it('uses bounded reads for search preview and status, never mutations', async () => {
    await queryItem('letter', 'item');
    await searchItemTasks('letter', 'item', 'Exact title', 25);
    await previewItemTask('letter', 'item', 'task-full-id');
    expect(get.mock.calls[1][1]).toEqual({ query: 'Exact title', offset: '25', limit: '25' });
    expect(get.mock.calls.every(call => call[2].timeoutMs === 12_000)).toBe(true);
    expect(post).not.toHaveBeenCalled();
  });
  it('prepares human input separately from final authorization', async () => {
    await prepareItem('letter', 'item', { actionId: 'create', goal: 'Approved goal', title: 'Review', project: '' });
    expect(post.mock.calls[0][0]).toBe(`${itemRoute('letter', 'item')}/prepare`);
    expect(post.mock.calls[0][1]).not.toHaveProperty('confirmed');
  });
  it('keeps typed initial and reply items when normalizing letter detail', async () => {
    const item = { id: 'mail-a', subject: 'Update', summary: '', source: { kind: 'mail', account: 'account-a', message: 'message-a' }, actions: [] };
    get.mockResolvedValue({ letter: { id: 'letter', items: [item] }, body: 'Document', thread: [{ from: 'agent', at: 1, text: 'Reply', items: [{ ...item, id: 'mail-b' }] }] });
    const detail = await getLetter('letter');
    expect(detail.items?.[0].id).toBe('mail-a');
    expect(detail.thread[0].items?.[0].id).toBe('mail-b');
  });
  it('does not turn a deleted target into an older-server fallback', () => {
    expect(itemError({ status: 404, body: { error: { code: 'target_deleted', message: 'Target deleted' } } }).message).toBe('Target deleted');
    expect(itemError({ status: 404 }).message).toBe('Email actions need a newer server');
    expect(itemError({ status: 403, body: { error: { code: 'local_only' } } }).message).toBe('Available on Mac only');
  });
});
