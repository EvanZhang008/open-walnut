/**
 * Time tracking: the usage-ledger backfill for the PER-TASK view.
 *
 * /summary fills agent time on days the live collector never observed from the
 * usage ledger (agent-time.ts withLedgerBackfill). A task's own answer has to do
 * the same, or a task worked on before the collector shipped would show less
 * agent time on its page than the Overview shows for the same days.
 *
 * The ledger is SQLite read synchronously, so it is read ONCE, for the days before
 * the first day the collector observed (after that, every day the server ran has
 * its own agent records), and kept until that first day changes. Same caveats as
 * the summary's backfill: the ledger dates by UTC and only has billed turns, so it
 * is approximate; it never replaces an observed day.
 */

import { log } from '../../logging/index.js';
import { addToTaskIndex, agentDates, createTaskIndex, type TaskIndex, type TaskOverlay } from './task-index.js';

let cached: { before: string; index: TaskIndex } | null = null;

/** The ledger's per-(task, session, day) agent time for days the collector never saw. */
export async function ledgerTaskOverlay(store: TaskIndex, today: string): Promise<TaskOverlay | undefined> {
  const observed = agentDates(store);
  let before = today;
  for (const date of observed) if (date < before) before = date;
  if (cached?.before !== before) {
    try {
      const { usageTracker } = await import('../usage/index.js');
      const index = createTaskIndex();
      for (const row of usageTracker.getTurnDurationsBySession(before)) {
        addToTaskIndex(index, {
          date: row.date,
          ts: `${row.date}T12:00:00.000Z`,
          durationMs: row.durationMs,
          kind: 'agent',
          ...(row.taskId ? { taskId: row.taskId } : {}),
          ...(row.sessionId ? { sessionId: row.sessionId } : {}),
        });
      }
      cached = { before, index };
    } catch (err) {
      // Not cached: the next answer tries again.
      log.web.warn('time-tracking task ledger backfill skipped', {
        error: err instanceof Error ? err.message : String(err),
      });
      return undefined;
    }
  }
  return { index: cached.index, skip: observed };
}

export function resetLedgerTaskOverlay(): void {
  cached = null;
}
