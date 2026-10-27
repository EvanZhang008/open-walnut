/**
 * Where the chat's composer writes in Conversation Mode (web/src/utils/composer-quote.ts):
 * the main conversation unless a question was quoted into it, and only while
 * that question (or its Ask) still exists.
 */
import { describe, expect, it } from 'vitest';
import { carriedRootDraft, composerKeyOf, pendingPageOf } from '@/utils/composer-quote';
import { buildThreadTree, ROOT_THREAD_KEY, threadKeyOf, type ThreadTreeMessage } from '@/utils/thread-tree';
import type { SessionThreadAnchor } from '@/types/session';
import type { ThreadPendingPage } from '@/components/sessions/thread-ui-contract';

const user = (msgId: string): ThreadTreeMessage => ({ role: 'user', msgId, text: `q ${msgId}` });
const reply = (msgId: string): ThreadTreeMessage => ({ role: 'assistant', msgId, text: `a ${msgId}` });
const anchor: SessionThreadAnchor = { msgId: 'u2', parent: 'r1', quote: { exact: 'a r1' }, source: 'selection', at: '2026-10-01T10:00:00Z' };
const tree = buildThreadTree([user('u1'), reply('r1'), user('u2'), reply('r2')], [anchor]);
const key = threadKeyOf(anchor);
const pending: ThreadPendingPage = { pageKey: 'pending:r1:x', parentKey: ROOT_THREAD_KEY, parentMsgId: 'r1', quote: { exact: 'x' }, title: 'x' };

describe('composerKeyOf', () => {
  it('nothing quoted: the main conversation', () => {
    expect(composerKeyOf(null, tree, undefined, [])).toBe(ROOT_THREAD_KEY);
  });
  it('a quoted question that exists', () => {
    expect(composerKeyOf(key, tree, undefined, [])).toBe(key);
  });
  it('a quoted Ask, on the path or kept as a draft', () => {
    expect(composerKeyOf(pending.pageKey, tree, pending, [])).toBe(pending.pageKey);
    expect(composerKeyOf(pending.pageKey, tree, undefined, [pending])).toBe(pending.pageKey);
  });
  it('a quoted question that is gone falls back to the main conversation', () => {
    expect(composerKeyOf('gone', tree, undefined, [])).toBe(ROOT_THREAD_KEY);
    expect(composerKeyOf(pending.pageKey, tree, undefined, [])).toBe(ROOT_THREAD_KEY);
  });
});

describe('pendingPageOf', () => {
  it('finds the page on the path first, then a draft', () => {
    expect(pendingPageOf(pending.pageKey, pending, [])).toBe(pending);
    expect(pendingPageOf(pending.pageKey, undefined, [pending])).toBe(pending);
    expect(pendingPageOf('other', pending, [pending])).toBeUndefined();
  });
});

describe('carriedRootDraft', () => {
  it('the typed words join the main draft after what was there', () => {
    expect(carriedRootDraft('', 'hello')).toBe('hello');
    expect(carriedRootDraft('kept\n', 'hello')).toBe('kept\n\nhello');
    expect(carriedRootDraft('kept', '  ')).toBe('kept');
  });
});
