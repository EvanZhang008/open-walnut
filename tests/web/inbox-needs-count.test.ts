/**
 * The bell and the Inbox rail with inbox_needs_threads on (web/src/contexts/notifications/needs-count.ts):
 * the live asks plus every thread that needs him plus every unread letter none of them holds, each
 * once. A letter's envelope that the feed carries twice, and a held decision letter, never count twice.
 */
import { describe, expect, it } from 'vitest';
import { attentionWithNeeds, feedLetters, inboxRailCount } from '../../web/src/contexts/notifications/needs-count';
import { attentionBadgeCount } from '../../web/src/contexts/notifications/notification-model';
import type { Notification } from '../../web/src/contexts/notifications/types';

let n = 0;
const note = (over: Partial<Notification>): Notification => ({ id: `n${++n}`, kind: 'info', severity: 'info', title: 't', timestamp: Date.now(), persistent: true, read: false, dedupKey: `k${n}`, ...over } as Notification);
const letter = (id: string, read = false) => note({ kind: 'letter', letterId: id, dedupKey: `letter:${id}`, read });
const ask = () => note({ kind: 'permission', resolved: false });

describe('the bell with the threads that need him', () => {
  const feed = [ask(), letter('lt-held'), letter('lt-fyi'), letter('lt-fyi'), letter('lt-read', true), note({ kind: 'cron' })];
  const needs = [{ letter: { id: 'lt-held' } }, {}];

  it('reads each letter once, with its envelope\'s read state', () => {
    expect(feedLetters(feed)).toEqual([{ id: 'lt-held', read: false }, { id: 'lt-fyi', read: false }, { id: 'lt-read', read: true }]);
    // Unread while any of its envelopes is; an envelope naming no letter stands for itself.
    const loose = note({ kind: 'letter', dedupKey: 'other' });
    expect(feedLetters([letter('lt-x', true), letter('lt-x'), loose])).toEqual([{ id: 'lt-x', read: false }, { id: `notification:${loose.id}`, read: false }]);
  });

  it('counts the asks, the threads, and the unread letters no thread holds', () => {
    // 1 ask + 2 threads + 1 unread letter (lt-fyi); lt-held is the first thread.
    expect(attentionWithNeeds(feed, needs)).toBe(4);
  });

  it('with no thread waiting, the same number as the bell without the experiment', () => {
    const plain = [ask(), letter('lt-a'), letter('lt-b', true)];
    expect(attentionWithNeeds(plain, [])).toBe(attentionBadgeCount(plain));
  });

  it('the Inbox rail prefers the letter store\'s list, else the feed', () => {
    const store = [{ id: 'lt-held', read: false }, { id: 'lt-fyi', read: true }, { id: 'lt-new', read: false }];
    expect(inboxRailCount(feed, store, needs)).toBe(3);
    expect(inboxRailCount(feed, [], needs)).toBe(3);
  });
});
