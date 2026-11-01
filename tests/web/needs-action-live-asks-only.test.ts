/**
 * Needs Action holds only what a session is asking LIVE; a letter never shows or
 * counts there.
 *
 * 2026-11-01, the user: "Needs Action and Inbox are two completely separate
 * things. Needs Action is like ask question ... Inbox is Inbox." Decision letters
 * (action_required) had been counted into the Needs Action badge and listed above
 * the permission cards, with a five-minute grace after reading. They now live in
 * the Inbox alone, buttons included.
 *
 * Three guards, so the next way a letter could reach Needs Action fails here:
 *   1. Every notification kind, read from the NotificationKind union itself: only
 *      the live-ask kinds land in the 'action' section. A NEW kind fails until it
 *      is placed in one of the two lists below.
 *   2. sectionCounts over every letter shape and state: the action count is the
 *      pending asks of the feed and nothing else.
 *   3. The source of every web file that counts or renders Needs Action: no
 *      letter predicate, letter row or letter list in it.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  answerableCount, attentionBadgeCount, sectionCounts, sectionOf, type LetterCountable,
} from '../../web/src/contexts/notifications/notification-model';
import type { Notification, NotificationKind } from '../../web/src/contexts/notifications/types';

const ROOT = path.resolve(import.meta.dirname, '../..');
const read = (rel: string): string => fs.readFileSync(path.join(ROOT, rel), 'utf8');

/** The kinds that ARE a session asking right now. */
const LIVE_ASK_KINDS: readonly NotificationKind[] = ['permission'];
/** Every other kind, each decided NOT to be a live ask. `letter` is Inbox mail. */
const NOT_A_LIVE_ASK: readonly NotificationKind[] = [
  'letter', 'cron', 'operation-error', 'sort', 'audio-error', 'skill', 'hook', 'reminder', 'hint',
];

/** The members of `export type NotificationKind = ...`, read from the source. */
function notificationKindsFromSource(): string[] {
  const src = read('web/src/contexts/notifications/types.ts').replace(/\/\*[\s\S]*?\*\//g, '');
  const start = src.indexOf('export type NotificationKind =');
  expect(start, 'NotificationKind union not found').toBeGreaterThanOrEqual(0);
  const body = src.slice(start, src.indexOf(';', start));
  return [...body.matchAll(/'([a-z-]+)'/g)].map(m => m[1]!);
}

function n(over: Partial<Notification> & { kind: NotificationKind }): Notification {
  return {
    id: `n-${over.kind}-${over.dedupKey ?? ''}`,
    severity: 'info',
    title: over.kind,
    timestamp: 1_800_000_000_000,
    persistent: true,
    read: false,
    dedupKey: `${over.kind}:x`,
    ...over,
  } as Notification;
}

describe('which notification kinds are Needs Action', () => {
  it('every kind of the union is decided: a live ask, or not', () => {
    const kinds = notificationKindsFromSource();
    expect(kinds).toContain('letter');
    expect([...kinds].sort(), 'a new NotificationKind: add it to LIVE_ASK_KINDS only if it is a session asking live')
      .toEqual([...LIVE_ASK_KINDS, ...NOT_A_LIVE_ASK].sort());
  });

  it('only a live ask lands in the action section, read or not', () => {
    for (const kind of notificationKindsFromSource() as NotificationKind[]) {
      for (const isRead of [false, true]) {
        const section = sectionOf(n({ kind, read: isRead }));
        expect(section === 'action', `${kind} read=${isRead}`).toBe(LIVE_ASK_KINDS.includes(kind));
      }
    }
  });

  it('a letter envelope is Inbox, whatever its letter is', () => {
    expect(sectionOf(n({ kind: 'letter', dedupKey: 'letter:lt-1', letterId: 'lt-1' }))).toBe('inbox');
  });
});

describe('the Needs Action count is the pending asks, never a letter', () => {
  const TYPES = ['action_required', 'review', 'completion', 'info'] as const;

  function everyLetter(): LetterCountable[] {
    const out: LetterCountable[] = [];
    for (const type of TYPES) {
      for (const isRead of [false, true]) {
        for (const answered of [undefined, { actionId: 'ok' }]) {
          for (const archived of [false, true]) {
            for (const pinned of [false, true]) {
              out.push({ type, read: isRead, archived, pinned, ...(answered ? { answered } : {}) });
            }
          }
        }
      }
    }
    return out;
  }

  const letterFeed = TYPES.flatMap((type, i) => [false, true].map(isRead =>
    n({ kind: 'letter', dedupKey: `letter:lt-${type}-${isRead}`, letterId: `lt-${i}`, read: isRead })));

  it('letters alone: 0, from the feed envelopes and from the letter store', () => {
    expect(everyLetter()).toHaveLength(4 * 2 * 2 * 2 * 2);
    expect(sectionCounts(letterFeed).action).toBe(0);
    expect(sectionCounts(letterFeed, everyLetter()).action).toBe(0);
    expect(sectionCounts([], everyLetter()).action).toBe(0);
    expect(answerableCount(letterFeed)).toBe(0);
  });

  it('with live asks: exactly the pending asks, the same with or without letters', () => {
    const asks = [
      n({ kind: 'permission', dedupKey: 'perm:a', toolName: 'Bash' }),
      n({ kind: 'permission', dedupKey: 'perm:q', toolName: 'AskUserQuestion', read: true }),
      n({ kind: 'permission', dedupKey: 'perm:done', resolved: 'allowed' }),
    ];
    const feed = [...asks, ...letterFeed];
    expect(sectionCounts(feed).action).toBe(2);
    expect(sectionCounts(feed, everyLetter()).action).toBe(2);
    expect(answerableCount(feed)).toBe(2);
  });

  it('the bell counts a letter once, as unread Inbox mail', () => {
    // 4 unread letter envelopes (one per type) + 1 pending ask.
    expect(attentionBadgeCount([n({ kind: 'permission', dedupKey: 'perm:a' }), ...letterFeed])).toBe(5);
  });
});

describe('no web file that counts or renders Needs Action reaches for letters', () => {
  /** Code with comments removed: a comment that names the rule is not a breach of it. */
  function code(src: string): string {
    return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
  }

  /** What makes a file part of the Needs Action surface. */
  const NEEDS_ACTION = /Needs Action|counts\.action|\.action\b\s*[+-]?=(?!=)|\.action\+\+|answerableCount|landingSectionFor|section\s*===\s*['"]action['"]|case\s+['"]action['"]/;
  /** What a letter in Needs Action would need. */
  const LETTER = /isOpenDecision|isUnseenDecision|isAwaitingDecision|decisionGraceEndsAt|DECISION_SEEN_GRACE_MS|LetterEnvelopeRow|liveLetters\.filter|action_required|decisionLetterCount|attentionLetterCount/;

  function webFiles(dir: string): string[] {
    const out: string[] = [];
    for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
      const rel = path.join(dir, entry.name);
      if (entry.isDirectory()) out.push(...webFiles(rel));
      else if (/\.(ts|tsx)$/.test(entry.name)) out.push(rel);
    }
    return out;
  }

  it('finds the surface it guards', () => {
    const surface = webFiles('web/src').filter(f => NEEDS_ACTION.test(code(read(f))));
    expect(surface).toContain(path.join('web/src/components/common/NotificationPanel.tsx'));
    expect(surface).toContain(path.join('web/src/contexts/notifications/notification-model.ts'));
  });

  it('none of those files uses a letter predicate, letter row or letter list', () => {
    const offenders = webFiles('web/src')
      .map(f => ({ f, src: code(read(f)) }))
      .filter(({ src }) => NEEDS_ACTION.test(src) && LETTER.test(src))
      .map(({ f, src }) => `${f}: ${src.match(LETTER)![0]}`);
    expect(offenders).toEqual([]);
  });

  it('sectionCounts adds to the action count in one place, the feed loop', () => {
    const src = code(read('web/src/contexts/notifications/notification-model.ts'));
    const fn = src.slice(src.indexOf('export function sectionCounts'), src.indexOf('export function attentionBadgeCount'));
    expect(fn.match(/counts\.action\s*(\+\+|\+=|-=)/g)).toHaveLength(1);
    expect(fn).not.toMatch(/counts\.action\s*=(?!=)/);
    expect(fn).toMatch(/if \(section === 'action'\) counts\.action\+\+/);
  });

  it('the panel badges Needs Action with counts.action and lists only feed asks there; letters render only in the Inbox', () => {
    const src = code(read('web/src/components/common/NotificationPanel.tsx'));
    // The rail badge is the pure count, nothing added to it.
    expect(src).toMatch(/label="Needs Action" count=\{counts\.action\}\s/);
    // Every letter list (InboxPane, the reader's rows) sits behind the Inbox branch.
    const panes = [...src.matchAll(/<InboxPane\b/g)];
    expect(panes.length).toBeGreaterThan(0);
    for (const m of panes) {
      expect(src.slice(Math.max(0, m.index! - 80), m.index), 'InboxPane outside the Inbox branch')
        .toMatch(/section === 'inbox' \? \(\s*$/);
    }
    // The action section's items come from the feed alone: no letter source names it.
    for (const line of src.split('\n').filter(l => /section === 'action'/.test(l))) {
      expect(line, line).not.toMatch(/letter|Letter|inbox\./);
    }
  });
});
