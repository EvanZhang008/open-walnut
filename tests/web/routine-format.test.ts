/**
 * The Routines card's one-line texts for a walnut-trigger check: what the daemon
 * reported, how long ago, and the command it runs. Pure functions, so the
 * awkward inputs (a missing timestamp, a delivery still retrying) are pinned
 * here rather than discovered on a card.
 */
import { describe, it, expect } from 'vitest';
import {
  auditClock, auditHistory, auditTarget, describeAgo, describeAuditEntry, describeCheck, describeFireTally,
  describeLastCheck, describeSchedule,
} from '../../web/src/utils/routine-format';

const NOW = Date.parse('2026-09-16T12:00:00Z');

describe('describeAgo', () => {
  it('rounds to the unit a human would say', () => {
    expect(describeAgo(NOW - 10_000, NOW)).toBe('just now');
    expect(describeAgo(NOW - 3 * 60_000, NOW)).toBe('3m ago');
    expect(describeAgo(NOW - 2 * 3_600_000, NOW)).toBe('2h ago');
    expect(describeAgo(NOW - 3 * 86_400_000, NOW)).toBe('3d ago');
  });

  it('never prints NaN for a missing or invalid timestamp', () => {
    expect(describeAgo(Number.NaN, NOW)).toBe('at an unknown time');
    expect(describeAgo(undefined as unknown as number, NOW)).toBe('at an unknown time');
  });
});

describe('describeLastCheck', () => {
  it('names each outcome with its count, reason, or error', () => {
    expect(describeLastCheck(undefined, NOW)).toBe('not checked yet');
    expect(describeLastCheck({ atMs: NOW - 180_000, outcome: 'fired', items: 2 }, NOW)).toBe('fired, 2 items, 3m ago');
    expect(describeLastCheck({ atMs: NOW - 180_000, outcome: 'fired', items: 1 }, NOW)).toBe('fired, 1 item, 3m ago');
    expect(describeLastCheck({ atMs: NOW - 180_000, outcome: 'fired' }, NOW)).toBe('fired, 3m ago');
    expect(describeLastCheck({ atMs: NOW - 180_000, outcome: 'quiet', reason: 'all-seen' }, NOW)).toBe('quiet, 3m ago');
    expect(describeLastCheck({ atMs: NOW - 180_000, outcome: 'quiet', reason: 'rate-limited' }, NOW)).toBe('quiet (daily fire limit), 3m ago');
    expect(describeLastCheck({ atMs: NOW - 180_000, outcome: 'error', error: 'exit 1: boom' }, NOW)).toBe('error: exit 1: boom, 3m ago');
  });

  it('says when a fire is still waiting on a retried delivery', () => {
    expect(describeLastCheck({ atMs: NOW - 60_000, outcome: 'fired', items: 3, retryPending: true, error: 'host unreachable' }, NOW))
      .toBe('fired, 3 items, delivery retrying, 1m ago');
  });

  it('clips a long error and flattens its whitespace', () => {
    const text = describeLastCheck({ atMs: NOW, outcome: 'error', error: `exit 2:\n  ${'x'.repeat(200)}` }, NOW);
    expect(text.startsWith('error: exit 2: xxx')).toBe(true);
    expect(text).toContain('…, just now');
    expect(text.length).toBeLessThan(120);
  });
});

describe('describeCheck', () => {
  it('shows the command and the host, "local" for the wire value', () => {
    expect(describeCheck({ run: 'gh pr view 1', host: '__local__' })).toBe('$ gh pr view 1 @ local');
    expect(describeCheck({ run: 'gh   pr\nview 1', host: 'devbox' })).toBe('$ gh pr view 1 @ devbox');
    expect(describeCheck({ run: 'x'.repeat(80), host: '__local__' })).toBe(`$ ${'x'.repeat(60)}… @ local`);
  });
});

describe('describeSchedule for an interval', () => {
  it('says seconds under a minute instead of rounding up to "1 min"', () => {
    expect(describeSchedule({ kind: 'every', everyMs: 30_000 })).toBe('Every 30s');
    expect(describeSchedule({ kind: 'every', everyMs: 10_000 })).toBe('Every 10s');
    expect(describeSchedule({ kind: 'every', everyMs: 300_000 })).toBe('Every 5 min');
    expect(describeSchedule({ kind: 'every', everyMs: 3_600_000 })).toBe('Every 1 hour');
  });
});

describe('the trigger audit trail as sentences', () => {
  it('names each verdict, and never calls a retrying delivery "delivered"', () => {
    expect(describeAuditEntry({ atMs: NOW, outcome: 'quiet', reason: 'all-seen' }))
      .toBe('quiet — nothing new (all items already seen)');
    expect(describeAuditEntry({ atMs: NOW, outcome: 'quiet', reason: 'fire-false' }))
      .toBe('quiet — the script said no');
    expect(describeAuditEntry({ atMs: NOW, outcome: 'quiet', reason: 'rate-limited' }))
      .toBe('quiet — daily fire limit reached');
    expect(describeAuditEntry({ atMs: NOW, outcome: 'error', error: 'exit 3:\n  boom' }))
      .toBe('check error: exit 3: boom');
    expect(describeAuditEntry({
      atMs: NOW, outcome: 'fired', items: 2,
      delivery: { status: 'ok', summary: 'resumed session "PR watch"' },
    })).toBe('fired, 2 new items → resumed session "PR watch"');
    expect(describeAuditEntry({
      atMs: NOW, outcome: 'fired', items: 1, attempts: 2,
      delivery: { status: 'retrying', error: 'host unreachable' },
    })).toBe('fired, 1 new item → delivery retrying after 2 tries');
    expect(describeAuditEntry({
      atMs: NOW, outcome: 'fired', items: 0,
      delivery: { status: 'error', error: 'target task is complete' },
    })).toBe('fired → not delivered: target task is complete');
  });

  it('keeps "where it went" to one clause, even when a session is titled after the envelope', () => {
    // Measured on prod: a session the trigger itself started is titled after its
    // launch message, so its handle carried the raw envelope tag into the row.
    expect(describeAuditEntry({
      atMs: NOW, outcome: 'fired', items: 1,
      delivery: { status: 'ok', summary: 'sent to session Audit probe — <walnut-message kind="trigger" from="Trigger: x"> [ea6cffef]' },
    })).toBe('fired, 1 new item → sent to session Audit probe');
    expect(auditTarget(undefined)).toBe('delivered');
    expect(auditTarget(`sent to session ${'y'.repeat(80)}`)).toHaveLength(57);
  });

  // Measured on prod: the clamp cut "… [42eba805]" down to "… [42eb…", which
  // names no session at all. The id is the part a clamp may never eat.
  it('clamps the title of a session handle but never its id', () => {
    const clamped = auditTarget('sent to session Trigger: Audit probe 1789675159651 [42eba805]');
    expect(clamped).toBe('sent to session Trigger: Audit probe 1789675… [42eba805]');
    expect(clamped.length).toBeLessThanOrEqual(56);
    expect(clamped.endsWith(' [42eba805]')).toBe(true);
    // The bracket run is bounded, so even the widest handle keeps words in front
    // of it: there is no input for which the id gets dropped instead of clamped.
    const wide = auditTarget(`resumed session ${'z'.repeat(60)} [0123456789ab]`);
    expect(wide).toMatch(/^resumed session z+… \[0123456789ab\]$/);
    expect(wide.length).toBeLessThanOrEqual(56);
    // A clause with no handle at all still gets clamped.
    expect(auditTarget(`restarted session on task ${'t'.repeat(60)}`)).toHaveLength(57);
    // And a clamp landing INSIDE an emoji (its high surrogate sits on the last
    // kept unit, verified: index 55 is 0xd83d) drops the whole character.
    const astral = auditTarget(`sent to session ${'w'.repeat(39)}\u{1F680}${'w'.repeat(20)}`);
    expect(/[\uD800-\uDBFF]/.test(astral)).toBe(false);
    expect(astral).toBe(`sent to session ${'w'.repeat(39)}\u2026`);
    // A short handle is left exactly as the server wrote it.
    expect(auditTarget('resumed session Watch the PR [sid-stop]')).toBe('resumed session Watch the PR [sid-stop]');
  });

  // The server does not count a fire whose delivery is still being retried (the
  // daemon still owns it), so the tally must not read it as the newest landed one.
  it('never reports a still-retrying delivery as landed', () => {
    const landedAt = NOW - 600_000;
    const state = {
      fireCount: 3,
      fireLog: [
        { atMs: NOW - 1000, outcome: 'fired' as const, seq: 4, delivery: { status: 'retrying' as const } },
        { atMs: landedAt, outcome: 'fired' as const, seq: 3, delivery: { status: 'ok' as const } },
      ],
    };
    expect(describeFireTally(state, NOW)).toBe('fired 3×, last 10m ago, one delivery retrying');
    // A trigger whose FIRST fire is mid-retry has fired, and has landed nothing.
    expect(describeFireTally({ fireLog: [state.fireLog[0]] }, NOW)).toBe('fired, delivery retrying');
  });

  it('says on the card when a fire never landed', () => {
    expect(describeLastCheck({ atMs: NOW - 120_000, outcome: 'fired', items: 2, error: 'delivery failed 3 times, giving up: host unreachable' }, NOW))
      .toBe('fired, 2 items but not delivered, 2m ago');
    // A retry is still in flight, which is not the same thing.
    expect(describeLastCheck({ atMs: NOW - 120_000, outcome: 'fired', items: 2, retryPending: true, error: 'host unreachable' }, NOW))
      .toBe('fired, 2 items, delivery retrying, 2m ago');
  });

  it('counts the tries on a fire that was given up on', () => {
    expect(describeAuditEntry({
      atMs: NOW, outcome: 'fired', items: 1, attempts: 3,
      delivery: { status: 'error', error: 'host unreachable' },
    })).toBe('fired, 1 new item → not delivered after 3 tries: host unreachable');
  });

  // A replayed attempt can arrive after quiet checks pushed the fire's own row out
  // of checkLog, which appends a SECOND fired row for one fire.
  it('shows one row per fire even when checkLog holds two copies of it', () => {
    const fire = (atMs: number, attempts?: number) => ({
      atMs, outcome: 'fired' as const, seq: 7, epoch: 'e1',
      ...(attempts ? { attempts } : {}),
      delivery: { status: 'ok' as const, summary: 'sent to session x [abcd1234]' },
    });
    const rows = auditHistory({
      checkLog: [fire(NOW), { atMs: NOW - 1000, outcome: 'quiet' }, fire(NOW - 120_000)],
      fireLog: [fire(NOW, 3)],
    });
    expect(rows.map((r) => r.outcome)).toEqual(['fired', 'quiet']);
    // And the surviving copy is the fire-only one, which carries the real count.
    expect(rows[0].attempts).toBe(3);
    // With no checkLog at all the fires are still the history.
    expect(auditHistory({ fireLog: [fire(NOW)] })).toHaveLength(1);
    expect(auditHistory(undefined)).toEqual([]);
  });

  it('says plainly when a trigger has never fired', () => {
    expect(describeFireTally(undefined)).toBe('never fired yet');
    expect(describeFireTally({ lastCheck: { atMs: NOW, outcome: 'quiet' } })).toBe('never fired yet');
    expect(describeFireTally({ fireCount: 2, fireLog: [{ atMs: NOW - 180_000, outcome: 'fired' }] }, NOW))
      .toBe('fired 2×, last 3m ago');
    // A count with no log (the log scrolled past, or a pre-audit routine) still counts.
    expect(describeFireTally({ fireCount: 7 }, NOW)).toBe('fired 7×');
  });

  it('prints an audit clock even for a broken timestamp', () => {
    expect(auditClock(Number.NaN)).toBe('--:--');
    expect(auditClock(NOW, NOW)).toMatch(/^\d{2}:\d{2}/);
  });

  // A replayed fire can be days old; "06:12" alone would read as this morning.
  it('dates a row from another day, and only then', () => {
    expect(auditClock(NOW - 60_000, NOW)).not.toMatch(/[A-Za-z]{3}/);
    const twoDaysAgo = auditClock(NOW - 2 * 86_400_000, NOW);
    expect(twoDaysAgo).toMatch(/[A-Za-z]{3}\s+\d{1,2}\s+\d{2}:\d{2}/);
  });

  it('a backlog delivered as one envelope reads as one row, with how late it was', () => {
    expect(describeAuditEntry({
      atMs: NOW, outcome: 'fired', seq: 1, items: 9, coalesced: 7,
      firstAtMs: NOW - 43 * 3_600_000, deliveredAtMs: NOW + 60_000,
      delivery: { status: 'ok', summary: 'resumed session Slack sweep [e9a5f101]' },
    })).toBe('7 fires, 9 new items → resumed session Slack sweep [e9a5f101], 43h late');
    // A single late fire, and a batch that has not landed yet (no lateness claim).
    expect(describeAuditEntry({
      atMs: NOW, outcome: 'fired', items: 1, deliveredAtMs: NOW + 12 * 60_000,
      delivery: { status: 'ok', summary: 'sent to session x [abcd1234]' },
    })).toBe('fired, 1 new item → sent to session x [abcd1234], 12m late');
    expect(describeAuditEntry({
      atMs: NOW, outcome: 'fired', items: 3, coalesced: 3, attempts: 2,
      delivery: { status: 'retrying' },
    })).toBe('3 fires, 3 new items → delivery retrying after 2 tries');
  });

  it('the tally names the newest fire by fire time, not the last one written', () => {
    expect(describeFireTally({
      fireCount: 9,
      fireLog: [
        { atMs: NOW - 43 * 3_600_000, outcome: 'fired', delivery: { status: 'ok' } },
        { atMs: NOW - 180_000, outcome: 'fired', delivery: { status: 'ok' } },
      ],
    }, NOW)).toBe('fired 9×, last 3m ago');
  });

  it('orders the History rows by their own time, even from a list stored out of order', () => {
    const rows = auditHistory({
      checkLog: [
        { atMs: NOW - 43 * 3_600_000, outcome: 'fired', seq: 1, epoch: 'e', delivery: { status: 'ok' } },
        { atMs: NOW, outcome: 'quiet' },
        { atMs: NOW - 60_000, outcome: 'quiet' },
      ],
    });
    expect(rows.map((r) => r.atMs)).toEqual([NOW, NOW - 60_000, NOW - 43 * 3_600_000]);
  });
});
