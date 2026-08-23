/**
 * Time tracking — pure rollup logic: sample validation, the (date, task, kind)
 * fold, local-date arithmetic, and the human/agent + focus-share join.
 */

import { describe, it, expect } from 'vitest';
import {
  addRecord, bucketKey, datesWithAgentTime, foldRecords, localDateKey, mergeIndex,
  parseBucketKey, recentDateKeys, sanitizeSample, sanitizeSamples, shiftDateKey, summarize,
  MAX_SAMPLE_MS, MAX_SAMPLES_PER_REQUEST,
} from '../../../src/core/time-tracking/rollup.js';
import type { RollupIndex, TimeRecord } from '../../../src/core/time-tracking/types.js';

const NOW = new Date('2026-08-22T15:00:00.000Z');
/** The composite bucket-key separator, exactly as rollup.ts uses it. */
const SEP = '\u0000';

function rec(over: Partial<TimeRecord> = {}): TimeRecord {
  return {
    date: '2026-08-22',
    ts: '2026-08-22T15:00:00.000Z',
    durationMs: 60_000,
    kind: 'session',
    ...over,
  };
}

describe('bucket keys', () => {
  it('round-trips date/task/kind', () => {
    const key = bucketKey('2026-08-22', 't_alpha', 'agent');
    expect(parseBucketKey(key)).toEqual({ date: '2026-08-22', taskId: 't_alpha', kind: 'agent' });
  });

  it('keeps an empty task id distinct from a named one', () => {
    expect(bucketKey('2026-08-22', '', 'chat')).not.toBe(bucketKey('2026-08-22', 'x', 'chat'));
    expect(parseBucketKey(bucketKey('2026-08-22', '', 'chat')).taskId).toBe('');
  });

  it('reads the kind from the LAST field, so an id with a separator keeps its lane', () => {
    expect(parseBucketKey(`2026-08-22${SEP}t_real${SEP}agent${SEP}session`)).toEqual({
      date: '2026-08-22', taskId: `t_real${SEP}agent`, kind: 'session',
    });
  });

  it('gives a too-short key no kind at all rather than guessing one', () => {
    expect(parseBucketKey('2026-08-22').kind).toBe('');
    expect(parseBucketKey(`2026-08-22${SEP}t_alpha`).kind).toBe('');
  });
});

describe('local date arithmetic', () => {
  it('formats the LOCAL day, not UTC', () => {
    const d = new Date(2026, 7, 22, 23, 30, 0); // local 2026-08-22 23:30
    expect(localDateKey(d)).toBe('2026-08-22');
  });

  it('shifts across a month boundary', () => {
    expect(shiftDateKey('2026-09-01', -1)).toBe('2026-08-31');
    expect(shiftDateKey('2026-08-31', 1)).toBe('2026-09-01');
    expect(shiftDateKey('2026-08-22', 0)).toBe('2026-08-22');
  });

  it('returns the window ascending and ending at today', () => {
    expect(recentDateKeys('2026-08-22', 3)).toEqual(['2026-08-20', '2026-08-21', '2026-08-22']);
    expect(recentDateKeys('2026-08-22', 1)).toEqual(['2026-08-22']);
  });
});

describe('sanitizeSample', () => {
  it('assigns the local date from ts and normalizes ids', () => {
    const out = sanitizeSample(
      { ts: '2026-08-22T15:00:00.000Z', durationMs: 1234.6, kind: 'session', sessionId: ' sess-aaaa-1111 ' },
      NOW,
    );
    expect(out).toMatchObject({ durationMs: 1235, kind: 'session', sessionId: 'sess-aaaa-1111' });
    expect(out!.date).toBe(localDateKey(new Date('2026-08-22T15:00:00.000Z')));
  });

  it('rejects an unknown kind — the agent lane is never client-supplied', () => {
    expect(sanitizeSample({ ts: NOW.toISOString(), durationMs: 1000, kind: 'agent' }, NOW)).toBeNull();
    expect(sanitizeSample({ ts: NOW.toISOString(), durationMs: 1000, kind: 'nope' }, NOW)).toBeNull();
  });

  it('rejects an id carrying a separator or any other control character', () => {
    // The bucket key is `date NUL taskId NUL kind`, so a NUL inside a
    // browser-supplied taskId would smuggle a kind into the key and write the
    // AGENT lane. Any control character is rejected, not just the separator.
    const base = { ts: NOW.toISOString(), durationMs: 1000, kind: 'session' as const };
    const smuggled = sanitizeSample({ ...base, taskId: `t_real${SEP}agent` }, NOW);
    expect(smuggled!.taskId).toBeUndefined();
    expect(sanitizeSample({ ...base, sessionId: `sess${SEP}x` }, NOW)!.sessionId).toBeUndefined();
    expect(sanitizeSample({ ...base, taskId: 't_a\u0009b' }, NOW)!.taskId).toBeUndefined();
    expect(sanitizeSample({ ...base, taskId: 't_a\u007f' }, NOW)!.taskId).toBeUndefined();
    // The window itself still counts — under the taskless bucket, never a fake lane.
    expect(smuggled).toMatchObject({ durationMs: 1000, kind: 'session' });
  });

  it('keeps an ordinary id with spaces and unicode', () => {
    const out = sanitizeSample(
      { ts: NOW.toISOString(), durationMs: 1000, kind: 'chat', taskId: 't_a b-ü' },
      NOW,
    );
    expect(out!.taskId).toBe('t_a b-ü');
  });

  it('rejects zero, negative and non-finite durations', () => {
    for (const durationMs of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(sanitizeSample({ ts: NOW.toISOString(), durationMs, kind: 'chat' }, NOW)).toBeNull();
    }
  });

  it('clamps an absurd duration instead of dropping the window', () => {
    const out = sanitizeSample({ ts: NOW.toISOString(), durationMs: 99 * 60 * 60 * 1000, kind: 'chat' }, NOW);
    expect(out!.durationMs).toBe(MAX_SAMPLE_MS);
  });

  it('rejects timestamps far in the past or the future', () => {
    const old = new Date(NOW.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const future = new Date(NOW.getTime() + 60 * 60 * 1000).toISOString();
    expect(sanitizeSample({ ts: old, durationMs: 1000, kind: 'chat' }, NOW)).toBeNull();
    expect(sanitizeSample({ ts: future, durationMs: 1000, kind: 'chat' }, NOW)).toBeNull();
  });

  it('tolerates small clock skew forward', () => {
    const skewed = new Date(NOW.getTime() + 60_000).toISOString();
    expect(sanitizeSample({ ts: skewed, durationMs: 1000, kind: 'chat' }, NOW)).not.toBeNull();
  });

  it('drops garbage shapes without throwing', () => {
    for (const bad of [null, undefined, 7, 'x', {}, { ts: 'not-a-date', durationMs: 5, kind: 'chat' }]) {
      expect(sanitizeSample(bad, NOW)).toBeNull();
    }
  });

  it('caps a batch and skips unusable entries', () => {
    const good = { ts: NOW.toISOString(), durationMs: 1000, kind: 'chat' };
    const batch = [...Array(MAX_SAMPLES_PER_REQUEST + 50)].map(() => good);
    batch.splice(3, 0, { ts: 'bad', durationMs: 1, kind: 'chat' } as never);
    const out = sanitizeSamples(batch, NOW);
    expect(out.length).toBe(MAX_SAMPLES_PER_REQUEST - 1);
    expect(sanitizeSamples('not-an-array', NOW)).toEqual([]);
  });
});

describe('fold', () => {
  it('sums into one bucket per (date, task, kind)', () => {
    const index = foldRecords([
      rec({ taskId: 't_alpha', durationMs: 1000 }),
      rec({ taskId: 't_alpha', durationMs: 2000 }),
      rec({ taskId: 't_alpha', durationMs: 500, kind: 'chat' }),
      rec({ taskId: 't_beta', durationMs: 7000 }),
      rec({ date: '2026-08-21', taskId: 't_alpha', durationMs: 4000 }),
    ]);
    expect(index.get(bucketKey('2026-08-22', 't_alpha', 'session'))).toBe(3000);
    expect(index.get(bucketKey('2026-08-22', 't_alpha', 'chat'))).toBe(500);
    expect(index.get(bucketKey('2026-08-22', 't_beta', 'session'))).toBe(7000);
    expect(index.get(bucketKey('2026-08-21', 't_alpha', 'session'))).toBe(4000);
  });

  it('buckets a taskless record under the empty task id', () => {
    const index = foldRecords([rec({ kind: 'chat', durationMs: 900 })]);
    expect(index.get(bucketKey('2026-08-22', '', 'chat'))).toBe(900);
  });

  it('merges two indexes additively', () => {
    const a: RollupIndex = new Map([[bucketKey('2026-08-22', 't_alpha', 'agent'), 1000]]);
    const b: RollupIndex = new Map([[bucketKey('2026-08-22', 't_alpha', 'agent'), 250]]);
    expect(mergeIndex(a, b).get(bucketKey('2026-08-22', 't_alpha', 'agent'))).toBe(1250);
  });

  it('reports only days that really carry agent time', () => {
    const index = foldRecords([
      rec({ date: '2026-08-22', kind: 'agent', durationMs: 10 }),
      rec({ date: '2026-08-21', kind: 'session', durationMs: 10 }),
    ]);
    addRecord(index, rec({ date: '2026-08-20', kind: 'agent', durationMs: 0 }));
    expect([...datesWithAgentTime(index)]).toEqual(['2026-08-22']);
  });
});

describe('summarize', () => {
  const days = ['2026-08-20', '2026-08-21', '2026-08-22'];

  it('splits the human and agent lanes and keeps per-kind detail', () => {
    const index = foldRecords([
      rec({ taskId: 't_alpha', kind: 'session', durationMs: 60_000 }),
      rec({ taskId: 't_alpha', kind: 'triage', durationMs: 30_000 }),
      rec({ taskId: 't_alpha', kind: 'agent', durationMs: 120_000 }),
    ]);
    const out = summarize(index, { days, today: '2026-08-22' });
    const day = out.days.at(-1)!;
    expect(day.humanMs).toBe(90_000);
    expect(day.agentMs).toBe(120_000);
    expect(day.tasks[0]).toMatchObject({
      taskId: 't_alpha', humanMs: 90_000, agentMs: 120_000,
      byKind: { session: 60_000, triage: 30_000, chat: 0 },
    });
    expect(out.totalHumanMs).toBe(90_000);
    expect(out.totalAgentMs).toBe(120_000);
  });

  it('emits one entry per requested day, zeros included, ascending', () => {
    const out = summarize(new Map(), { days, today: '2026-08-22' });
    expect(out.days.map((d) => d.date)).toEqual(days);
    expect(out.days.every((d) => d.humanMs === 0 && d.agentMs === 0 && d.tasks.length === 0)).toBe(true);
  });

  it('ignores buckets outside the requested window', () => {
    const index = foldRecords([rec({ date: '2026-07-01', taskId: 't_alpha', durationMs: 5000 })]);
    expect(summarize(index, { days, today: '2026-08-22' }).totalHumanMs).toBe(0);
  });

  it('orders each day busiest first', () => {
    const index = foldRecords([
      rec({ taskId: 't_small', durationMs: 1000 }),
      rec({ taskId: 't_big', durationMs: 9000 }),
      rec({ taskId: 't_mid', kind: 'agent', durationMs: 5000 }),
    ]);
    const out = summarize(index, { days, today: '2026-08-22' });
    expect(out.days.at(-1)!.tasks.map((t) => t.taskId)).toEqual(['t_big', 't_mid', 't_small']);
  });

  it('computes focus share over HUMAN time only, and flags focus tasks', () => {
    const index = foldRecords([
      rec({ taskId: 't_focus', durationMs: 30_000 }),
      rec({ taskId: 't_other', durationMs: 90_000 }),
      // A huge agent number on a focus task must not move the human share.
      rec({ taskId: 't_focus', kind: 'agent', durationMs: 600_000 }),
    ]);
    const out = summarize(index, { days, today: '2026-08-22', focusTaskIds: ['t_focus'] });
    expect(out.focusShare).toBeCloseTo(0.25, 6);
    const focusTask = out.days.at(-1)!.tasks.find((t) => t.taskId === 't_focus')!;
    expect(focusTask.focus).toBe(true);
    expect(out.days.at(-1)!.tasks.find((t) => t.taskId === 't_other')!.focus).toBe(false);
  });

  it('reports a zero focus share rather than NaN when nothing was tracked', () => {
    const out = summarize(new Map(), { days, today: '2026-08-22', focusTaskIds: ['t_focus'] });
    expect(out.focusShare).toBe(0);
  });

  it('spans days for the focus share, not just today', () => {
    const index = foldRecords([
      rec({ date: '2026-08-20', taskId: 't_focus', durationMs: 60_000 }),
      rec({ date: '2026-08-22', taskId: 't_other', durationMs: 60_000 }),
    ]);
    const out = summarize(index, { days, today: '2026-08-22', focusTaskIds: ['t_focus'] });
    expect(out.focusShare).toBeCloseTo(0.5, 6);
  });

  it('ignores a bucket whose kind is not one of the four lanes', () => {
    // Belt to sanitizeSample's braces: a key like this can only come from an
    // already-written file (or an older build), and it must not invent a lane.
    const index: RollupIndex = new Map([
      [`2026-08-22${SEP}t_alpha${SEP}session`, 60_000],
      [`2026-08-22${SEP}t_alpha${SEP}bogus`, 5_000],
      [`2026-08-22${SEP}t_beta${SEP}`, 7_000],
    ]);
    const out = summarize(index, { days, today: '2026-08-22' });
    expect(out.totalHumanMs).toBe(60_000);
    expect(out.totalAgentMs).toBe(0);
    const day = out.days.at(-1)!;
    expect(day.tasks).toHaveLength(1);
    expect(day.tasks[0]).toMatchObject({
      taskId: 't_alpha', humanMs: 60_000, byKind: { session: 60_000, triage: 0, chat: 0 },
    });
  });

  it('never lets a smuggled separator reach the agent lane', () => {
    // The key an older build wrote for taskId `t_real<NUL>agent` + kind session.
    // The LAST field is the kind, so this stays human time under an odd id —
    // reading the second field as the kind is what used to write the agent lane.
    const index: RollupIndex = new Map([
      [`2026-08-22${SEP}t_real${SEP}agent${SEP}session`, 90_000],
    ]);
    const out = summarize(index, { days, today: '2026-08-22' });
    expect(out.totalAgentMs).toBe(0);
    expect(out.totalHumanMs).toBe(90_000);
    expect(out.days.at(-1)!.tasks[0]!.taskId).toBe(`t_real${SEP}agent`);
    expect(datesWithAgentTime(index).size).toBe(0);
  });

  it('carries the degraded flag through', () => {
    expect(summarize(new Map(), { days, today: '2026-08-22', degraded: true }).degraded).toBe(true);
    expect(summarize(new Map(), { days, today: '2026-08-22' }).degraded).toBeUndefined();
  });
});
