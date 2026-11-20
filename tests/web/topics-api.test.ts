/**
 * The topics API client (web/src/api/topics.ts) against the contract's routes, with fetch mocked:
 * each call's method, path and body, the envelopes it unwraps, a server with the experiment off
 * (404 topics_off) reading as no topics, and a send carrying a clientId so a retry is answered once.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

interface Call { url: string; method: string; body: unknown }
const originalFetch = globalThis.fetch;
let calls: Call[] = [];

function stub(status: number, body: unknown) {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({
      url: typeof input === 'string' ? input : String(input),
      method: init?.method ?? 'GET',
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    return {
      ok: status >= 200 && status < 300,
      status,
      statusText: status === 404 ? 'Not Found' : 'OK',
      headers: { get: () => null },
      json: async () => body,
      text: async () => JSON.stringify(body),
    } as unknown as Response;
  }) as typeof fetch;
}

beforeEach(() => {
  calls = [];
  (globalThis as { localStorage?: unknown }).localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
});
afterEach(() => { globalThis.fetch = originalFetch; });

const path = (c: Call) => new URL(c.url, 'http://x').pathname + new URL(c.url, 'http://x').search;

describe('topics api client', () => {
  it('lists topics, and a server with the experiment off reads as none', async () => {
    const api = await import('../../web/src/api/topics');
    stub(200, { topics: [{ id: 'tp-1', title: 'A', members: [], updatedAt: 'x' }] });
    expect((await api.listTopics()).map((t) => t.id)).toEqual(['tp-1']);
    expect(path(calls[0]!)).toBe('/api/topics');
    stub(404, { error: 'topics_off' });
    await expect(api.listTopics()).resolves.toEqual([]);
  });

  it('reads one topic, with since when given', async () => {
    const api = await import('../../web/src/api/topics');
    stub(200, { topic: { id: 'tp-1' } });
    expect((await api.readTopic('tp-1')).id).toBe('tp-1');
    await api.readTopic('tp-1', 'tpm-9');
    expect(path(calls[0]!)).toBe('/api/topics/tp-1');
    expect(path(calls[1]!)).toBe('/api/topics/tp-1?since=tpm-9');
  });

  it('creates a topic with members, host index, first text and a clientId', async () => {
    const api = await import('../../web/src/api/topics');
    stub(200, { topic: { id: 'tp-2' } });
    const t = await api.createTopic({ title: 'Launch', members: [{ kind: 'task', taskId: 'a' }, { kind: 'org', node: 'main' }], host: 1, text: '  hello  ' });
    expect(t.id).toBe('tp-2');
    expect(calls[0]!.method).toBe('POST');
    expect(path(calls[0]!)).toBe('/api/topics');
    expect(calls[0]!.body).toMatchObject({ title: 'Launch', host: 1, text: 'hello', members: [{ kind: 'task', taskId: 'a' }, { kind: 'org', node: 'main' }] });
    expect(typeof (calls[0]!.body as { clientId?: string }).clientId).toBe('string');
    // No first message: no text field at all.
    await api.createTopic({ title: 'B', members: [{ kind: 'task', taskId: 'a' }], text: '   ' });
    expect(calls[1]!.body).not.toHaveProperty('text');
    expect(calls[1]!.body).not.toHaveProperty('host');
  });

  it('posts a message with mentions and the given clientId', async () => {
    const api = await import('../../web/src/api/topics');
    stub(200, { message: { id: 'tpm-1' }, delivery: { wake: ['mb-a'], fold: [], mail: [], refused: [] } });
    const res = await api.postTopicMessage('tp-1', '@A hi', { mentions: ['mb-a'], clientId: 'c1' });
    expect(res.message.id).toBe('tpm-1');
    expect(path(calls[0]!)).toBe('/api/topics/tp-1/messages');
    expect(calls[0]!.body).toEqual({ text: '@A hi', mentions: ['mb-a'], clientId: 'c1' });
  });

  it('adds, removes and confirms members, and closes', async () => {
    const api = await import('../../web/src/api/topics');
    stub(200, { topic: { id: 'tp-1' } });
    await api.editTopicMembers('tp-1', { add: [{ kind: 'person', name: 'Ann', email: 'ann@example.com', bot: true }] });
    await api.editTopicMembers('tp-1', { remove: ['mb-x'] });
    await api.confirmTopicMember('tp-1', 'mb-x');
    await api.closeTopic('tp-1');
    expect(calls.map((c) => `${c.method} ${path(c)}`)).toEqual([
      'POST /api/topics/tp-1/members',
      'POST /api/topics/tp-1/members',
      'POST /api/topics/tp-1/members/mb-x/confirm',
      'POST /api/topics/tp-1/close',
    ]);
    expect(calls[0]!.body).toEqual({ add: [{ kind: 'person', name: 'Ann', email: 'ann@example.com', bot: true }] });
    expect(calls[1]!.body).toEqual({ remove: ['mb-x'] });
  });

  it('lists the mail accounts and sets or clears the topic\'s mailbox', async () => {
    const api = await import('../../web/src/api/topics');
    stub(200, { accounts: [{ accountId: 'a1', address: 'robin@example.com', canSend: true }], available: true });
    expect(await api.listTopicMailAccounts()).toEqual({ accounts: [{ accountId: 'a1', address: 'robin@example.com', canSend: true }], available: true });
    stub(200, { topic: { id: 'tp-1', mail: { accountId: 'a1', everyMinutes: 15 } } });
    expect((await api.setTopicMail('tp-1', 'a1')).mail).toEqual({ accountId: 'a1', everyMinutes: 15 });
    await api.setTopicMail('tp-1', null, 30);
    expect(calls.map((c) => `${c.method} ${path(c)}`)).toEqual([
      'GET /api/topics/mail-accounts',
      'POST /api/topics/tp-1/mail',
      'POST /api/topics/tp-1/mail',
    ]);
    expect(calls[1]!.body).toEqual({ accountId: 'a1' });
    expect(calls[2]!.body).toEqual({ accountId: null, everyMinutes: 30 });
  });

  it('a refused write throws, so the view keeps what the person typed', async () => {
    const api = await import('../../web/src/api/topics');
    stub(409, { error: 'closed' });
    await expect(api.postTopicMessage('tp-1', 'hi')).rejects.toBeTruthy();
  });
});
