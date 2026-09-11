/**
 * Watcher state: the dedup memory that keeps a poll from re-acting forever.
 *
 * The pure helpers are tested directly (that is where the dedup RULE lives) and
 * the disk layer is exercised against a mocked WALNUT_HOME, including the two
 * failure shapes that matter: a corrupt file and a day roll.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createMockConstants } from '../../helpers/mock-constants.js';

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-trigger-state'));

import {
  emptyTriggerState, markSeen, hasActed, pruneTriggerState, rollDay, dayKeyOf,
  loadTriggerState, updateTriggerState, deleteTriggerState,
  triggerStatePath, triggerStateDir, NOTES_MAX_CHARS,
} from '../../../src/core/routines/trigger-state.js';

const T0 = Date.UTC(2026, 8, 10, 12, 0, 0);
let n = 0;
const jobId = () => `job-${++n}-${Math.random().toString(36).slice(2, 8)}`;

describe('markSeen', () => {
  it('returns only ids never seen before, and remembers them', () => {
    const s = emptyTriggerState(T0);
    expect(markSeen(s, ['a', 'b'], T0).newIds).toEqual(['a', 'b']);
    expect(markSeen(s, ['b', 'c'], T0).newIds).toEqual(['c']);
    expect(markSeen(s, ['a', 'b', 'c'], T0).newIds).toEqual([]);
  });

  it('collapses duplicates inside one call and ignores blanks', () => {
    const s = emptyTriggerState(T0);
    const { newIds } = markSeen(s, ['x', 'x', '  ', '', ' y '], T0);
    expect(newIds).toEqual(['x', 'y']);
  });

  it('trims, so the same id with stray whitespace is not seen twice', () => {
    const s = emptyTriggerState(T0);
    markSeen(s, [' msg-1 '], T0);
    expect(markSeen(s, ['msg-1'], T0).newIds).toEqual([]);
  });
});

describe('hasActed', () => {
  it('is the hard dedup check, independent of seen', () => {
    const s = emptyTriggerState(T0);
    markSeen(s, ['m1'], T0);
    // Seen but not acted → an outcome is still allowed.
    expect(hasActed(s, 'm1')).toBe(false);
    s.acted['m1'] = T0;
    expect(hasActed(s, 'm1')).toBe(true);
    expect(hasActed(s, ' m1 ')).toBe(true);
  });
});

describe('pruneTriggerState', () => {
  it('drops seen entries older than 30 days but keeps acted for 90', () => {
    const s = emptyTriggerState(T0);
    const days = (d: number) => T0 - d * 24 * 60 * 60_000;
    s.seen = { fresh: days(1), stale: days(31) };
    s.acted = { recent: days(10), old: days(60), ancient: days(120) };
    pruneTriggerState(s, T0);
    expect(Object.keys(s.seen)).toEqual(['fresh']);
    expect(Object.keys(s.acted).sort()).toEqual(['old', 'recent']);
  });

  it('caps by count, dropping the oldest first', () => {
    const s = emptyTriggerState(T0);
    for (let i = 0; i < 2100; i++) s.seen[`id-${i}`] = T0 - (2100 - i) * 1000;
    pruneTriggerState(s, T0);
    expect(Object.keys(s.seen)).toHaveLength(2000);
    // The oldest went, the newest stayed.
    expect(s.seen['id-0']).toBeUndefined();
    expect(s.seen['id-2099']).toBeDefined();
  });

  it('truncates an oversized note instead of letting it grow the file', () => {
    const s = emptyTriggerState(T0);
    s.notes = 'x'.repeat(NOTES_MAX_CHARS + 500);
    pruneTriggerState(s, T0);
    expect(s.notes).toHaveLength(NOTES_MAX_CHARS);
  });
});

describe('rollDay', () => {
  it('zeroes the per-day session counter when the local day changes', () => {
    const s = emptyTriggerState(T0);
    s.day.sessions = 3;
    rollDay(s, T0 + 60_000);
    expect(s.day.sessions).toBe(3);   // same day
    const nextDay = T0 + 36 * 60 * 60_000;
    rollDay(s, nextDay);
    expect(s.day).toEqual({ key: dayKeyOf(nextDay), sessions: 0 });
  });
});

describe('triggerStatePath', () => {
  it('flattens separators so a stored id cannot escape the directory', () => {
    const p = triggerStatePath('../../etc/passwd');
    expect(path.dirname(p)).toBe(triggerStateDir());
    expect(path.basename(p)).not.toContain('/');
  });
});

describe('persistence', () => {
  it('round-trips through disk', async () => {
    const id = jobId();
    await updateTriggerState(id, (s) => {
      markSeen(s, ['m1', 'm2'], T0);
      s.acted['m1'] = T0;
      s.notes = 'waiting on Dana';
      s.singletons.triage = 'task-7';
    }, T0);

    const loaded = await loadTriggerState(id, T0);
    expect(Object.keys(loaded.seen).sort()).toEqual(['m1', 'm2']);
    expect(hasActed(loaded, 'm1')).toBe(true);
    expect(loaded.notes).toBe('waiting on Dana');
    expect(loaded.singletons.triage).toBe('task-7');
  });

  it('degrades to empty on a corrupt file rather than failing the run', async () => {
    const id = jobId();
    await fs.mkdir(triggerStateDir(), { recursive: true });
    await fs.writeFile(triggerStatePath(id), '{ not json', 'utf-8');
    const loaded = await loadTriggerState(id, T0);
    expect(loaded.seen).toEqual({});
    expect(loaded.version).toBe(1);
  });

  it('rolls the day on load, so a counter from yesterday never blocks today', async () => {
    const id = jobId();
    await updateTriggerState(id, (s) => { s.day.sessions = 5; }, T0);
    const nextDay = T0 + 30 * 60 * 60_000;
    const loaded = await loadTriggerState(id, nextDay);
    expect(loaded.day.sessions).toBe(0);
  });

  it('serializes concurrent updates instead of losing one', async () => {
    const id = jobId();
    await Promise.all(
      ['a', 'b', 'c', 'd', 'e'].map((k) =>
        updateTriggerState(id, (s) => { s.acted[k] = T0; }, T0)),
    );
    const loaded = await loadTriggerState(id, T0);
    expect(Object.keys(loaded.acted).sort()).toEqual(['a', 'b', 'c', 'd', 'e']);
  });

  it('deleteTriggerState forgets everything, and is safe when absent', async () => {
    const id = jobId();
    await updateTriggerState(id, (s) => { s.acted.x = T0; }, T0);
    await deleteTriggerState(id);
    expect(hasActed(await loadTriggerState(id, T0), 'x')).toBe(false);
    await expect(deleteTriggerState('never-existed')).resolves.toBeUndefined();
  });
});
