/**
 * The state carries the journal's newest line, whatever order two runs settle in.
 *
 * A run's settle appends its line to the journal note and then records the same line in the
 * triage state, for the NEXT envelope. Two runs settling together interleaved those writes:
 * run 1 appended, run 2 appended and recorded, then run 1 recorded, so the state carried run 1
 * while the journal's newest line was run 2's (2026-11-26). They are one step now, run by run.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import { createMockConstants } from '../helpers/mock-constants.js';

vi.mock('../../src/constants.js', () => createMockConstants('walnut-triage-journal-line'));

import { WALNUT_HOME } from '../../src/constants.js';
import { bus, EventNames } from '../../src/core/event-bus.js';
import { startTriageRuns } from '../../src/core/triage/runs.js';
import { TRIAGE_PROJECT } from '../../src/core/triage/bootstrap.js';
import { loadTriageState, triageStatePath } from '../../src/core/triage/state.js';
import type { Task } from '../../src/core/types.js';

const tasks = new Map<string, Task>();
function runTask(id: string, title: string): Task {
  const task = {
    id, title, project: TRIAGE_PROJECT, agent_id: 'triage', phase: 'IN_PROGRESS',
    created_at: new Date(Date.now() - 5_000).toISOString(), updated_at: new Date().toISOString(),
  } as unknown as Task;
  tasks.set(id, task);
  return task;
}

async function until(done: () => boolean | Promise<boolean>, what: string): Promise<void> {
  for (let i = 0; i < 400; i += 1) {
    if (await done()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${what}`);
}

let handle: { stop(): void; stats(): { settled: number } } | null = null;
afterEach(() => { handle?.stop(); handle = null; });
beforeEach(async () => {
  tasks.clear();
  await fs.rm(triageStatePath(WALNUT_HOME), { force: true });
});

describe('the line the next envelope shows', () => {
  it('is the journal\'s newest line when two runs settle together', async () => {
    runTask('run-one-0001', 'Triage · 09:00 · 22 items');
    runTask('run-two-0002', 'Triage · 09:00 · 24 items');
    const journal: string[] = [];
    // Run one's write lands at once but takes a while to come back (a slow disk, a held lock),
    // so run two settles inside it: the order that used to leave run one in the state.
    let releaseFirst: () => void = () => {};
    const firstBack = new Promise<void>((resolve) => { releaseFirst = resolve; });
    // A settle tells the routine's card after its journal step, so a run's outcome here means
    // its journal line and the state's copy are both written.
    const outcomes: string[] = [];
    handle = startTriageRuns({
      home: WALNUT_HOME,
      listRunTaskIds: async () => [...tasks.keys()],
      getTask: async (id) => tasks.get(id),
      completeTask: async () => undefined,
      recordOutcome: async (o) => { outcomes.push(o.taskId); },
      withdrawSuperseded: async () => ({ withdrawn: [], kept: 0, failed: 0 }),
      appendJournal: async (line) => {
        journal.push(line);
        if (line.includes('task run-one')) await firstBack;
        return 'notes/x.md';
      },
    });

    bus.emit(EventNames.SESSION_RESULT, { taskId: 'run-one-0001', sessionId: 's-1', result: 'done' }, ['web-ui']);
    await until(() => journal.length === 1, 'run one\'s line');
    bus.emit(EventNames.SESSION_RESULT, { taskId: 'run-two-0002', sessionId: 's-2', result: 'done' }, ['web-ui']);
    await until(() => handle!.stats().settled === 2, 'run two settling');
    await new Promise((resolve) => setImmediate(resolve));
    // Where run two's write already went ahead of run one's (the order before the fix), let it
    // finish first: that is the interleaving that left run one in the state.
    if (journal.length === 2) {
      await until(async () => (await loadTriageState(WALNUT_HOME)).lastJournalLine?.includes('task run-two') === true, 'run two recorded first');
    }
    releaseFirst();
    await until(() => outcomes.length === 2, 'both runs settled');
    await until(async () => (await loadTriageState(WALNUT_HOME)).lastJournalLine !== undefined, 'a carried line');

    expect(journal[0]).toContain('task run-one');
    expect(journal[1]).toContain('task run-two');
    expect((await loadTriageState(WALNUT_HOME)).lastJournalLine).toBe(journal[1]);
  });
});
