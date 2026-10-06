/**
 * The per-task ledger backfill (src/core/time-tracking/task-backfill.ts): it reads
 * the usage ledger once, only for the days before the collector's first observed
 * day, and reads again only when that first day moves.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { createMockConstants } from '../../helpers/mock-constants.js';

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-time-task-backfill'));

import { usageTracker } from '../../../src/core/usage/index.js';
import { ledgerTaskOverlay, resetLedgerTaskOverlay } from '../../../src/core/time-tracking/task-backfill.js';
import { addToTaskIndex, createTaskIndex, taskTimeView } from '../../../src/core/time-tracking/task-index.js';

const TODAY = '2026-10-05';

afterEach(() => {
  vi.restoreAllMocks();
  resetLedgerTaskOverlay();
});

function storeWithAgentOn(date: string) {
  const index = createTaskIndex();
  addToTaskIndex(index, { date, ts: `${date}T10:00:00.000Z`, durationMs: 1000, kind: 'agent', taskId: 't_a', sessionId: 's1' });
  return index;
}

describe('ledgerTaskOverlay', () => {
  it('asks the ledger for the days before the first observed one, once', async () => {
    const spy = vi.spyOn(usageTracker, 'getTurnDurationsBySession').mockReturnValue([
      { date: '2026-08-01', taskId: 't_a', sessionId: 's9', durationMs: 60_000 },
      { date: '2026-08-02', taskId: '', sessionId: '', durationMs: 5000 },
    ]);
    const store = storeWithAgentOn('2026-09-01');
    const overlay = await ledgerTaskOverlay(store, TODAY);
    expect(spy).toHaveBeenCalledWith('2026-09-01');
    expect(taskTimeView(store, 't_a', TODAY, overlay).totals.all.agentMs).toBe(61_000);

    await ledgerTaskOverlay(store, TODAY);
    expect(spy).toHaveBeenCalledTimes(1);
    // An earlier observed day moves the boundary: read again.
    addToTaskIndex(store, { date: '2026-08-15', ts: '2026-08-15T10:00:00.000Z', durationMs: 1, kind: 'agent', taskId: 't_b' });
    await ledgerTaskOverlay(store, TODAY);
    expect(spy).toHaveBeenLastCalledWith('2026-08-15');
  });

  it('asks for everything before today when the collector has observed nothing', async () => {
    const spy = vi.spyOn(usageTracker, 'getTurnDurationsBySession').mockReturnValue([]);
    await ledgerTaskOverlay(createTaskIndex(), TODAY);
    expect(spy).toHaveBeenCalledWith(TODAY);
  });

  it('answers without a backfill when the ledger cannot be read, and tries again next time', async () => {
    const spy = vi.spyOn(usageTracker, 'getTurnDurationsBySession').mockImplementation(() => { throw new Error('locked'); });
    expect(await ledgerTaskOverlay(createTaskIndex(), TODAY)).toBeUndefined();
    await ledgerTaskOverlay(createTaskIndex(), TODAY);
    expect(spy).toHaveBeenCalledTimes(2);
  });
});
