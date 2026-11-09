/**
 * Who a letter is from, when the caller's session record cannot be read.
 *
 * A caller that names its session id keeps that id whatever happens to the lookup
 * (unknown record, a lookup that throws, one that times out), and gets NO host: the
 * old `external`/`local` stamp read as a letter from the primary, so a remote
 * session's source links opened this Mac's files. Only a request with no caller id
 * at all is `external` on `local`. The stored form keeps a missing host missing.
 *
 * WALNUT_HOME is redirected to an isolated tmpdir via createMockConstants.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createMockConstants } from '../helpers/mock-constants.js';

vi.mock('../../src/constants.js', () => createMockConstants());

const tracker = vi.hoisted(() => ({ impl: (_sid: string): Promise<unknown> => Promise.resolve(undefined) }));
vi.mock('../../src/core/session-tracker.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/core/session-tracker.js')>()),
  getSessionByClaudeId: vi.fn((sid: string) => tracker.impl(sid)),
}));
vi.mock('../../src/core/task-manager.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/core/task-manager.js')>()),
  listTasksByIds: vi.fn(async (ids: string[]) => ids.map((id) => ({ id, title: 'Marina page' }))),
}));

import { resolveLetterSender } from '../../src/core/human-inbox/letter-ops.js';
import { normalizeSender, normalizeStore } from '../../src/core/human-inbox/normalize.js';

describe('resolveLetterSender', () => {
  beforeEach(() => { tracker.impl = () => Promise.resolve(undefined); });
  afterEach(() => { vi.useRealTimers(); });

  it('a request with no caller id is external on local', async () => {
    expect(await resolveLetterSender(undefined)).toEqual({ sessionId: 'external', host: 'local', via: 'api' });
    expect(await resolveLetterSender('   ')).toEqual({ sessionId: 'external', host: 'local', via: 'api' });
  });

  it('an unknown caller id keeps the id and names no host', async () => {
    const sender = await resolveLetterSender('  sess-unknown-1  ');
    expect(sender).toEqual({ sessionId: 'sess-unknown-1' });
    expect('host' in sender).toBe(false);
  });

  it('a lookup that throws keeps the id and names no host', async () => {
    tracker.impl = () => Promise.reject(new Error('tracker unavailable (injected)'));
    const sender = await resolveLetterSender('sess-throw-1');
    expect(sender).toEqual({ sessionId: 'sess-throw-1' });
    expect('host' in sender).toBe(false);
  });

  it('a lookup that never answers times out to the id with no host', async () => {
    vi.useFakeTimers();
    tracker.impl = () => new Promise(() => {});
    const pending = resolveLetterSender('sess-slow-1');
    await vi.advanceTimersByTimeAsync(3_000);
    const sender = await pending;
    expect(sender).toEqual({ sessionId: 'sess-slow-1' });
    expect('host' in sender).toBe(false);
  });

  it('a session on a remote host is stamped with that host', async () => {
    tracker.impl = async () => ({
      claudeSessionId: 'sess-remote-1', host: 'devbox', title: 'Layout work', taskId: 'task-7', project: 'Acme',
    });
    expect(await resolveLetterSender('sess-remote-1')).toEqual({
      sessionId: 'sess-remote-1', host: 'devbox', sessionTitle: 'Layout work',
      taskId: 'task-7', taskTitle: 'Marina page', project: 'Acme',
    });
  });

  it('a session on this machine reads local', async () => {
    tracker.impl = async () => ({ claudeSessionId: 'sess-local-1', host: '__local__' });
    expect(await resolveLetterSender('sess-local-1')).toEqual({ sessionId: 'sess-local-1', host: 'local' });
  });
});

describe('normalizeSender', () => {
  it('keeps a missing host missing for a real session id, through a stored round trip', () => {
    const stored = JSON.parse(JSON.stringify(normalizeSender({ sessionId: 'sess-unknown-1' })));
    expect(stored).toEqual({ sessionId: 'sess-unknown-1' });
    expect(normalizeSender(stored)).toEqual({ sessionId: 'sess-unknown-1' });
    expect('host' in normalizeSender(stored)).toBe(false);
  });

  it('never invents a local host for an older external sender or a missing sender', () => {
    for (const input of [{ sessionId: 'external' }, undefined]) {
      const sender = normalizeSender(input);
      expect(sender).toEqual({ sessionId: 'external' });
      expect(normalizeSender(JSON.parse(JSON.stringify(sender)))).toEqual(sender);
    }
    expect(normalizeSender({ sessionId: 'external', host: 'local' })).toEqual({ sessionId: 'external', host: 'local' });
  });

  it('an older sender-less letter stays source-less through a stored rewrite', () => {
    const store = normalizeStore({ version: 1, letters: [{ id: 'lt-mh0abc12-aaaa1111', subject: 'Old', type: 'review' }] });
    expect(store.letters[0].sender).toEqual({ sessionId: 'external' });
    expect(normalizeStore(JSON.parse(JSON.stringify(store))).letters[0].sender).toEqual({ sessionId: 'external' });
  });

  it('keeps a host that was written', () => {
    expect(normalizeSender({ sessionId: 'sess-remote-1', host: 'devbox', taskId: 'task-7' }))
      .toEqual({ sessionId: 'sess-remote-1', host: 'devbox', taskId: 'task-7' });
  });
});

describe('a thread turn writer through the stored form', () => {
  const store = (thread: unknown[]) => normalizeStore({
    version: 1,
    letters: [{ id: 'lt-mh0abc12-aaaa1111', subject: 's', type: 'review', sender: { sessionId: 'sess-a', host: 'devbox' }, thread }],
  });

  it('an agent turn written before the field existed stays unknown, never the letter sender or local', () => {
    const [turn] = store([{ from: 'agent', text: 'old', at: 1 }]).letters[0].thread;
    expect(turn).toBeDefined();
    expect('sender' in turn).toBe(false);
  });

  it('a recorded writer survives, a missing host stays missing, a human turn carries none', () => {
    const [remote, unknown, external, human] = store([
      { from: 'agent', text: 'a', at: 1, sender: { sessionId: 'sess-b', host: 'workbench' } },
      { from: 'agent', text: 'b', at: 2, sender: { sessionId: 'sess-c' } },
      { from: 'agent', text: 'c', at: 3, sender: { sessionId: 'external', host: 'local' } },
      { from: 'human', text: 'd', at: 4, sender: { sessionId: 'sess-d', host: 'devbox' } },
    ]).letters[0].thread;
    expect(remote.sender).toEqual({ sessionId: 'sess-b', host: 'workbench' });
    expect(unknown.sender).toEqual({ sessionId: 'sess-c' });
    expect(external.sender).toEqual({ sessionId: 'external', host: 'local' });
    expect('sender' in human).toBe(false);
  });

  it('a sender object with no session id is not a recorded writer', () => {
    const [turn] = store([{ from: 'agent', text: 'x', at: 1, sender: { host: 'local' } }]).letters[0].thread;
    expect('sender' in turn).toBe(false);
  });
});
