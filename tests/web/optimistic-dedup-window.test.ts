/**
 * Bubbles whose rows the index watermark cannot reach.
 *
 * inc-1790922678361: a server restart mid-turn swapped the client's history for a
 * byte-bounded tail window. The rows of six mid-turn sends sat above that window
 * and were never loaded again (deltas only append), so their "Delivered" bubbles
 * stayed pinned under every later turn until a reload. The same shape appears
 * without a restart whenever a row lands under a watermark that already moved on
 * (a turn start before the refetch that carries the row).
 *
 * Two answers, both pinned here: a row below the watermark still counts when it
 * is not older than the bubble's enqueue (time floor), and a delivered bubble
 * enqueued before the loaded window's first row is accounted for by position.
 */
import { describe, it, expect } from 'vitest';
import { dedupeOptimisticMessages, BUBBLE_CLOCK_SLACK_MS, windowHeadMs } from '@/components/sessions/optimistic-dedup';

type Row = { role: 'user' | 'assistant'; text: string; timestamp?: string; walnutMessageId?: string };
type Bubble = { text: string; status: string; queueId: string; timestamp?: string; launch?: boolean; dedupText?: string };

const T0 = Date.parse('2026-10-02T05:14:00.000Z');
const at = (offsetMs: number) => new Date(T0 + offsetMs).toISOString();
const row = (text: string, offsetMs?: number, role: 'user' | 'assistant' = 'user'): Row =>
  ({ role, text, ...(offsetMs === undefined ? {} : { timestamp: at(offsetMs) }) });
const delivered = (text: string, queueId: string, offsetMs?: number): Bubble =>
  ({ text, status: 'delivered', queueId, ...(offsetMs === undefined ? {} : { timestamp: at(offsetMs) }) });
const received = (text: string, queueId: string, offsetMs?: number): Bubble =>
  ({ text, status: 'received', queueId, ...(offsetMs === undefined ? {} : { timestamp: at(offsetMs) }) });
const ids = (bs: Bubble[]) => bs.map((b) => b.queueId);

describe('time floor: a row under the watermark still proves a bubble enqueued before it', () => {
  it('absorbs a delivered bubble whose row landed below a watermark that moved on', () => {
    // Turn 1 rows (the bubble's row at +34s), then turn 2 started and the
    // watermark advanced to the end: the index window is empty.
    const rows: Row[] = [
      row('first ask', 0),
      row('', 10_000, 'assistant'),
      row('mid-turn send', 34_000),
      row('', 60_000, 'assistant'),
    ];
    const bubbles = [delivered('mid-turn send', 'qm-1', 33_800)];
    expect(dedupeOptimisticMessages(bubbles, rows, rows.length)).toEqual([]);
  });

  it('does not let an older identical row absorb a newer bubble', () => {
    const rows: Row[] = [
      row('ok', 0),
      row('', 5_000, 'assistant'),
    ];
    // Sent 10 minutes after that old "ok"; its own row is not loaded yet.
    const bubbles = [delivered('ok', 'qm-2', 600_000)];
    expect(ids(dedupeOptimisticMessages(bubbles, rows, rows.length))).toEqual(['qm-2']);
  });

  it('tolerates the CLI clock running slightly behind the server clock', () => {
    const rows: Row[] = [row('drifted', -(BUBBLE_CLOCK_SLACK_MS - 1_000))];
    expect(dedupeOptimisticMessages([delivered('drifted', 'qm-3', 0)], rows, rows.length)).toEqual([]);
    const tooOld: Row[] = [row('drifted', -(BUBBLE_CLOCK_SLACK_MS + 1_000))];
    expect(ids(dedupeOptimisticMessages([delivered('drifted', 'qm-3', 0)], tooOld, tooOld.length))).toEqual(['qm-3']);
  });

  it('reaches an undated row only by index, as before', () => {
    const rows: Row[] = [row('undated')];
    expect(ids(dedupeOptimisticMessages([delivered('undated', 'qm-4', 0)], rows, rows.length))).toEqual(['qm-4']);
    expect(dedupeOptimisticMessages([delivered('undated', 'qm-4', 0)], rows, 0)).toEqual([]);
  });

  it('a bubble without an enqueue time keeps the index-only rule', () => {
    const rows: Row[] = [row('no clock', 30_000)];
    expect(ids(dedupeOptimisticMessages([delivered('no clock', 'qm-5')], rows, rows.length))).toEqual(['qm-5']);
  });

  it('is a multiset across both coordinates: one row accounts for one bubble', () => {
    const rows: Row[] = [
      row('same', 10_000), // below the watermark, dated
      row('', 11_000, 'assistant'),
      row('same', 40_000), // inside the index window
    ];
    const bubbles = [delivered('same', 'qm-a', 9_900), delivered('same', 'qm-b', 39_900), delivered('same', 'qm-c', 39_950)];
    expect(ids(dedupeOptimisticMessages(bubbles, rows, 2))).toEqual(['qm-c']);
  });

  it('matches the enqueued text (dedupText) against a dated row carrying the image preamble', () => {
    const line = '[Images attached — use the Read tool to view them]\n- /tmp/a.png\n\nwhat is this?';
    const rows: Row[] = [row(line, 20_000), row('', 21_000, 'assistant')];
    const bubbles: Bubble[] = [{ ...delivered('what is this?', 'qm-6', 19_800), dedupText: line }];
    expect(dedupeOptimisticMessages(bubbles, rows, rows.length)).toEqual([]);
  });

  it('proves a merged batch from dated rows below the watermark', () => {
    const rows: Row[] = [row('one\ntwo', 30_000), row('', 31_000, 'assistant')];
    const bubbles = [delivered('one', 'qm-7', 20_000), delivered('two', 'qm-8', 25_000)];
    expect(dedupeOptimisticMessages(bubbles, rows, rows.length)).toEqual([]);
  });

  it('retires a launch row below the watermark before a same-text send can claim it', () => {
    const rows: Row[] = [row('again', 0), row('', 1_000, 'assistant')];
    const launch: Bubble = { text: 'again', status: 'delivered', queueId: 'launch-1', launch: true, timestamp: at(0) };
    const out = dedupeOptimisticMessages([launch, delivered('again', 'qm-9', 30_000)], rows, rows.length);
    expect(ids(out)).toEqual(['qm-9']);
  });
});

describe('above the loaded window: a delivered bubble older than the first loaded row', () => {
  // The incident shape: the window starts at the compaction, the two sends sit
  // minutes above it.
  const windowRows: Row[] = [
    row('This session is being continued…', 9 * 60_000),
    row('', 9 * 60_000 + 5_000, 'assistant'),
  ];

  it('is absorbed when the history is a tail window', () => {
    const bubbles = [delivered('peer reply text', 'qm-10', 118_000), delivered('what do you think?', 'qm-11', 208_000)];
    expect(dedupeOptimisticMessages(bubbles, windowRows, windowRows.length, { historyFromStart: false })).toEqual([]);
  });

  it('stays when the history starts at the beginning (its row would be loaded)', () => {
    const bubbles = [delivered('what do you think?', 'qm-11', 208_000)];
    expect(ids(dedupeOptimisticMessages(bubbles, windowRows, windowRows.length, { historyFromStart: true }))).toEqual(['qm-11']);
  });

  it('stays while only received: the CLI has no row for it yet', () => {
    const bubbles = [received('still queued', 'qm-12', 100_000)];
    expect(ids(dedupeOptimisticMessages(bubbles, windowRows, windowRows.length, { historyFromStart: false }))).toEqual(['qm-12']);
  });

  it('stays when enqueued inside the window (a missing row there is a real mismatch)', () => {
    const bubbles = [delivered('sent after the head', 'qm-13', 9 * 60_000 + 2_000)];
    expect(ids(dedupeOptimisticMessages(bubbles, windowRows, windowRows.length, { historyFromStart: false }))).toEqual(['qm-13']);
  });

  it('stays when enqueued within the clock slack of the head', () => {
    const bubbles = [delivered('just before the head', 'qm-14', 9 * 60_000 - BUBBLE_CLOCK_SLACK_MS + 1_000)];
    expect(ids(dedupeOptimisticMessages(bubbles, windowRows, windowRows.length, { historyFromStart: false }))).toEqual(['qm-14']);
  });

  it('stays when neither side has a clock', () => {
    const undated: Row[] = [row('head without a timestamp')];
    expect(ids(dedupeOptimisticMessages([delivered('old', 'qm-15', 0)], undated, 1, { historyFromStart: false }))).toEqual(['qm-15']);
    expect(ids(dedupeOptimisticMessages([delivered('old', 'qm-16')], windowRows, 2, { historyFromStart: false }))).toEqual(['qm-16']);
  });

  it('never hides a failed bubble', () => {
    const failed: Bubble = { text: 'lost', status: 'failed', queueId: 'qm-17', timestamp: at(0) };
    expect(ids(dedupeOptimisticMessages([failed], windowRows, 2, { historyFromStart: false }))).toEqual(['qm-17']);
  });

  it('windowHeadMs reads the first dated row of a window and nothing for a full history', () => {
    expect(windowHeadMs(windowRows, false)).toBe(T0 + 9 * 60_000);
    expect(windowHeadMs(windowRows, true)).toBeUndefined();
    expect(windowHeadMs([row('x')], false)).toBeUndefined();
  });
});
