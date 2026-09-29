/**
 * The launch-prompt bubble (session:get-queue's launchPrompt) and the history row
 * that replaces it.
 *
 * A fresh session used to show nothing above "Claude Code is working…" until the
 * CLI had booted and written the prompt to its transcript (13s on the reported
 * session). The server now hands the prompt to the panel as it opens; these pin
 * how that bubble leaves: by POSITION (the first typed user row), since its text
 * can differ from the row and it can arrive after the watermark passed the row.
 */
import { describe, it, expect } from 'vitest';
import { dedupeOptimisticMessages, launchRowIndex } from '@/components/sessions/optimistic-dedup';
import { launchBubbleOf } from '@/hooks/useSessionSend';

type Row = { role: 'user' | 'assistant'; text: string; injected?: boolean };
type Bubble = { text: string; status: string; queueId: string; launch?: boolean };

const launch = (text: string): Bubble => ({ text, status: 'delivered', queueId: 'launch-sid-1', launch: true });
const sent = (text: string, queueId: string): Bubble => ({ text, status: 'received', queueId });
const ids = (bs: Bubble[]) => bs.map((b) => b.queueId);

describe('launch bubble absorption', () => {
  it('stays while history holds no user row (the CLI is still booting)', () => {
    const out = dedupeOptimisticMessages([launch('who owns the VM?')], [], 0);
    expect(ids(out)).toEqual(['launch-sid-1']);
  });

  it('stays while history holds only assistant rows or injected user rows', () => {
    const rows: Row[] = [
      { role: 'user', text: 'Base directory for this skill: …', injected: true },
      { role: 'assistant', text: '' },
    ];
    expect(ids(dedupeOptimisticMessages([launch('hi')], rows, 0))).toEqual(['launch-sid-1']);
  });

  it('is absorbed by the first typed user row even when its text differs', () => {
    // The row carries Walnut's image preamble; the bubble shows the typed words.
    const rows: Row[] = [{ role: 'user', text: '[Images attached — use the Read tool to view them]\n- /tmp/a.png\n\nwhat is this?' }];
    expect(dedupeOptimisticMessages([launch('what is this?')], rows, 0)).toEqual([]);
  });

  it('is absorbed when the watermark is already past its row (panel opened after the line landed)', () => {
    const rows: Row[] = [
      { role: 'user', text: 'launch words' },
      { role: 'assistant', text: 'working on it' },
    ];
    // First load seeded the watermark at the full length.
    expect(dedupeOptimisticMessages([launch('launch words')], rows, rows.length)).toEqual([]);
  });

  it('retires its row first, so a later send with the same words keeps its bubble until ITS row lands', () => {
    const rows: Row[] = [{ role: 'user', text: 'again' }];
    const out = dedupeOptimisticMessages([launch('again'), sent('again', 'qm-2')], rows, 0);
    expect(ids(out)).toEqual(['qm-2']);
    const both: Row[] = [...rows, { role: 'assistant', text: 'ok' }, { role: 'user', text: 'again' }];
    expect(dedupeOptimisticMessages([launch('again'), sent('again', 'qm-2')], both, 0)).toEqual([]);
  });

  it('never hides an ordinary bubble by position', () => {
    const rows: Row[] = [{ role: 'user', text: 'something else' }];
    expect(ids(dedupeOptimisticMessages([sent('mine', 'qm-1')], rows, 0))).toEqual(['qm-1']);
  });

  it('a tail window: the launch row is above it, and its first user row is some later send', () => {
    // A long first turn read as a bounded tail: the first loaded user row is a
    // mid-turn send whose own bubble must still be matched by it.
    const rows: Row[] = [
      { role: 'assistant', text: 'step 400' },
      { role: 'user', text: 'also check the logs' },
    ];
    const out = dedupeOptimisticMessages(
      [launch('the launch words'), sent('also check the logs', 'qm-9')], rows, 0, { historyFromStart: false });
    expect(out).toEqual([]);
    // A tail with no user row at all: the launch still does not head the window.
    expect(dedupeOptimisticMessages([launch('x')], [{ role: 'assistant', text: 'y' }], 0, { historyFromStart: false })).toEqual([]);
  });

  it('launchRowIndex skips injected, empty and assistant rows', () => {
    const rows: Row[] = [
      { role: 'assistant', text: 'x' },
      { role: 'user', text: '   ' },
      { role: 'user', text: 'meta', injected: true },
      { role: 'user', text: 'the prompt' },
    ];
    expect(launchRowIndex(rows)).toBe(3);
    expect(launchRowIndex([])).toBe(-1);
  });
});

describe('launchBubbleOf', () => {
  it('builds a delivered launch bubble with the display text', () => {
    const b = launchBubbleOf({ id: 'launch-s', text: 'hello there', at: '2026-09-28T00:00:00.000Z' });
    expect(b).toMatchObject({ role: 'user', text: 'hello there', queueId: 'launch-s', status: 'delivered', launch: true, timestamp: '2026-09-28T00:00:00.000Z' });
  });

  it('peels the image preamble a rehydrated row would carry', () => {
    const b = launchBubbleOf({ id: 'launch-s', text: '[Images attached — use the Read tool to view them]\n- /tmp/a.png\n\nlook', at: 'x' });
    expect(b?.text).toBe('look');
  });

  it('returns null for an empty prompt', () => {
    expect(launchBubbleOf({ id: 'launch-s', text: '  ', at: 'x' })).toBeNull();
  });
});
