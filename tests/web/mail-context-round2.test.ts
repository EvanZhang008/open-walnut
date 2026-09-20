/**
 * Round 2 of the mail right-click slice: the rules behind each reported defect, graded without a browser.
 *
 * One `describe` per finding, named by its id, because each one is a rule somebody can argue with and the
 * argument is what the assertion has to hold. The DOM halves (the clamped menu's follow-scroll, the row
 * marks, the strip's geometry) are pinned in Playwright; everything here is arithmetic, wording or state.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { setMailUnreadOnly, unreadOnlyAnswer } from '../../web/src/apps/mail/mail-actions';
import {
  ANSWER_MS,
  __resetMailStore,
  clearMailPaneNote,
  getMailSnapshot,
  mailRowLabel,
  patch,
  setMailPaneNote,
  setMailRowNote,
} from '../../web/src/apps/mail/mail-store';
import {
  readUnreadOnly,
  subscribeUnreadOnly,
  unreadOnlyVersion,
  writeUnreadOnly,
} from '../../web/src/apps/mail/mail-unread-filter';
import {
  flipCountedBy,
  forgetFlipCounted,
  mailCountsClock,
  noteFlipCounted,
} from '../../web/src/apps/mail/mail-seen-clock';
import {
  contextMenuNavigable,
  contextMenuRunnable,
} from '../../web/src/components/common/ContextMenu';
import { menuHeadingLines } from '../../web/src/apps/mail/mail-context-items';
import {
  DISCARD_DRAFT_TITLE,
  draftRowHeading,
  draftRowMenuItems,
} from '../../web/src/apps/mail/mail-draft-context-items';

const WRITER = 'ctx-writer';

/** This tier has no DOM, and the preference lives in `localStorage`: one honest in-memory store. */
function installStorage(): void {
  const kept = new Map<string, string>();
  vi.stubGlobal('window', {
    localStorage: {
      getItem: (key: string) => kept.get(key) ?? null,
      setItem: (key: string, value: string) => { kept.set(key, value); },
      removeItem: (key: string) => { kept.delete(key); },
    },
  });
}

beforeEach(() => { __resetMailStore(); installStorage(); });
afterEach(() => { vi.unstubAllGlobals(); });

describe('R2-01: the chip and the folder menu read ONE preference', () => {
  it('announces every write, so a subscriber never holds a stale copy', () => {
    const seen: boolean[] = [];
    const stop = subscribeUnreadOnly(() => { seen.push(readUnreadOnly(WRITER, 'INBOX')); });
    writeUnreadOnly(WRITER, 'INBOX', true);
    writeUnreadOnly(WRITER, 'INBOX', false);
    stop();
    // The sidebar menu writes, the header chip is told, and both read the same answer.
    expect(seen).toEqual([true, false]);
    // After unsubscribing nothing else arrives, so an unmounted pane cannot be notified.
    writeUnreadOnly(WRITER, 'INBOX', true);
    expect(seen).toHaveLength(2);
    expect(readUnreadOnly(WRITER, 'INBOX')).toBe(true);
  });

  it('is per (account, mailbox), so a folder menu cannot filter the folder on screen', () => {
    writeUnreadOnly(WRITER, 'Archive', true);
    expect(readUnreadOnly(WRITER, 'Archive')).toBe(true);
    expect(readUnreadOnly(WRITER, 'INBOX')).toBe(false);
    expect(readUnreadOnly('other-account', 'Archive')).toBe(false);
  });

  it('moves its version on a write, which is what a render can be keyed on', () => {
    const before = unreadOnlyVersion();
    writeUnreadOnly(WRITER, 'INBOX', true);
    expect(unreadOnlyVersion()).toBeGreaterThan(before);
  });
});

describe('R2-02: a flip the server has counted is not subtracted twice', () => {
  it('reads as counted only for requests issued AFTER the answer landed', () => {
    const pair = JSON.stringify([WRITER, 'm1']);
    const beforeFlip = mailCountsClock();
    // A mailbox list that left before the flip was answered cannot include it: still subtract.
    expect(flipCountedBy(pair, beforeFlip)).toBe(false);
    noteFlipCounted(pair);
    // A request issued now carries a reading taken after the answer: the number already includes it.
    expect(flipCountedBy(pair, mailCountsClock())).toBe(true);
    // And the older request still in flight is judged by ITS reading, not by the newest one.
    expect(flipCountedBy(pair, beforeFlip)).toBe(false);
  });

  it('forgets a flip that was rolled back, so nothing claims the server counted it', () => {
    const pair = JSON.stringify([WRITER, 'm2']);
    noteFlipCounted(pair);
    expect(flipCountedBy(pair, mailCountsClock())).toBe(true);
    forgetFlipCounted(pair);
    expect(flipCountedBy(pair, mailCountsClock())).toBe(false);
  });

  it('keeps one flip out of another flip\'s answer', () => {
    const one = JSON.stringify([WRITER, 'm3']);
    const other = JSON.stringify([WRITER, 'm4']);
    noteFlipCounted(one);
    const between = mailCountsClock();
    noteFlipCounted(other);
    // A list requested between the two answers includes the first and not the second.
    expect(flipCountedBy(one, between)).toBe(true);
    expect(flipCountedBy(other, between)).toBe(false);
  });
});

describe('R2-14: a success retires itself, a refusal waits to be read', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('retires a plain answer on the shared clock', () => {
    setMailRowNote('Link copied.', 'a 1');
    vi.advanceTimersByTime(ANSWER_MS - 1_000);
    expect(getMailSnapshot().rowNote?.text).toBe('Link copied.');
    vi.advanceTimersByTime(2_000);
    expect(getMailSnapshot().rowNote).toBeNull();
  });

  it('never retires a refusal, however long the triage pass runs', () => {
    setMailRowNote('Walnut could not mark that message read.', 'a 1', { sticky: true });
    vi.advanceTimersByTime(ANSWER_MS * 10);
    const note = getMailSnapshot().rowNote;
    expect(note?.text).toBe('Walnut could not mark that message read.');
    // Flagged, so the pane knows to draw a dismiss for it.
    expect(note?.sticky).toBe(true);
  });

  it('uses ONE rule for the pane channel too', () => {
    setMailPaneNote('Archive now shows only unread messages.');
    vi.advanceTimersByTime(ANSWER_MS + 1_000);
    expect(getMailSnapshot().paneNote).toBeNull();
    setMailPaneNote('Walnut could not fetch that folder.', { sticky: true });
    vi.advanceTimersByTime(ANSWER_MS * 5);
    expect(getMailSnapshot().paneNote?.text).toBe('Walnut could not fetch that folder.');
    clearMailPaneNote();
    expect(getMailSnapshot().paneNote).toBeNull();
  });

  it('gives a sticky note no leftover timer that could blank the next one', () => {
    setMailRowNote('Walnut could not mark that message read.', 'a 1', { sticky: true });
    vi.advanceTimersByTime(ANSWER_MS - 100);
    setMailRowNote('Link copied.', 'a 2');
    vi.advanceTimersByTime(200);
    expect(getMailSnapshot().rowNote?.text).toBe('Link copied.');
  });
});

describe('R2-16: one preposition in the task answer', () => {
  it('names the sender in parentheses rather than with a second "from"', () => {
    const row = { subject: 'Quarterly keeper report', from: { name: 'Keeper Reports', address: 'k@example.invalid' } };
    const sentence = `Task made from ${mailRowLabel(row, 'paren')}.`;
    expect(sentence).toBe('Task made from "Quarterly keeper report" (Keeper Reports).');
    expect(sentence.match(/\bfrom\b/g)).toHaveLength(1);
    // The refusal wording keeps its own shape, where "from" is the only reading that works.
    expect(mailRowLabel(row)).toBe('"Quarterly keeper report" from Keeper Reports');
  });
});

describe('R2-08: the BOX truncates the heading, not a character count', () => {
  it('keeps a realistic sender and subject whole', () => {
    const person = 'Harbour Office';
    const subject = 'Pontoon works next week and what the crews will need on the day';
    const [first] = menuHeadingLines(person, subject, '');
    // 78 characters: the old 44 cap ellipsed both halves inside a box that had clipped nothing.
    expect(first!.label).toBe(`${person} · ${subject}`);
    expect(first!.title).toBe(`${person} · ${subject}`);
  });

  it('still refuses a pathological header, and still protects the subject', () => {
    const rambling = 'x'.repeat(400);
    const [first] = menuHeadingLines('Harbour Office', rambling, '');
    expect(String(first!.label).length).toBeLessThan(200);
    expect(first!.label.endsWith('…')).toBe(true);
    // A very long NAME cannot take the subject's room.
    const [line] = menuHeadingLines('y'.repeat(200), 'Berth swap', '');
    expect(line!.label).toContain('Berth swap');
  });

  it('keeps the account on its own line, in full for any real display name', () => {
    const account = 'mailbox.operations.harbour.office@example.invalid';
    const lines = menuHeadingLines('Harbour Office', 'Berth swap', account);
    expect(lines).toHaveLength(2);
    expect(lines[1]!.label).toBe(account);
    expect(lines[1]!.title).toBe(account);
  });
});

describe('R2-11: a disabled item is reachable, never runnable', () => {
  it('walks the highlight onto it so its reason can be read', () => {
    const disabled = { key: 'reply', label: 'Reply', disabled: true, title: 'This account cannot send', onSelect: () => {} };
    expect(contextMenuNavigable(disabled)).toBe(true);
    expect(contextMenuRunnable(disabled)).toBe(false);
  });

  it('still skips the rows that are not items at all', () => {
    expect(contextMenuNavigable({ divider: true })).toBe(false);
    expect(contextMenuNavigable({ section: true, label: 'SECTION' })).toBe(false);
    expect(contextMenuNavigable({ info: true, label: 'Harbour Office · Berth swap' })).toBe(false);
  });

  it('runs an ordinary item', () => {
    const item = { key: 'open', label: 'Open message', onSelect: () => {} };
    expect(contextMenuNavigable(item)).toBe(true);
    expect(contextMenuRunnable(item)).toBe(true);
  });
});

describe('R2-07: a row drawn as a message row answers with a Walnut menu', () => {
  const target = { draftId: 'd1', subject: 'Berth swap', recipients: 'Harbour Office', open: false };

  it('offers only what a draft can do, and names the draft', () => {
    const items = draftRowMenuItems(target, { onEdit: () => {}, onDiscard: () => {} });
    const labels = items.filter((one) => !one.divider && !one.info).map((one) => one.label);
    expect(labels).toEqual(['Continue editing', 'Discard draft']);
    expect(items[0]!.info).toBe(true);
    expect(items[0]!.label).toBe('Berth swap');
    // Discard is a delete and says so, and is marked as the destructive one.
    const discard = items.find((one) => one.key === 'discard');
    expect(discard!.title).toBe(DISCARD_DRAFT_TITLE);
    expect(discard!.danger).toBe(true);
  });

  it('drops Discard for the draft the composer is holding, rather than drawing a second path', () => {
    const items = draftRowMenuItems({ ...target, open: true }, { onEdit: () => {}, onDiscard: () => {} });
    const labels = items.filter((one) => !one.divider && !one.info).map((one) => one.label);
    expect(labels).toEqual(['Continue editing']);
    // The divider tied to the dropped item went with it: no rule hanging under the heading.
    expect(items.some((one) => one.divider)).toBe(false);
  });

  it('acts on the row it was opened on', () => {
    const edited: string[] = [];
    const binned: string[] = [];
    const items = draftRowMenuItems(target, {
      onEdit: (id) => edited.push(id),
      onDiscard: (id) => binned.push(id),
    });
    items.find((one) => one.key === 'edit')!.onSelect!();
    items.find((one) => one.key === 'discard')!.onSelect!();
    expect(edited).toEqual(['d1']);
    expect(binned).toEqual(['d1']);
  });

  it('has a heading for a draft with nothing written in it yet', () => {
    expect(draftRowHeading({ ...target, subject: '' })).toBe('Draft to Harbour Office');
    expect(draftRowHeading({ ...target, subject: '', recipients: '' })).toBe('Unsent draft');
    expect(draftRowHeading({ ...target, subject: 'Two\n  lines' })).toBe('Two lines');
  });
});

describe('R2-06: a preference written for a folder that is not on screen says so', () => {
  beforeEach(() => {
    patch({
      loaded: true,
      accounts: [{ accountId: WRITER, displayName: 'one', unread: 2 }] as never,
      mailboxes: {
        [WRITER]: [
          { accountId: WRITER, mailboxId: 'INBOX', name: 'Inbox', role: 'inbox', unread: 2, total: 9 },
          { accountId: WRITER, mailboxId: 'Archive', name: 'Archive', role: 'archive', unread: 0, total: 4 },
        ] as never,
      },
      selected: { accountId: WRITER, mailboxId: 'INBOX' },
    });
  });

  it('names the folder, in the channel the fetch answers already use', async () => {
    await setMailUnreadOnly(WRITER, 'Archive', true);
    expect(getMailSnapshot().paneNote?.text).toBe('Archive now shows only unread messages.');
    await setMailUnreadOnly(WRITER, 'Archive', false);
    expect(getMailSnapshot().paneNote?.text).toBe('Archive now shows every message.');
    // And the preference really landed, which is the half the label on reopening the menu shows.
    await setMailUnreadOnly(WRITER, 'Archive', true);
    expect(readUnreadOnly(WRITER, 'Archive')).toBe(true);
  });

  it('says nothing when the folder IS on screen: the list itself is the answer', async () => {
    // The list reload needs no server here; a failed read leaves the note question untouched.
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 500 })));
    await setMailUnreadOnly(WRITER, 'INBOX', true);
    expect(getMailSnapshot().paneNote).toBeNull();
  });

  it('falls back to the id for a folder whose row this console has not listed', () => {
    expect(unreadOnlyAnswer(WRITER, 'Newsletters', true))
      .toBe('Newsletters now shows only unread messages.');
  });
});

describe('R2-13: the refusal a person reads names no plugin id', () => {
  it('is worded on the server without an internal id or an editorial clause', () => {
    const text = readFileSync('src/integrations/mail/service.ts', 'utf8');
    const line = text.split('\n').find((one) => one.includes('cannot change read flags'));
    expect(line, 'the 409 sentence is still the one this rule is about').toBeTruthy();
    expect(line).not.toContain('spec.id');
    expect(text).not.toContain('will not pretend');
    // The account is the subject, and the provider is named by its label when it is named at all.
    expect(line).toContain('This account cannot change read flags');
  });
});
