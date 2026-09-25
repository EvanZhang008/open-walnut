/**
 * Needs Action for letters, and the Inbox Unread filter.
 *
 * Two rules the notification panel renders from pure functions:
 *   1. A decision letter the human has READ leaves the Needs Action badge at once
 *      and the Needs Action list after DECISION_SEEN_GRACE_MS (isUnseenDecision /
 *      isOpenDecision). Before this, a Slack ask the human read and handled in
 *      Slack sat in the rail forever: it never gets a button click here.
 *   2. The Inbox "Unread" filter keeps the letter the human just opened on the
 *      list until the filter flips (filterInboxLetters), so a row never vanishes
 *      from under the cursor.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DECISION_SEEN_GRACE_MS, decisionGraceEndsAt, isAwaitingDecision, isOpenDecision,
  isUnseenDecision, type LetterEnvelope,
} from '../../web/src/api/human-inbox';
import {
  INBOX_UNREAD_ONLY_KEY, filterInboxLetters, nextDecisionGraceExpiry, readUnreadOnlyPref,
  writeUnreadOnlyPref,
} from '../../web/src/components/inbox/inbox-filter';
import { sectionCounts } from '../../web/src/contexts/notifications/notification-model';
import { syncable } from '../../web/src/utils/ui-prefs-sync';

const NOW = 1_800_000_000_000;

function letter(over: Partial<LetterEnvelope> & { id: string }): LetterEnvelope {
  return {
    subject: `Subject ${over.id}`,
    type: 'action_required',
    bodyFormat: 'markdown',
    textPreview: 'preview',
    sender: { sessionId: 'sess-a', host: 'local' },
    createdAt: NOW - 60_000,
    read: false,
    pinned: false,
    archived: false,
    actions: [{ id: 'ok', label: 'OK' }],
    ...over,
  };
}

describe('a decision the human has read', () => {
  const unread = letter({ id: 'unread' });
  const justRead = letter({ id: 'just-read', read: true, readAt: NOW - 1_000 });
  const readLongAgo = letter({ id: 'old', read: true, readAt: NOW - DECISION_SEEN_GRACE_MS - 1 });
  const readBeforeStamp = letter({ id: 'legacy', read: true });
  const answered = letter({ id: 'answered', read: true, readAt: NOW, answered: { actionId: 'ok', label: 'OK', at: NOW } });
  const archived = letter({ id: 'archived', archived: true });
  const info = letter({ id: 'info', type: 'info' });

  it('is still awaiting a decision (nothing answered it)', () => {
    expect(isAwaitingDecision(justRead)).toBe(true);
    expect(isAwaitingDecision(readLongAgo)).toBe(true);
  });

  it('leaves the BADGE the moment it is read; unread ones stay', () => {
    expect(isUnseenDecision(unread)).toBe(true);
    expect(isUnseenDecision(justRead)).toBe(false);
    expect(isUnseenDecision(readLongAgo)).toBe(false);
    expect(isUnseenDecision(answered)).toBe(false);
    expect(isUnseenDecision(archived)).toBe(false);
    expect(isUnseenDecision(info)).toBe(false);
  });

  it('stays LISTED through the grace window, then leaves', () => {
    expect(isOpenDecision(unread, NOW)).toBe(true);
    expect(isOpenDecision(justRead, NOW)).toBe(true);
    // The last instant inside the window is open; the boundary itself is closed.
    expect(isOpenDecision(justRead, NOW - 1_000 + DECISION_SEEN_GRACE_MS - 1)).toBe(true);
    expect(isOpenDecision(justRead, NOW - 1_000 + DECISION_SEEN_GRACE_MS)).toBe(false);
    expect(isOpenDecision(readLongAgo, NOW)).toBe(false);
  });

  it('treats a letter read before readAt existed as seen long ago', () => {
    expect(isOpenDecision(readBeforeStamp, NOW)).toBe(false);
    expect(decisionGraceEndsAt(readBeforeStamp)).toBeNull();
  });

  it('never lists an answered, archived or non-decision letter', () => {
    expect(isOpenDecision(answered, NOW)).toBe(false);
    expect(isOpenDecision(archived, NOW)).toBe(false);
    expect(isOpenDecision(info, NOW)).toBe(false);
  });

  it('comes back when marked unread (read flips, readAt is irrelevant)', () => {
    const back = { ...readLongAgo, read: false };
    expect(isUnseenDecision(back)).toBe(true);
    expect(isOpenDecision(back, NOW)).toBe(true);
  });

  it('names the deadline only for a read, unanswered decision', () => {
    expect(decisionGraceEndsAt(justRead)).toBe(NOW - 1_000 + DECISION_SEEN_GRACE_MS);
    expect(decisionGraceEndsAt(unread)).toBeNull();
    expect(decisionGraceEndsAt(answered)).toBeNull();
    expect(decisionGraceEndsAt(archived)).toBeNull();
  });

  it('is five minutes (the number the user asked for)', () => {
    expect(DECISION_SEEN_GRACE_MS).toBe(5 * 60 * 1000);
  });

  it('the rail count and isUnseenDecision agree on EVERY combination', () => {
    // sectionCounts cannot import api/human-inbox (it must stay free of the API
    // client), so it inlines the rule; this matrix is what keeps the two copies
    // one rule. Every axis that appears in either implementation is enumerated.
    const answeredAt = { actionId: 'ok', label: 'OK', at: NOW };
    let combos = 0;
    for (const type of ['action_required', 'info', 'review', 'completion'] as const) {
      for (const read of [false, true]) {
        for (const answered of [undefined, answeredAt]) {
          for (const archived of [false, true]) {
            for (const readAt of [undefined, NOW - 1, NOW - DECISION_SEEN_GRACE_MS - 1]) {
              const l = letter({
                id: `m-${combos++}`, type, read, archived,
                ...(answered ? { answered } : {}),
                ...(readAt !== undefined ? { readAt } : {}),
              });
              expect(sectionCounts([], [l]).action, JSON.stringify(l)).toBe(isUnseenDecision(l) ? 1 : 0);
            }
          }
        }
      }
    }
    expect(combos).toBe(4 * 2 * 2 * 2 * 3);
  });

  it('drops off the Needs Action rail count with the same rule', () => {
    const counts = sectionCounts([], [unread, justRead, readLongAgo, answered, archived, info]);
    expect(counts.action).toBe(1);
    // …while the Inbox count is plain unread, as before (archived excluded).
    expect(counts.inbox).toBe(2);
    expect(counts.inboxTotal).toBe(6 - 1);
  });
});

describe('the one timer behind the grace window', () => {
  it('picks the EARLIEST deadline still ahead', () => {
    const a = letter({ id: 'a', read: true, readAt: NOW - 60_000 });
    const b = letter({ id: 'b', read: true, readAt: NOW - 10_000 });
    expect(nextDecisionGraceExpiry([b, a], NOW)).toBe(NOW - 60_000 + DECISION_SEEN_GRACE_MS);
  });

  it('skips deadlines already passed and letters with none', () => {
    const past = letter({ id: 'past', read: true, readAt: NOW - DECISION_SEEN_GRACE_MS - 5 });
    const unread = letter({ id: 'unread' });
    expect(nextDecisionGraceExpiry([past, unread], NOW)).toBeNull();
    expect(nextDecisionGraceExpiry([], NOW)).toBeNull();
  });

  it('a deadline exactly now is not ahead (the row is already closed)', () => {
    const edge = letter({ id: 'edge', read: true, readAt: NOW - DECISION_SEEN_GRACE_MS });
    expect(nextDecisionGraceExpiry([edge], NOW)).toBeNull();
  });
});

describe('the Inbox Unread filter', () => {
  const read = letter({ id: 'read', type: 'info', read: true });
  const unread = letter({ id: 'unread', type: 'info' });
  const opened = letter({ id: 'opened', type: 'info', read: true });

  it('off = the list untouched (a copy, never the caller array)', () => {
    const list = [read, unread];
    const out = filterInboxLetters(list, false, new Set());
    expect(out).toEqual(list);
    expect(out).not.toBe(list);
  });

  it('on = unread only', () => {
    expect(filterInboxLetters([read, unread], true, new Set()).map(l => l.id)).toEqual(['unread']);
  });

  it('keeps the letter read WHILE the filter was on, so the row does not vanish under the cursor', () => {
    const out = filterInboxLetters([read, opened, unread], true, new Set(['opened']));
    expect(out.map(l => l.id)).toEqual(['opened', 'unread']);
  });

  it('a kept id that is unread again is simply unread (no double listing)', () => {
    const out = filterInboxLetters([{ ...opened, read: false }], true, new Set(['opened']));
    expect(out).toHaveLength(1);
  });
});

describe('the Unread filter preference', () => {
  const store = new Map<string, string>();
  beforeEach(() => {
    store.clear();
    (globalThis as unknown as { localStorage: unknown }).localStorage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => { store.set(k, v); },
      removeItem: (k: string) => { store.delete(k); },
    };
  });
  afterEach(() => {
    delete (globalThis as { localStorage?: unknown }).localStorage;
  });

  it('defaults off, round-trips on, and clears the key when turned off', () => {
    expect(readUnreadOnlyPref()).toBe(false);
    writeUnreadOnlyPref(true);
    expect(store.get(INBOX_UNREAD_ONLY_KEY)).toBe('1');
    expect(readUnreadOnlyPref()).toBe(true);
    writeUnreadOnlyPref(false);
    expect(store.has(INBOX_UNREAD_ONLY_KEY)).toBe(false);
    expect(readUnreadOnlyPref()).toBe(false);
  });

  it('is not a synced ui-pref key (one browser must not narrow every other device)', () => {
    // Asked of the sync module itself, so a widened allowlist fails this test
    // instead of silently starting to mirror the filter.
    expect(syncable(INBOX_UNREAD_ONLY_KEY)).toBe(false);
  });

  it('survives a browser with no storage at all', () => {
    delete (globalThis as { localStorage?: unknown }).localStorage;
    expect(readUnreadOnlyPref()).toBe(false);
    expect(() => writeUnreadOnlyPref(true)).not.toThrow();
  });
});
