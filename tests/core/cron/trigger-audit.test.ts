/**
 * The trigger audit trail's shape and bounds. Pure functions, so the awkward
 * cases (a replayed fire, a preview longer than the cap, a list at its bound)
 * are pinned here rather than discovered on a flyout hours later.
 */
import { describe, it, expect } from 'vitest';
import {
  appendAudit, auditDelivery, checkedAuditEntry, firedAuditEntry, injectedPreview, mergeFireAttempt,
  mergeRunOutcome,
  AUDIT_TEXT_CAP, LATE_DELIVERY_MS, INJECTED_PREVIEW_CAP, TRIGGER_CHECK_LOG_MAX, TRIGGER_FIRE_LOG_MAX,
} from '../../../src/core/cron/trigger-audit.js';
import type { TriggerAuditEntry } from '../../../src/core/cron/types.js';

const NOW = Date.parse('2026-09-17T15:31:00Z');

const quiet = (atMs: number): TriggerAuditEntry =>
  checkedAuditEntry({ atMs, outcome: 'quiet', reason: 'all-seen', durationMs: 12 });

describe('appendAudit', () => {
  it('puts the newest first and never grows past the bound', () => {
    let list: TriggerAuditEntry[] | undefined;
    for (let i = 0; i < TRIGGER_CHECK_LOG_MAX + 5; i++) {
      list = appendAudit(list, quiet(NOW + i), TRIGGER_CHECK_LOG_MAX);
    }
    expect(list).toHaveLength(TRIGGER_CHECK_LOG_MAX);
    expect(list![0].atMs).toBe(NOW + TRIGGER_CHECK_LOG_MAX + 4);
    expect(list![list!.length - 1].atMs).toBe(NOW + 5);
  });

  it('treats a missing or junk list as empty and keeps at least one entry', () => {
    expect(appendAudit(undefined, quiet(NOW), 5)).toHaveLength(1);
    expect(appendAudit(null as unknown as TriggerAuditEntry[], quiet(NOW), 5)).toHaveLength(1);
    expect(appendAudit([quiet(NOW)], quiet(NOW + 1), 0)).toHaveLength(1);
  });

  it('does not mutate the list it was given (the store may share it)', () => {
    const original = [quiet(NOW)];
    const next = appendAudit(original, quiet(NOW + 1), 5);
    expect(original).toHaveLength(1);
    expect(next).toHaveLength(2);
  });

  // Write order, not fire time: the bound keeps the most recent WRITES. A fire
  // held through an outage is older than the checks around it, and cutting by
  // age would drop it the moment it was written (the display sorts it instead).
  it('a late fire goes on top and is never cut by its age on the write', () => {
    const full = [quiet(NOW + 2), quiet(NOW + 1)];
    const late = firedAuditEntry({ atMs: NOW - 3_600_000, seq: 1, items: 1, delivery: { status: 'ok' } });
    const next = appendAudit(full, late, 2);
    expect(next[0]).toBe(late);
    expect(next).toHaveLength(2);
  });
});

describe('a coalesced or late fire row', () => {
  it('records how many fires one delivery carried and when the oldest was', () => {
    const entry = firedAuditEntry({
      atMs: NOW, seq: 3, items: 9, coalesced: 7, firstAtMs: NOW - 43 * 3_600_000,
      deliveredAtMs: NOW + 1_000, delivery: { status: 'ok' },
    });
    expect(entry).toMatchObject({ seq: 3, items: 9, coalesced: 7, firstAtMs: NOW - 43 * 3_600_000 });
    // Late is measured from the OLDEST fire: the newest one was only 1s ago.
    expect(entry.deliveredAtMs).toBe(NOW + 1_000);
  });

  it('a single fire carries no batch fields, and an on-time delivery no delivery time', () => {
    const single = firedAuditEntry({
      atMs: NOW, seq: 1, items: 1, coalesced: 1, firstAtMs: NOW,
      deliveredAtMs: NOW + LATE_DELIVERY_MS - 1, delivery: { status: 'ok' },
    });
    expect(single.coalesced).toBeUndefined();
    expect(single.firstAtMs).toBeUndefined();
    expect(single.deliveredAtMs).toBeUndefined();
    const lateSingle = firedAuditEntry({
      atMs: NOW, seq: 1, items: 1, deliveredAtMs: NOW + LATE_DELIVERY_MS + 1, delivery: { status: 'ok' },
    });
    expect(lateSingle.deliveredAtMs).toBe(NOW + LATE_DELIVERY_MS + 1);
  });

  it('a retried batch updates its one row in place', () => {
    const older = quiet(NOW - 10);
    const first = { ...firedAuditEntry({ atMs: NOW - 5, seq: 1, items: 3, coalesced: 3, firstAtMs: NOW - 99, delivery: { status: 'retrying' } }), epoch: 'e' };
    const newer = quiet(NOW);
    const retry = { ...firedAuditEntry({ atMs: NOW - 5, seq: 1, items: 3, coalesced: 3, firstAtMs: NOW - 99, attempts: 2, delivery: { status: 'ok' } }), epoch: 'e' };
    const merged = mergeFireAttempt([newer, first, older], retry, 10);
    expect(merged).toHaveLength(3);
    expect(merged[1]).toMatchObject({ seq: 1, coalesced: 3, attempts: 2, delivery: { status: 'ok' } });
  });
});

describe('checkedAuditEntry / firedAuditEntry', () => {
  it('stores no undefined keys, so a quiet row carries only its verdict', () => {
    const entry = checkedAuditEntry({ atMs: NOW, outcome: 'quiet' });
    expect(Object.keys(entry).sort()).toEqual(['atMs', 'outcome']);
    expect(JSON.stringify(entry)).toBe(`{"atMs":${NOW},"outcome":"quiet"}`);
  });

  it('keeps the error text on a failed check', () => {
    const entry = checkedAuditEntry({ atMs: NOW, outcome: 'error', error: 'exit 3: boom', durationMs: 7 });
    expect(entry).toEqual({ atMs: NOW, outcome: 'error', error: 'exit 3: boom', durationMs: 7 });
  });

  it('a fire carries its seq, item count, delivery and the injected preview', () => {
    const entry = firedAuditEntry({
      atMs: NOW,
      seq: 4,
      items: 2,
      durationMs: 33,
      delivery: auditDelivery({ status: 'ok', retry: false, summary: 'resumed session "PR watch"', sessionId: 'sid-1' }),
      injected: injectedPreview('<walnut-message kind="trigger">\nRead each new comment.\n</walnut-message>'),
    });
    expect(entry).toMatchObject({
      outcome: 'fired', seq: 4, items: 2, durationMs: 33,
      delivery: { status: 'ok', summary: 'resumed session "PR watch"', sessionId: 'sid-1' },
    });
    expect(entry.injected!.preview).toContain('Read each new comment.');
  });
});

describe('auditDelivery', () => {
  // The summary names a session whose title is arbitrary, and an error can carry
  // a whole stderr: ten fire rows of that would turn the store into a log.
  it('clamps the strings it stores and never ends on half a character', () => {
    const long = auditDelivery({ status: 'error', retry: false, summary: 's'.repeat(400), error: `${'e'.repeat(AUDIT_TEXT_CAP - 1)}\u{1F680}rest` });
    expect(long.summary).toHaveLength(AUDIT_TEXT_CAP + 1);
    expect(long.error).toHaveLength(AUDIT_TEXT_CAP);
    expect(/[\uD800-\uDBFF]/.test(long.error!)).toBe(false);
    // A newline in a summary would break the one-line row it is printed on.
    expect(auditDelivery({ status: 'ok', retry: false, summary: 'sent to\n  session x' }).summary).toBe('sent to session x');
  });

  it('calls an unacked retry "retrying", never a failure', () => {
    const retrying = auditDelivery({ status: 'error', retry: true, error: 'host unreachable' });
    expect(retrying).toEqual({ status: 'retrying', error: 'host unreachable' });
    const failed = auditDelivery({ status: 'error', retry: false, error: 'task is complete' });
    expect(failed.status).toBe('error');
    expect(auditDelivery({ status: 'ok', retry: false }).status).toBe('ok');
  });
});

describe('injectedPreview', () => {
  it('reports the full length while storing at most the cap', () => {
    const long = 'x'.repeat(INJECTED_PREVIEW_CAP + 500);
    const p = injectedPreview(long);
    expect(p.chars).toBe(INJECTED_PREVIEW_CAP + 500);
    expect(p.preview).toHaveLength(INJECTED_PREVIEW_CAP + 1); // + the ellipsis
    expect(p.preview.endsWith('…')).toBe(true);
    const short = injectedPreview('two\nlines');
    expect(short).toEqual({ chars: 9, preview: 'two\nlines' });
  });

  // A lone surrogate in the stored preview makes the whole cron store unreadable
  // to a strict JSON parser, so the cut backs off to the last whole character.
  it('never cuts an astral character in half', () => {
    const emoji = '\u{1F680}'; // one code point, two UTF-16 units
    const split = injectedPreview('x'.repeat(INJECTED_PREVIEW_CAP - 1) + emoji + 'tail');
    expect(split.preview).toHaveLength(INJECTED_PREVIEW_CAP); // dropped half, kept the ellipsis
    expect(/[\uD800-\uDBFF]$/.test(split.preview.slice(0, -1))).toBe(false);
    expect(JSON.parse(JSON.stringify(split)).preview).toBe(split.preview);
    // A pair that ends exactly on the cap survives whole.
    const whole = injectedPreview('x'.repeat(INJECTED_PREVIEW_CAP - 2) + emoji + 'tail');
    expect(whole.preview.endsWith(`${emoji}\u2026`)).toBe(true);
  });
});

describe('mergeFireAttempt', () => {
  const fire = (seq: number, epoch: string, status: 'ok' | 'error' | 'retrying'): TriggerAuditEntry => ({
    ...firedAuditEntry({ atMs: NOW, seq, items: 1, delivery: { status } }),
    epoch,
  });

  // checkLog holds 12 rows and a 10s trigger writes 6 quiet rows a minute, while
  // the daemon replays an unacked fire once a minute: by attempt 3 the fire's own
  // row can be gone. The count must come from the caller's state, not from a row
  // that may no longer exist.
  it('takes the caller\'s attempt count over one re-derived from the row', () => {
    const attempt3 = { ...firedAuditEntry({ atMs: NOW, seq: 9, items: 1, attempts: 3, delivery: { status: 'ok' } }), epoch: 'e1' };
    // The row was pushed out of this list, so there is nothing to fold into.
    const fresh = mergeFireAttempt([quiet(NOW)], attempt3, TRIGGER_FIRE_LOG_MAX);
    expect(fresh[0].attempts).toBe(3);
    // And folding into a surviving row uses the same authoritative number.
    const held = mergeFireAttempt([{ ...firedAuditEntry({ atMs: NOW, seq: 9, items: 1, delivery: { status: 'retrying' } }), epoch: 'e1' }], attempt3, TRIGGER_FIRE_LOG_MAX);
    expect(held[0].attempts).toBe(3);
    // A first attempt records no count at all - "after 1 tries" is noise.
    expect(firedAuditEntry({ atMs: NOW, seq: 1, items: 0, attempts: 1, delivery: { status: 'ok' } }).attempts).toBeUndefined();
  });

  it('keeps what an earlier attempt recorded when a later one has less', () => {
    const first = { ...firedAuditEntry({ atMs: NOW, seq: 4, items: 2, delivery: { status: 'retrying' }, injected: injectedPreview('the message it tried to send') }), epoch: 'e1' };
    const second = { ...firedAuditEntry({ atMs: NOW, seq: 4, items: 2, attempts: 2, delivery: { status: 'error', error: 'host unreachable' } }), epoch: 'e1' };
    const merged = mergeFireAttempt([first], second, TRIGGER_FIRE_LOG_MAX);
    expect(merged[0].delivery!.status).toBe('error');
    expect(merged[0].injected!.preview).toContain('the message it tried to send');
  });

  it('folds a replayed attempt of the SAME fire into its row and counts the tries', () => {
    let list = mergeFireAttempt(undefined, fire(1, 'e1', 'retrying'), TRIGGER_FIRE_LOG_MAX);
    expect(list).toHaveLength(1);
    list = mergeFireAttempt(list, fire(1, 'e1', 'retrying'), TRIGGER_FIRE_LOG_MAX);
    list = mergeFireAttempt(list, fire(1, 'e1', 'ok'), TRIGGER_FIRE_LOG_MAX);
    expect(list).toHaveLength(1);
    expect(list[0].attempts).toBe(3);
    expect(list[0].delivery!.status).toBe('ok');
  });

  it('a different seq, or the same seq under a new epoch, is a different fire', () => {
    let list = mergeFireAttempt(undefined, fire(1, 'e1', 'ok'), TRIGGER_FIRE_LOG_MAX);
    list = mergeFireAttempt(list, fire(2, 'e1', 'ok'), TRIGGER_FIRE_LOG_MAX);
    list = mergeFireAttempt(list, fire(1, 'e2', 'ok'), TRIGGER_FIRE_LOG_MAX);
    expect(list).toHaveLength(3);
    expect(list[0]).toMatchObject({ seq: 1, epoch: 'e2' });
  });

  it('leaves a quiet row alone even when it sits where a fire would match', () => {
    const list = mergeFireAttempt([quiet(NOW)], fire(1, 'e1', 'ok'), TRIGGER_FIRE_LOG_MAX);
    expect(list).toHaveLength(2);
    expect(list[0].outcome).toBe('fired');
    expect(list[1].outcome).toBe('quiet');
  });

  it('stays within the bound while merging', () => {
    let list: TriggerAuditEntry[] | undefined;
    for (let i = 0; i < TRIGGER_FIRE_LOG_MAX + 4; i++) {
      list = mergeFireAttempt(list, fire(i, 'e1', 'ok'), TRIGGER_FIRE_LOG_MAX);
    }
    expect(list).toHaveLength(TRIGGER_FIRE_LOG_MAX);
    // The newest fire is at the head, and re-merging it does not push anything out.
    const before = list!.length;
    list = mergeFireAttempt(list, fire(TRIGGER_FIRE_LOG_MAX + 3, 'e1', 'ok'), TRIGGER_FIRE_LOG_MAX);
    expect(list).toHaveLength(before);
    expect(list[0].attempts).toBe(2);
  });
});

describe('mergeRunOutcome', () => {
  /** What applyJobResult writes the instant an executor returns. */
  const dispatch = (atMs: number, taskId: string): TriggerAuditEntry => ({
    ...firedAuditEntry({
      atMs, seq: 0, items: 22,
      delivery: auditDelivery({ status: 'ok', retry: false, summary: `Started Claude Code session for task ${taskId} (/repo)` }),
      injected: injectedPreview('<walnut-message kind="trigger">the batch</walnut-message>'),
    }),
  });

  /**
   * What the layer watching that session writes minutes later — built as a plain
   * row, exactly as src/core/triage/runs.ts does. It deliberately carries NO
   * `items` and NO `injected`: it never knew either, and the merge has to keep the
   * dispatch's.
   */
  const outcome = (atMs: number, taskId: string, ended: string): TriggerAuditEntry => ({
    atMs,
    outcome: 'fired',
    durationMs: 94_000,
    delivery: auditDelivery({ status: 'ok', retry: false, summary: `Triage (task ${taskId}) ${ended}` }),
  });

  it('folds the verdict into the row that NAMES this run, not the newest one', () => {
    // Two runs a minute apart is ordinary for a wake routine, and it is exactly
    // where "merge into the head row" hands run 1's verdict to run 2.
    let list = mergeRunOutcome(undefined, dispatch(NOW, 'task-one'), '', TRIGGER_FIRE_LOG_MAX);
    list = mergeRunOutcome(list, dispatch(NOW + 60_000, 'task-two'), '', TRIGGER_FIRE_LOG_MAX);
    expect(list).toHaveLength(2);

    list = mergeRunOutcome(list, outcome(NOW, 'task-one', 'ended ok'), 'task-one', TRIGGER_FIRE_LOG_MAX);
    expect(list).toHaveLength(2);
    const one = list.find((e) => (e.delivery?.summary ?? '').includes('task-one'))!;
    const two = list.find((e) => (e.delivery?.summary ?? '').includes('task-two'))!;
    expect(one.delivery!.summary).toContain('ended ok');
    expect(two.delivery!.summary).toContain('Started Claude Code session');
  });

  it('keeps the dispatch\'s item count and injected preview through the merge', () => {
    let list = mergeRunOutcome(undefined, dispatch(NOW, 'task-one'), '', TRIGGER_FIRE_LOG_MAX);
    list = mergeRunOutcome(list, outcome(NOW, 'task-one', 'ended ok'), 'task-one', TRIGGER_FIRE_LOG_MAX);
    expect(list).toHaveLength(1);
    // The outcome counted no items and previewed nothing; both survive from the
    // dispatch, which is the only thing that ever knew them.
    expect(list[0].items).toBe(22);
    expect(list[0].injected!.preview).toContain('the batch');
    expect(list[0].durationMs).toBe(94_000);
  });

  it('appends when the run left no fire row at all (a clock-driven run)', () => {
    // applyJobResult only logs a fire when a wake counter was consumed, so a run
    // the clock started has nothing to merge into — and still has to be visible.
    const list = mergeRunOutcome([quiet(NOW)], outcome(NOW, 'task-three', 'ended ok'), 'task-three', TRIGGER_FIRE_LOG_MAX);
    expect(list).toHaveLength(2);
    expect(list[0].delivery!.summary).toContain('ended ok');
    expect(list[1].outcome).toBe('quiet');
  });

  it('an empty ref never merges — it would match every row', () => {
    const list = mergeRunOutcome([dispatch(NOW, 'task-one')], outcome(NOW, '', 'ended ok'), '', TRIGGER_FIRE_LOG_MAX);
    expect(list).toHaveLength(2);
  });

  it('never grows past the bound', () => {
    let list: TriggerAuditEntry[] | undefined;
    for (let i = 0; i < TRIGGER_FIRE_LOG_MAX + 3; i++) {
      list = mergeRunOutcome(list, outcome(NOW + i, `task-${i}`, 'ended ok'), `task-${i}`, TRIGGER_FIRE_LOG_MAX);
    }
    expect(list).toHaveLength(TRIGGER_FIRE_LOG_MAX);
  });
});
