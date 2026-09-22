/**
 * A new triage run takes back the decisions the previous one left open.
 *
 * Three decision letters per run pile up fast: the item each one asks about has been looked at again by
 * the batch that just landed, so an old letter's buttons act on a stale reading. The withdrawal happens
 * the moment the NEW run's task appears, which is also why it needs no "keep my own letters" argument:
 * that run's session has not had a turn yet, so it cannot have sent one.
 *
 * The cases here are about the wiring, not about which letters qualify (`triage-quota.test.ts` grades
 * that): it happens, it happens once, and a failure to withdraw never costs the acknowledgement that
 * stops a batch being delivered twice.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createMockConstants } from '../helpers/mock-constants.js';

vi.mock('../../src/constants.js', () => createMockConstants());

import { bus, EventNames } from '../../src/core/event-bus.js';
import { startTriageRuns } from '../../src/core/triage/runs.js';
import { TRIAGE_PROJECT } from '../../src/core/triage/bootstrap.js';
import { claimTriageBatch, loadTriageState, recordTriageArrivals } from '../../src/core/triage/state.js';
import type { Task } from '../../src/core/types.js';

const HOME = (): string => {
  const { WALNUT_HOME } = require('../../src/constants.js') as { WALNUT_HOME: string };
  return WALNUT_HOME;
};

function runTask(id: string): Task {
  return {
    id,
    title: 'Triage · 14:10 · 12 items',
    project: TRIAGE_PROJECT,
    agent_id: 'triage',
    phase: 'IN_PROGRESS',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  } as unknown as Task;
}

/** Wait for the handler's fire-and-forget async work. */
async function settle(): Promise<void> {
  for (let i = 0; i < 12; i += 1) await new Promise((resolve) => setTimeout(resolve, 5));
}

let handle: { stop(): void } | null = null;

beforeEach(async () => {
  handle?.stop();
  handle = null;
  // A claim has to exist for the acknowledgement path to run at all.
  await recordTriageArrivals({ mail: [{ accountId: 'a', mailbox: 'INBOX', count: 3, headlines: ['hi'] }] }, HOME());
  await claimTriageBatch(HOME());
});

describe('a run takes back the previous run s open decisions', () => {
  it('withdraws once, when the new run s task appears', async () => {
    const withdrawSuperseded = vi.fn(async () => ({ withdrawn: ['lt-1', 'lt-2'], kept: 0, failed: 0 }));
    handle = startTriageRuns({
      home: HOME(),
      withdrawSuperseded,
      listRunTaskIds: async () => [],
      getTask: async () => undefined,
      completeTask: async () => undefined,
      appendJournal: async () => 'notes/Walnut/Triage/Runs/2026-09.md',
      recordOutcome: async () => undefined,
    });

    bus.emit(EventNames.TASK_CREATED, { task: runTask('t-run-1') }, ['web-ui']);
    await settle();

    expect(withdrawSuperseded).toHaveBeenCalledTimes(1);
    // The claim is acknowledged too: the withdrawal is the last thing, never a gate on delivery.
    expect((await loadTriageState(HOME())).claim).toBeUndefined();
  });

  it('leaves a task that is not a triage run alone', async () => {
    const withdrawSuperseded = vi.fn(async () => ({ withdrawn: [], kept: 0, failed: 0 }));
    handle = startTriageRuns({ home: HOME(), withdrawSuperseded, listRunTaskIds: async () => [] });

    const other = { ...runTask('t-other'), agent_id: 'general', project: 'Ask Walnut' } as Task;
    bus.emit(EventNames.TASK_CREATED, { task: other }, ['web-ui']);
    await settle();

    expect(withdrawSuperseded).not.toHaveBeenCalled();
  });

  /**
   * A letter that cannot be taken back is one stale question in an inbox. A batch delivered twice is every
   * item triaged twice, with letters and note edits to match, so the acknowledgement wins.
   */
  it('still acknowledges the batch when the withdrawal throws', async () => {
    handle = startTriageRuns({
      home: HOME(),
      withdrawSuperseded: async () => { throw new Error('the inbox is unreachable'); },
      listRunTaskIds: async () => [],
    });

    bus.emit(EventNames.TASK_CREATED, { task: runTask('t-run-2') }, ['web-ui']);
    await settle();

    expect((await loadTriageState(HOME())).claim).toBeUndefined();
  });
});
