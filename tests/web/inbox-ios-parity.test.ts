/**
 * The phone's Inbox filters follow the WEB console's inbox rules.
 *
 * The iOS Inbox tab (ios-native/Walnut/Stores/InboxFilter.swift) re-implements
 * four console rules in Swift: the unread badge (sectionCounts), the Unread
 * filter with its "read while filtered" keep set (filterInboxLetters), the Needs
 * Action letter rules (isUnseenDecision for the count, isOpenDecision for the
 * list) and the pinned-first order (compareLetters). A past parity bug came from
 * porting a rule by reading it instead of running it, so the verdicts here are
 * produced by RUNNING the web functions on one shared fixture, and the Swift
 * suite (ios-native/WalnutTests/InboxFilterParityTests.swift) replays the same
 * fixture against the same expected file.
 *
 * If a web rule changes on purpose, regenerate with
 *   UPDATE_INBOX_PARITY=1 ./node_modules/.bin/vitest run tests/web/inbox-ios-parity.test.ts
 * and then make the Swift suite pass again: that is the point of the file.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { compareLetters, isOpenDecision, type LetterEnvelope } from '../../web/src/api/human-inbox';
import { filterInboxLetters, nextDecisionGraceExpiry } from '../../web/src/components/inbox/inbox-filter';
import { sectionCounts } from '../../web/src/contexts/notifications/notification-model';

const DIR = path.resolve(import.meta.dirname, '../fixtures/inbox-parity');
const FIXTURE = path.join(DIR, 'letters.json');
const EXPECTED = path.join(DIR, 'expected.json');

interface Scenario {
  name: string;
  nowMs: number;
  keep: string[];
  /** id → fields to overwrite; `null` deletes a field; an unknown id adds a letter. */
  patch: Record<string, Record<string, unknown>>;
}

interface Verdict {
  name: string;
  unreadCount: number;
  unseenDecisionCount: number;
  order: string[];
  unreadRows: string[];
  actionNeededRows: string[];
  nextGraceExpiry: number | null;
}

/** The scenario's letter list, in the fixture's (server) order, new letters last. */
function applyPatch(base: LetterEnvelope[], patch: Scenario['patch']): LetterEnvelope[] {
  const apply = (l: Record<string, unknown>, p: Record<string, unknown>): LetterEnvelope => {
    const out: Record<string, unknown> = { ...l };
    for (const [k, v] of Object.entries(p)) {
      if (v === null) delete out[k];
      else out[k] = v;
    }
    return out as unknown as LetterEnvelope;
  };
  const known = new Set(base.map((l) => l.id));
  const patched = base.map((l) => (patch[l.id] ? apply(l as unknown as Record<string, unknown>, patch[l.id]) : l));
  for (const [id, p] of Object.entries(patch)) {
    if (!known.has(id)) patched.push(apply({}, p));
  }
  return patched;
}

/** Exactly what the notification panel computes (NotificationPanel.tsx). */
function webVerdict(s: Scenario, letters: LetterEnvelope[]): Verdict {
  const live = letters.filter((l) => !l.archived);
  const sorted = [...live].sort(compareLetters);
  const counts = sectionCounts([], letters);
  return {
    name: s.name,
    unreadCount: counts.inbox,
    unseenDecisionCount: counts.action,
    order: sorted.map((l) => l.id),
    unreadRows: filterInboxLetters(sorted, true, new Set(s.keep)).map((l) => l.id),
    actionNeededRows: sorted.filter((l) => isOpenDecision(l, s.nowMs)).map((l) => l.id),
    nextGraceExpiry: nextDecisionGraceExpiry(sorted, s.nowMs),
  };
}

const doc = JSON.parse(fs.readFileSync(FIXTURE, 'utf8')) as { letters: LetterEnvelope[]; scenarios: Scenario[] };
const verdicts = doc.scenarios.map((s) => webVerdict(s, applyPatch(doc.letters, s.patch)));

describe('iOS inbox parity fixture (the web functions are the referee)', () => {
  it('the fixture has real density: dozens of letters, long mixed-script subjects, every type', () => {
    expect(doc.letters.length).toBeGreaterThanOrEqual(40);
    expect(Math.max(...doc.letters.map((l) => l.subject.length))).toBeGreaterThan(100);
    // Mixed script, carried as \u escapes in the file (CJK Unified Ideographs).
    expect(doc.letters.filter((l) => /[一-鿿]/.test(l.subject)).length).toBeGreaterThan(20);
    expect(new Set(doc.letters.map((l) => l.type))).toEqual(new Set(['info', 'action_required', 'review', 'completion']));
  });

  it('expected.json is exactly what the web functions answer today', () => {
    if (process.env.UPDATE_INBOX_PARITY === '1') {
      fs.writeFileSync(EXPECTED, `${JSON.stringify(verdicts, null, 1)}\n`);
    }
    const expected = JSON.parse(fs.readFileSync(EXPECTED, 'utf8')) as Verdict[];
    expect(verdicts).toEqual(expected);
  });

  it('the scenarios actually exercise each rule (a fixture where every list is empty proves nothing)', () => {
    const by = new Map(verdicts.map((v) => [v.name, v]));
    const listed = by.get('as-listed')!;
    expect(listed.unreadCount).toBeGreaterThan(3);
    expect(listed.unseenDecisionCount).toBeGreaterThan(0);
    // Pinned first.
    expect(listed.order.slice(0, 2).sort()).toEqual(['lt-parity-004', 'lt-parity-022']);
    // A decision read two minutes ago is listed, not counted; one read seven minutes
    // ago is gone; one read with no stamp counts as seen long ago.
    const grace = by.get('decision-read-inside-grace')!;
    expect(grace.actionNeededRows).toContain('lt-parity-012');
    expect(grace.actionNeededRows).not.toContain('lt-parity-019');
    expect(grace.actionNeededRows).not.toContain('lt-parity-028');
    expect(grace.nextGraceExpiry).toBe(1_800_000_000_000 - 2 * 60_000 + 5 * 60_000);
    expect(by.get('grace-window-over')!.actionNeededRows).not.toContain('lt-parity-012');
    // Read while filtered: still listed under Unread, no longer counted.
    const kept = by.get('read-while-unread-filter-on')!;
    expect(kept.unreadRows).toEqual(expect.arrayContaining(['lt-parity-007', 'lt-parity-013']));
    expect(kept.unreadCount).toBe(listed.unreadCount - 2);
    // A letter arriving while a filter is on lands at the top of that filter,
    // under a pinned unread one (pinned keeps its place inside every filter).
    const arrived = by.get('new-unread-letter-arrives')!;
    expect(arrived.unreadRows.slice(0, 2)).toEqual(['lt-parity-022', 'lt-parity-900']);
    expect(arrived.unreadRows).toContain('lt-parity-007'); // kept across the refresh
    expect(arrived.actionNeededRows[0]).toBe('lt-parity-900');
    // Archived letters never count.
    expect(by.get('archived-letter-never-counts')!.unreadCount).toBe(listed.unreadCount - 1);
    expect(by.get('everything-read')!.unreadRows).toEqual([]);
  });
});
