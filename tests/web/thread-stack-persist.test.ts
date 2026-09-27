/**
 * Stack persistence (web/src/utils/thread-stack-persist.ts): the sessionStorage
 * record, head-id path restore (all or nothing), and the URL `t<n>` leaf.
 */
import { describe, it, expect } from 'vitest';
import {
  STACK_STORAGE_PREFIX, emptyPersistedStack, getThreadLeaves, headIdsOfPath, pathForLeaf,
  readPersistedStack, readUrlLeaf, restorePath, sanitizePersistedStack, setThreadLeaf,
  subscribeThreadLeaves, threadParamsFor, writePersistedStack,
} from '@/utils/thread-stack-persist';
import { ROOT_THREAD_KEY, buildThreadTree, threadKeyOf, type ThreadTreeMessage } from '@/utils/thread-tree';
import type { SessionThreadAnchor } from '@/types/session';

const user = (msgId: string): ThreadTreeMessage => ({ role: 'user', msgId, text: `q ${msgId}` });
const reply = (msgId: string): ThreadTreeMessage => ({ role: 'assistant', msgId, text: `a ${msgId}` });
const anchor = (msgId: string, parent: string, exact: string): SessionThreadAnchor =>
  ({ msgId, parent, source: 'selection', at: '2026-09-03T10:00:00Z', quote: { exact } });

function fixture(withB = true) {
  const messages = [user('u1'), reply('r1'), user('u2'), reply('r2'), user('u3'), reply('r3')];
  const anchors = [anchor('u2', 'r1', 'alpha passage here'), ...(withB ? [anchor('u3', 'r2', 'beta passage here')] : [])];
  const tree = buildThreadTree(messages, anchors);
  return { tree, A: threadKeyOf(anchors[0]), B: withB ? threadKeyOf(anchors[1]) : '' };
}

function memoryStore() {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => { data.set(k, v); },
  };
}

describe('the sessionStorage record', () => {
  it('round-trips under thread-stack.v1:<sessionId>', () => {
    const store = memoryStore();
    const state = { ...emptyPersistedStack(), path: ['u2', 'u3'], pages: { '': { scrollTop: 120, sentenceTop: 40 } }, lastViewedAt: { u2: 5 } };
    writePersistedStack('s1', state, store);
    expect([...store.data.keys()]).toEqual([`${STACK_STORAGE_PREFIX}s1`]);
    expect(readPersistedStack('s1', store)).toEqual(state);
    expect(readPersistedStack('s2', store)).toBeNull();
  });

  it('drops anything it did not write', () => {
    expect(sanitizePersistedStack('nope')).toBeNull();
    const s = sanitizePersistedStack({
      path: ['u2', 3, ''], pages: { a: { scrollTop: 'x' }, b: { scrollTop: 9 } }, lastViewedAt: { u2: 'x', u3: 4 },
      drafts: [{ pageKey: 'u2', parentKey: '', parentMsgId: 'r1', title: 't' }, { pageKey: 'pending:r1:1', parentKey: '', parentMsgId: 'r1', title: 't' }],
    });
    expect(s).toEqual({
      path: ['u2'], pages: { b: { scrollTop: 9 } }, lastViewedAt: { u3: 4 },
      drafts: [{ pageKey: 'pending:r1:1', parentKey: '', parentMsgId: 'r1', title: 't' }],
    });
    const store = memoryStore();
    store.setItem(`${STACK_STORAGE_PREFIX}s1`, '{not json');
    expect(readPersistedStack('s1', store)).toBeNull();
  });
});

describe('path restore', () => {
  it('maps head ids back to keys only when every one exists and chains', () => {
    const { tree, A, B } = fixture();
    expect(headIdsOfPath(tree, [ROOT_THREAD_KEY, A, B, 'pending:r3:1'])).toEqual(['u2', 'u3']);
    expect(restorePath(tree, ['u2', 'u3'])).toEqual([ROOT_THREAD_KEY, A, B]);
    expect(restorePath(tree, [])).toEqual([ROOT_THREAD_KEY]);
    // B skipped: u3 is not a child of the root.
    expect(restorePath(tree, ['u3'])).toBeNull();
    // An anchor on the path was removed: back to the root.
    const without = fixture(false);
    expect(restorePath(without.tree, ['u2', 'u3'])).toBeNull();
    expect(pathForLeaf(tree, 'u3')).toEqual([ROOT_THREAD_KEY, A, B]);
    expect(pathForLeaf(tree, 'nope')).toBeNull();
  });
});

describe('the URL leaf', () => {
  it('reads t<n> for the column holding this session', () => {
    expect(readUrlLeaf('?s1=a&s2=b&t2=u9', 'b')).toBe('u9');
    expect(readUrlLeaf('?s1=a&s2=b&t2=u9', 'a')).toBeNull();
    expect(readUrlLeaf('?s1=a', 'zzz')).toBeNull();
  });

  it('publishes leaves and builds t<n> params beside s<n>', () => {
    let calls = 0;
    const off = subscribeThreadLeaves(() => { calls++; });
    setThreadLeaf('sa', 'u2');
    setThreadLeaf('sa', 'u2');
    setThreadLeaf('sb', 'u7');
    expect(calls).toBe(2);
    expect(threadParamsFor(['sb', 'sx', 'sa'], getThreadLeaves())).toEqual([['t1', 'u7'], ['t3', 'u2']]);
    setThreadLeaf('sa', null);
    setThreadLeaf('sb', null);
    expect(getThreadLeaves().size).toBe(0);
    off();
  });
});
